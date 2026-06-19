import { NextRequest, NextResponse } from "next/server";
import * as line from "@line/bot-sdk";
import { getFaqCsv } from "@/lib/sheet";
import { uploadImageToDrive, appendSlipRecord } from "@/lib/google";
import { askGemini, verifySlipImage } from "@/lib/gemini";
import {
  startSlipFlow,
  getSession,
  updateSession,
  clearSession,
} from "@/lib/session";

const DEFAULT_REPLY =
  "ขออภัยค่ะในส่วนนี้ กรุณาติดต่อกับทางหอพักโดยตรงได้เลยนะคะ 😊 📞 080-499-9116";

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
});
const blobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
});

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";

  const isValid = line.validateSignature(
    body,
    process.env.LINE_CHANNEL_SECRET!,
    signature
  );
  if (!isValid) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const events = JSON.parse(body).events;

  await Promise.all(
    events.map(async (event: any) => {
      if (event.type !== "message") return;

      const userId = event.source.userId;
      const replyToken = event.replyToken;

      // ===== กรณีลูกค้าส่งรูป =====
      if (event.message.type === "image") {
        await handleImageMessage(userId, event.message.id, replyToken);
        return;
      }

      // ===== กรณีลูกค้าส่งข้อความ =====
      if (event.message.type !== "text") return;

      const userMessage: string = event.message.text;
      const session = getSession(userId);

      // ถ้าลูกค้าอยู่ระหว่างขั้นตอนส่งสลิปอยู่แล้ว
      if (session) {
        await handleSlipFlow(userId, userMessage, replyToken);
        return;
      }

      // ===== กรณีปกติ ถามตอบ FAQ ด้วย AI =====
      let replyText = DEFAULT_REPLY;
      try {
        const csv = await getFaqCsv();
        replyText = await askGemini(csv, userMessage);
      } catch (err) {
        console.error("[webhook] processing error:", err);
      }

      try {
        await client.replyMessage({
          replyToken,
          messages: [{ type: "text", text: replyText }],
        });
      } catch (err) {
        console.error("[webhook] reply error:", err);
      }
    })
  );

  return NextResponse.json({ ok: true });
}

// จัดการขั้นตอนสนทนาเก็บชื่อ/ห้อง
async function handleSlipFlow(
  userId: string,
  message: string,
  replyToken: string
) {
  const session = getSession(userId)!;

  if (session.step === "waiting_name") {
    updateSession(userId, { name: message, step: "waiting_room" });
    await client.replyMessage({
      replyToken,
      messages: [
        { type: "text", text: "ขอบคุณค่ะ กรุณาแจ้งหมายเลขห้องด้วยนะคะ" },
      ],
    });
    return;
  }

if (session.step === "waiting_room") {
    const room = message;

    try {
      // บันทึกลง Google Sheet (รูปถูกอัปโหลดไว้แล้วตอนตรวจสอบผ่าน)
      await appendSlipRecord(room, session.name!, session.imageUrl!);

      await client.replyMessage({
        replyToken,
        messages: [
          {
            type: "text",
            text: `รับสลิปเรียบร้อยแล้วค่ะ ✅\nชื่อ: ${session.name}\nห้อง: ${room}\nขอบคุณนะคะ 😊`,
          },
        ],
      });

      // แจ้งเจ้าของหอในกลุ่ม LINE
      if (process.env.LINE_OWNER_GROUP_ID) {
        await client.pushMessage({
          to: process.env.LINE_OWNER_GROUP_ID,
          messages: [
            {
              type: "text",
              text: `📥 มีการแจ้งโอนเงินใหม่\nชื่อ: ${session.name}\nห้อง: ${room}\nดูรูปสลิป: ${session.imageUrl}`,
            },
          ],
        });
      }
    } catch (err) {
      console.error("[webhook] save slip error:", err);
      await client.replyMessage({
        replyToken,
        messages: [
          {
            type: "text",
            text: "ขออภัยค่ะ เกิดข้อผิดพลาดในการบันทึกข้อมูล กรุณาติดต่อหอพักโดยตรงค่ะ 📞 080-499-9116",
          },
        ],
      });
    }

    clearSession(userId);
    return;
  }
}

// จัดการตอนลูกค้าส่งรูป (ไม่ว่าจะอยู่ขั้นตอนไหนก็ตรวจสอบได้เลย)
async function handleImageMessage(
  userId: string,
  messageId: string,
  replyToken: string
) {
  try {
    // ดึงรูปจาก LINE
    const stream = await blobClient.getMessageContent(messageId);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    const imageBuffer = Buffer.concat(chunks);

    // ให้ AI ตรวจสอบก่อนว่าเป็นรูปสลิปจริงไหม
    const isSlip = await verifySlipImage(imageBuffer);

    if (!isSlip) {
      // ถ้าลูกค้าส่งรูปอื่นมาเฉยๆ (ไม่ใช่สลิป) ไม่ต้องตอบอะไร ปล่อยผ่าน
      // เพื่อไม่ให้รบกวนตอนลูกค้าส่งรูปอื่นที่ไม่เกี่ยวกับสลิป
      return;
    }

    // ตรวจสอบผ่านแล้ว → อัปโหลดขึ้น Google Drive ทันที
    const fileName = `slip_${userId}_${Date.now()}.jpg`;
    const imageUrl = await uploadImageToDrive(imageBuffer, fileName);

    // เริ่ม session ใหม่ พร้อมเก็บ imageUrl แล้วถามชื่อ
    startSlipFlow(userId);
    updateSession(userId, { imageUrl, step: "waiting_name" });

    await client.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text: "รับรูปสลิปเรียบร้อยค่ะ ✅ กรุณาแจ้งชื่อ-นามสกุลผู้โอนด้วยนะคะ",
        },
      ],
    });
  } catch (err) {
    console.error("[webhook] image processing error:", err);
  }
}