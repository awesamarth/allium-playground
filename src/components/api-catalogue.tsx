"use client";

import { useAppKit } from "@reown/appkit/react";
import { ArrowUpRight, Check, ChevronRight, Copy, LoaderCircle, X } from "lucide-react";
import { Mppx, tempo as tempoPayment } from "mppx/client";
import { useMemo, useState } from "react";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { getConnectorClient, signTypedData } from "wagmi/actions";
import {
  alliumToolCatalogue,
  type AlliumToolDefinition,
  type ToolField,
} from "@/lib/allium-tools";
import {
  BASE_CHAIN_ID,
  TEMPO_CHAIN_ID,
  type TempoQuote,
  type X402Quote,
} from "@/lib/allium";
import { wagmiAdapter } from "@/lib/wallet";
import { ApiResultView } from "@/components/api-result-view";

type WorkbenchStage = "edit" | "quoting" | "paying" | "result" | "error";

type PaymentReceipt = Record<string, unknown>;

function decodePaymentReceipt(value: string | null): PaymentReceipt | null {
  if (!value) return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(atob(padded)) as PaymentReceipt;
  } catch {
    return { raw: value };
  }
}

function toToolInput(tool: AlliumToolDefinition, values: Record<string, string>) {
  const input: Record<string, unknown> = {};
  for (const field of tool.fields) {
    const value = values[field.key]?.trim() ?? "";
    if (!value && field.optional) continue;
    if (!value) input[field.key] = "";
    else if (field.type === "number") input[field.key] = Number(value);
    else if (field.type === "datetime-local") input[field.key] = new Date(value).toISOString();
    else input[field.key] = value;
  }
  return input;
}

