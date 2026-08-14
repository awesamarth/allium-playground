import { NextResponse } from "next/server";
import { z } from "zod";
import { alliumToolSchemas, type AlliumToolId } from "@/lib/allium-tools";
import { readCodexSessionCookie, requireSameOrigin } from "@/server/codex-session-cookie";
import { getCodexSession } from "@/server/codex-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const evidenceSchema = z.object({
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  data: z.unknown(),
}).strict();
const requestSchema = z.object({
  query: z.string().trim().min(3).max(2_000),
  evidence: z.array(evidenceSchema).min(1).max(5),
}).strict();

function bounded(value: unknown, depth = 0): unknown {
  if (depth > 7) return "[nested data omitted]";
  if (typeof value === "string") return value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => bounded(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, item]) => [key, bounded(item, depth + 1)]),
    );
  }
  return value;
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Request rejected." }, { status: 403 });
  }

  const text = await request.text();
  if (text.length > 2_000_000) return NextResponse.json({ error: "Evidence payload is too large." }, { status: 413 });
  let json: unknown;
  try { json = JSON.parse(text); } catch { return NextResponse.json({ error: "Invalid analysis request." }, { status: 400 }); }
  const input = requestSchema.safeParse(json);
  if (!input.success) return NextResponse.json({ error: "Invalid analysis request." }, { status: 400 });

  const evidence = input.data.evidence.map((item) => {
    if (!(item.tool in alliumToolSchemas)) throw new Error("Unsupported evidence tool.");
    const tool = item.tool as AlliumToolId;
    const arguments_ = alliumToolSchemas[tool].parse(item.arguments);
    return { tool, arguments: arguments_, data: bounded(item.data) };
  });

  const sessionId = await readCodexSessionCookie();
  const session = sessionId ? getCodexSession(sessionId) : undefined;
  if (!session) return NextResponse.json({ error: "Codex session expired." }, { status: 401 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (event: unknown) => {
        if (open) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      void session.answer(input.data.query, evidence, (delta) => send({ type: "delta", delta }))
        .then((answer) => send({ type: "result", answer }))
        .catch((error) => send({ type: "error", error: error instanceof Error ? error.message : "Analysis failed." }))
        .finally(() => { if (open) controller.close(); open = false; });
    },
  });
  return new Response(stream, {
    headers: {
      "cache-control": "no-store, no-transform",
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
