import { z } from "zod";

const text = z.string().trim().min(1).max(256);
const chain = z.string().trim().min(1).max(64).regex(/^[a-z0-9_-]+$/);
const isoTimestamp = z.string().datetime({ offset: true });
const optionalText = z.string().trim().max(512).optional();
const optionalNonnegativeNumber = z.number().min(0).max(1_000_000_000).optional();
const tokenSort = z.enum(["volume", "trade_count", "fully_diluted_valuation"]);
const tokenGranularity = z.enum(["1h", "1d"]);
const activityType = z.enum([
  "asset_approval",
  "nft_trade",
  "dex_trade",
  "asset_bridge",
  "dex_liquidity_pool_created",
  "dex_liquidity_pool_burn",
  "dex_liquidity_pool_mint",
]);
const pair = z.object({ chain, address: text }).strict();
const tokenPair = z.object({ chain, tokenAddress: text }).strict();
const granularity = z.enum(["15s", "1m", "5m", "1h", "1d"]);

export const alliumToolSchemas = {
  allium_token_prices: tokenPair.extend({ withLiquidityInfo: z.boolean().optional() }).strict(),
  allium_token_prices_at_timestamp: tokenPair.extend({
    timestamp: isoTimestamp,
    timeGranularity: granularity,
    stalenessTolerance: z.string().trim().max(32).regex(/^\d+(s|m|h|d)$/).optional(),
  }).strict(),
  allium_token_price_history: tokenPair.extend({
    startTimestamp: isoTimestamp,
    endTimestamp: isoTimestamp,
    timeGranularity: granularity,
    cursor: optionalText,
  }).strict(),
  allium_token_price_stats: tokenPair,
  allium_token_search: z.object({
    query: z.string().trim().min(1).max(100),
    chain: chain.optional(),
    sort: tokenSort,
    granularity: tokenGranularity,
    order: z.enum(["asc", "desc"]),
    limit: z.number().int().min(1).max(200),
    volumeUsd1dThreshold: optionalNonnegativeNumber,
    volumeUsd1hThreshold: optionalNonnegativeNumber,
  }).strict(),
  allium_token_by_address: tokenPair,
  allium_tokens_list: z.object({
    chain: chain.optional(),
    sort: tokenSort,
    granularity: tokenGranularity,
    order: z.enum(["asc", "desc"]),
    limit: z.number().int().min(1).max(200),
    volumeUsd1dThreshold: optionalNonnegativeNumber,
    volumeUsd1hThreshold: optionalNonnegativeNumber,
  }).strict(),
  allium_wallet_balances: pair.extend({ withLiquidityInfo: z.boolean().optional() }).strict(),
  allium_wallet_balance_history: pair.extend({
    startTimestamp: isoTimestamp,
    endTimestamp: isoTimestamp,
    limit: z.number().int().min(1).max(5_000),
    cursor: optionalText,
  }).strict(),
  allium_wallet_transactions: pair.extend({
    activityType: activityType.optional(),
    transactionHash: optionalText,
    limit: z.number().int().min(1).max(1_000),
    cursor: optionalText,
  }).strict(),
  allium_wallet_pnl: pair.extend({ minLiquidity: optionalNonnegativeNumber }).strict(),
} as const;

export type AlliumToolId = keyof typeof alliumToolSchemas;

export type ToolField = {
  key: string;
  label: string;
  type?: "text" | "number" | "datetime-local" | "select" | "boolean";
  placeholder?: string;
  optional?: boolean;
  options?: Array<{ label: string; value: string }>;
};

export type AlliumToolDefinition = {
  id: AlliumToolId;
  category: "Wallets" | "Prices" | "Tokens";
  title: string;
  description: string;
  method: "GET" | "POST";
  path: string;
  priceUsd: number;
  fields: ToolField[];
  defaults: Record<string, string>;
};