function Field({ field, value, onChange }: { field: ToolField; value: string; onChange: (value: string) => void }) {
  if (field.type === "select") {
    return (
      <label className="api-field">
        <span>{field.label}{field.optional ? " · optional" : ""}</span>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {field.options?.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select>
      </label>
    );
  }
  return (
    <label className="api-field">
      <span>{field.label}{field.optional ? " · optional" : ""}</span>
      <input
        type={field.type ?? "text"}
        value={value}
        placeholder={field.placeholder}
        min={field.type === "number" ? 0 : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function ApiCatalogue({ paymentRail = "tempo" }: { paymentRail?: "tempo" | "base" }) {
  const [selected, setSelected] = useState<AlliumToolDefinition | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [stage, setStage] = useState<WorkbenchStage>("edit");
  const [quote, setQuote] = useState<TempoQuote | X402Quote | null>(null);
  const [result, setResult] = useState<unknown>(null);
  const [receipt, setReceipt] = useState<PaymentReceipt | null>(null);
  const [copied, setCopied] = useState<"response" | "receipt" | null>(null);
  const [error, setError] = useState("");
  const { open } = useAppKit();
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const categories = useMemo(() => ["Wallets", "Prices", "Tokens"] as const, []);

  function openTool(tool: AlliumToolDefinition) {
    setSelected(tool);
    setValues({ ...tool.defaults });
    setStage("edit");
    setQuote(null);
    setResult(null);
    setReceipt(null);
    setCopied(null);
    setError("");
  }

  function updateValue(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setQuote(null);
    setStage("edit");
  }

  function requestEnvelope() {
    if (!selected) throw new Error("Select an endpoint first.");
    return { tool: selected.id, input: toToolInput(selected, values) };
  }

  async function copyJson(kind: "response" | "receipt", value: unknown) {
    await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
    setCopied(kind);
    window.setTimeout(() => setCopied((current) => current === kind ? null : current), 1_600);
  }

  async function approveAndRun() {
    if (!selected) return;
    if (!isConnected) {
      await open({ view: "Connect" });
      return;
    }
    setStage("quoting");
    setError("");

    try {
      // Always obtain and validate a fresh 402 challenge immediately before signing.
      // The user does not need a separate review step, but cached catalogue pricing is
      // never trusted as payment authorization.
      const paymentRequired = await fetch("/api/allium/run", {
        method: "POST",
        headers: { "content-type": "application/json", "x-allium-payment-rail": paymentRail },
        body: JSON.stringify(requestEnvelope()),
      });
      const challenge = await paymentRequired.clone().json();
      if (paymentRequired.status !== 402 || !challenge.quote) {
        throw new Error(challenge.error ?? "Could not obtain an Allium payment challenge.");
      }
      const activeQuote = challenge.quote as TempoQuote | X402Quote;
      setQuote(activeQuote);
      setStage("paying");

      const targetChainId = paymentRail === "base" ? BASE_CHAIN_ID : TEMPO_CHAIN_ID;
      if (chainId !== targetChainId) await switchChainAsync({ chainId: targetChainId });
      const connectorClient = await getConnectorClient(wagmiAdapter.wagmiConfig, { chainId: targetChainId });
      let credential: string;
      if (paymentRail === "base") {
        const x402Quote = activeQuote as X402Quote;
        const accepted = x402Quote.accepted;
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const nonce = `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
        const authorization = {
          from: connectorClient.account.address,
          to: accepted.payTo as `0x${string}`,
          value: accepted.amount,
          validAfter: "0",
          validBefore: String(accepted.maxTimeoutSeconds),
          nonce,
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
        credential = btoa(JSON.stringify({
          x402Version: x402Quote.paymentRequired.x402Version,
          resource: x402Quote.paymentRequired.resource,
          accepted,
          payload: { signature, authorization },
        }));
      } else {
        const mppx = Mppx.create({
          polyfill: false,
          methods: [tempoPayment.charge({
            expectedChainId: TEMPO_CHAIN_ID,
            mode: "push",
            clientId: "allium-playground",
            getClient: () => connectorClient,
          })],
        });
        credential = await mppx.createCredential(paymentRequired);
      }
      const response = await fetch("/api/allium/run", {
        method: "POST",
        headers: paymentRail === "base"
          ? { "content-type": "application/json", "payment-signature": credential, "x-allium-payment-rail": "base" }
          : { "content-type": "application/json", authorization: credential, "x-allium-payment-rail": "tempo" },
        body: JSON.stringify(requestEnvelope()),
      });
      const responseText = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(responseText);
      } catch {
        throw new Error(
          response.ok
            ? "Allium returned an unreadable response."
            : `Allium request failed (${response.status}): ${responseText.slice(0, 160) || "empty response"}`,
        );
      }
      if (!response.ok) {
        const message =
          typeof payload === "object" && payload && "error" in payload
            ? String(payload.error)
            : "Allium could not complete the request.";
        throw new Error(message);
      }
      setResult(payload);
      setReceipt(decodePaymentReceipt(response.headers.get("payment-receipt") ?? response.headers.get("payment-response")));
      setStage("result");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Payment failed.";
      setError(message.toLowerCase().includes("rejected") ? "Payment approval was declined. Nothing was charged." : message);
      setStage("error");
    }
  }

  return (
    <section className="api-catalogue" aria-labelledby="catalogue-title">
      <div className="catalogue-intro">
        <div>
          <p className="eyebrow">DIRECT API WORKBENCH</p>
          <h2 id="catalogue-title">Explore Allium APIs</h2>
        </div>
        <p>Test any machine-payable Realtime endpoint directly. No Codex connection required—configure the request, inspect its price, then approve the exact call from your wallet.</p>
      </div>

      {categories.map((category) => (
        <div className="catalogue-group" key={category}>
          <div className="catalogue-group-title">
            <h3>{category}</h3>
            <span>{alliumToolCatalogue.filter((tool) => tool.category === category).length} endpoints</span>
          </div>
          <div className="catalogue-grid">
            {alliumToolCatalogue.filter((tool) => tool.category === category).map((tool) => (
              <button className="api-card" key={tool.id} onClick={() => openTool(tool)}>
                <span className="api-card-meta"><code>{tool.method}</code><strong>${tool.priceUsd.toFixed(2)}</strong></span>
                <span className="api-card-body"><strong>{tool.title}</strong><small>{tool.description}</small></span>
                <span className="api-card-path"><code>{tool.path}</code><ChevronRight size={15} /></span>
              </button>
            ))}
          </div>
        </div>
      ))}

      {selected && (
        <div className="workbench-backdrop" onMouseDown={() => setSelected(null)}>
          <aside className="api-workbench" role="dialog" aria-modal="true" aria-labelledby="workbench-title" onMouseDown={(event) => event.stopPropagation()}>
            <header className="workbench-header">
              <div><span>{selected.category} · ${selected.priceUsd.toFixed(2)} per call</span><h2 id="workbench-title">{selected.title}</h2></div>
              <button onClick={() => setSelected(null)} aria-label="Close workbench"><X size={19} /></button>
            </header>
            <div className="workbench-scroll">
              <p className="workbench-description">{selected.description}</p>
              <div className="endpoint-line"><code>{selected.method}</code><span>{selected.path}</span></div>

              <div className="api-fields">
                {selected.fields.map((field) => (
                  <Field key={field.key} field={field} value={values[field.key] ?? ""} onChange={(value) => updateValue(field.key, value)} />
                ))}
              </div>

              <div className="request-preview">
                <span>Request arguments</span>
                <pre>{JSON.stringify(requestEnvelope().input, null, 2)}</pre>
              </div>

              {quote && (
                <div className="manual-quote">
                  <div><span>Exact Allium cost</span><small>{paymentRail === "base" ? "Base mainnet · x402 signature required" : "Tempo mainnet · wallet approval required"}</small></div>
                  <strong>${quote.amountUsd.toFixed(2)}</strong>
                </div>
              )}

              {stage === "result" && (
                <div className="api-result">
                  <div className="api-result-heading"><span><Check size={14} /> Request complete</span><small>${quote?.amountUsd.toFixed(2)} paid · receipt returned</small></div>
                  <ApiResultView
                    tool={selected.id}
                    result={result}
                    copied={copied === "response"}
                    onCopy={() => copyJson("response", result)}
                  />
                  {receipt && (
                    <details>
                      <summary>Payment receipt</summary>
                      <div className="receipt-json">
                        <button onClick={() => copyJson("receipt", receipt)} aria-label="Copy payment receipt" title="Copy payment receipt">
                          {copied === "receipt" ? <Check size={13} /> : <Copy size={13} />}
                        </button>
                        <pre>{JSON.stringify(receipt, null, 2)}</pre>
                      </div>
                    </details>
                  )}
                </div>
              )}
              {stage === "error" && <p className="workbench-error">{error}</p>}
            </div>

            <footer className="workbench-actions">
              <button className="workbench-primary" onClick={approveAndRun} disabled={stage === "quoting" || stage === "paying"}>
                {stage === "quoting" ? <><LoaderCircle className="spin" size={16} /> Preparing payment</>
                  : stage === "paying" ? <><LoaderCircle className="spin" size={16} /> Awaiting wallet</>
                  : !isConnected ? <>Connect wallet <ArrowUpRight size={15} /></>
                  : stage === "result" ? <>Run again <ArrowUpRight size={15} /></>
                  : <>Approve and run <ArrowUpRight size={15} /></>}
              </button>
              <small>No request is paid until you approve it in your wallet.</small>
            </footer>
          </aside>
        </div>
      )}
    </section>
  );
}
