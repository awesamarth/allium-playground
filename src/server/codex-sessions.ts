import { CodexAppServer } from "@/server/codex-app-server";

const SESSION_TTL_MS = 30 * 60 * 1000;

type SessionStore = Map<string, CodexAppServer>;

const globalSessions = globalThis as typeof globalThis & {
  __alliumCodexSessions?: SessionStore;
  __alliumCodexCleanupTimer?: ReturnType<typeof setInterval>;
};

export const codexSessions =
  globalSessions.__alliumCodexSessions ?? new Map<string, CodexAppServer>();

globalSessions.__alliumCodexSessions = codexSessions;

if (!globalSessions.__alliumCodexCleanupTimer) {
  const timer = setInterval(() => void removeExpiredCodexSessions(), 60_000);
  timer.unref();
  globalSessions.__alliumCodexCleanupTimer = timer;
}

export async function createCodexSession() {
  const session = new CodexAppServer();
  codexSessions.set(session.id, session);
  try {
    await session.start();
    return session;
  } catch (error) {
    codexSessions.delete(session.id);
    await session.close();
    throw error;
  }
}

export function getCodexSession(id: string) {
  const session = codexSessions.get(id);
  if (session) session.touch();
  return session;
}

export async function deleteCodexSession(id: string) {
  const session = codexSessions.get(id);
  codexSessions.delete(id);
  await session?.close();
}

export async function removeExpiredCodexSessions() {
  const now = Date.now();
  const expired = [...codexSessions.values()].filter(
    (session) => now - session.lastUsedAt > SESSION_TTL_MS,
  );
  await Promise.all(expired.map((session) => deleteCodexSession(session.id)));
}
