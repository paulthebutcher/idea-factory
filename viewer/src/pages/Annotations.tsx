import { useState } from "react";
import { useGet, type Annotation } from "../api.js";
import { AnnotationLine } from "../components/Annotate.js";
import { IdeaLink, Loading } from "../components/ui.js";

export function Annotations() {
  const { data, error } = useGet<Annotation[]>("/annotations");
  const [verdict, setVerdict] = useState<string>("all");
  const [blind, setBlind] = useState<string>("all");
  if (!data) return <Loading error={error} />;
  const rows = data.filter((a) => (verdict === "all" ? true : verdict === "none" ? !a.verdict : a.verdict === verdict)).filter((a) => (blind === "all" ? true : blind === "blind" ? a.blind === 1 : a.blind === 0));
  const count = (f: (a: Annotation) => boolean) => data.filter(f).length;
  return (
    <>
      <h1>
        Annotations <span className="muted">{data.length}</span>
      </h1>
      <div className="toolbar">
        <span>
          {["all", "agree", "disagree", "unsure", "none"].map((v) => (
            <button key={v} className={`chip ${verdict === v ? "" : "off"} ${v !== "all" && v !== "none" ? `v-${v}` : ""}`} onClick={() => setVerdict(v)}>
              {v} <span className="muted">{v === "all" ? data.length : v === "none" ? count((a) => !a.verdict) : count((a) => a.verdict === v)}</span>
            </button>
          ))}
        </span>
        <span>
          {["all", "blind", "revealed"].map((v) => (
            <button key={v} className={`chip ${blind === v ? "" : "off"}`} onClick={() => setBlind(v)}>
              {v} <span className="muted">{v === "all" ? data.length : v === "blind" ? count((a) => a.blind === 1) : count((a) => a.blind === 0)}</span>
            </button>
          ))}
        </span>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>#</th>
            <th>Idea</th>
            <th>Target</th>
            <th>Annotation</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td className="muted">{a.id}</td>
              <td>
                {a.idea_id && <IdeaLink id={a.idea_id} />}
                {!a.idea_id && a.target?.type === "comparison" && (
                  <>
                    <IdeaLink id={a.target.idea_a} /> <IdeaLink id={a.target.idea_b} />
                  </>
                )}
              </td>
              <td className="small">{a.target?.type === "stage_result" ? `${a.target.stage} · ${a.target.run_id}` : a.target?.type === "comparison" ? `comparison · ${a.target.run_id}` : "—"}</td>
              <td>
                <AnnotationLine a={a} withTarget />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Annotations are written straight to the store's annotations table (one of stage_result_id or comparison_id is set; blind records whether hidden fields were revealed for the idea at the time).</p>
    </>
  );
}