const chainField: ToolField = { key: "chain", label: "Data chain", placeholder: "ethereum" };
const walletField: ToolField = { key: "address", label: "Wallet address", placeholder: "0x… or a chain-native address" };
const tokenField: ToolField = { key: "tokenAddress", label: "Token address", placeholder: "Contract or chain-native token address" };
const granularityField: ToolField = {
  key: "timeGranularity", label: "Granularity", type: "select",
  options: ["15s", "1m", "5m", "1h", "1d"].map((value) => ({ label: value, value })),
};
const tokenSortField: ToolField = {
  key: "sort", label: "Sort by", type: "select",
  options: ["volume", "trade_count", "fully_diluted_valuation"].map((value) => ({ label: value.replaceAll("_", " "), value })),
};
const tokenGranularityField: ToolField = {
  key: "granularity", label: "Sort granularity", type: "select",
  options: ["1d", "1h"].map((value) => ({ label: value, value })),
};
const orderField: ToolField = { key: "order", label: "Order", type: "select", options: [{ label: "Descending", value: "desc" }, { label: "Ascending", value: "asc" }] };
const liquidityInfoField: ToolField = { key: "withLiquidityInfo", label: "Include liquidity information", type: "boolean" };
const volumeThresholdFields: ToolField[] = [
  { key: "volumeUsd1dThreshold", label: "Minimum 1d volume (USD)", type: "number", optional: true },
  { key: "volumeUsd1hThreshold", label: "Minimum 1h volume (USD)", type: "number", optional: true },
];
const limitField = (maximum: number, defaultValue: string): [ToolField, string] => [
  { key: "limit", label: `Result limit (max ${maximum})`, type: "number" }, defaultValue,
];
const now = new Date();
const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
const localDatetime = (date: Date) => date.toISOString().slice(0, 16);
const ethereumUsdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const binance14 = "0x28C6c06298d514Db089934071355E5743bf21d60";

const [tokenSearchLimit, tokenSearchDefault] = limitField(200, "20");
const [tokenListLimit, tokenListDefault] = limitField(200, "20");
const [balanceHistoryLimit, balanceHistoryDefault] = limitField(5_000, "100");
const [transactionLimit, transactionDefault] = limitField(1_000, "100");

