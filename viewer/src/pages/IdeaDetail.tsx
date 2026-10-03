import { Link, useParams } from "react-router-dom";
import { usd, useGet, type Annotation, type Comparison, type Idea, type ResultSummary, type Stage } from "../api.js";
import { AnnotationLine } from "../components/Annotate.js";
import { IdeaLink, Loading, RevealPanel, RunLink, TraceLink, Verdict } from "../components/ui.js";

interface IdeaData {
  idea: Idea & { status: string };
  parent: Idea | null;
  variants: (Idea & { status: string })[];
  results: ResultSummary[];
  comparisons: Comparison[];
  annotations: Annotation[];
}

export function IdeaDetail() {
  const { id } = useParams();
  const { data, error } = useGet<IdeaData>(`/ideas/${id}`);
  if (!data) return <Loading error={error} />;
  const { idea, parent, variants, results, comparisons, annotations } = data;
  const stages: Stage[] = ["kill_gate", "viability", "critic"];
  return (
    <>
      <h1>
        <span className="mono">{idea.id}</span> <span className={`pill`}>{idea.status}</span>
      </h1>
      <p className="ideafull">{idea.idea}</p>
      <dl className="facts">
        {idea.customer && (
          <>
            <dt>Customer</dt>
            <dd>{idea.customer}</dd>
          </>
        )}
        {idea.source_url && (
          <>
            <dt>Source</dt>
            <dd>
              <a href={idea.source_url} target="_blank" rel="noreferrer">
                {idea.source_url}
              </a>
            </dd>
          </>
        )}
        {idea.verbatim_quote && (
          <>
            <dt>Quote</dt>
            <dd className="quote">“{idea.verbatim_quote}”</dd>
          </>
        )}
        {parent && (
          <>
            <dt>Variant of</dt>
            <dd>
              <IdeaLink id={parent.id} /> <span className="muted">{parent.idea}</span>
            </dd>
          </>
        )}
        {variants.length > 0 && (
          <>
            <dt>Variants</dt>
            <dd>
              {variants.map((v) => (
                <div key={v.id}>
                  <IdeaLink id={v.id} /> <span className="pill small">{v.status}</span> <span className="muted">{v.idea}</span>
                </div>
              ))}
            </dd>
          </>
        )}
      </dl>
      <RevealPanel idea={idea} />

      {stages.map((stage) => {
        const rows = results.filter((r) => r.stage === stage);
        if (rows.length === 0) return null;
        return (
          <section key={stage}>
            <h2>
              {stage} <span className="muted">{rows.length} {rows.length === 1 ? "attempt" : "attempts"}</span>
            </h2>
            <table className="grid">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Verdict</th>
                  <th>Rules fired</th>
                  <th className="num">Cost</th>
                  <th>Model</th>
                  <th>Created</th>
                  <th>Trace</th>
                  <th className="num">Ann.</th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .slice()
                  .reverse()
                  .map((r, i) => (
                    <tr key={r.id} className={i === 0 ? "latest" : "muted"}>
                      <td>
                        <RunLink id={r.run_id} />
                      </td>
                      <td>
                        {r.kind === "standing" ? <span className="badge">rank {r.rank}</span> : <Verdict v={r.verdict} />}
                        {r.kind === "comparison" && <span className="muted small"> comparison</span>}
                      </td>
                      <td className="mono small">{r.rules_fired.join(", ")}</td>
                      <td className="num">{usd(r.cost_usd)}</td>
                      <td className="small">{r.model}</td>
                      <td className="small muted nowrap">{r.created_at}</td>
                      <td>
                        <TraceLink id={r.id} />
                        {i === 0 && <span className="muted small"> latest</span>}
                      </td>
                      <td className="num">{r.annotations || ""}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>
        );
      })}

      {comparisons.length > 0 && (
        <section>
          <h2>
            Comparisons <span className="muted">{comparisons.length}</span>
          </h2>
          <table className="grid">
            <thead>
              <tr>
                <th>#</th>
                <th>Run</th>
                <th className="num">Round</th>
                <th>Opponent</th>
                <th>A first</th>
                <th>B first</th>
                <th>Result</th>
                <th>For {idea.id}</th>
                <th>Trace</th>
              </tr>
            </thead>
            <tbody>
              {comparisons.map((c) => {
                const me = c.idea_a === idea.id ? "A" : "B";
                const other = me === "A" ? c.idea_b : c.idea_a;
                const outcome = c.result === "tie" ? "tie" : c.result === me ? "win" : "loss";
                return (
                  <tr key={c.id} className={c.flip ? "flip" : ""}>
                    <td>
                      <Link to={`/comparisons/${c.id}`}>#{c.id}</Link>
                    </td>
                    <td>
                      <RunLink id={c.run_id} />
                    </td>
                    <td className="num">{c.round}</td>
                    <td>
                      <IdeaLink id={other} /> <span className="muted small">(as {me === "A" ? "B" : "A"})</span>
                    </td>
                    <td className="mono">{c.order_ab}</td>
                    <td className="mono">{c.order_ba}</td>
                    <td>
                      <span className={`badge result-${c.result}`}>{c.result}</span>
                      {c.flip && <span className="pill flip"> order flip</span>}
                    </td>
                    <td>
                      <span className={`badge outcome-${outcome}`}>{outcome}</span>
                    </td>
                    <td>
                      <TraceLink id={c.stage_result_id} label="trace" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <section>
        <h2>
          Annotations <span className="muted">{annotations.length}</span>
        </h2>
        {annotations.length === 0 && <p className="muted">None yet. Annotate from a trace or comparison page.</p>}
        <ul className="annlist">
          {annotations.map((a) => (
            <li key={a.id}>
              <AnnotationLine a={a} withTarget />
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
