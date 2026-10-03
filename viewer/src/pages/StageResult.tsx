import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { num, usd, useGet, type Json, type Source, type StageResultDetail, type TraceEvent } from "../api.js";
import { Annotate } from "../components/Annotate.js";
import { JsonTree } from "../components/JsonTree.js";
import { Hash, IdeaLink, Loading, Markdown, RevealPanel, RunLink, Verdict } from "../components/ui.js";
import { ComparisonCard } from "./Comparison.js";

const KIND_ORDER = ["system", "input", "model_call", "tool_call", "tool_result", "output", "error", "runner_check", "runner_note", "runner_override"];
const kindRank = (k: string) => {
  const i = KIND_ORDER.indexOf(k);
  return i < 0 ? (k.startsWith("runner_") ? 9.5 : 99) : i;
};

export function StageResult() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const { data, error, reload } = useGet<StageResultDetail>(`/stage-results/${id}`);
  if (!data) return <Loading error={error} />;
  const { result, idea, events, kinds, usage, sources, unsourced_doc_urls, comparison, annotations } = data;
  const isViability = result.stage === "viability";
  const tabs = ["timeline", "output", ...(isViability && result.doc_md ? ["brief"] : []), ...(comparison ? ["comparison"] : [])];
  const tab = params.get("tab") && tabs.includes(params.get("tab")!) ? params.get("tab")! : isViability && result.doc_md ? "brief" : comparison ? "comparison" : "timeline";
  const payload = result.payload ?? {};
  const ideaIds = comparison ? [comparison.idea_a?.id, comparison.idea_b?.id] : [result.idea_id];

  return (
    <>
      <h1>
        <span className="mono">{result.id}</span>
      </h1>
      <dl className="facts">
        <dt>Stage</dt>
        <dd>
          {result.stage}
          {result.kind && <span className="muted"> · {result.kind}</span>} <Verdict v={result.verdict} />
          {result.rules_fired.length > 0 && <span className="mono"> {result.rules_fired.join(", ")}</span>}
          {result.self_found ? <span className="pill fm"> self_found</span> : null}
        </dd>
        <dt>Idea</dt>
        <dd>
          {comparison ? (
            <>
              <IdeaLink id={comparison.idea_a!.id} /> vs <IdeaLink id={comparison.idea_b!.id} />
            </>
          ) : (
            <>
              <IdeaLink id={result.idea_id} /> {idea && <span className="muted">{idea.idea}</span>}
            </>
          )}
        </dd>
        <dt>Run</dt>
        <dd>
          <RunLink id={result.run_id} /> · {result.model} · agent {result.agent} · prompt <Hash h={result.prompt_hash} /> · {result.created_at}
        </dd>
        <dt>Usage</dt>
        <dd>
          {usage.calls} model calls · in {num(usage.input)} · out {num(usage.output)} · cache read {num(usage.cache_read)} · cache write {num(usage.cache_write)} · model cost {usd(usage.cost, 4)} · recorded cost <strong>{usd(result.cost_usd, 4)}</strong>
        </dd>
      </dl>
      {!comparison && idea && <RevealPanel idea={idea} />}

      <div className="tabs">
        {tabs.map((t) => (
          <button key={t} className={t === tab ? "on" : ""} onClick={() => setParams({ tab: t })}>
            {t}
            {t === "timeline" && <span className="muted"> {events.length}</span>}
            {t === "brief" && unsourced_doc_urls.length > 0 && <span className="pill flip"> {unsourced_doc_urls.length} unsourced</span>}
          </button>
        ))}
      </div>

      {tab === "timeline" && <Timeline events={events} kinds={kinds} />}
      {tab === "output" && (
        <section>
          <JsonTree value={payload} open={2} />
        </section>
      )}
      {tab === "brief" && <Brief md={result.doc_md ?? ""} payload={payload} sources={sources} unsourced={unsourced_doc_urls} />}
      {tab === "comparison" && comparison && <ComparisonCard c={comparison} />}

      <Annotate stageResultId={result.id} ideaIds={ideaIds} existing={annotations} onChange={reload} />
    </>
  );
}

// ---------- timeline ----------

