"use client";

import { useAppKit } from "@reown/appkit/react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  LoaderCircle,
  Send,
  Wallet,
} from "lucide-react";
import { Mppx, tempo as tempoPayment } from "mppx/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { getConnectorClient } from "wagmi/actions";
import { DEMO_WALLET, TEMPO_CHAIN_ID } from "@/lib/allium";
import { fixtureTransfers } from "@/lib/fixture";
import { outgoingStablecoinTransfers, type TransferRow } from "@/lib/normalize";
import { wagmiAdapter } from "@/lib/wallet";
import { ApiCatalogue } from "@/components/api-catalogue";

const DEFAULT_QUERY =
  "Show the five largest recent outgoing stablecoin transfers from Binance 14.";

type Stage = "compose" | "plan" | "paying" | "result" | "error";

type Quote = {
  amountUsd: number;
  amountAtomic: string;
  chainId: number;
  currency: string;
  recipient: string;
};

type Receipt = {
  reference?: string;
  status?: string;
  settlement?: { network?: string; transaction?: string };
};

type CodexStatus =
  | { state: "disconnected" }
  | { state: "starting" }
  | { state: "awaiting_login"; login: { verificationUrl: string; userCode: string } }
  | { state: "connected"; planType?: string | null }
  | { state: "error"; message: string };

type WalletTransactionsArguments = {
  address: string;
  chain: "base" | "ethereum";
  limit: number;
};

type CodexPlan = {
  interpretation: string;
  calls: Array<{
    tool: "allium_wallet_transactions";
    arguments: WalletTransactionsArguments;
    reason: string;
    unitCostUsd: number;
    maxCalls: 1;
  }>;
  assumptions: string[];
  unsupportedParts: string[];
  maximumDataCostUsd: number;
};

function shorten(value: string, left = 6, right = 4) {
  if (value.length <= left + right + 1) return value;
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

function extractPartialJsonString(source: string, key: string) {
  const marker = `"${key}"`;
  const keyIndex = source.indexOf(marker);
  if (keyIndex < 0) return "";
  const colon = source.indexOf(":", keyIndex + marker.length);
  if (colon < 0) return "";
  const quote = source.indexOf('"', colon + 1);
  if (quote < 0) return "";

  let value = "";
  for (let index = quote + 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') break;
    if (character !== "\\") {
      value += character;
      continue;
    }

    const escaped = source[index + 1];
    if (!escaped) break;
    const escapes: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    if (escaped === "u") {
      const code = source.slice(index + 2, index + 6);
      if (code.length < 4) break;
      value += String.fromCharCode(Number.parseInt(code, 16));
      index += 5;
    } else {
      value += escapes[escaped] ?? escaped;
      index += 1;
    }
  }
  return value;
}

function decodeReceipt(value: string | null): Receipt | null {
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(normalized));
  } catch {
    return null;
  }
}

