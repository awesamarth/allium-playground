type AssetTransfer = {
  transaction_hash?: string;
  from_address?: string | null;
  to_address?: string | null;
  asset?: { symbol?: string; name?: string };
  amount?: { amount?: number; amount_str?: string };
};

type WalletTransaction = {
  hash?: string;
  block_timestamp?: string;
  asset_transfers?: AssetTransfer[];
};

export type TransferRow = {
  hash: string;
  timestamp: string;
  to: string;
  amount: number;
  symbol: string;
};

const STABLECOINS = new Set(["USDC", "USDT", "DAI", "USDS", "PYUSD"]);

export function outgoingStablecoinTransfers(
  payload: { items?: WalletTransaction[] },
  wallet: string,
): TransferRow[] {
  const address = wallet.toLowerCase();

  return (payload.items ?? [])
    .flatMap((transaction) =>
      (transaction.asset_transfers ?? []).map((transfer) => ({
        hash: transfer.transaction_hash ?? transaction.hash ?? "",
        timestamp: transaction.block_timestamp ?? "",
        to: transfer.to_address ?? "",
        amount: Number(
          transfer.amount?.amount ?? transfer.amount?.amount_str ?? 0,
        ),
        symbol: transfer.asset?.symbol ?? transfer.asset?.name ?? "Token",
        from: transfer.from_address?.toLowerCase(),
      })),
    )
    .filter(
      (transfer) =>
        transfer.from === address &&
        STABLECOINS.has(transfer.symbol.toUpperCase()) &&
        transfer.amount > 0 &&
        Number.isFinite(transfer.amount),
    )
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
    .map((transfer) => ({
      hash: transfer.hash,
      timestamp: transfer.timestamp,
      to: transfer.to,
      amount: transfer.amount,
      symbol: transfer.symbol,
    }));
}
