type SlipSession = {
  step: "waiting_image" | "waiting_name" | "waiting_room";
  name?: string;
  room?: string;
  imageUrl?: string;
};

const sessions = new Map<string, SlipSession>();

export function startSlipFlow(userId: string) {
  sessions.set(userId, { step: "waiting_image" });
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