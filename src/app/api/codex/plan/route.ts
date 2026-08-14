import { NextResponse } from "next/server";
import { z } from "zod";
import { getCodexSession } from "@/server/codex-sessions";
import {
  readCodexSessionCookie,
  requireSameOrigin,
} from "@/server/codex-session-cookie";
import { alliumToolCatalogue, alliumToolSchemas, type AlliumToolId } from "@/lib/allium-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const inputSchema = z.object({
  query: z.string().trim().min(3).max(2_000),
});

const toolIds = alliumToolCatalogue.map((tool) => tool.id) as [AlliumToolId, ...AlliumToolId[]];
const prices = Object.fromEntries(alliumToolCatalogue.map((tool) => [tool.id, tool.priceUsd])) as Record<AlliumToolId, number>;

const modelPlanSchema = z.object({
  interpretation: z.string(),
  calls: z.array(
    z.object({
      tool: z.enum(toolIds),
      arguments: z.record(z.string(), z.unknown()),
      reason: z.string().min(1),
      unitCostUsd: z.number(),
      maxCalls: z.literal(1),
    }),
  ).max(5),
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
  if (session.plannerVersion !== 2) {
    return NextResponse.json(
      { error: "The connected Codex session uses an older tool schema. Disconnect and reconnect Codex once, then retry." },
      { status: 409 },
    );
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
          const calls = modelPlan.calls.map((call) => {
            const suppliedArguments = Object.fromEntries(
              Object.entries(call.arguments).filter(([, value]) => value !== null && value !== ""),
            );
            const parsedArguments = alliumToolSchemas[call.tool].safeParse(suppliedArguments);
            if (!parsedArguments.success) {
              const details = parsedArguments.error.issues
                .slice(0, 3)
                .map((issue) => `${issue.path.join(".") || "arguments"}: ${issue.message}`)
                .join("; ");
              throw new Error(`Codex produced invalid arguments for ${call.tool}: ${details}`);
            }
            return {
              ...call,
              arguments: parsedArguments.data,
              unitCostUsd: prices[call.tool],
            };
          });
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