export const alliumToolCatalogue: AlliumToolDefinition[] = [
  {
    id: "allium_wallet_balances", category: "Wallets", title: "Current balances",
    description: "Fetch current fungible token balances for a wallet.", method: "POST",
    path: "/api/v1/developer/wallet/balances", priceUsd: 0.01,
    fields: [chainField, walletField, liquidityInfoField], defaults: { chain: "ethereum", address: binance14, withLiquidityInfo: "false" },
  },
  {
    id: "allium_wallet_balance_history", category: "Wallets", title: "Balance history",
    description: "Inspect historical token balance snapshots over a time range.", method: "POST",
    path: "/api/v1/developer/wallet/balances/history", priceUsd: 0.01,
    fields: [chainField, walletField, { key: "startTimestamp", label: "Start", type: "datetime-local" }, { key: "endTimestamp", label: "End", type: "datetime-local" }, balanceHistoryLimit, { key: "cursor", label: "Cursor", optional: true }],
    defaults: { chain: "ethereum", address: binance14, startTimestamp: localDatetime(weekAgo), endTimestamp: localDatetime(now), limit: balanceHistoryDefault, cursor: "" },
  },
  {
    id: "allium_wallet_transactions", category: "Wallets", title: "Transactions",
    description: "Fetch decoded activity, transfers, swaps, labels, and transaction history.", method: "POST",
    path: "/api/v1/developer/wallet/transactions", priceUsd: 0.03,
    fields: [chainField, walletField, { key: "activityType", label: "Decoded activity filter", type: "select", optional: true, options: [
      { label: "All transactions and transfers", value: "" },
      ...["asset_approval", "nft_trade", "dex_trade", "asset_bridge", "dex_liquidity_pool_created", "dex_liquidity_pool_burn", "dex_liquidity_pool_mint"].map((value) => ({ label: value.replaceAll("_", " "), value })),
    ] }, { key: "transactionHash", label: "Transaction hash", optional: true }, transactionLimit, { key: "cursor", label: "Cursor", optional: true }],
    defaults: { chain: "ethereum", address: binance14, activityType: "", transactionHash: "", limit: transactionDefault, cursor: "" },
  },
  {
    id: "allium_wallet_pnl", category: "Wallets", title: "Wallet PnL",
    description: "Calculate current realized and unrealized wallet profit and loss.", method: "POST",
    path: "/api/v1/developer/wallet/pnl", priceUsd: 0.01,
    fields: [chainField, walletField, { key: "minLiquidity", label: "Minimum liquidity", type: "number", optional: true }],
    defaults: { chain: "ethereum", address: binance14, minLiquidity: "" },
  },
  {
    id: "allium_token_prices", category: "Prices", title: "Latest prices",
    description: "Get the latest minute-level token price and OHLC values.", method: "POST",
    path: "/api/v1/developer/prices", priceUsd: 0.02,
    fields: [chainField, tokenField, liquidityInfoField], defaults: { chain: "ethereum", tokenAddress: ethereumUsdc, withLiquidityInfo: "false" },
  },
  {
    id: "allium_token_prices_at_timestamp", category: "Prices", title: "Price at timestamp",
    description: "Get a token price at a specific point in time.", method: "POST",
    path: "/api/v1/developer/prices/at-timestamp", priceUsd: 0.02,
    fields: [chainField, tokenField, { key: "timestamp", label: "Timestamp", type: "datetime-local" }, granularityField, { key: "stalenessTolerance", label: "Maximum lookback", placeholder: "30m or 1h", optional: true }],
    defaults: { chain: "ethereum", tokenAddress: ethereumUsdc, timestamp: localDatetime(weekAgo), timeGranularity: "1h", stalenessTolerance: "" },
  },
  {
    id: "allium_token_price_history", category: "Prices", title: "Price history",
    description: "Fetch a historical token price series for charting and analysis.", method: "POST",
    path: "/api/v1/developer/prices/history", priceUsd: 0.02,
    fields: [chainField, tokenField, { key: "startTimestamp", label: "Start", type: "datetime-local" }, { key: "endTimestamp", label: "End", type: "datetime-local" }, granularityField, { key: "cursor", label: "Cursor", optional: true }],
    defaults: { chain: "ethereum", tokenAddress: ethereumUsdc, startTimestamp: localDatetime(weekAgo), endTimestamp: localDatetime(now), timeGranularity: "1d", cursor: "" },
  },
  {
    id: "allium_token_price_stats", category: "Prices", title: "Price stats",
    description: "Get the latest price plus 1-hour and 24-hour highs, lows, and percentage change.", method: "POST",
    path: "/api/v1/developer/prices/stats", priceUsd: 0.02,
    fields: [chainField, tokenField], defaults: { chain: "ethereum", tokenAddress: ethereumUsdc },
  },
  {
    id: "allium_token_search", category: "Tokens", title: "Search tokens",
    description: "Fuzzy-search token metadata by name or ticker symbol.", method: "GET",
    path: "/api/v1/developer/tokens/search", priceUsd: 0.03,
    fields: [{ key: "query", label: "Name or symbol", placeholder: "USDC" }, { ...chainField, optional: true }, tokenSortField, tokenGranularityField, orderField, tokenSearchLimit, ...volumeThresholdFields],
    defaults: { query: "USDC", chain: "", sort: "volume", granularity: "1d", order: "desc", limit: tokenSearchDefault, volumeUsd1dThreshold: "", volumeUsd1hThreshold: "" },
  },
  {
    id: "allium_token_by_address", category: "Tokens", title: "Token lookup",
    description: "Look up exact token metadata by chain and contract address.", method: "POST",
    path: "/api/v1/developer/tokens/chain-address", priceUsd: 0.02,
    fields: [chainField, tokenField], defaults: { chain: "ethereum", tokenAddress: ethereumUsdc },
  },
  {
    id: "allium_tokens_list", category: "Tokens", title: "Browse tokens",
    description: "List supported tokens ranked by volume, trades, valuation, or name.", method: "GET",
    path: "/api/v1/developer/tokens", priceUsd: 0.03,
    fields: [{ ...chainField, optional: true }, tokenSortField, tokenGranularityField, orderField, tokenListLimit, ...volumeThresholdFields],
    defaults: { chain: "ethereum", sort: "volume", granularity: "1d", order: "desc", limit: tokenListDefault, volumeUsd1dThreshold: "", volumeUsd1hThreshold: "" },
  },
];

