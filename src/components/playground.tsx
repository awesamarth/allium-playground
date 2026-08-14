"use client";

import { useAppKit } from "@reown/appkit/react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  LoaderCircle,
  Send,
  Wallet,
} from "lucide-react";
import { Mppx, tempo as tempoPayment } from "mppx/client";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { getConnectorClient } from "wagmi/actions";
import { BASE_CHAIN_ID, DEMO_WALLET, TEMPO_CHAIN_ID, type TempoQuote, type X402Quote } from "@/lib/allium";
import { fixtureTransfers } from "@/lib/fixture";
import { outgoingStablecoinTransfers, type TransferRow } from "@/lib/normalize";
import { wagmiAdapter } from "@/lib/wallet";
import { ApiCatalogue } from "@/components/api-catalogue";
import { ApiResultView } from "@/components/api-result-view";
import { alliumToolCatalogue, type AlliumToolId } from "@/lib/allium-tools";
import { createBaseX402Credential } from "@/lib/x402-browser";

const DEFAULT_QUERY =
  "Show the five largest recent outgoing stablecoin transfers from Binance 14.";

type Stage = "compose" | "plan" | "paying" | "result" | "error";

type Receipt = {
  reference?: string;
  status?: string;
  transaction?: string;
  settlement?: { network?: string; transaction?: string };
};

type CodexStatus =
  | { state: "disconnected" }
  | { state: "starting" }
  | { state: "awaiting_login"; login: { verificationUrl: string; userCode: string } }
  | { state: "connected"; planType?: string | null }
  | { state: "error"; message: string };

type CodexPlan = {
  interpretation: string;
  calls: Array<{
    tool: AlliumToolId;
    arguments: Record<string, unknown>;
    reason: string;
    unitCostUsd: number;
    maxCalls: 1;
  }>;
  assumptions: string[];
  unsupportedParts: string[];
  maximumDataCostUsd: number;
};

