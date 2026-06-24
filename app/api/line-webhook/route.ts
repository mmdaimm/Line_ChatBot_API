import { NextRequest, NextResponse } from "next/server";
import * as line from "@line/bot-sdk";
import { getFaqCsv } from "@/lib/sheet";
import { appendSlipRecord } from "@/lib/google";
import { uploadImageToR2 } from "@/lib/r2";
import { askGemini, verifySlipImage, extractNameAndRoom } from "@/lib/gemini";
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

for (const event of events) {
  if (event.type !== "message") continue;

  const userId = event.source.userId;
  const replyToken = event.replyToken;

  // ===== กรณีลูกค้าส่งรูป =====
  if (event.message.type === "image") {
    await handleImageMessage(
      userId,
      event.message.id,
      replyToken
    );
    continue;
  }

  // ===== กรณีลูกค้าส่งข้อความ =====
  if (event.message.type !== "text") continue;

  const userMessage = event.message.text;
  
  // ===== ดักคำสั่งลับขอ userId =====
  if (userMessage.trim() === "#myid") {
    try {
      await client.replyMessage({
        replyToken,
        messages: [
          {
            type: "text",
            text: `รหัสประจำตัว LINE ของคุณคือ:\n\n${userId}\n\n(กดค้างที่ข้อความนี้เพื่อคัดลอกส่งให้แอดมินหอพักได้เลยค่ะ 😊)`,
          },
        ],
      });
    } catch (err) {
      console.error("[webhook] reply #myid error:", err);
    }
    continue;
  }

  const session = getSession(userId);

  if (session) {
    await handleSlipFlow(
      userId,
      userMessage,
      replyToken
    );
    continue;
  }

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
}

  return NextResponse.json({ ok: true });
}

// จัดการขั้นตอนรับชื่อ+ห้องพร้อมกัน
async function handleSlipFlow(
  userId: string,
  message: string,
  replyToken: string
) {
  const session = getSession(userId)!;

  if (session.step !== "waiting_info") return;

  const extracted = await extractNameAndRoom(message);

  if (!extracted) {
    await client.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text: "ขออภัยค่ะ ไม่สามารถอ่านชื่อและเลขห้องได้ กรุณาพิมพ์ใหม่ เช่น \"สมชาย ใจดี ห้อง 15\" ค่ะ",
        },
      ],
    });
    return;
  }

  const { name, room } = extracted;

  try {
    const viewUrl = `${process.env.APP_URL}/api/slip?key=` + encodeURIComponent(session.imageUrl!);

    await appendSlipRecord(room, name, viewUrl);

    await client.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text: `รับสลิปเรียบร้อยแล้วค่ะ ✅\nชื่อ: ${name}\nห้อง: ${room}\nขอบคุณนะคะ 😊`,
        },
      ],
    });

    if (process.env.LINE_OWNER_GROUP_ID) {

      await client.pushMessage({
        to: process.env.LINE_OWNER_GROUP_ID,
        messages: [
          {
            type: "text",
            text: `📥 มีการแจ้งโอนเงินใหม่\nชื่อ: ${name}\nห้อง: ${room}\nดูรูปสลิป: ${viewUrl}`,
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

    startSlipFlow(userId);

    // ให้ AI ตรวจสอบก่อนว่าเป็นรูปสลิปจริงไหม
    const isSlip = await verifySlipImage(imageBuffer);

    if (!isSlip) {
      // ถ้าลูกค้าส่งรูปอื่นมาเฉยๆ (ไม่ใช่สลิป) ไม่ต้องตอบอะไร ปล่อยผ่าน
      // เพื่อไม่ให้รบกวนตอนลูกค้าส่งรูปอื่นที่ไม่เกี่ยวกับสลิป
      clearSession(userId);
      return;
    }

    // const imageUrl = await uploadImageToDrive(imageBuffer, fileName);
    const imageUrl = await uploadImageToR2(imageBuffer);

    // เริ่ม session ใหม่ พร้อมเก็บ imageUrl แล้วถามชื่อ+ห้องพร้อมกัน
    updateSession(userId, { imageUrl, step: "waiting_info" });

    await client.replyMessage({
      replyToken,
      messages: [
        {
          type: "text",
          text: "รับรูปสลิปเรียบร้อยค่ะ ✅ กรุณาแจ้งชื่อ-นามสกุล พร้อมหมายเลขห้องด้วยนะคะ เช่น \"สมชาย ใจดี ห้อง 15\"",
        },
      ],
    });
  } catch (err) {
    console.error("[webhook] image processing error:", err);
  }
}