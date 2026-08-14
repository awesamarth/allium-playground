"use client";

import { getConnectorClient, signTypedData } from "wagmi/actions";
import { BASE_CHAIN_ID, type X402Quote } from "@/lib/allium";
import { wagmiAdapter } from "@/lib/wallet";

function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
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
