import { NextResponse } from "next/server";
import {
  ALLIUM_ORIGIN,
  validateTempoChallenge,
  walletTransactionsInput,
} from "@/lib/allium";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENDPOINT = "/api/v1/developer/wallet/transactions";

export async function POST(request: Request) {
  const parsed = walletTransactionsInput.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid wallet transaction request." },
      { status: 400 },
    );
  }

  const authorization = request.headers.get("authorization");
  if (authorization && !authorization.startsWith("Payment ")) {
    return NextResponse.json(
      { error: "Unsupported authorization scheme." },
      { status: 400 },
    );
  }

  const upstream = await fetch(
    `${ALLIUM_ORIGIN}${ENDPOINT}?limit=${parsed.data.limit}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify([
        { address: parsed.data.address, chain: parsed.data.chain },
      ]),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (upstream.status === 402) {
    const challenge = upstream.headers.get("www-authenticate");
    if (!challenge) {
      return NextResponse.json(
        { error: "Allium omitted its payment challenge." },
        { status: 502 },
      );
    }

    try {
      const quote = validateTempoChallenge(challenge);
      return NextResponse.json(
        {
          error: "Payment required",
          protocol: "mpp",
          method: "tempo",
          intent: "charge",
          quote,
        },
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
        {
          error:
            error instanceof Error
              ? error.message
              : "Invalid payment challenge.",
        },
        { status: 502 },
      );
    }
  }

  const body = await upstream.text();
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  });
  const receipt = upstream.headers.get("payment-receipt");
  if (receipt) headers.set("payment-receipt", receipt);

  return new Response(body, { status: upstream.status, headers });
}
