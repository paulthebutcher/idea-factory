// Pretty-printed JSON with collapsible objects/arrays and long strings folded.
import { useState } from "react";

const LONG = 240;

export function JsonTree({ value, depth = 0, open = 2, name }: { value: unknown; depth?: number; open?: number; name?: string }) {
  const [expanded, setExpanded] = useState(depth < open);
  const label = name !== undefined ? <span className="jk">{name}: </span> : null;

  if (value === null || value === undefined) return <div className="jl">{label}<span className="jnull">null</span></div>;
  if (typeof value === "boolean" || typeof value === "number") return <div className="jl">{label}<span className="jnum">{String(value)}</span></div>;
  if (typeof value === "string") return <div className="jl">{label}<Str s={value} /></div>;

  const isArr = Array.isArray(value);
  const entries = isArr ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <div className="jl">{label}<span className="jpunct">{isArr ? "[]" : "{}"}</span></div>;
  const summary = isArr ? `[${entries.length}]` : `{${entries.length} ${entries.length === 1 ? "key" : "keys"}${!expanded ? ": " + entries.slice(0, 4).map(([k]) => k).join(", ") + (entries.length > 4 ? ", …" : "") : ""}}`;
  return (
    <div className="jl">
      <button className="jtoggle" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
        {expanded ? "▾" : "▸"}
      </button>
      {label}
      {!expanded && <span className="jpunct jsummary">{summary}</span>}
      {expanded && (
        <div className="jchildren">
          {entries.map(([k, v]) => (
            <JsonTree key={k} name={k} value={v} depth={depth + 1} open={open} />
          ))}
        </div>
      )}
    </div>
  );
}

function Str({ s }: { s: string }) {
  const [full, setFull] = useState(false);
  const isUrl = /^https?:\/\/\S+$/.test(s);
  if (isUrl) return <a className="jstr" href={s} target="_blank" rel="noreferrer">{s}</a>;
  if (s.length <= LONG) return <span className="jstr">{JSON.stringify(s)}</span>;
  return (
    <span className="jstr">
      {full ? <pre className="jlong">{s}</pre> : JSON.stringify(s.slice(0, LONG)).slice(0, -1) + "…\""}{" "}
      <button className="jmore" onClick={() => setFull((f) => !f)}>
        {full ? "fold" : `+${(s.length - LONG).toLocaleString()} chars`}
      </button>
    </span>
  );
}
