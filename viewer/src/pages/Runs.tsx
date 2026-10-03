import { Link } from "react-router-dom";
import { duration, usd, useGet, type RunSummary, type Stage } from "../api.js";
import { Hash, Loading, RunLink, Status } from "../components/ui.js";

const STAGES: Stage[] = ["kill_gate", "viability", "critic"];

export function Runs() {
  const { data, error } = useGet<RunSummary[]>("/runs");
  if (!data) return <Loading error={error} />;
  const rows = [...data].reverse();
  return (
    <>
      <h1>Runs</h1>
      <table className="grid">
        <thead>
          <tr>
            <th>Run</th>
            <th>Status</th>
            <th>Stages</th>
            <th className="num">Budget</th>
            <th className="num">Spent</th>
            <th className="num">Duration</th>
            <th>Started</th>
            <th>Tasks</th>
            <th>Results</th>
            <th>Prompts</th>
            <th>Mode</th>
            <th>Superseded</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>
                <RunLink id={r.id} />
              </td>
              <td>
                <Status s={r.status} />
              </td>
              <td>{r.stages.join(", ")}</td>
              <td className="num">{usd(r.budget_usd, 2)}</td>
              <td className={`num ${r.spent_usd > r.budget_usd ? "over" : ""}`}>
                {usd(r.spent_usd, 2)}
                <Bar frac={r.budget_usd ? r.spent_usd / r.budget_usd : 0} />
              </td>
              <td className="num">{duration(r.started_at, r.finished_at)}</td>
              <td className="muted nowrap">{r.started_at}</td>
              <td className="small">
                {Object.entries(r.tasks)
                  .sort()
                  .map(([s, n]) => (
                    <span key={s} className={`pill task-${s}`}>
                      {s} {n}
                    </span>
                  ))}
              </td>
              <td className="small">
                {STAGES.filter((s) => r.verdicts[s]).map((s) => (
                  <div key={s}>
                    <span className="muted">{s}:</span>{" "}
                    {Object.entries(r.verdicts[s]!)
                      .sort()
                      .map(([v, n]) => `${v} ${n}`)
                      .join(", ")}{" "}
                    <span className="muted">{usd(r.result_cost[s], 2)}</span>
                  </div>
                ))}
              </td>
              <td className="small">
                {STAGES.filter((s) => r.config.prompt_hashes?.[s]).map((s) => (
                  <div key={s}>
                    <span className="muted">{s}</span> <Hash h={r.config.prompt_hashes![s]} title={s} />
                  </div>
                ))}
              </td>
              <td className="small muted">
                {r.config.search_mode && <div>search {r.config.search_mode}</div>}
                {r.config.model_mode && <div>model {r.config.model_mode}</div>}
              </td>
              <td className="small">
                {r.superseded_by.length > 0 && (
                  <div>
                    by{" "}
                    {r.superseded_by.map((id) => (
                      <RunLink key={id} id={id} />
                    ))}
                  </div>
                )}
                {r.supersedes.length > 0 && (
                  <div>
                    supersedes{" "}
                    {r.supersedes.map((id) => (
                      <RunLink key={id} id={id} />
                    ))}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        {data.length} runs · total spent {usd(data.reduce((a, r) => a + r.spent_usd, 0), 2)} · <Link to="/ideas">pipeline across all runs</Link>
      </p>
    </>
  );
}

export function Bar({ frac }: { frac: number }) {
  const pct = Math.max(0, Math.min(100, frac * 100));
  return (
    <span className={`bar ${frac > 1 ? "over" : ""}`} title={`${pct.toFixed(0)}% of budget`}>
      <span style={{ width: `${Math.min(100, pct)}%` }} />
    </span>
  );
}
