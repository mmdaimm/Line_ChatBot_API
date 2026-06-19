type SlipSession = {
  step: "waiting_name" | "waiting_room" | "waiting_image";
  name?: string;
  room?: string;
};

// เก็บ session ไว้ใน memory โดยใช้ LINE userId เป็น key
const sessions = new Map<string, SlipSession>();

export function startSlipFlow(userId: string) {
  sessions.set(userId, { step: "waiting_name" });
}

export function getSession(userId: string): SlipSession | undefined {
  return sessions.get(userId);
}

export function updateSession(userId: string, data: Partial<SlipSession>) {
  const current = sessions.get(userId);
  if (current) {
    sessions.set(userId, { ...current, ...data });
  }
}

export function clearSession(userId: string) {
  sessions.delete(userId);
}