import { z } from "zod";

export const ALLIUM_ORIGIN = "https://agents.allium.so";
export const TEMPO_CHAIN_ID = 4217;
export const TEMPO_USDC = "0x20c000000000000000000000b9537d11c60e8b50";
export const BASE_CHAIN_ID = 8453;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const DEMO_WALLET = "0x28C6c06298d514Db089934071355E5743bf21d60";

export const walletTransactionsInput = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  chain: z.enum(["base", "ethereum"]),
  limit: z.number().int().min(1).max(100).default(50),
});

const tempoRequest = z.object({
  amount: z.string().regex(/^\d+$/),
  currency: z.string(),
  expires: z.string().datetime({ offset: true }),
  methodDetails: z.object({ chainId: z.number() }).passthrough(),
  recipient: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});

export type TempoQuote = {
  amountUsd: number;
  amountAtomic: string;
  chainId: number;
  currency: string;
  recipient: string;
};

const x402Option = z.object({
  scheme: z.literal("exact"),
  network: z.string(),
  amount: z.string().regex(/^\d+$/),
  asset: z.string(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.object({ name: z.string(), version: z.string() }).passthrough(),
});

const x402PaymentRequired = z.object({
  x402Version: z.literal(2),
  accepts: z.array(x402Option),
  resource: z.object({
    url: z.string().url(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
  }),
}).passthrough();

export type X402Quote = {
  amountUsd: number;
  amountAtomic: string;
  chainId: number;
  currency: string;
  recipient: string;
  paymentRequired: z.infer<typeof x402PaymentRequired>;
  accepted: z.infer<typeof x402Option>;
};

export function validateBaseX402Challenge(body: unknown, maximumAmountAtomic: number): X402Quote {
  const paymentRequired = x402PaymentRequired.parse(body);
  const accepted = paymentRequired.accepts.find((option) => option.network === `eip155:${BASE_CHAIN_ID}`);
  if (!accepted) throw new Error("Allium did not offer Base x402 payment.");
  const amount = Number(accepted.amount);
  if (
    !/^0x[a-fA-F0-9]{40}$/.test(accepted.asset) ||
    !/^0x[a-fA-F0-9]{40}$/.test(accepted.payTo) ||
    accepted.asset.toLowerCase() !== BASE_USDC.toLowerCase() ||
    !Number.isSafeInteger(amount) || amount <= 0 || amount > maximumAmountAtomic ||
    accepted.maxTimeoutSeconds <= Math.floor(Date.now() / 1000)
  ) throw new Error("Allium Base payment details did not match the approved policy.");
  return {
    amountUsd: amount / 1_000_000,
    amountAtomic: accepted.amount,
    chainId: BASE_CHAIN_ID,
    currency: accepted.asset,
    recipient: accepted.payTo,
    paymentRequired,
    accepted,
  };
}

export function validateTempoChallenge(
  header: string,
  maximumAmountAtomic = 30_000,
): TempoQuote {
  const method = /method="([^"]+)"/.exec(header)?.[1];
  const intent = /intent="([^"]+)"/.exec(header)?.[1];
  const encoded = /request="([^"]+)"/.exec(header)?.[1];

  if (method !== "tempo" || intent !== "charge" || !encoded) {
    throw new Error("Allium returned an unsupported payment challenge.");
  }

  const decoded = JSON.parse(
    Buffer.from(encoded, "base64url").toString("utf8"),
  );
  const request = tempoRequest.parse(decoded);
  const amount = Number(request.amount);
  const expiresAt = Date.parse(request.expires);
  const now = Date.now();

  if (
    request.methodDetails.chainId !== TEMPO_CHAIN_ID ||
    request.currency.toLowerCase() !== TEMPO_USDC ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    amount > maximumAmountAtomic ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + 10 * 60 * 1000
  ) {
    throw new Error("Allium payment details did not match the approved policy.");
  }

  return {
    amountUsd: amount / 1_000_000,
    amountAtomic: request.amount,
    chainId: request.methodDetails.chainId,
    currency: request.currency,
    recipient: request.recipient,
  };
}
