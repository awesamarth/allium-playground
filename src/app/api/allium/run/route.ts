import { NextResponse } from "next/server";
import { z } from "zod";
import {
  ALLIUM_ORIGIN,
  validateBaseX402Challenge,
  validateTempoChallenge,
} from "@/lib/allium";
import {
  alliumToolCatalogue,
  alliumToolSchemas,
  buildAlliumRequest,
  type AlliumToolId,
} from "@/lib/allium-tools";
import { requireSameOrigin } from "@/server/codex-session-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const envelopeSchema = z.object({
  tool: z.string(),
  input: z.unknown(),
}).strict();

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Request rejected." },
      { status: 403 },
    );
  }

  const envelope = envelopeSchema.safeParse(await request.json());
  if (!envelope.success || !(envelope.data.tool in alliumToolSchemas)) {
    return NextResponse.json({ error: "Unsupported Allium tool." }, { status: 400 });
  }

  const tool = envelope.data.tool as AlliumToolId;
  const input = alliumToolSchemas[tool].safeParse(envelope.data.input);
  if (!input.success) {
    return NextResponse.json(
      { error: "Invalid tool arguments.", issues: input.error.issues },
      { status: 400 },
    );
  }

  const authorization = request.headers.get("authorization");
  const paymentSignature = request.headers.get("payment-signature");
  if (authorization && !authorization.startsWith("Payment ")) {
    return NextResponse.json({ error: "Unsupported authorization scheme." }, { status: 400 });
  }

  const requestDefinition = buildAlliumRequest(tool, input.data as Record<string, unknown>);
  const url = `${ALLIUM_ORIGIN}${requestDefinition.path}${requestDefinition.query ? `?${requestDefinition.query}` : ""}`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: requestDefinition.method,
      headers: {
        ...(requestDefinition.method === "POST" ? { "content-type": "application/json" } : {}),
        ...(authorization ? { authorization } : {}),
        ...(paymentSignature ? { "payment-signature": paymentSignature } : {}),
      },
      ...(requestDefinition.method === "POST" ? { body: JSON.stringify(requestDefinition.body) } : {}),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Allium request failed." },
      { status: 502 },
    );
  }

  if (upstream.status === 402) {
    const challenge = upstream.headers.get("www-authenticate");
    const paymentRequiredHeader = upstream.headers.get("payment-required");
    const definition = alliumToolCatalogue.find((item) => item.id === tool)!;
    const maximumAmountAtomic = Math.round(definition.priceUsd * 1_000_000);

    try {
      if (request.headers.get("x-allium-payment-rail") === "base") {
        const paymentRequiredBody = JSON.parse(await upstream.clone().text());
        const quote = validateBaseX402Challenge(paymentRequiredBody, maximumAmountAtomic);
        return NextResponse.json(
          { error: "Payment required", protocol: "x402", tool, quote },
          {
            status: 402,
            headers: {
              "cache-control": "no-store",
              ...(paymentRequiredHeader ? { "payment-required": paymentRequiredHeader } : {}),
            },
          },
        );
      }
      if (!challenge) throw new Error("Allium omitted its payment challenge.");
      const quote = validateTempoChallenge(challenge, maximumAmountAtomic);
      return NextResponse.json(
        { error: "Payment required", protocol: "mpp", method: "tempo", intent: "charge", tool, quote },
        {
          status: 402,
          headers: {
            "cache-control": "no-store",
            "www-authenticate": challenge,
          },
        },
      );
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Invalid payment challenge." },
        { status: 502 },
      );
    }
  }

  const body = await upstream.text();
  const upstreamContentType = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok && !upstreamContentType.includes("application/json")) {
    return NextResponse.json(
      {
        error:
          upstream.status >= 500
            ? `Allium returned an internal error (${upstream.status}). The payment result is uncertain; do not retry until the receipt is checked.`
            : `Allium rejected the request (${upstream.status}).`,
      },
      { status: upstream.status },
    );
  }

  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": upstreamContentType || "application/json",
  });
  const receipt = upstream.headers.get("payment-receipt");
  const paymentResponse = upstream.headers.get("payment-response") ?? upstream.headers.get("x-payment-response");
  if (receipt) headers.set("payment-receipt", receipt);
  if (paymentResponse) headers.set("payment-response", paymentResponse);
  return new Response(body, { status: upstream.status, headers });
}
