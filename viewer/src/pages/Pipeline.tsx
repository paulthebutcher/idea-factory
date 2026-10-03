import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { usd, useGet, type PipelineCell, type PipelineRow, type RunSummary } from "../api.js";
import { IdeaLink, Loading, TraceLink, Verdict } from "../components/ui.js";

export function Pipeline() {
  const [params, setParams] = useSearchParams();
  const run = params.get("run") ?? "";
  const { data, error } = useGet<{ runs: string[]; rows: PipelineRow[] }>(`/pipeline?run=${encodeURIComponent(run)}`);
  const runs = useGet<RunSummary[]>("/runs").data;
  const [filter, setFilter] = useState("");
  const [hideInactive, setHideInactive] = useState(true);
  const [sort, setSort] = useState<"id" | "rank" | "cost">("id");

  const rows = useMemo(() => {
    if (!data) return [];
    let r = data.rows;
    if (hideInactive) r = r.filter((x) => x.idea.status === "active" || x.kill_gate || x.viability || x.critic);
    if (filter) {
      const f = filter.toLowerCase();
      r = r.filter((x) => x.idea.id.toLowerCase().includes(f) || x.idea.idea.toLowerCase().includes(f) || (x.idea.customer ?? "").toLowerCase().includes(f));
    }
    const cost = (x: PipelineRow) => (x.kill_gate?.cost ?? 0) + (x.viability?.cost ?? 0) + (x.critic?.cost ?? 0);
    if (sort === "rank") r = [...r].sort((a, b) => (a.critic?.rank ?? 1e9) - (b.critic?.rank ?? 1e9) || a.idea.id.localeCompare(b.idea.id));
    if (sort === "cost") r = [...r].sort((a, b) => cost(b) - cost(a));
    return r;
  }, [data, filter, hideInactive, sort]);

  if (!data) return <Loading error={error} />;
  const total = (k: "kill_gate" | "viability" | "critic") => rows.reduce((a, r) => a + (r[k]?.cost ?? 0), 0);
  return (
    <>
      <h1>Idea pipeline</h1>
      <div className="toolbar">
        <label>
          Run{" "}
          <select value={run} onChange={(e) => setParams(e.target.value ? { run: e.target.value } : {})}>
            <option value="">all runs (latest result per idea and stage)</option>
            {(runs ?? [])
              .slice()
              .reverse()
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id} ({r.status})
                </option>
              ))}
          </select>
        </label>
        <input placeholder="filter id / text / customer" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label>
          Sort{" "}
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="id">id</option>
            <option value="rank">critic rank</option>
            <option value="cost">cost</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={hideInactive} onChange={(e) => setHideInactive(e.target.checked)} /> hide unprocessed variants
        </label>
        <span className="muted">{rows.length} ideas</span>
      </div>
      <table className="grid pipeline">
        <thead>
          <tr>
            <th>Idea</th>
            <th>Text</th>
            <th colSpan={3}>Kill gate</th>
            <th colSpan={3}>Viability</th>
            <th colSpan={4}>Critic</th>
            <th className="num">Ann.</th>
          </tr>
          <tr className="sub">
            <th />
            <th />
            <th>verdict</th>
            <th className="num">cost</th>
            <th className="num">att.</th>
            <th>verdict</th>
            <th className="num">cost</th>
            <th className="num">att.</th>
            <th className="num">rank</th>
            <th>W-T-L</th>
            <th className="num">cost</th>
            <th className="num">cmp.</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.idea.id} className={r.idea.status !== "active" ? "inactive" : ""}>
              <td>
                <IdeaLink id={r.idea.id} />
                {r.idea.parent_id && (
                  <div className="small muted">
                    ← <IdeaLink id={r.idea.parent_id} />
                  </div>
                )}
                {r.idea.status !== "active" && <div className="pill small">{r.idea.status}</div>}
              </td>
              <td className="ideatext" title={r.idea.idea}>
                {r.idea.idea}
                {r.idea.customer && <div className="muted small">{r.idea.customer}</div>}
              </td>
              <Cell c={r.kill_gate} />
              <Cell c={r.viability} />
              <td className="num">{r.critic?.rank ?? ""}</td>
              <td className="mono">
                {r.critic?.record ? (
                  <TraceLink id={r.critic.id} label={`${r.critic.record.wins}-${r.critic.record.ties}-${r.critic.record.losses}`} />
                ) : (
                  ""
                )}
              </td>
              <td className="num">{r.critic ? usd(r.critic.cost, 2) : ""}</td>
              <td className="num">{r.critic?.comparisons ?? ""}</td>
              <td className="num">{r.annotations || ""}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2} className="muted">
              totals
            </td>
            <td />
            <td className="num">{usd(total("kill_gate"), 2)}</td>
            <td />
            <td />
            <td className="num">{usd(total("viability"), 2)}</td>
            <td />
            <td />
            <td />
            <td className="num">{usd(total("critic"), 2)}</td>
            <td />
            <td />
          </tr>
        </tfoot>
      </table>
      <p className="muted small">
        Attempts count every stage result for the idea and stage (retries across runs); the verdict shown is the latest. Critic cost is half of each comparison the idea took part in. <Link to="/runs">Runs →</Link>
      </p>
    </>
  );
}

function Cell({ c }: { c: PipelineCell | null }) {
  if (!c)
    return (
      <>
        <td className="muted">—</td>
        <td />
        <td />
      </>
    );
  return (
    <>
      <td>
        <Link to={`/traces/${c.id}`} title={`${c.id} (${c.run_id})`}>
          <Verdict v={c.verdict} />
        </Link>
        {c.rules_fired.length > 0 && <span className="mono small"> {c.rules_fired.join(", ")}</span>}
      </td>
      <td className="num">{usd(c.cost, 2)}</td>
      <td className={`num ${c.attempts > 1 ? "warn" : ""}`}>{c.attempts}</td>
    </>
  );
}