type ExecutedCall = {
  call: CodexPlan["calls"][number];
  result: unknown;
  quote: TempoQuote | X402Quote;
  receipt: Receipt | null;
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
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

export function Playground({ paymentRail = "base" }: { paymentRail?: "tempo" | "base" }) {
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [stage, setStage] = useState<Stage>("compose");
  const [quotes, setQuotes] = useState<Array<TempoQuote | X402Quote>>([]);
  const [rows, setRows] = useState<TransferRow[]>([]);
  const [executions, setExecutions] = useState<ExecutedCall[]>([]);
  const [copiedResult, setCopiedResult] = useState<number | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [finalAnswer, setFinalAnswer] = useState("");
  const [answering, setAnswering] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [payingCall, setPayingCall] = useState(0);
  const [error, setError] = useState("");
  const [codexStatus, setCodexStatus] = useState<CodexStatus>({ state: "disconnected" });
  const [showCodex, setShowCodex] = useState(false);
  const [codexCodeCopied, setCodexCodeCopied] = useState(false);
  const [codexRequired, setCodexRequired] = useState(false);
  const [codexPlan, setCodexPlan] = useState<CodexPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [streamedInterpretation, setStreamedInterpretation] = useState("");
  const [fixtureMode, setFixtureMode] = useState(false);
  const challengeResponses = useRef<Response[]>([]);
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

  const quotedTotal = quotes.reduce((sum, item) => sum + item.amountUsd, 0);
  const singleTransactionResult = executions.length === 1 && executions[0]?.call.tool === "allium_wallet_transactions";
  const total = useMemo(
    () => rows.reduce((sum, transfer) => sum + transfer.amount, 0),
    [rows],
  );

  async function connectCodex() {
    setShowCodex(true);
    setCodexCodeCopied(false);
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

  async function copyCodexCode(code: string) {
    await navigator.clipboard.writeText(code);
    setCodexCodeCopied(true);
    window.setTimeout(() => setCodexCodeCopied(false), 1_600);
  }

  async function copyToolResult(result: unknown, index: number) {
    await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    setCopiedResult(index);
    window.setTimeout(() => setCopiedResult((current) => current === index ? null : current), 1_600);
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
    setQuotes([]);
    setExecutions([]);
    setCopiedResult(null);
    setFinalAnswer("");
    setAnalysisError("");
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
      if (planBody.calls.length < 1 || planBody.calls.length > 5 || planBody.calls.some((call) => !alliumToolCatalogue.some((tool) => tool.id === call.tool))) {
        throw new Error(planBody.unsupportedParts?.[0] ?? "Codex could not map this question to supported Allium calls.");
      }
      setCodexPlan(planBody);
      setPlanning(false);

      const quotedCalls = await Promise.all(planBody.calls.map(async (call) => {
        const response = await fetch("/api/allium/run", {
          method: "POST",
          headers: { "content-type": "application/json", "x-allium-payment-rail": paymentRail },
          body: JSON.stringify({ tool: call.tool, input: call.arguments }),
        });
        const body = await response.clone().json();
        if (response.status !== 402 || !body.quote) throw new Error(body.error ?? `Could not quote ${call.tool}.`);
        return { response, quote: body.quote as TempoQuote | X402Quote };
      }));
      challengeResponses.current = quotedCalls.map((item) => item.response);
      setQuotes(quotedCalls.map((item) => item.quote));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create plan.");
      setStage("error");
    } finally {
      setPlanning(false);
    }
  }

  async function analyzeResults(completed: ExecutedCall[]) {
    setAnswering(true);
    setFinalAnswer("");
    setAnalysisError("");
    try {
      const response = await fetch("/api/codex/analyze", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query,
          evidence: completed.map((item) => ({ tool: item.call.tool, arguments: item.call.arguments, data: item.result })),
        }),
      });
      if (!response.ok || !response.body) {
        const body = await response.json();
        throw new Error(body.error ?? "Codex could not analyze the purchased data.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line) as { type: "delta"; delta: string } | { type: "result"; answer: string } | { type: "error"; error: string };
          if (event.type === "delta") {
            answer += event.delta;
            setFinalAnswer(answer);
          } else if (event.type === "result") {
            answer = event.answer;
            setFinalAnswer(answer);
          } else throw new Error(event.error);
        }
        if (done) break;
      }
    } catch (caught) {
      setAnalysisError(caught instanceof Error ? caught.message : "Codex analysis failed. The paid data remains available below.");
    } finally {
      setAnswering(false);
    }
  }

  async function approveAndRun() {
    if (!isConnected) {
      await open({ view: "Connect" });
      return;
    }
    if (!codexPlan || quotes.length !== codexPlan.calls.length || challengeResponses.current.length !== codexPlan.calls.length) {
      setError("The approved execution plan is missing or expired. Create a new plan.");
      setStage("error");
      return;
    }

    setStage("paying");
    setError("");
    setExecutions([]);
    const completed: ExecutedCall[] = [];

    try {
      const targetChainId = paymentRail === "base" ? BASE_CHAIN_ID : TEMPO_CHAIN_ID;
      if (chainId !== targetChainId) await switchChainAsync({ chainId: targetChainId });

      for (let index = 0; index < codexPlan.calls.length; index += 1) {
        setPayingCall(index);
        const call = codexPlan.calls[index];
        const activeQuote = quotes[index];
        const paymentRequired = challengeResponses.current[index];
        if (!call || !activeQuote || paymentRequired?.status !== 402) throw new Error(`The quote for call ${index + 1} expired.`);

        let credential: string;
        if (paymentRail === "base") {
          credential = await createBaseX402Credential(activeQuote as X402Quote);
        } else {
          const mppx = Mppx.create({
            polyfill: false,
            methods: [tempoPayment.charge({
              expectedChainId: TEMPO_CHAIN_ID,
              mode: "push",
              clientId: "allium-playground",
              getClient: ({ chainId: requestedChainId }) => getConnectorClient(wagmiAdapter.wagmiConfig, { chainId: requestedChainId ?? TEMPO_CHAIN_ID }),
            })],
          });
          credential = await mppx.createCredential(paymentRequired);
        }
        const paidResponse = await fetch("/api/allium/run", {
          method: "POST",
          headers: paymentRail === "base"
            ? { "content-type": "application/json", "payment-signature": credential, "x-allium-payment-rail": "base" }
            : { "content-type": "application/json", authorization: credential, "x-allium-payment-rail": "tempo" },
          body: JSON.stringify({ tool: call.tool, input: call.arguments }),
        });
        const payload = await paidResponse.json();
        if (!paidResponse.ok) throw new Error(payload.error ?? `Allium could not complete call ${index + 1}.`);
        const executed = {
          call,
          result: payload,
          quote: activeQuote,
          receipt: decodeReceipt(paidResponse.headers.get("payment-receipt") ?? paidResponse.headers.get("payment-response")),
        };
        completed.push(executed);
        setExecutions([...completed]);
      }

      const onlyCall = completed.length === 1 ? completed[0] : null;
      setRows(
        onlyCall?.call.tool === "allium_wallet_transactions" && typeof onlyCall.call.arguments.address === "string"
          ? outgoingStablecoinTransfers(onlyCall.result as Parameters<typeof outgoingStablecoinTransfers>[0], onlyCall.call.arguments.address)
          : [],
      );
      setReceipt(onlyCall?.receipt ?? null);
      setStage("result");
      await analyzeResults(completed);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Payment failed.";
      const friendly = message.toLowerCase().includes("rejected") ? "Payment approval was declined. No unapproved calls were charged." : message;
      if (completed.length) {
        setStage("result");
        setAnalysisError(`${friendly} ${completed.length} completed call${completed.length === 1 ? " was" : "s were"} preserved below.`);
      } else {
        setError(friendly);
        setStage("error");
      }
    }
  }

  function reset() {
    setStage("compose");
    setQuotes([]);
    setRows([]);
    setExecutions([]);
    setCopiedResult(null);
    setReceipt(null);
    setFinalAnswer("");
    setAnswering(false);
    setAnalysisError("");
    setCodexPlan(null);
    setPlanning(false);
    setStreamedInterpretation("");
    setFixtureMode(false);
    setError("");
    challengeResponses.current = [];
  }

  function showFixture() {
    setQuotes([{ amountUsd: 0.03, amountAtomic: "30000", chainId: paymentRail === "base" ? BASE_CHAIN_ID : TEMPO_CHAIN_ID, currency: "USDC", recipient: "Fixture" }]);
    setRows(fixtureTransfers);
    setReceipt({ reference: "fixture-receipt", status: "simulated" });
    setFixtureMode(true);
    setStage("result");
  }

  return (
    <div className="site-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Allium Playground home">
          <Image src="/allium-logo.svg" alt="Allium" width={100} height={28} priority />
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
                    : codexPlan && quotes.length === codexPlan.calls.length
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
                  {codexPlan.calls.map((call, index) => {
                    const definition = alliumToolCatalogue.find((tool) => tool.id === call.tool);
                    return (
                      <div className="plan-call" key={`${call.tool}-${index}`}>
                        <div className="call-number">{index + 1}</div>
                        <div>
                          <strong>{definition?.title ?? call.tool}</strong>
                          <p>{call.reason}</p>
                          <code>{JSON.stringify(call.arguments)}</code>
                        </div>
                        <strong className="call-price">${call.unitCostUsd.toFixed(2)}</strong>
                      </div>
                    );
                  })}
                  <div className="quote-total">
                    <div>
                      <span>Maximum Allium data cost</span>
                      <small>{codexPlan.calls.length} exact payment{codexPlan.calls.length === 1 ? "" : "s"} on {paymentRail === "base" ? "Base" : "Tempo"} mainnet · USDC</small>
                    </div>
                    <strong>${(quotes.length ? quotedTotal : codexPlan.maximumDataCostUsd).toFixed(2)}</strong>
                  </div>
                  <div className="approval-row">
                    <p>
                      Each payment is bound to one approved call. Your wallet will request one signature per call.
                    </p>
                    <button onClick={approveAndRun} disabled={stage === "paying" || quotes.length !== codexPlan.calls.length}>
                      {stage === "paying" ? (
                        <><LoaderCircle className="spin" size={16} /> Call {payingCall + 1} of {codexPlan.calls.length}</>
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
                <h2>{fixtureMode ? "Largest recent outgoing transfers" : "Codex answer"}</h2>
                <div className="result-answer streaming-copy" aria-live="polite">
                  {fixtureMode ? (
                    <p>Allium returned {rows.length} outgoing transfers, totaling ${total.toLocaleString(undefined, { maximumFractionDigits: 2 })} across the rows below.</p>
                  ) : finalAnswer ? (
                    <div className="codex-markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{finalAnswer}</ReactMarkdown>
                      {answering && <i className="stream-cursor" />}
                    </div>
                  ) : answering ? (
                    <span className="thinking-copy">Analyzing purchased data<span>…</span></span>
                  ) : (
                    <p>{codexPlan?.interpretation}</p>
                  )}
                </div>
                {analysisError && (
                  <div className="analysis-retry">
                    <span>{analysisError}</span>
                    {!fixtureMode && executions.length > 0 && <button onClick={() => analyzeResults(executions)} disabled={answering}>Retry analysis · $0 data cost</button>}
                  </div>
                )}
              </div>

              {(fixtureMode || singleTransactionResult) && rows.length > 0 && (
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

              {!fixtureMode && executions.map((execution, index) => {
                const definition = alliumToolCatalogue.find((tool) => tool.id === execution.call.tool);
                return (
                  <section className="codex-tool-result" key={`${execution.call.tool}-${index}`}>
                    <div className="codex-tool-result-heading"><span>Call {index + 1}</span><strong>{definition?.title ?? execution.call.tool}</strong></div>
                    <ApiResultView
                      tool={execution.call.tool}
                      result={execution.result}
                      copied={copiedResult === index}
                      onCopy={() => copyToolResult(execution.result, index)}
                    />
                  </section>
                );
              })}

              <details className="evidence">
                <summary>Data and payment provenance <ChevronDown size={15} /></summary>
                <div className="evidence-grid">
                  <div><span>Actual / approved cost</span><p>{fixtureMode ? "$0.00 actual · fixture" : `$${executions.reduce((sum, item) => sum + item.quote.amountUsd, 0).toFixed(2)} / $${quotedTotal.toFixed(2)} USDC on ${paymentRail === "base" ? "Base" : "Tempo"}`}</p></div>
                  <div><span>Calls completed</span><p>{fixtureMode ? "Fixture" : `${executions.length} of ${codexPlan?.calls.length ?? 0}`}</p></div>
                  {(fixtureMode ? [{ call: { tool: "allium_wallet_transactions" as AlliumToolId, arguments: { address: DEMO_WALLET, chain: "ethereum" } }, receipt }] : executions).map((execution, index) => {
                    const definition = alliumToolCatalogue.find((tool) => tool.id === execution.call.tool);
                    const paymentReceipt = execution.receipt;
                    return (
                      <div key={`${execution.call.tool}-receipt-${index}`}>
                        <span>Call {index + 1} · {definition?.title}</span>
                        <code>{definition?.path}</code>
                        <p>{String(execution.call.arguments.chain ?? "all chains")} · {shorten(String(execution.call.arguments.address ?? ("tokenAddress" in execution.call.arguments ? execution.call.arguments.tokenAddress : undefined) ?? "catalogue"), 10, 8)}</p>
                        <code>{shorten(paymentReceipt?.reference ?? paymentReceipt?.transaction ?? paymentReceipt?.settlement?.transaction ?? "Receipt returned", 10, 8)}</code>
                      </div>
                    );
                  })}
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
                <div className="device-code-value">
                  <strong>{codexStatus.login.userCode}</strong>
                  <button
                    onClick={() => copyCodexCode(codexStatus.login.userCode)}
                    aria-label="Copy one-time code"
                    title="Copy one-time code"
                  >
                    {codexCodeCopied ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
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
