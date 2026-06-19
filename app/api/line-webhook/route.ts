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

// คำที่ใช้เริ่มขั้นตอนส่งสลิป
const SLIP_TRIGGER_WORDS = ["ส่งสลิป", "แจ้งโอนเงิน", "แจ้งชำระเงิน", "โอนเงินแล้ว"];

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

      // ถ้าลูกค้าพิมพ์คำเริ่มต้นส่งสลิป
      if (SLIP_TRIGGER_WORDS.some((w) => userMessage.includes(w))) {
        startSlipFlow(userId);
        await client.replyMessage({
          replyToken,
          messages: [
            {
              type: "text",
              text: "รับทราบค่ะ กรุณาแจ้งชื่อ-นามสกุลผู้โอนด้วยนะคะ 😊",
            },
          ],
        });
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
    updateSession(userId, { room: message, step: "waiting_image" });
    await client.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text: "กรุณาส่งรูปสลิปโอนเงินได้เลยค่ะ 📸",
        },
      ],
    });
    return;
  }

  // ถ้าลูกค้าพิมพ์ข้อความแทนที่จะส่งรูปตอนรอรูป
  if (session.step === "waiting_image") {
    await client.replyMessage({
      replyToken,
      messages: [
        { type: "text", text: "กรุณาส่งเป็นรูปภาพสลิปนะคะ 📸" },
      ],
    });
    return;
  }
}

// จัดการตอนลูกค้าส่งรูปจริงๆ
async function handleImageMessage(
  userId: string,
  messageId: string,
  replyToken: string
) {
  const session = getSession(userId);

  // ถ้าไม่ได้อยู่ในขั้นตอนส่งสลิป ไม่ต้องทำอะไร
  if (!session || session.step !== "waiting_image") {
    await client.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text: 'หากต้องการแจ้งสลิปโอนเงิน กรุณาพิมพ์ "ส่งสลิป" ก่อนนะคะ 😊',
        },
      ],
    });
    return;
  }

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
      await client.replyMessage({
        replyToken,
        messages: [
          {
            type: "text",
            text: "รูปนี้ดูไม่เหมือนสลิปโอนเงินนะคะ กรุณาส่งรูปสลิปโอนเงินใหม่อีกครั้งค่ะ 📸",
          },
        ],
      });
      return; // ไม่บันทึก ไม่ล้าง session รอรูปใหม่
    }

    // อัปโหลดขึ้น Google Drive
    const fileName = `slip_${session.room}_${Date.now()}.jpg`;
    const imageUrl = await uploadImageToDrive(imageBuffer, fileName);

    // บันทึกลง Google Sheet
    await appendSlipRecord(session.room!, session.name!, imageUrl);

    // แจ้งลูกค้า
    await client.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text: `รับสลิปเรียบร้อยแล้วค่ะ ✅\nชื่อ: ${session.name}\nห้อง: ${session.room}\nขอบคุณนะคะ 😊`,
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
            text: `📥 มีการแจ้งโอนเงินใหม่\nชื่อ: ${session.name}\nห้อง: ${session.room}\nดูรูปสลิป: ${imageUrl}`,
          },
        ],
      });
    }

    clearSession(userId);
  } catch (err) {
    console.error("[webhook] image processing error:", err);
    await client.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text: "ขออภัยค่ะ เกิดข้อผิดพลาดในการบันทึกสลิป กรุณาลองใหม่อีกครั้งหรือติดต่อหอพักโดยตรงค่ะ 📞 080-499-9116",
        },
      ],
    });
  }
}