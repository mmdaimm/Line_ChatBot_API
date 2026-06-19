import { google } from "googleapis";

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.file",
    ],
  });
}

// อัปโหลดรูปไป Google Drive แล้วคืนค่าเป็นลิงก์
export async function uploadImageToDrive(
  imageBuffer: Buffer,
  fileName: string
): Promise<string> {
  const auth = getAuth();
  const drive = google.drive({ version: "v3", auth });

  const { Readable } = await import("stream");
  const stream = new Readable();
  stream.push(imageBuffer);
  stream.push(null);

  const file = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: process.env.GOOGLE_DRIVE_FOLDER_ID
        ? [process.env.GOOGLE_DRIVE_FOLDER_ID]
        : undefined,
    },
    media: {
      mimeType: "image/jpeg",
      body: stream,
    },
    fields: "id",
  });

  const fileId = file.data.id!;

  // ทำให้ลิงก์เปิดดูได้สาธารณะ
  await drive.permissions.create({
    fileId,
    requestBody: {
      role: "reader",
      type: "anyone",
    },
  });

  return `https://drive.google.com/uc?id=${fileId}`;
}

// บันทึกข้อมูลสลิปลง Google Sheet
export async function appendSlipRecord(
  room: string,
  name: string,
  imageUrl: string
): Promise<void> {
  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

  const timestamp = new Date().toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok",
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SLIP_SHEET_ID!,
    range: "Sheet1!A:D",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[timestamp, room, name, imageUrl]],
    },
  });
}