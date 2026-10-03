import { useParams } from "react-router-dom";
import { useGet, type Annotation, type Comparison, type Idea } from "../api.js";
import { Annotate } from "../components/Annotate.js";
import { IdeaLink, Loading, RunLink, TraceLink } from "../components/ui.js";

type Full = Comparison & { idea_a: Idea | null; idea_b: Idea | null };

export function ComparisonPage() {
  const { id } = useParams();
  const { data, error, reload } = useGet<Full & { annotations: Annotation[] }>(`/comparisons/${id}`);
  if (!data) return <Loading error={error} />;
  return (
    <>
      <h1>
        Comparison #{data.id} <span className="muted">round {data.round}</span>
      </h1>
      <p>
        <RunLink id={data.run_id} /> · {data.model} · {data.created_at} · <TraceLink id={data.stage_result_id} label="trace" />
      </p>
      <ComparisonCard c={data} />
      <Annotate comparisonId={data.id} ideaIds={[data.idea_a?.id, data.idea_b?.id]} existing={data.annotations} onChange={reload} />
    </>
  );
}

/** Both presentation orders side by side. Highlights a tie and an order flip. */
export function ComparisonCard({ c }: { c: Full }) {
  const winnerId = (w: string | undefined) => (w === "A" ? c.idea_a?.id : w === "B" ? c.idea_b?.id : undefined);
  return (
    <section className={`cmpcard ${c.flip ? "flip" : ""}`}>
      <div className="cmpideas">
        <div className="cmpidea">
          <span className="badge letter">A</span> <IdeaLink id={c.idea_a?.id ?? c.idea_a as unknown as string} />
          <p>{c.idea_a?.idea}</p>
        </div>
        <div className="cmpidea">
          <span className="badge letter">B</span> <IdeaLink id={c.idea_b?.id ?? c.idea_b as unknown as string} />
          <p>{c.idea_b?.idea}</p>
        </div>
      </div>
      <div className="cmpresult">
        Result <span className={`badge result-${c.result}`}>{c.result === "tie" ? "tie" : `${c.result} (${winnerId(c.result)})`}</span>
        {c.flip && <span className="pill flip">order flip: the two presentation orders disagree</span>}
        {!c.flip && <span className="pill ok">orders agree</span>}
      </div>
      <div className="orders">
        {(["ab", "ba"] as const).map((o) => {
          const r = c.rationale?.[o];
          const w = o === "ab" ? c.order_ab : c.order_ba;
          return (
            <div key={o} className="order">
              <h3>
                {o === "ab" ? "A shown first" : "B shown first"} → winner <span className={`badge letter`}>{w}</span> <span className="mono">{winnerId(w)}</span>
              </h3>
              <ol>
                {(r?.reasons ?? []).map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ol>
            </div>
          );
        })}
      </div>
    </section>
  );
}