export function parseToolInput(tool: AlliumToolId, raw: unknown) {
  return alliumToolSchemas[tool].parse(raw);
}

export function buildAlliumRequest(tool: AlliumToolId, input: Record<string, unknown>) {
  const definition = alliumToolCatalogue.find((item) => item.id === tool);
  if (!definition) throw new Error("Unsupported Allium tool.");
  const params = new URLSearchParams();
  let body: unknown;

  if (tool === "allium_token_search" || tool === "allium_tokens_list") {
    if (tool === "allium_token_search") params.set("q", String(input.query));
    if (input.chain) params.set("chain", String(input.chain));
    params.set("sort", String(input.sort)); params.set("granularity", String(input.granularity));
    params.set("order", String(input.order)); params.set("limit", String(input.limit));
    if (input.volumeUsd1dThreshold !== undefined) params.set("volume_usd_1d_threshold", String(input.volumeUsd1dThreshold));
    if (input.volumeUsd1hThreshold !== undefined) params.set("volume_usd_1h_threshold", String(input.volumeUsd1hThreshold));
  } else if (tool === "allium_token_prices" || tool === "allium_token_price_stats" || tool === "allium_token_by_address") {
    body = [{ chain: input.chain, token_address: input.tokenAddress }];
    if (tool === "allium_token_prices" && input.withLiquidityInfo !== undefined) params.set("with_liquidity_info", String(input.withLiquidityInfo));
  } else if (tool === "allium_token_prices_at_timestamp") {
    body = { addresses: [{ chain: input.chain, token_address: input.tokenAddress }], timestamp: input.timestamp, time_granularity: input.timeGranularity, ...(input.stalenessTolerance ? { staleness_tolerance: input.stalenessTolerance } : {}) };
  } else if (tool === "allium_token_price_history") {
    body = { addresses: [{ chain: input.chain, token_address: input.tokenAddress }], start_timestamp: input.startTimestamp, end_timestamp: input.endTimestamp, time_granularity: input.timeGranularity };
    if (input.cursor) params.set("cursor", String(input.cursor));
  } else if (tool === "allium_wallet_balances" || tool === "allium_wallet_pnl") {
    body = [{ chain: input.chain, address: input.address }];
    if (tool === "allium_wallet_balances" && input.withLiquidityInfo !== undefined) params.set("with_liquidity_info", String(input.withLiquidityInfo));
    if (tool === "allium_wallet_pnl" && input.minLiquidity !== undefined) params.set("min_liquidity", String(input.minLiquidity));
  } else if (tool === "allium_wallet_balance_history") {
    body = { addresses: [{ chain: input.chain, address: input.address }], start_timestamp: input.startTimestamp, end_timestamp: input.endTimestamp };
    params.set("limit", String(input.limit)); if (input.cursor) params.set("cursor", String(input.cursor));
  } else if (tool === "allium_wallet_transactions") {
    body = [{ chain: input.chain, address: input.address }];
    params.set("limit", String(input.limit));
    if (input.activityType) params.set("activity_type", String(input.activityType));
    if (input.transactionHash) params.set("transaction_hash", String(input.transactionHash));
    if (input.cursor) params.set("cursor", String(input.cursor));
  }

  return { ...definition, query: params.toString(), body };
}
