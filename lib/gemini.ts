import { GoogleGenAI } from "@google/genai";

const DEFAULT_REPLY =
  "ขออภัยค่ะในส่วนนี้ กรุณาติดต่อกับทางหอพักโดยตรงได้เลยนะคะ 😊 📞 080-499-9116";

const SYSTEM_PROMPT = `<role>
คุณคือแอดมินของหอพักดำรงรักษ์ หอพักขนาดเล็กที่มีห้องพักทั้งหมด 13 ห้อง
หน้าที่ของคุณคือตอบคำถามลูกค้าและผู้สนใจเช่าห้องพักอย่างสุภาพและเป็นกันเอง
</role>

<constraints>
- ตอบโดยใช้ข้อมูลใน <faq> เป็นหลัก
- ถ้ามีข้อมูลใน FAQ ให้ใช้ข้อมูลนั้นตอบเสมอ
- ถ้าไม่มีข้อมูลใน FAQ แต่เป็นคำถามทั่วไปเกี่ยวกับหอพัก เช่น การทักทาย ขอบคุณ หรือคำถามทั่วไป ให้ตอบได้ตามธรรมชาติ
- ถ้าเป็นคำถามเฉพาะเจาะจง เช่น ราคา วันเวลา กฎระเบียบ ที่ไม่มีใน FAQ ให้ตอบว่า "ขออภัยค่ะในส่วนนี้ กรุณาติดต่อกับทางหอพักโดยตรงได้เลยนะคะ 😊 📞 080-499-9116"
- ถ้าเป็นคำถามถามค่าห้องแล้วเลข 3 ตัวท้ายไม่เหมือนใน FAQ เช่น "คำถาม ค่าห้อง 14 001 แต่ใน FAQ คำถามเป็น ค่าห้อง 14 101" ให้ตอบว่า "ขออภัยค่ะเลข 3 ตัวท้ายบัตรประชาชนไม่ตรงกับหมายเลขบัตรเจ้าของห้อง"
- ห้ามแต่งราคาหรือข้อมูลที่ไม่มีใน FAQ โดยเด็ดขาด
- โทนภาษา: สุภาพ เป็นกันเอง ใช้ emoji ได้เหมาะสม ลงท้ายด้วย "ค่ะ"
- ความยาวคำตอบ 1-3 ประโยค ไม่ยาวเกินไป
</constraints>

<output_format>
- ภาษาไทยเท่านั้น
- ห้ามใช้ markdown เช่น ** หรือ ## หรือ bullet point
- ห้ามขึ้นหัวข้อ ตอบเป็นประโยคปกติเท่านั้น
</output_format>

<faq>
{CSV_CONTENT}
</faq>

<question>
{USER_MESSAGE}
</question>`;

export async function askGemini(
  csvContent: string,
  userMessage: string
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

  const prompt = SYSTEM_PROMPT.replace("{CSV_CONTENT}", csvContent).replace(
    "{USER_MESSAGE}",
    userMessage
  );

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        temperature: 1.0,
        maxOutputTokens: 1024,
      },
    });

    // Log สำหรับ debug
    const finishReason = response.candidates?.[0]?.finishReason;
    const thoughtsTokens = response.usageMetadata?.thoughtsTokenCount ?? 0;
    const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
    console.log(
      `[gemini] finishReason=${finishReason} thoughts=${thoughtsTokens} output=${outputTokens}`
    );

    // ถ้าถูกตัดกลางทาง ส่ง default แทน
    if (finishReason === "MAX_TOKENS") {
      console.warn("[gemini] MAX_TOKENS reached → using default reply");
      return DEFAULT_REPLY;
    }

    return response.text ?? DEFAULT_REPLY;
  } catch (err) {
    console.error("[gemini] error:", err);
    return DEFAULT_REPLY;
  }
}

// ตรวจสอบว่ารูปเป็นสลิปโอนเงินไหม
export async function verifySlipImage(
  imageBuffer: Buffer
): Promise<boolean> {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

  const base64Image = imageBuffer.toString("base64");

  const prompt = `ดูรูปนี้แล้วตอบแค่คำเดียวว่า "YES" หรือ "NO"
ตอบ YES ถ้ารูปนี้เป็นสลิปโอนเงิน ใบเสร็จการโอนเงิน หรือหน้าจอแอปธนาคารที่แสดงการทำธุรกรรมโอนเงิน
ตอบ NO ถ้าไม่ใช่ เช่น เป็นรูปคน รูปสัตว์ รูปอาหาร รูปสถานที่ หรือภาพอื่นๆ ที่ไม่เกี่ยวกับการโอนเงิน
ตอบแค่ YES หรือ NO เท่านั้น ห้ามตอบอย่างอื่น`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: "image/jpeg",
                data: base64Image,
              },
            },
          ],
        },
      ],
      config: {
        temperature: 1.0,
        maxOutputTokens: 1024,
      },
    });

    const finishReason = response.candidates?.[0]?.finishReason;
    console.log(`[gemini-vision] finishReason=${finishReason}`);

    const answer = response.text?.trim().toUpperCase() ?? "";
    console.log(`[gemini-vision] answer=${answer}`);

    return answer.includes("YES");
  } catch (err) {
    console.error("[gemini-vision] error:", err);
    // ถ้า AI ตรวจสอบไม่ได้ ให้ผ่านไปก่อน (ป้องกันบล็อกลูกค้าจริง)
    return true;
  }
}