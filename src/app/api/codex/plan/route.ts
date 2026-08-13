import { NextResponse } from "next/server";
import { z } from "zod";
import { getCodexSession } from "@/server/codex-sessions";
import {
  readCodexSessionCookie,
  requireSameOrigin,
} from "@/server/codex-session-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inputSchema = z.object({
  query: z.string().trim().min(3).max(2_000),
});

const prices = {
  allium_wallet_transactions: 0.03,
} as const;

const walletArgumentsSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chain: z.enum(["base", "ethereum"]),
  limit: z.number().int().min(1).max(100),
}).strict();

const modelPlanSchema = z.object({
  interpretation: z.string(),
  calls: z.array(
    z.object({
      tool: z.enum(Object.keys(prices) as [keyof typeof prices, ...(keyof typeof prices)[]]),
      arguments: walletArgumentsSchema,
      reason: z.string().min(1),
      unitCostUsd: z.number(),
      maxCalls: z.literal(1),
    }),
  ).max(1),
  assumptions: z.array(z.string()),
  unsupportedParts: z.array(z.string()),
});

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Request rejected." },
      { status: 403 },
    );
  }

  const input = inputSchema.safeParse(await request.json());
  if (!input.success) {
    return NextResponse.json({ error: "Invalid planning request." }, { status: 400 });
  }

  const sessionId = await readCodexSessionCookie();
  const session = sessionId ? getCodexSession(sessionId) : undefined;
  if (!session) {
    return NextResponse.json({ error: "Codex session expired." }, { status: 401 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (event: unknown) => {
        if (open) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      void (async () => {
        try {
          const modelPlan = modelPlanSchema.parse(
            await session.plan(input.data.query, (delta) => send({ type: "delta", delta })),
          );
          const calls = modelPlan.calls.map((call) => ({
            ...call,
            unitCostUsd: prices[call.tool],
          }));
          const maximumDataCostUsd = calls.reduce(
            (total, call) => total + call.unitCostUsd * call.maxCalls,
            0,
          );
          send({
            type: "result",
            plan: {
              ...modelPlan,
              calls,
              maximumDataCostUsd: Number(maximumDataCostUsd.toFixed(2)),
            },
          });
        } catch (error) {
          send({
            type: "error",
            error: error instanceof Error ? error.message : "Planning failed.",
          });
        } finally {
          if (open) controller.close();
          open = false;
        }
      })();
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
