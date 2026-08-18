"use client";

import { formatUnits } from "viem";
import { getConnectorClient, readContract, signTypedData } from "wagmi/actions";
import { BASE_CHAIN_ID, BASE_USDC, type X402Quote } from "@/lib/allium";
import { wagmiAdapter } from "@/lib/wallet";

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
}

const balanceOfAbi = [{
  type: "function",
  name: "balanceOf",
  stateMutability: "view",
  inputs: [{ name: "account", type: "address" }],
  outputs: [{ name: "balance", type: "uint256" }],
}] as const;

function usd(value: bigint) {
  return Number(formatUnits(value, 6)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

export async function requireSufficientBaseUsdc(required: bigint) {
  const client = await getConnectorClient(wagmiAdapter.wagmiConfig, { chainId: BASE_CHAIN_ID });
  let balance: bigint;
  try {
    balance = await readContract(wagmiAdapter.wagmiConfig, {
      chainId: BASE_CHAIN_ID,
      address: BASE_USDC,
      abi: balanceOfAbi,
      functionName: "balanceOf",
      args: [client.account.address],
    });
  } catch {
    throw new Error("Could not check this wallet’s Base USDC balance. Try again before approving payment.");
  }
  if (balance < required) {
    throw new Error(`Not enough USDC on Base. This plan requires $${usd(required)} USDC, but this wallet has $${usd(balance)}. Add USDC on Base or connect another wallet. Nothing was signed or charged.`);
  }
}

/** Sign one exact Base USDC EIP-3009 authorization from a validated x402 quote. */
export async function createBaseX402Credential(quote: X402Quote) {
  const connectorClient = await getConnectorClient(wagmiAdapter.wagmiConfig, { chainId: BASE_CHAIN_ID });
  const accepted = quote.accepted;
  const authorization = {
    from: connectorClient.account.address,
    to: accepted.payTo as `0x${string}`,
    value: accepted.amount,
    validAfter: "0",
    validBefore: String(accepted.maxTimeoutSeconds),
    nonce: randomNonce(),
  };
  const signature = await signTypedData(wagmiAdapter.wagmiConfig, {
    account: connectorClient.account.address,
    domain: {
      name: accepted.extra.name,
      version: accepted.extra.version,
      chainId: BASE_CHAIN_ID,
      verifyingContract: accepted.asset as `0x${string}`,
    },
    primaryType: "TransferWithAuthorization",
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    message: {
      ...authorization,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
    },
  });

  return btoa(JSON.stringify({
    x402Version: quote.paymentRequired.x402Version,
    resource: quote.paymentRequired.resource,
    accepted,
    payload: { signature, authorization },
  }));
}
