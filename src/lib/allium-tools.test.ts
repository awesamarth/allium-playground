import { describe, expect, test } from "bun:test";
import { alliumToolSchemas, buildAlliumRequest } from "./allium-tools";

const baseInput = {
  chain: "ethereum",
  address: "0x28C6c06298d514Db089934071355E5743bf21d60",
  limit: 1000,
};

describe("wallet transaction arguments", () => {
  test("rejects ordinary transfers as a decoded activity filter before payment", () => {
    expect(alliumToolSchemas.allium_wallet_transactions.safeParse({ ...baseInput, activityType: "transfer" }).success).toBe(false);
    expect(alliumToolSchemas.allium_wallet_transactions.safeParse({ ...baseInput, lookbackDays: 30 }).success).toBe(false);
  });

  test("omits activity_type for transfer questions and maps supported filters exactly", () => {
    expect(buildAlliumRequest("allium_wallet_transactions", baseInput).query).toBe("limit=1000");
    expect(buildAlliumRequest("allium_wallet_transactions", { ...baseInput, activityType: "dex_trade" }).query).toBe("limit=1000&activity_type=dex_trade");
  });
});
