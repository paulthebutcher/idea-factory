// Agree / disagree / unsure plus a note, on a stage result or a comparison. Blind is computed from the
// reveal state of the idea(s) involved at the moment of saving.
import { useState } from "react";
import { Link } from "react-router-dom";
import { send, type Annotation } from "../api.js";
import { useReveal } from "../reveal.js";

type Verdict = "agree" | "disagree" | "unsure";

export function Annotate({ stageResultId, comparisonId, ideaIds, existing, onChange }: { stageResultId?: string; comparisonId?: number; ideaIds: (string | null | undefined)[]; existing: Annotation[]; onChange: () => void }) {
  const { blindFor } = useReveal();
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blind = blindFor(ideaIds);

  const save = async () => {
    if (!verdict && !note.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await send("POST", "/annotations", { stage_result_id: stageResultId ?? null, comparison_id: comparisonId ?? null, verdict, note, blind });
      setVerdict(null);
      setNote("");
      onChange();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const del = async (id: number) => {
    if (!confirm(`Delete annotation #${id}?`)) return;
    await send("DELETE", `/annotations/${id}`);
    onChange();
  };

  return (
    <section className="annotate">
      <header>
        <strong>Annotate</strong>
        <span className={`pill ${blind ? "blind" : "revealed"}`} title="Recorded with the annotation">{blind ? "blind" : "revealed"}</span>
      </header>
      <div className="verdicts">
        {(["agree", "disagree", "unsure"] as Verdict[]).map((v) => (
          <button key={v} className={`vbtn ${v} ${verdict === v ? "on" : ""}`} onClick={() => setVerdict(verdict === v ? null : v)} disabled={busy}>
            {v}
          </button>
        ))}
      </div>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional with a verdict; required without one). ⌘↩ to save." rows={2} onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && void save()} />
      <div className="row">
        <button className="primary" onClick={() => void save()} disabled={busy || (!verdict && !note.trim())}>
          Save
        </button>
        {error && <span className="error">{error}</span>}
      </div>
      {existing.length > 0 && (
        <ul className="annlist">
          {existing.map((a) => (
            <li key={a.id}>
              <AnnotationLine a={a} />
              <button className="link danger" onClick={() => void del(a.id)}>
                delete
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AnnotationLine({ a, withTarget = false }: { a: Annotation; withTarget?: boolean }) {
  return (
    <span className="annline">
      {a.verdict && <span className={`pill v-${a.verdict}`}>{a.verdict}</span>}
      <span className={`pill ${a.blind ? "blind" : "revealed"}`}>{a.blind ? "blind" : "revealed"}</span>
      {a.failure_mode && <span className="pill fm">{a.failure_mode}</span>}
      {withTarget && a.target?.type === "stage_result" && (
        <Link to={`/traces/${a.stage_result_id}`}>
          {a.target.stage} {a.target.idea_id} → {a.target.verdict}
        </Link>
      )}
      {withTarget && a.target?.type === "comparison" && (
        <Link to={`/comparisons/${a.comparison_id}`}>
          comparison #{a.comparison_id} r{a.target.round} {a.target.idea_a} vs {a.target.idea_b} → {a.target.result}
        </Link>
      )}
      {a.note && <span className="note">{a.note}</span>}
      <span className="muted">
        {a.author} · {a.created_at}
      </span>
    </span>
  );
}
