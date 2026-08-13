import { describe, expect, test } from "bun:test";
import { TEMPO_USDC, validateTempoChallenge } from "./allium";

function challenge(overrides: Record<string, unknown> = {}) {
  const request = Buffer.from(
    JSON.stringify({
      amount: "30000",
      currency: TEMPO_USDC,
      expires: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      methodDetails: { chainId: 4217 },
      recipient: "0x15be81fe078368e63a6970692127c9b6e15b1ca8",
      ...overrides,
    }),
  ).toString("base64url");
  return `Payment id="test", method="tempo", intent="charge", request="${request}"`;
}

describe("Tempo challenge policy", () => {
  test("accepts the expected Allium charge", () => {
    expect(validateTempoChallenge(challenge())).toMatchObject({
      amountUsd: 0.03,
      amountAtomic: "30000",
      chainId: 4217,
      currency: TEMPO_USDC,
    });
  });

  test.each<[Record<string, unknown>, string]>([
    [{ amount: "30001" }, "over budget"],
    [{ methodDetails: { chainId: 1 } }, "wrong network"],
    [{ currency: "0x0000000000000000000000000000000000000000" }, "wrong asset"],
    [{ expires: new Date(Date.now() - 1_000).toISOString() }, "expired"],
  ])("rejects a %s challenge (%s)", (override) => {
    expect(() => validateTempoChallenge(challenge(override))).toThrow(
      "did not match the approved policy",
    );
  });
});
