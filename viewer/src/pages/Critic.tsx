import { useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useGet, type Comparison, type Idea, type RunSummary, type Standing } from "../api.js";
import { IdeaLink, Loading, RunLink, Status, TraceLink } from "../components/ui.js";

interface CriticData {
  run: { id: string; status: string };
  standings: Standing[];
  comparisons: Comparison[];
  ideas: Record<string, Idea | null>;
}

/** /critic: jump to the latest run that has comparisons. */
export function CriticLatest() {
  const { data, error } = useGet<RunSummary[]>("/runs");
  if (!data) return <Loading error={error} />;
  const last = [...data].reverse().find((r) => r.verdicts.critic);
  if (!last) return <p>No critic runs yet.</p>;
  return <Navigate to={`/runs/${last.id}/critic`} replace />;
}

export function Critic() {
  const { id } = useParams();
  const { data, error } = useGet<CriticData>(`/runs/${id}/critic`);
  const runs = useGet<RunSummary[]>("/runs").data;
  const [only, setOnly] = useState<"all" | "flips" | "ties">("all");
  const [open, setOpen] = useState<Set<number>>(new Set());
  if (!data) return <Loading error={error} />;
  const { run, standings, comparisons, ideas } = data;
  const rows = comparisons.filter((c) => (only === "flips" ? c.flip : only === "ties" ? c.result === "tie" : true));
  const flips = comparisons.filter((c) => c.flip).length;
  const ties = comparisons.filter((c) => c.result === "tie").length;
  const rounds = [...new Set(comparisons.map((c) => c.round))].sort((a, b) => a - b);
  const criticRuns = (runs ?? []).filter((r) => r.verdicts.critic).reverse();
  const toggle = (n: number) =>
    setOpen((s) => {
      const x = new Set(s);
      if (x.has(n)) x.delete(n);
      else x.add(n);
      return x;
    });
  return (
    <>
      <h1>
        Critic <RunLink id={run.id} /> <Status s={run.status} />
      </h1>
      <div className="toolbar">
        {criticRuns.length > 1 && (
          <span>
            Runs:{" "}
            {criticRuns.map((r) => (
              <Link key={r.id} to={`/runs/${r.id}/critic`} className={r.id === run.id ? "on mono" : "mono"}>
                {r.id}
              </Link>
            ))}
          </span>
        )}
        <span className="muted">
          {comparisons.length} comparisons in {rounds.length} rounds · {ties} ties · {flips} order flips
        </span>
      </div>

      <section>
        <h2>Standings</h2>
        <table className="grid">
          <thead>
            <tr>
              <th className="num">Rank</th>
              <th>Idea</th>
              <th />
              <th className="num">Score</th>
              <th>W-T-L</th>
              <th className="num">Byes</th>
              <th className="num">Opp. score</th>
              <th>Trace</th>
            </tr>
          </thead>
          <tbody>
            {standings.map((s) => (
              <tr key={s.ideaId}>
                <td className="num">{s.rank}</td>
                <td>
                  <IdeaLink id={s.ideaId} />
                </td>
                <td className="ideatext muted">{ideas[s.ideaId]?.idea}</td>
                <td className="num">{s.score}</td>
                <td className="mono">
                  {s.wins}-{s.ties}-{s.losses}
                </td>
                <td className="num">{s.byes}</td>
                <td className="num">{s.opponentScore}</td>
                <td>
                  <TraceLink id={s.stage_result_id} label="standing" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Tournament table</h2>
        <div className="toolbar">
          {(["all", "flips", "ties"] as const).map((o) => (
            <button key={o} className={`chip ${only === o ? "" : "off"}`} onClick={() => setOnly(o)}>
              {o}
            </button>
          ))}
          <button className="link" onClick={() => setOpen(new Set(rows.map((c) => c.id)))}>
            expand all rationale
          </button>
          <button className="link" onClick={() => setOpen(new Set())}>
            collapse
          </button>
        </div>
        <table className="grid tournament">
          <thead>
            <tr>
              <th>#</th>
              <th className="num">Rd</th>
              <th>A</th>
              <th>B</th>
              <th>A first</th>
              <th>B first</th>
              <th>Result</th>
              <th>Trace</th>
              <th className="num">Ann.</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <Row key={c.id} c={c} ideas={ideas} open={open.has(c.id)} toggle={() => toggle(c.id)} />
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function Row({ c, ideas, open, toggle }: { c: Comparison; ideas: Record<string, Idea | null>; open: boolean; toggle: () => void }) {
  const cls = [c.result === "tie" ? "tie" : "", c.flip ? "flip" : ""].join(" ");
  return (
    <>
      <tr className={cls}>
        <td>
          <Link to={`/comparisons/${c.id}`}>#{c.id}</Link>
        </td>
        <td className="num">{c.round}</td>
        <td className={c.result === "A" ? "winner" : ""}>
          <IdeaLink id={c.idea_a} />
          <div className="muted small ideatext">{ideas[c.idea_a]?.idea}</div>
        </td>
        <td className={c.result === "B" ? "winner" : ""}>
          <IdeaLink id={c.idea_b} />
          <div className="muted small ideatext">{ideas[c.idea_b]?.idea}</div>
        </td>
        <td className="mono center">{c.order_ab}</td>
        <td className="mono center">{c.order_ba}</td>
        <td>
          <span className={`badge result-${c.result}`}>{c.result}</span>
          {c.flip && <span className="pill flip">flip</span>}
        </td>
        <td>
          <TraceLink id={c.stage_result_id} label="trace" />
        </td>
        <td className="num">{c.annotations || ""}</td>
        <td>
          <button className="link" onClick={toggle}>
            {open ? "hide" : "rationale"}
          </button>
        </td>
      </tr>
      {open && (
        <tr className={`rationale ${cls}`}>
          <td colSpan={10}>
            <div className="orders">
              {(["ab", "ba"] as const).map((o) => (
                <div key={o} className="order">
                  <h4>
                    {o === "ab" ? "A first" : "B first"} → {o === "ab" ? c.order_ab : c.order_ba}
                  </h4>
                  <ol>
                    {(c.rationale?.[o]?.reasons ?? []).map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
