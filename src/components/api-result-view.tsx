"use client";

import { Check, Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { EChart } from "@/components/charts/echart";
import type { AlliumToolId } from "@/lib/allium-tools";
import { buildVisualization, formatCell } from "@/lib/allium-visualization";

type ResultTab = "visual" | "table" | "json";

export function ApiResultView({
  tool,
  result,
  copied,
  onCopy,
}: {
  tool: AlliumToolId;
  result: unknown;
  copied: boolean;
  onCopy: () => void;
}) {
  const [tab, setTab] = useState<ResultTab>("visual");
  const visualization = useMemo(() => buildVisualization(tool, result), [tool, result]);
  const visibleRows = visualization.table.rows.slice(0, 200);

  return (
    <div className="result-explorer">
      <div className="result-tabs" role="tablist" aria-label="Result views">
        <button className={tab === "visual" ? "active" : ""} onClick={() => setTab("visual")}>Visual</button>
        <button className={tab === "table" ? "active" : ""} onClick={() => setTab("table")}>Table</button>
        <button className={tab === "json" ? "active" : ""} onClick={() => setTab("json")}>Raw JSON</button>
      </div>

      {tab === "visual" && (
        <div className="visual-result">
          <div className="visual-result-copy">
            <h4>{visualization.title}</h4>
            <p>{visualization.description}</p>
          </div>
          {visualization.option ? (
            <EChart option={visualization.option} ariaLabel={visualization.title} />
          ) : (
            <div className="chart-empty">This response has no plottable numeric series.</div>
          )}
        </div>
      )}

      {tab === "table" && (
        <div className="result-table-wrap">
          <table className="result-table">
            <thead><tr>{visualization.table.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
            <tbody>
              {visibleRows.map((row, index) => (
                <tr key={index}>{visualization.table.columns.map((column) => <td key={column.key}>{formatCell(row[column.key])}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {visualization.table.total > visibleRows.length && (
            <p className="table-limit-note">Showing the first {visibleRows.length.toLocaleString()} of {visualization.table.total.toLocaleString()} rows. Raw JSON contains the complete response.</p>
          )}
        </div>
      )}

      {tab === "json" && (
        <div className="response-json">
          <button onClick={onCopy} aria-label="Copy response JSON" title="Copy response JSON">
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <pre>{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
