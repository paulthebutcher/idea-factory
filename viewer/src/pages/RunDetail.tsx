import { Link, useParams } from "react-router-dom";
import { duration, usd, useGet, type ResultSummary, type RunSummary, type Stage, type Standing } from "../api.js";
import { Hash, IdeaLink, Loading, RunLink, Status, TraceLink, Verdict } from "../components/ui.js";
import { JsonTree } from "../components/JsonTree.js";
import { Bar } from "./Runs.js";

interface Task {
  id: string;
  idea_id: string | null;
  stage: Stage;
  claimed_by: string | null;
  claimed_at: string | null;
  status: string;
}

export function RunDetail() {
  const { id } = useParams();
  const { data, error } = useGet<{ run: RunSummary; results: ResultSummary[]; standings: Standing[]; tasks: Task[] }>(`/runs/${id}`);
  if (!data) return <Loading error={error} />;
  const { run, results, standings, tasks } = data;
  const byStage = (s: Stage) => results.filter((r) => r.stage === s);
  const comparisons = byStage("critic").filter((r) => r.kind === "comparison");
  return (
    <>
      <h1>
        Run <span className="mono">{run.id}</span> <Status s={run.status} />
      </h1>
      <dl className="facts">
        <dt>Stages</dt>
        <dd>{run.stages.join(", ")}</dd>
        <dt>Budget</dt>
        <dd>
          {usd(run.spent_usd, 2)} of {usd(run.budget_usd, 2)} <Bar frac={run.budget_usd ? run.spent_usd / run.budget_usd : 0} />
        </dd>
        <dt>Timing</dt>
        <dd>
          {run.started_at} → {run.finished_at ?? "(open)"} {duration(run.started_at, run.finished_at) && `(${duration(run.started_at, run.finished_at)})`}
        </dd>
        <dt>Models</dt>
        <dd>
          {Object.entries(run.config.models ?? {}).map(([s, m]) => (
            <div key={s}>
              <span className="muted">{s}</span> {m}
            </div>
          ))}
        </dd>
        <dt>Prompt hashes</dt>
        <dd>
          {Object.entries(run.config.prompt_hashes ?? {}).map(([s, h]) => (
            <div key={s}>
              <span className="muted">{s}</span> <Hash h={h} title={s} /> <code className="muted small">{h}</code>
            </div>
          ))}
        </dd>
        <dt>Mode</dt>
        <dd>
          search {run.config.search_mode ?? "?"}, model {run.config.model_mode ?? "?"}
        </dd>
        {(run.superseded_by.length > 0 || run.supersedes.length > 0) && (
          <>
            <dt>Superseded</dt>
            <dd>
              {run.superseded_by.length > 0 && (
                <div>
                  by{" "}
                  {run.superseded_by.map((r) => (
                    <RunLink key={r} id={r} />
                  ))}
                </div>
              )}
              {run.supersedes.length > 0 && (
                <div>
                  supersedes{" "}
                  {run.supersedes.map((r) => (
                    <RunLink key={r} id={r} />
                  ))}
                </div>
              )}
            </dd>
          </>
        )}
        <dt>Tasks</dt>
        <dd>
          {Object.entries(run.tasks)
            .sort()
            .map(([s, n]) => (
              <span key={s} className={`pill task-${s}`}>
                {s} {n}
              </span>
            ))}
        </dd>
        <dt>Links</dt>
        <dd>
          <Link to={`/ideas?run=${run.id}`}>pipeline for this run</Link>
          {comparisons.length > 0 && (
            <>
              {" · "}
              <Link to={`/runs/${run.id}/critic`}>critic tournament ({comparisons.length} comparisons)</Link>
            </>
          )}
        </dd>
      </dl>

      {(["kill_gate", "viability"] as Stage[]).map((stage) => {
        const rows = byStage(stage);
        if (rows.length === 0) return null;
        return (
          <section key={stage}>
            <h2>
              {stage} <span className="muted">{rows.length} results · {usd(rows.reduce((a, r) => a + r.cost_usd, 0), 2)}</span>
            </h2>
            <table className="grid">
              <thead>
                <tr>
                  <th>Idea</th>
                  <th>Verdict</th>
                  <th>Rules fired</th>
                  <th className="num">Cost</th>
                  <th>Model</th>
                  <th>Agent</th>
                  <th>Created</th>
                  <th>Trace</th>
                  <th className="num">Ann.</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <IdeaLink id={r.idea_id} />
                    </td>
                    <td>
                      <Verdict v={r.verdict} />
                      {r.self_found ? <span className="pill fm" title="research found the actual business">self_found</span> : null}
                    </td>
                    <td className="mono small">{r.rules_fired.join(", ")}</td>
                    <td className="num">{usd(r.cost_usd)}</td>
                    <td className="small">{r.model}</td>
                    <td className="small">{r.agent}</td>
                    <td className="muted small nowrap">{r.created_at}</td>
                    <td>
                      <TraceLink id={r.id} />
                    </td>
                    <td className="num">{r.annotations || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}

      {standings.length > 0 && (
        <section>
          <h2>
            Critic standings <span className="muted">{comparisons.length} comparisons · {usd(byStage("critic").reduce((a, r) => a + r.cost_usd, 0), 2)}</span>
          </h2>
          <table className="grid">
            <thead>
              <tr>
                <th className="num">Rank</th>
                <th>Idea</th>
                <th className="num">Score</th>
                <th>W-T-L</th>
                <th className="num">Byes</th>
                <th className="num">Opp. score</th>
                <th>Opponents</th>
                <th>Record</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((s) => (
                <tr key={s.ideaId}>
                  <td className="num">{s.rank}</td>
                  <td>
                    <IdeaLink id={s.ideaId} />
                  </td>
                  <td className="num">{s.score}</td>
                  <td className="mono">
                    {s.wins}-{s.ties}-{s.losses}
                  </td>
                  <td className="num">{s.byes}</td>
                  <td className="num">{s.opponentScore}</td>
                  <td className="small">
                    {s.opponents.map((o) => (
                      <IdeaLink key={o} id={o} />
                    ))}
                  </td>
                  <td>
                    <TraceLink id={s.stage_result_id} label="standing" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            <Link to={`/runs/${run.id}/critic`}>Full tournament table →</Link>
          </p>
        </section>
      )}

      <details>
        <summary>Tasks ({tasks.length})</summary>
        <table className="grid">
          <thead>
            <tr>
              <th>Task</th>
              <th>Stage</th>
              <th>Idea</th>
              <th>Status</th>
              <th>Claimed by</th>
              <th>Claimed at</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td className="mono small">{t.id}</td>
                <td>{t.stage}</td>
                <td>{t.idea_id && <IdeaLink id={t.idea_id} />}</td>
                <td>
                  <span className={`pill task-${t.status}`}>{t.status}</span>
                </td>
                <td className="small">{t.claimed_by}</td>
                <td className="small muted">{t.claimed_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <details>
        <summary>config_json</summary>
        <JsonTree value={run.config} open={2} />
      </details>
    </>
  );
}
