// เก็บ cache ไว้ในหน่วยความจำ
let cachedFaq: string = "";
let cacheTime: number = 0;
const CACHE_DURATION = 60 * 1000; // 60 วินาที

export async function getFaqCsv(): Promise<string> {
  const now = Date.now();

  // ถ้า cache ยังไม่หมดอายุ ใช้ของเก่าได้เลย
  if (cachedFaq && now - cacheTime < CACHE_DURATION) {
    return cachedFaq;
  }

  try {
    const url = process.env.SHEET_CSV_URL!;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("Sheet fetch failed");

    const csv = await res.text();
    cachedFaq = csv;
    cacheTime = now;
    return csv;
  } catch (err) {
    console.error("[sheet] fetch error:", err);
    // ถ้าดึงไม่ได้แต่มี cache เก่าอยู่ ใช้ cache เก่าแทน
    if (cachedFaq) return cachedFaq;
    // ถ้าไม่มีเลย return ค่าว่าง
    return "";
  }
}