function Timeline({ events, kinds }: { events: TraceEvent[]; kinds: Record<string, number> }) {
  const allKinds = useMemo(() => Object.keys(kinds).sort((a, b) => kindRank(a) - kindRank(b)), [kinds]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [openJson, setOpenJson] = useState<Set<number>>(new Set());
  const shown = events.filter((e) => !hidden.has(e.kind));
  const toggleKind = (k: string) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const toggleJson = (seq: number) =>
    setOpenJson((s) => {
      const n = new Set(s);
      if (n.has(seq)) n.delete(seq);
      else n.add(seq);
      return n;
    });
  return (
    <section>
      <div className="toolbar">
        {allKinds.map((k) => (
          <button key={k} className={`chip kind-${k} ${hidden.has(k) ? "off" : ""}`} onClick={() => toggleKind(k)}>
            {k} <span className="muted">{kinds[k]}</span>
          </button>
        ))}
        <button className="link" onClick={() => setOpenJson(new Set(shown.map((e) => e.seq)))}>
          expand all JSON
        </button>
        <button className="link" onClick={() => setOpenJson(new Set())}>
          collapse
        </button>
      </div>
      <ol className="timeline">
        {shown.map((e) => (
          <li key={e.seq} className={`ev kind-${e.kind}`}>
            <div className="evhead">
              <span className="seq">{e.seq}</span>
              <span className={`badge kind-${e.kind}`}>{e.kind}</span>
              <EventSummary e={e} />
              <button className="link" onClick={() => toggleJson(e.seq)}>
                {openJson.has(e.seq) ? "hide JSON" : "JSON"}
              </button>
            </div>
            {openJson.has(e.seq) && (
              <div className="evbody">
                <JsonTree value={e.content} open={1} />
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function EventSummary({ e }: { e: TraceEvent }) {
  const c = (e.content ?? {}) as Json;
  switch (e.kind) {
    case "system":
      return (
        <span className="evsum">
          {String(c.model ?? "")} · prompt <Hash h={c.prompt_hash as string} /> · system prompt {num(String(c.system_prompt ?? "").length)} chars
        </span>
      );
    case "input": {
      const idea = c.idea as Json | undefined;
      return (
        <span className="evsum">
          {idea?.id ? <IdeaLink id={String(idea.id)} /> : null} {Object.keys(c).join(", ")}
        </span>
      );
    }
    case "model_call": {
      const u = (c.usage ?? {}) as Record<string, number>;
      const content = Array.isArray(c.content) ? (c.content as Json[]) : [];
      const toolUses = content.filter((b) => b.type === "tool_use").map((b) => `${b.name}`);
      const text = content.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join(" ");
      return (
        <span className="evsum">
          <span className="muted">iter</span> {String(c.iteration ?? "")} · <span className="muted">stop</span> {String(c.stop_reason ?? "")} · <span className="muted">in</span> {num(u.input_tokens)} <span className="muted">out</span> {num(u.output_tokens)}{" "}
          <span className="muted">cache r/w</span> {num(u.cache_read_input_tokens)}/{num(u.cache_creation_input_tokens)} · <strong>{usd(Number(c.cost_usd ?? 0), 4)}</strong>
          {c.source ? <span className="pill small">{String(c.source)}</span> : null}
          {toolUses.length > 0 && <span className="muted"> → {toolUses.join(", ")}</span>}
          {text && <span className="evtext">{text.slice(0, 200)}{text.length > 200 ? "…" : ""}</span>}
        </span>
      );
    }
    case "tool_call":
      return (
        <span className="evsum">
          <strong>{String(c.tool ?? "")}</strong> <span className="query">{String(c.query ?? "")}</span>
          {c.mode ? <span className="pill small">{String(c.mode)}</span> : null}
        </span>
      );
    case "tool_result": {
      const r = (c.result ?? {}) as Json;
      const results = Array.isArray(r.results) ? (r.results as Json[]) : r.url ? [r] : [];
      return (
        <span className="evsum">
          <strong>{String(c.tool ?? "")}</strong> {c.ok === false ? <span className="badge verdict-error">failed</span> : <span className="muted">{results.length} result{results.length === 1 ? "" : "s"}</span>}
          {c.source ? <span className="pill small">{String(c.source)}</span> : null}
          {c.error ? <span className="error"> {String(c.error)}</span> : null}
          {results.length > 0 && (
            <ul className="urls">
              {results.map((x, i) => (
                <li key={i}>
                  <a href={String(x.url)} target="_blank" rel="noreferrer">
                    {String(x.title ?? x.url)}
                  </a>{" "}
                  <span className="muted small">{String(x.url)}</span>
                </li>
              ))}
            </ul>
          )}
        </span>
      );
    }
    case "output":
      return (
        <span className="evsum">
          <Verdict v={String(c.verdict ?? "")} />
          {Array.isArray(c.rules_fired) && (c.rules_fired as string[]).length > 0 && <span className="mono"> {(c.rules_fired as string[]).join(", ")}</span>}
          {Array.isArray(c.missing) && (c.missing as string[]).length > 0 && <span className="error"> missing: {(c.missing as string[]).join(", ")}</span>}
        </span>
      );
    case "error":
      return <span className="evsum error">{String(c.error ?? JSON.stringify(c))}</span>;
    default: {
      // runner_check, runner_note, runner_override and anything new
      const label = String(c.check ?? c.note ?? c.kind ?? "");
      const ok = c.ok === undefined ? null : Boolean(c.ok);
      return (
        <span className="evsum">
          <strong>{label}</strong>
          {ok !== null && <span className={`badge ${ok ? "verdict-pass" : "verdict-kill"}`}> {ok ? "ok" : "failed"}</span>}
          {Array.isArray(c.moved) && <span className="muted"> {(c.moved as Json[]).length} moved</span>}
          {c.reason ? <span className="evtext">{String(c.reason).slice(0, 200)}</span> : null}
        </span>
      );
    }
  }
}

// ---------- viability brief ----------

function Brief({ md, payload, sources, unsourced }: { md: string; payload: Json; sources: Source[]; unsourced: string[] }) {
  const flag = useMemo(() => new Set(unsourced), [unsourced]);
  const claims = Array.isArray(payload.unsourced_claims) ? (payload.unsourced_claims as string[]) : [];
  const runner = (payload.runner ?? {}) as Json;
  const moved = Array.isArray(runner.unsourced_moved) ? (runner.unsourced_moved as { field: string; url: string }[]) : [];
  return (
    <section className="brief">
      <div className="briefdoc">
        <Markdown md={md} flagUrls={flag} />
      </div>
      <aside className="sources">
        {(unsourced.length > 0 || claims.length > 0 || moved.length > 0) && (
          <div className="box flipbox">
            <h3>Unsourced</h3>
            {unsourced.length > 0 && (
              <>
                <h4>URLs in the brief never retrieved</h4>
                <ul>
                  {unsourced.map((u) => (
                    <li key={u}>
                      <a className="unsourced" href={u} target="_blank" rel="noreferrer">
                        {u}
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {moved.length > 0 && (
              <>
                <h4>Moved by the runner</h4>
                <ul>
                  {moved.map((m, i) => (
                    <li key={i}>
                      <span className="mono small">{m.field}</span>{" "}
                      <a className="unsourced" href={m.url} target="_blank" rel="noreferrer">
                        {m.url}
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {claims.length > 0 && (
              <>
                <h4>unsourced_claims</h4>
                <ul>
                  {claims.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        <div className="box">
          <h3>
            Sources retrieved <span className="muted">{sources.length}</span>
          </h3>
          <ul className="srclist">
            {sources.map((s) => (
              <li key={s.key}>
                <a href={s.url} target="_blank" rel="noreferrer">
                  {s.title ?? s.url}
                </a>
                <div className="muted small">{s.url}</div>
                <div className="small via">
                  {dedupe(s.via.map((v) => `${v.tool}: ${v.query}`)).map((v) => (
                    <div key={v}>{v}</div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="muted small">
          A link is flagged when its URL does not appear in any tool_result of this stage call. <Link to="?tab=timeline">Timeline →</Link>
        </p>
      </aside>
    </section>
  );
}

const dedupe = (xs: string[]) => [...new Set(xs)];
