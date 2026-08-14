import type { EChartsCoreOption } from "echarts/core";
import type { AlliumToolId } from "@/lib/allium-tools";

const PALETTE = ["#d66acc", "#7755a6", "#e18c63", "#3c8f8b", "#d3a136", "#a67591", "#5572a6", "#9f5967"];
const TEXT = "#332d32";
const MUTED = "#766f75";
const GRID = "#e7e2e5";

type JsonRecord = Record<string, unknown>;
export type ResultTable = { columns: Array<{ key: string; label: string }>; rows: JsonRecord[]; total: number };
export type Visualization = {
  title: string;
  description: string;
  option: EChartsCoreOption | null;
  table: ResultTable;
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function itemsOf(payload: unknown) {
  const root = record(payload);
  return Array.isArray(root?.items) ? root.items.map(record).filter(Boolean) as JsonRecord[] : [];
}

function nested(item: JsonRecord, ...path: string[]): unknown {
  let value: unknown = item;
  for (const key of path) value = record(value)?.[key];
  return value;
}

function numberAt(item: JsonRecord, paths: string[][]) {
  for (const path of paths) {
    const value = nested(item, ...path);
    const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function stringAt(item: JsonRecord, paths: string[][], fallback = "—") {
  for (const path of paths) {
    const value = nested(item, ...path);
    if (typeof value === "string" && value) return value;
  }
  return fallback;
}

function short(value: string) {
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-6)}` : value;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { notation: Math.abs(value) >= 1_000_000 ? "compact" : "standard", maximumFractionDigits: 2 }).format(value);
}

const axis = {
  axisLine: { lineStyle: { color: GRID } },
  axisTick: { show: false },
  axisLabel: { color: MUTED, fontSize: 10, fontFamily: "monospace" },
  splitLine: { lineStyle: { color: GRID, type: "dashed" as const } },
};

function baseOption(): EChartsCoreOption {
  return {
    animationDuration: 500,
    color: PALETTE,
    textStyle: { color: TEXT, fontFamily: "var(--font-manrope), sans-serif" },
    tooltip: { trigger: "axis", backgroundColor: "#161015", borderWidth: 0, textStyle: { color: "#fff", fontSize: 11 } },
    grid: { left: 14, right: 20, top: 24, bottom: 38, containLabel: true },
  };
}

const CANONICAL_ASSETS = new Set([
  "ethereum:0x0000000000000000000000000000000000000000",
  "ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7",
  "ethereum:0x6b175474e89094c44da98b954eedeac495271d0f",
  "ethereum:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
  "base:0x0000000000000000000000000000000000000000",
  "base:0x4200000000000000000000000000000000000006",
  "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "solana:so11111111111111111111111111111111111111112",
  "solana:epjfwdd5aufqssqem2qn1xzzybapc8g4wegkzwytdt1v",
]);

function holdings(items: JsonRecord[]): Visualization {
  const rows = items.map((item) => {
    const decimals = numberAt(item, [["token", "decimals"]]);
    const raw = numberAt(item, [["raw_balance_str"], ["raw_balance"]]);
    const balance = Number.isFinite(raw) && Number.isFinite(decimals) ? raw / (10 ** decimals) : Number.NaN;
    const price = numberAt(item, [["token", "price"], ["price"]]);
    const value = Number.isFinite(balance) && Number.isFinite(price) ? balance * price : Number.NaN;
    const chain = stringAt(item, [["token", "chain"], ["chain"]], "").toLowerCase();
    const tokenAddress = stringAt(item, [["token", "address"]], "").toLowerCase();
    return {
      symbol: stringAt(item, [["token", "info", "symbol"], ["token", "info", "name"], ["token", "address"]]),
      balance,
      price,
      value,
      canonical: CANONICAL_ASSETS.has(`${chain}:${tokenAddress}`),
      updated: stringAt(item, [["block_timestamp"]]),
    };
  }).sort((a, b) => (Number.isFinite(b.value) ? b.value : -1) - (Number.isFinite(a.value) ? a.value : -1));
  // Wallets receive spam tokens with manipulated symbols and prices. Keep every
  // row in the table, but chart only canonical contracts we can identify safely.
  const chartRows = rows.filter((row) => row.canonical && Number.isFinite(row.value) && row.value > 0).slice(0, 10);
  const total = chartRows.reduce((sum, row) => sum + row.value, 0);
  return {
    title: "Portfolio allocation",
    description: chartRows.length ? `Recognized canonical holdings total $${formatNumber(total)} across the displayed assets. Unverified and spam-token valuations are excluded from the chart.` : "No recognized canonical assets with positive priced balances were available to chart.",
    option: chartRows.length ? {
      ...baseOption(),
      tooltip: { trigger: "item", formatter: (params: { name: string; value: number; percent: number }) => `${params.name}<br/><b>$${formatNumber(params.value)}</b> · ${params.percent}%` },
      legend: { type: "scroll", orient: "vertical", right: 10, top: "middle", textStyle: { color: MUTED, fontSize: 10 }, icon: "circle" },
      series: [{ type: "pie", radius: ["48%", "74%"], center: ["36%", "50%"], itemStyle: { borderColor: "#fbfaf8", borderWidth: 2 }, label: { show: false }, data: chartRows.map((row) => ({ name: row.symbol, value: row.value })) }],
    } : null,
    table: { columns: [{ key: "symbol", label: "Asset" }, { key: "balance", label: "Balance" }, { key: "price", label: "Price (USD)" }, { key: "value", label: "Value (USD)" }, { key: "updated", label: "Updated" }], rows, total: rows.length },
  };
}

function balanceHistory(items: JsonRecord[]): Visualization {
  const rows = items.map((item) => {
    const decimals = numberAt(item, [["token", "decimals"]]);
    const raw = numberAt(item, [["raw_balance_str"], ["raw_balance"]]);
    const balance = Number.isFinite(raw) && Number.isFinite(decimals) ? raw / (10 ** decimals) : Number.NaN;
    return {
      timestamp: stringAt(item, [["block_timestamp"]]),
      symbol: stringAt(item, [["token", "info", "symbol"], ["token", "info", "name"], ["token", "address"]]),
      balance,
      transaction: stringAt(item, [["txn_id"], ["transaction_hash"]]),
    };
  }).filter((row) => Number.isFinite(row.balance));
  const latestBySymbol = new Map<string, number>();
  for (const row of rows) latestBySymbol.set(row.symbol, row.balance);
  const seriesNames = [...latestBySymbol.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name]) => name);
  return {
    title: "Balance movement",
    description: rows.length ? `Historical balance observations for the ${seriesNames.length} largest returned assets.` : "No balance observations were available to chart.",
    option: rows.length ? {
      ...baseOption(),
      legend: { type: "scroll", data: seriesNames, top: 0, textStyle: { color: MUTED, fontSize: 10 } },
      xAxis: { ...axis, type: "time" },
      yAxis: { ...axis, type: "value", scale: true },
      dataZoom: rows.length > 80 ? [{ type: "inside" }, { type: "slider", height: 14, bottom: 4 }] : [],
      series: seriesNames.map((name, index) => ({ name, type: "line", smooth: .16, showSymbol: false, lineStyle: { width: 2, color: PALETTE[index % PALETTE.length] }, data: rows.filter((row) => row.symbol === name && row.timestamp !== "—").map((row) => [row.timestamp, row.balance]) })),
    } : null,
    table: { columns: [{ key: "timestamp", label: "Timestamp" }, { key: "symbol", label: "Asset" }, { key: "balance", label: "Balance" }, { key: "transaction", label: "Transaction" }], rows, total: rows.length },
  };
}

function priceSeries(items: JsonRecord[]): Visualization {
  const rows = items.map((item) => ({
    timestamp: stringAt(item, [["timestamp"], ["block_timestamp"], ["interval_start"], ["time"]]),
    symbol: stringAt(item, [["token", "info", "symbol"], ["symbol"], ["token_address"]], "Token"),
    price: numberAt(item, [["price"], ["close"], ["price_usd"]]),
    open: numberAt(item, [["open"]]),
    high: numberAt(item, [["high"]]),
    low: numberAt(item, [["low"]]),
    volume: numberAt(item, [["volume"], ["volume_usd"]]),
  })).filter((row) => Number.isFinite(row.price));
  const seriesNames = [...new Set(rows.map((row) => row.symbol))];
  return {
    title: "Price movement",
    description: rows.length ? `${rows.length} price observations across ${seriesNames.length} asset${seriesNames.length === 1 ? "" : "s"}.` : "No price observations were available to chart.",
    option: rows.length ? {
      ...baseOption(),
      legend: { data: seriesNames, top: 0, textStyle: { color: MUTED, fontSize: 10 } },
      xAxis: { ...axis, type: "time", boundaryGap: false },
      yAxis: { ...axis, type: "value", scale: true, axisLabel: { ...axis.axisLabel, formatter: (value: number) => `$${formatNumber(value)}` } },
      dataZoom: rows.length > 80 ? [{ type: "inside" }, { type: "slider", height: 14, bottom: 4 }] : [],
      series: seriesNames.map((name, index) => ({ name, type: "line", smooth: .18, showSymbol: rows.length < 35, symbolSize: 5, lineStyle: { width: 2, color: PALETTE[index % PALETTE.length] }, areaStyle: index === 0 ? { color: "rgba(214,106,204,.12)" } : undefined, data: rows.filter((row) => row.symbol === name && row.timestamp !== "—").map((row) => [row.timestamp, row.price]) })),
    } : null,
    table: { columns: [{ key: "timestamp", label: "Timestamp" }, { key: "symbol", label: "Asset" }, { key: "price", label: "Price" }, { key: "open", label: "Open" }, { key: "high", label: "High" }, { key: "low", label: "Low" }, { key: "volume", label: "Volume" }], rows, total: rows.length },
  };
}

function transactionActivity(items: JsonRecord[]): Visualization {
  const counts = new Map<string, number>();
  const rows = items.map((item) => {
    const timestamp = stringAt(item, [["block_timestamp"]]);
    const day = timestamp === "—" ? "Unknown" : new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    counts.set(day, (counts.get(day) ?? 0) + 1);
    const activities = Array.isArray(item.activities) ? item.activities : [];
    const transfers = Array.isArray(item.asset_transfers) ? item.asset_transfers : [];
    return { timestamp, hash: stringAt(item, [["hash"]]), from: stringAt(item, [["from_address"]]), to: stringAt(item, [["to_address"]]), activities: activities.length, transfers: transfers.length };
  });
  const points = [...counts.entries()];
  return {
    title: "Transaction activity",
    description: `${items.length} transactions grouped by day.`,
    option: points.length ? { ...baseOption(), xAxis: { ...axis, type: "category", data: points.map(([day]) => day) }, yAxis: { ...axis, type: "value", minInterval: 1 }, series: [{ type: "bar", name: "Transactions", barMaxWidth: 30, itemStyle: { color: PALETTE[0], borderRadius: [3, 3, 0, 0] }, data: points.map(([, count]) => count) }] } : null,
    table: { columns: [{ key: "timestamp", label: "Timestamp" }, { key: "hash", label: "Transaction" }, { key: "from", label: "From" }, { key: "to", label: "To" }, { key: "activities", label: "Activities" }, { key: "transfers", label: "Transfers" }], rows, total: rows.length },
  };
}

function generic(items: JsonRecord[], title: string): Visualization {
  const flattened = items.map((item) => {
    const row: JsonRecord = {};
    for (const [key, value] of Object.entries(item)) {
      if (["string", "number", "boolean"].includes(typeof value) || value === null) row[key] = value;
      else if (key === "token") row.token = stringAt(item, [["token", "info", "symbol"], ["token", "info", "name"], ["token", "address"]]);
    }
    return row;
  });
  const keys = [...new Set(flattened.flatMap((row) => Object.keys(row)))].slice(0, 8);
  const numericKey = keys.find((key) => flattened.some((row) => typeof row[key] === "number"));
  const labelKey = keys.find((key) => flattened.some((row) => typeof row[key] === "string"));
  const chartRows = numericKey && labelKey ? flattened.filter((row) => typeof row[numericKey] === "number").slice(0, 20) : [];
  return {
    title,
    description: `${items.length} result${items.length === 1 ? "" : "s"} returned by Allium.`,
    option: chartRows.length ? { ...baseOption(), xAxis: { ...axis, type: "category", data: chartRows.map((row) => short(String(row[labelKey!]))) }, yAxis: { ...axis, type: "value" }, series: [{ type: "bar", data: chartRows.map((row) => row[numericKey!] as number), itemStyle: { color: PALETTE[0] } }] } : null,
    table: { columns: keys.map((key) => ({ key, label: key.replaceAll("_", " ") })), rows: flattened, total: flattened.length },
  };
}

export function buildVisualization(tool: AlliumToolId, payload: unknown): Visualization {
  const items = itemsOf(payload);
  if (tool === "allium_wallet_balances") return holdings(items);
  if (tool === "allium_wallet_balance_history") return balanceHistory(items);
  if (["allium_token_prices", "allium_token_prices_at_timestamp", "allium_token_price_history", "allium_token_price_stats"].includes(tool)) return priceSeries(items);
  if (tool === "allium_wallet_transactions") return transactionActivity(items);
  if (tool === "allium_wallet_pnl") return generic(items, "Profit and loss");
  return generic(items, "Token results");
}

export function formatCell(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? formatNumber(value) : "—";
  if (typeof value === "string") return value.startsWith("0x") ? short(value) : value;
  if (value === null || value === undefined) return "—";
  return JSON.stringify(value);
}
