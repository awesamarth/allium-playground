import { describe, expect, test } from "bun:test";
import { buildVisualization } from "./allium-visualization";

describe("Allium result visualizations", () => {
  test("charts canonical holdings but excludes manipulated spam-token valuations", () => {
    const visualization = buildVisualization("allium_wallet_balances", {
      items: [
        {
          chain: "ethereum",
          raw_balance_str: "100000000",
          block_timestamp: "2026-08-13T00:00:00Z",
          token: {
            chain: "ethereum",
            address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            decimals: 6,
            price: 1,
            info: { symbol: "USDC" },
          },
        },
        {
          chain: "ethereum",
          raw_balance_str: "1000000000000000000000000",
          token: {
            chain: "ethereum",
            address: "0x1111111111111111111111111111111111111111",
            decimals: 18,
            price: 999_999_999,
            info: { symbol: "FREE MONEY" },
          },
        },
      ],
    });

    const chartData = (visualization.option as { series: Array<{ data: Array<{ name: string; value: number }> }> }).series[0].data;
    expect(chartData).toEqual([{ name: "USDC", value: 100 }]);
    expect(visualization.table.total).toBe(2);
  });

  test("builds a time series for historical prices", () => {
    const visualization = buildVisualization("allium_token_price_history", {
      items: [
        { timestamp: "2026-08-12T00:00:00Z", price: 1, symbol: "USDC" },
        { timestamp: "2026-08-13T00:00:00Z", price: 1.001, symbol: "USDC" },
      ],
    });

    expect(visualization.option).not.toBeNull();
    expect(visualization.table.total).toBe(2);
  });
});
