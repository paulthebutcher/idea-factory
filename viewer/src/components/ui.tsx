// Small shared bits: verdict badges, id links, markdown, reveal toggle.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { get, type HiddenFields, type Idea } from "../api.js";
import { useReveal } from "../reveal.js";

export function Verdict({ v }: { v: string | null | undefined }) {
  if (!v) return <span className="muted">—</span>;
  return <span className={`badge verdict-${v}`}>{v}</span>;
}

export function Status({ s }: { s: string }) {
  return <span className={`badge status-${s}`}>{s}</span>;
}

export function Hash({ h, title }: { h: string | null | undefined; title?: string }) {
  if (!h) return null;
  return (
    <code className="hash" title={title ? `${title}: ${h}` : h}>
      {h.slice(0, 8)}
    </code>
  );
}

export function IdeaLink({ id }: { id: string }) {
  return (
    <Link className="mono" to={`/ideas/${id}`}>
      {id}
    </Link>
  );
}

export function TraceLink({ id, label }: { id: string | null | undefined; label?: string }) {
  if (!id) return null;
  return (
    <Link className="mono" to={`/traces/${id}`} title={id}>
      {label ?? id}
    </Link>
  );
}

export function RunLink({ id }: { id: string }) {
  return (
    <Link className="mono" to={`/runs/${id}`}>
      {id}
    </Link>
  );
}

export function Markdown({ md, flagUrls }: { md: string; flagUrls?: Set<string> }) {
  let html = DOMPurify.sanitize(marked.parse(md, { async: false }) as string, { ADD_ATTR: ["target"] });
  if (flagUrls && flagUrls.size) {
    const div = document.createElement("div");
    div.innerHTML = html;
    for (const a of Array.from(div.querySelectorAll("a"))) {
      const href = a.getAttribute("href") ?? "";
      if (flagUrls.has(href) || flagUrls.has(href.replace(/\/+$/, ""))) {
        a.classList.add("unsourced");
        a.title = "URL not retrieved in this stage call";
      }
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noreferrer");
    }
    html = div.innerHTML;
  }
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** The reveal toggle for one idea. Shows hidden fields inline when on. */
export function RevealPanel({ idea }: { idea: Idea }) {
  const { isRevealed, toggle } = useReveal();
  const on = isRevealed(idea.id);
  const [hidden, setHidden] = useState<HiddenFields | null>(null);
  useEffect(() => {
    if (!on) {
      setHidden(null);
      return;
    }
    let live = true;
    get<HiddenFields>(`/ideas/${idea.id}/reveal`).then((h) => live && setHidden(h));
    return () => {
      live = false;
    };
  }, [on, idea.id]);
  return (
    <div className={`reveal ${on ? "on" : ""}`}>
      <label>
        <input type="checkbox" checked={on} onChange={() => toggle(idea.id)} /> Reveal hidden fields for {idea.id}
        <span className="muted"> (labels, outcome, seed_source, set_name, test_role, notes; annotations made while revealed are marked)</span>
      </label>
      {on && hidden && (
        <dl className="hidden-fields">
          <dt>seed_source</dt>
          <dd>{hidden.seed_source ?? "—"}</dd>
          <dt>set_name</dt>
          <dd>{hidden.set_name ?? "—"}</dd>
          <dt>test_role</dt>
          <dd>{hidden.test_role ?? "—"}</dd>
          <dt>notes</dt>
          <dd>{hidden.notes ?? "—"}</dd>
          <dt>labels</dt>
          <dd>
            {hidden.labels.length === 0 && "—"}
            {hidden.labels.map((l, i) => (
              <div key={i}>
                <span className="mono">{l.labeler}</span> → <strong>{l.value}</strong>
                {l.reason && <span> ({l.reason})</span>}
                {l.note && <span className="muted"> — {l.note}</span>}
              </div>
            ))}
          </dd>
          <dt>outcome</dt>
          <dd>
            {hidden.outcome ? (
              <>
                <strong>{hidden.outcome.outcome}</strong> · {hidden.outcome.bucket}
                {hidden.outcome.business_name && <span> · {hidden.outcome.business_name}</span>}
              </>
            ) : (
              "—"
            )}
          </dd>
        </dl>
      )}
    </div>
  );
}

export function Loading({ error }: { error: string | null }) {
  return error ? <p className="error">Error: {error}</p> : <p className="muted">Loading…</p>;
}
