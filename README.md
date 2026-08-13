# Allium Playground

A browser-native interface for asking onchain data questions, reviewing the exact execution plan and maximum cost, approving payment from a connected wallet, and receiving an answer with data and payment provenance.

## Product surfaces

- **Ask with Codex:** turn a natural-language question into a structured, host-verified execution plan and cost quote.
- **Direct API catalogue:** configure and run any of Allium's 11 machine-payable Realtime endpoints without connecting Codex.
- **Payment provenance:** inspect validated pricing, formatted responses, and decoded settlement receipts.

The main page uses Base mainnet x402 for browser payments. The isolated `/tempo-test` route preserves the Tempo MPP integration for interoperability testing. `View fixture result` is clearly labelled and never initiates payment.

## Stack

- Next.js 16, React 19, TypeScript, Tailwind CSS
- Reown AppKit, wagmi, and viem for wallet connectivity
- Base x402 EIP-3009 signatures and `mppx` for Tempo MPP credentials
- Codex app-server over local stdio with an isolated `CODEX_HOME` per session
- Zod validation at trust boundaries

## Run locally

Requirements: Bun and the Codex CLI available on `PATH`.

```bash
bun install
bun run dev
```

Open [http://localhost:3000](http://localhost:3000).

The checked-in Reown project ID can be overridden:

```bash
NEXT_PUBLIC_REOWN_PROJECT_ID=... bun run dev
```

## Validation

```bash
bun test
bun run lint
bun run build
```

The Allium proxy accepts only allowlisted endpoints and validated per-tool arguments. It validates payment chain, official USDC contract, recipient, and endpoint-specific maximum cost before requesting a wallet signature. Codex auth state lives in an ephemeral per-session directory; explicit disconnect and TTL cleanup remove the isolated credentials.

## Architecture notes

Allium data calls go through `https://agents.allium.so`; the official account/API-key MCP is intentionally not used for paid execution. Base x402 is the current browser payment rail. Tempo MPP remains available at `/tempo-test` while a push-mode upstream interoperability failure is investigated.

Codex app-server requires a persistent Node/Bun host capable of spawning local processes. It will not run inside a conventional serverless function without a dedicated worker/container architecture.
