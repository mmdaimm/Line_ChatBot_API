import { NextRequest, NextResponse } from "next/server";
import * as line from "@line/bot-sdk";
import { getFaqCsv } from "@/lib/sheet";
import { askGemini } from "@/lib/gemini";

const DEFAULT_REPLY =
  "ขออภัยค่ะในส่วนนี้ กรุณาติดต่อกับทางหอพักโดยตรงได้เลยนะคะ 😊 📞 080-499-9116";

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
});

// const client = new line.messagingApi.MessagingApiClient(config);

export async function POST(req: NextRequest) {
  console.log("[webhook] request received");
  const body = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";

  // 1. ตรวจสอบว่า request มาจาก LINE จริง
  const isValid = line.validateSignature(
    body,
    process.env.LINE_CHANNEL_SECRET!,
    signature
  );
  if (!isValid) {
    console.warn("[webhook] invalid signature");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // const events: line.WebhookEvent[] = JSON.parse(body).events;
  const events = JSON.parse(body).events;

  // 2. วนลูปทุก event
  await Promise.all(
    events.map(async (event: any) => {
      // กรองเฉพาะข้อความ text เท่านั้น
      if (event.type !== "message" || event.message.type !== "text") return;
      console.log("[debug] source:", JSON.stringify(event.source));
      const userMessage = event.message.text;
      const replyToken = event.replyToken;

      let replyText = DEFAULT_REPLY;

      try {
        // 3. ดึง FAQ จาก Google Sheet
        const csv = await getFaqCsv();

        // 4. ถาม Gemini
        replyText = await askGemini(csv, userMessage);
      } catch (err) {
        console.error("[webhook] processing error:", err);
        replyText = DEFAULT_REPLY;
      }

      // 5. ส่งคำตอบกลับ LINE
      try {
        await client.replyMessage({
          replyToken,
          messages: [{ type: "text", text: replyText }],
        });
      } catch (err) {
        // log แต่ไม่ throw เพราะต้อง return 200 เสมอ
        console.error("[webhook] reply error:", err);
      }
    })
  );

  // LINE ต้องการ 200 เสมอ ไม่งั้นจะส่งซ้ำ
  return NextResponse.json({ ok: true });
}