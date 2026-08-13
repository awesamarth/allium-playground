import { NextResponse } from "next/server";
import {
  createCodexSession,
  deleteCodexSession,
  getCodexSession,
  removeExpiredCodexSessions,
} from "@/server/codex-sessions";
import {
  clearCodexSessionCookie,
  readCodexSessionCookie,
  requireSameOrigin,
  setCodexSessionCookie,
} from "@/server/codex-session-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await removeExpiredCodexSessions();

    const previousId = await readCodexSessionCookie();
    if (previousId) await deleteCodexSession(previousId);

    const session = await createCodexSession();
    await setCodexSessionCookie(session.id);
    return NextResponse.json(session.status);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not start Codex.",
      },
      { status: 503 },
    );
  }
}

export async function GET() {
  const id = await readCodexSessionCookie();
  const session = id ? getCodexSession(id) : undefined;
  if (!session) {
    await clearCodexSessionCookie();
    return NextResponse.json({ error: "Codex session not found." }, { status: 404 });
  }
  return NextResponse.json(session.status);
}

export async function DELETE(request: Request) {
  try {
    requireSameOrigin(request);
    const id = await readCodexSessionCookie();
    if (id) await deleteCodexSession(id);
    await clearCodexSessionCookie();
    return new Response(null, { status: 204 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not disconnect Codex." },
      { status: 403 },
    );
  }
}