export function Playground({ paymentRail = "base" }: { paymentRail?: "tempo" | "base" }) {
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [stage, setStage] = useState<Stage>("compose");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [rows, setRows] = useState<TransferRow[]>([]);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState("");
  const [codexStatus, setCodexStatus] = useState<CodexStatus>({ state: "disconnected" });
  const [showCodex, setShowCodex] = useState(false);
  const [codexRequired, setCodexRequired] = useState(false);
  const [codexPlan, setCodexPlan] = useState<CodexPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [streamedInterpretation, setStreamedInterpretation] = useState("");
  const [fixtureMode, setFixtureMode] = useState(false);
  const challengeResponse = useRef<Response | null>(null);
  const { open } = useAppKit();
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();

  const refreshCodex = useCallback(async () => {
    const response = await fetch("/api/codex/session", { cache: "no-store" });
    if (response.status === 404) {
      setCodexStatus({ state: "disconnected" });
      return;
    }
    const body = await response.json();
    setCodexStatus(body);
  }, []);

  useEffect(() => {
    void refreshCodex();
  }, [refreshCodex]);

  useEffect(() => {
    if (codexStatus.state !== "awaiting_login") return;
    const timer = window.setInterval(() => void refreshCodex(), 2_000);
    return () => window.clearInterval(timer);
  }, [codexStatus.state, refreshCodex]);

  const total = useMemo(
    () => rows.reduce((sum, transfer) => sum + transfer.amount, 0),
    [rows],
  );

  async function connectCodex() {
    setShowCodex(true);
    if (codexStatus.state === "awaiting_login" || codexStatus.state === "connected") return;
    setCodexStatus({ state: "starting" });
    try {
      const response = await fetch("/api/codex/session", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not start Codex.");
      setCodexStatus(body);
    } catch (caught) {
      setCodexStatus({ state: "error", message: caught instanceof Error ? caught.message : "Could not start Codex." });
    }
  }

  async function disconnectCodex() {
    await fetch("/api/codex/session", { method: "DELETE" });
    setCodexStatus({ state: "disconnected" });
    setShowCodex(false);
  }

  async function createPlan() {
    if (!query.trim()) return;
    if (codexStatus.state !== "connected") {
      setCodexRequired(true);
      setShowCodex(true);
      return;
    }
    setError("");
    setCodexPlan(null);
    setQuote(null);
    setStreamedInterpretation("");
    setPlanning(true);
    setStage("plan");

    try {
      const planResponse = await fetch("/api/codex/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!planResponse.ok || !planResponse.body) {
        const body = await planResponse.json();
        throw new Error(body.error ?? "Codex could not create a plan.");
      }

      const reader = planResponse.body.getReader();
      const decoder = new TextDecoder();
      let lineBuffer = "";
      let modelOutput = "";
      let planBody: CodexPlan | null = null;

      while (true) {
        const { done, value } = await reader.read();
        lineBuffer += decoder.decode(value, { stream: !done });
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line) as
            | { type: "delta"; delta: string }
            | { type: "result"; plan: CodexPlan }
            | { type: "error"; error: string };
          if (event.type === "delta") {
            modelOutput += event.delta;
            const interpretation = extractPartialJsonString(modelOutput, "interpretation");
            if (interpretation) setStreamedInterpretation(interpretation);
          } else if (event.type === "result") {
            planBody = event.plan;
          } else {
            throw new Error(event.error);
          }
        }
        if (done) break;
      }

      if (!planBody) throw new Error("Codex returned no execution plan.");
      if (planBody.calls.length !== 1 || planBody.calls[0].tool !== "allium_wallet_transactions") {
        throw new Error(
          planBody.unsupportedParts?.[0] ??
            "Include an EVM wallet address and choose Ethereum or Base.",
        );
      }
      setCodexPlan(planBody);
      setPlanning(false);

      const response = await fetch("/api/allium/wallet-transactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(planBody.calls[0].arguments),
      });
      const body = await response.clone().json();
      if (response.status !== 402 || !body.quote) {
        throw new Error(body.error ?? "Could not obtain an Allium quote.");
      }
      challengeResponse.current = response;
      setQuote(body.quote);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create plan.");
      setStage("error");
    } finally {
      setPlanning(false);
    }
  }

  async function approveAndRun() {
    if (!isConnected) {
      await open({ view: "Connect" });
      return;
    }

    setStage("paying");
    setError("");

    try {
      const approvedArguments = codexPlan?.calls[0]?.arguments;
      if (!approvedArguments) {
        throw new Error("The approved execution plan is missing. Create a new plan.");
      }

      if (chainId !== TEMPO_CHAIN_ID) {
        await switchChainAsync({ chainId: TEMPO_CHAIN_ID });
      }

      let paymentRequired = challengeResponse.current;
      if (!paymentRequired) {
        paymentRequired = await fetch("/api/allium/wallet-transactions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(approvedArguments),
        });
      }
      if (paymentRequired.status !== 402) {
        throw new Error("The Allium quote expired. Please create a new plan.");
      }

      const mppx = Mppx.create({
        polyfill: false,
        methods: [
          tempoPayment.charge({
            expectedChainId: TEMPO_CHAIN_ID,
            mode: "push",
            clientId: "allium-playground",
            getClient: ({ chainId: requestedChainId }) =>
              getConnectorClient(wagmiAdapter.wagmiConfig, {
                chainId: requestedChainId ?? TEMPO_CHAIN_ID,
              }),
          }),
        ],
      });
      const credential = await mppx.createCredential(paymentRequired);
      const paidResponse = await fetch("/api/allium/wallet-transactions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: credential,
        },
        body: JSON.stringify(approvedArguments),
      });
      const payload = await paidResponse.json();
      if (!paidResponse.ok) {
        throw new Error(payload.error ?? "Allium could not complete the request.");
      }

      setRows(outgoingStablecoinTransfers(payload, approvedArguments.address));
      setReceipt(decodeReceipt(paidResponse.headers.get("payment-receipt")));
      setStage("result");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Payment failed.";
      setError(
        message.toLowerCase().includes("rejected")
          ? "Payment approval was declined. Nothing was charged."
          : message,
      );
      setStage("error");
    }
  }

  function reset() {
    setStage("compose");
    setQuote(null);
    setRows([]);
    setReceipt(null);
    setCodexPlan(null);
    setPlanning(false);
    setStreamedInterpretation("");
    setFixtureMode(false);
    setError("");
    challengeResponse.current = null;
  }

  function showFixture() {
    setQuote({ amountUsd: 0.03, amountAtomic: "30000", chainId: TEMPO_CHAIN_ID, currency: "USDC", recipient: "Fixture" });
    setRows(fixtureTransfers);
    setReceipt({ reference: "fixture-receipt", status: "simulated" });
    setFixtureMode(true);
    setStage("result");
  }

  return (
    <div className="site-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Allium Playground home">
          <span className="allium-mark" aria-hidden="true">
            <span />
            <span />
          </span>
          <span>Allium</span>
          <span className="brand-divider" />
          <span className="brand-product">Playground</span>
        </a>
        <div className="header-actions">
          <a href="https://docs.allium.so/ai/machine-payments/overview" target="_blank">
            How payments work
          </a>
          <button className="codex-button" onClick={() => { setCodexRequired(false); void connectCodex(); }}>
            {codexStatus.state === "connected" ? <Check size={14} /> : null}
            {codexStatus.state === "connected" ? "Codex connected" : "Connect Codex"}
          </button>
          <button className="wallet-button" onClick={() => open({ view: "Connect" })}>
            <Wallet size={15} strokeWidth={1.8} />
            {isConnected && address ? shorten(address) : "Connect wallet"}
          </button>
        </div>
      </header>

      <main>
        <section className="intro">
          <p className="eyebrow">ALLIUM DATA, ON DEMAND</p>
          <h1>Ask the chain.<br />See every step.</h1>
          <p className="intro-copy">
            Turn a plain-English question into verified onchain data. Review the
            calls, approve the exact cost, and pay from your own wallet.
          </p>
        </section>

        <section className="workspace" aria-live="polite">
          <div className="workspace-title">
            <span>New analysis</span>
            {stage === "compose" ? (
              <button onClick={showFixture}>View fixture result</button>
            ) : (
              <button onClick={reset}>Start over</button>
            )}
          </div>

          <div className="composer">
            <textarea
              aria-label="Ask an onchain data question"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  void createPlan();
                }
              }}
              rows={3}
            />
            <div className="composer-footer">
              <span className="chain-select" aria-label="Supported data chains">
                Ethereum + Base
              </span>
              <button
                className="submit-query"
                onClick={createPlan}
                disabled={!query.trim() || stage === "paying" || planning}
                aria-label="Create execution plan"
              >
                <Send size={17} />
              </button>
            </div>
          </div>

          {stage === "compose" && (
            <div className="suggestions">
              <span>Try asking</span>
              <button onClick={() => setQuery(DEFAULT_QUERY)}>Largest transfers</button>
              <button onClick={() => setQuery("Summarize Binance 14's recent outgoing stablecoin transfers.")}>
                Recent activity
              </button>
            </div>
          )}

          {(stage === "plan" || stage === "paying" || stage === "error") && (
            <div className="plan-panel">
              <div className="section-heading">
                <p>Execution plan</p>
                <span>
                  {planning
                    ? "Codex planning"
                    : codexPlan && quote
                      ? "Host verified"
                      : stage === "error"
                        ? "Needs attention"
                        : "Verifying quote"}
                </span>
              </div>
              <div className="interpretation">
                <span>Interpretation</span>
                <p className="streaming-copy" aria-live="polite">
                  {planning ? (
                    streamedInterpretation ? (
                      <>{streamedInterpretation}<i className="stream-cursor" /></>
                    ) : (
                      <span className="thinking-copy">Thinking<span>…</span></span>
                    )
                  ) : (
                    codexPlan?.interpretation ?? streamedInterpretation
                  )}
                </p>
              </div>
              {codexPlan && (
                <>
                  <div className="plan-call">
                    <div className="call-number">1</div>
                    <div>
                      <strong>Fetch wallet transactions</strong>
                      <p>{codexPlan.calls[0]?.reason}</p>
                      <code>
                        {codexPlan.calls[0].arguments.chain} · {shorten(codexPlan.calls[0].arguments.address, 10, 8)} · limit {codexPlan.calls[0].arguments.limit}
                      </code>
                    </div>
                    <strong className="call-price">$0.03</strong>
                  </div>
                  <div className="quote-total">
                    <div>
                      <span>Maximum Allium data cost</span>
                      <small>One payment on Tempo mainnet · USDC</small>
                    </div>
                    <strong>{quote ? `$${quote.amountUsd.toFixed(2)}` : "$0.03"}</strong>
                  </div>
                  <div className="approval-row">
                    <p>
                      No payment is made until your wallet approves this exact call.
                    </p>
                    <button onClick={approveAndRun} disabled={stage === "paying" || !quote}>
                      {stage === "paying" ? (
                        <><LoaderCircle className="spin" size={16} /> Awaiting wallet</>
                      ) : isConnected ? (
                        <>Approve and run <ArrowUpRight size={15} /></>
                      ) : (
                        <>Connect wallet <ArrowUpRight size={15} /></>
                      )}
                    </button>
                  </div>
                </>
              )}
              {stage === "error" && <p className="error-message">{error}</p>}
            </div>
          )}

          {stage === "result" && (
            <div className="results">
              {fixtureMode && <div className="fixture-notice">Fixture mode — saved Allium response, no payment made</div>}
              <div className="result-lead">
                <p>Analysis</p>
                <h2>Largest recent outgoing transfers</h2>
                <p>
                  Allium returned {rows.length} outgoing transfers in the queried
                  window{rows.length ? `, totaling $${total.toLocaleString(undefined, { maximumFractionDigits: 2 })} across the rows below.` : ". No outgoing stablecoin transfers were present in the 100 most recent transactions."}
                </p>
              </div>

              {rows.length > 0 && (
                <>
                  <div className="bar-chart" aria-label="Transfer amount comparison">
                    {rows.map((row, index) => {
                      const maximum = Math.max(...rows.map((item) => item.amount));
                      return (
                        <div className="bar-row" key={`${row.hash}-${index}`}>
                          <span>{index + 1}</span>
                          <div><i style={{ width: `${Math.max(4, (row.amount / maximum) * 100)}%` }} /></div>
                          <strong>{row.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} {row.symbol}</strong>
                        </div>
                      );
                    })}
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Date</th><th>Recipient</th><th>Asset</th><th>Amount</th><th>Evidence</th></tr></thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.hash}>
                            <td>{new Date(row.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                            <td><code>{shorten(row.to, 8, 6)}</code></td>
                            <td>{row.symbol}</td>
                            <td>{row.amount.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
                            <td><a href={`https://etherscan.io/tx/${row.hash}`} target="_blank">Transaction <ArrowUpRight size={12} /></a></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <details className="evidence">
                <summary>Data and payment provenance <ChevronDown size={15} /></summary>
                <div className="evidence-grid">
                  <div><span>Allium endpoint</span><code>/api/v1/developer/wallet/transactions</code></div>
                  <div><span>Actual / approved cost</span><p>{fixtureMode ? "$0.00 actual · fixture" : `$${quote?.amountUsd.toFixed(2) ?? "0.03"} / $${quote?.amountUsd.toFixed(2) ?? "0.03"} USDC on Tempo`}</p></div>
                  <div><span>Wallet queried</span><code>{shorten(codexPlan?.calls[0]?.arguments.address ?? DEMO_WALLET, 10, 8)}</code></div>
                  <div><span>Data chain / request limit</span><p>{codexPlan ? `${codexPlan.calls[0].arguments.chain} · ${codexPlan.calls[0].arguments.limit}` : "ethereum · fixture"}</p></div>
                  <div><span>Receipt</span><code>{shorten(receipt?.reference ?? receipt?.settlement?.transaction ?? "Returned by Allium", 10, 8)}</code></div>
                </div>
              </details>
            </div>
          )}
        </section>

        <ApiCatalogue paymentRail={paymentRail} />
      </main>

      {showCodex && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowCodex(false)}>
          <div className="codex-modal" role="dialog" aria-modal="true" aria-labelledby="codex-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowCodex(false)} aria-label="Close">×</button>
            <p className="eyebrow">REASONING CONNECTION</p>
            <h2 id="codex-title">Use your Codex access</h2>
            <p className="modal-copy">
              {codexRequired
                ? "OpenAI login is required for natural-language queries. Codex interprets your question and creates the execution plan before any Allium payment is requested."
                : "Sign in through OpenAI. Your Codex plan allowance is used for reasoning; Allium data is paid separately from your wallet."}
            </p>
            {codexStatus.state === "starting" && <div className="codex-wait"><LoaderCircle className="spin" size={17} /> Starting an isolated session…</div>}
            {codexStatus.state === "awaiting_login" && (
              <div className="device-code">
                <p className="codex-auth-explainer">
                  You’ll continue on OpenAI’s Codex authorization page. OpenAI may warn you to proceed only if this code came from Codex. Playground started an isolated Codex app-server session, which generated this code.
                </p>
                <span>Enter this one-time code</span>
                <strong>{codexStatus.login.userCode}</strong>
                <a href={codexStatus.login.verificationUrl} target="_blank" rel="noreferrer">Continue to OpenAI Codex <ArrowUpRight size={14} /></a>
                <small>This window will update after approval.</small>
              </div>
            )}
            {codexStatus.state === "connected" && (
              <>
                <div className="connected-message"><Check size={18} /><div><strong>Codex is connected</strong><span>Ready to plan your next question.</span></div></div>
                <button className="disconnect-codex" onClick={disconnectCodex}>Disconnect and delete credentials</button>
              </>
            )}
            {codexStatus.state === "error" && <p className="error-message">{codexStatus.message}</p>}
            {codexStatus.state === "disconnected" && <button className="modal-primary" onClick={connectCodex}>Continue to OpenAI Codex</button>}
            <p className="codex-credential-note">
              Disconnecting signs out the isolated Codex session and deletes your credentials from Playground&apos;s servers. Inactive sessions are automatically deleted after 30 minutes.
            </p>
          </div>
        </div>
      )}

      <footer>
        <span>Reasoning by Codex · data by Allium</span>
        <span>You approve every paid call.</span>
      </footer>
    </div>
  );
}
