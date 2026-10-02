// Checkpoint 2 report for one run: counts per verdict per stage, cost per stage, the critic ranking,
// and a shortlist of traces most likely to be wrong, chosen by mechanical signals (overrides, unknowns
// on hard tests, many unsourced URLs, order flips, thin briefs). Reads only agent-visible data plus
// the run's own results; labels and outcomes stay in report_calibration.
//   npx tsx scripts/report_run.ts --run live_run_1[,live_run_2,...]   (several runs: latest result per idea and stage wins)
import { openDb } from "../src/store/db.js";
import { PATHS } from "../src/config.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = process.argv[i + 1];
  return i >= 0 && v && !v.startsWith("--") ? v : undefined;
}

const runArg = arg("run");
if (!runArg) throw new Error("--run <run id>[,<run id>...] is required");
const runIds = runArg.split(",").map((s) => s.trim()).filter(Boolean);
const runId = runIds.join(",");
const db = openDb(PATHS.db);
const runs = runIds.map((id) => {
  const r = db.getRun(id);
  if (!r) throw new Error(`run ${id} not found`);
  return r;
});
const run = { ...runs[runs.length - 1], budget_usd: runs.reduce((a, r) => a + r.budget_usd, 0), spent_usd: runs.reduce((a, r) => a + r.spent_usd, 0), status: runs.map((r) => `${r.id}:${r.status}`).join(" "), started_at: runs[0].started_at, finished_at: runs[runs.length - 1].finished_at };
// Latest result per (idea, stage) across the listed runs, so retried tasks count once. Critic rows are all kept.
const allRows = runIds.flatMap((id) => db.listStageResults({ runId: id }));
const latest = new Map<string, (typeof allRows)[number]>();
for (const r of allRows) {
  if (r.stage === "critic") continue;
  const k = `${r.idea_id}|${r.stage}`;
  const prev = latest.get(k);
  if (!prev || r.created_at > prev.created_at || (r.created_at === prev.created_at && r.id > prev.id)) latest.set(k, r);
}
const rows = [...latest.values(), ...allRows.filter((r) => r.stage === "critic")];
const allCost = allRows.reduce((a, r) => a + r.cost_usd, 0);
const kg = rows.filter((r) => r.stage === "kill_gate");
const via = rows.filter((r) => r.stage === "viability");
const critic = rows.filter((r) => r.stage === "critic");
const comparisons = critic.filter((r) => JSON.parse(r.payload_json).kind === "comparison");
const standings = critic.filter((r) => JSON.parse(r.payload_json).kind === "standing").map((r) => ({ ...JSON.parse(r.payload_json), trace: r.id }));
const sum = (xs: { cost_usd: number }[]) => xs.reduce((a, r) => a + r.cost_usd, 0);
const count = (xs: { verdict: string }[]) => {
  const c: Record<string, number> = {};
  for (const r of xs) c[r.verdict] = (c[r.verdict] ?? 0) + 1;
  return Object.entries(c).sort().map(([k, v]) => `${k} ${v}`).join(", ") || "none";
};

console.log(`# Run ${runId}\n`);
console.log(`Status **${run.status}**, budget $${run.budget_usd.toFixed(2)} (sum of run budgets), spent $${run.spent_usd.toFixed(2)} across ${runIds.length} run(s) (all results incl. superseded retries: $${allCost.toFixed(2)}), ${run.started_at} to ${run.finished_at ?? "(running)"}. Open tasks: ${runIds.reduce((a, id) => a + db.listTasks(id, "open").length, 0)}.\n`);
console.log("## Counts per verdict and cost per stage\n");
console.log("| Stage | Results | Verdicts | Cost | Per unit |");
console.log("|---|---|---|---|---|");
const kgAll = allRows.filter((r) => r.stage === "kill_gate"), viaAll = allRows.filter((r) => r.stage === "viability");
console.log(`| Kill gate | ${kg.length} ideas (${kgAll.length} attempts) | ${count(kg)} | $${sum(kgAll).toFixed(2)} | $${(kg.length ? sum(kgAll) / kg.length : 0).toFixed(3)} per idea |`);
console.log(`| Viability | ${via.length} ideas (${viaAll.length} attempts) | ${count(via)} | $${sum(viaAll).toFixed(2)} | $${(via.length ? sum(viaAll) / via.length : 0).toFixed(3)} per idea |`);
console.log(`| Critic | ${comparisons.length} comparisons, ${standings.length} ranked | ${count(comparisons)} | $${sum(critic).toFixed(2)} | $${(comparisons.length ? sum(critic) / comparisons.length / 2 : 0).toFixed(3)} per call |`);
console.log(`| **Total** | | | **$${run.spent_usd.toFixed(2)}** | |\n`);

const rulesFired: Record<string, number> = {};
for (const r of kg) for (const id of JSON.parse(r.rules_fired ?? "[]")) rulesFired[id] = (rulesFired[id] ?? 0) + 1;
const flags: Record<string, number> = {};
for (const r of kg) for (const f of JSON.parse(r.payload_json).flags ?? []) flags[f.id] = (flags[f.id] ?? 0) + 1;
console.log(`Kill rules fired: ${Object.entries(rulesFired).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}. Flags: ${Object.entries(flags).sort().map(([k, v]) => `${k} ${v}`).join(", ") || "none"}.`);
console.log(`Kills: ${kg.filter((r) => r.verdict === "kill").map((r) => `${r.idea_id}[${JSON.parse(r.rules_fired ?? "[]").join(",")}]`).join(" ")}`);
console.log(`Errors: ${kg.filter((r) => r.verdict === "error").map((r) => `${r.idea_id} (${JSON.parse(r.payload_json).error})`).join("; ") || "none"}`);
const overrides = kg.filter((r) => (JSON.parse(r.payload_json).runner?.overrides ?? []).length > 0);
console.log(`Runner overrides: ${overrides.map((r) => `${r.idea_id}: ${JSON.parse(r.payload_json).runner.overrides.join("; ")}`).join(" | ") || "none"}`);
console.log(`Variants proposed: ${kg.filter((r) => JSON.parse(r.payload_json).proposed_variant).length}. self_found: ${kg.filter((r) => r.self_found).map((r) => r.idea_id).join(", ") || "none"}.\n`);

console.log("## Viability\n");
const failEv = via.filter((r) => r.verdict === "fail_evidence");
console.log(`fail_evidence (${failEv.length}): ${failEv.map((r) => `${r.idea_id} [${(JSON.parse(r.payload_json).runner?.missing ?? []).join("; ")}]`).join(" · ") || "none"}`);
const unsourcedTotal = via.reduce((a, r) => a + (JSON.parse(r.payload_json).runner?.unsourced_moved?.length ?? 0), 0);
console.log(`Unsourced URLs moved: ${unsourcedTotal} across ${via.filter((r) => (JSON.parse(r.payload_json).runner?.unsourced_moved?.length ?? 0) > 0).length} briefs. Errors: ${via.filter((r) => r.verdict === "error").map((r) => r.idea_id).join(", ") || "none"}.\n`);

console.log("## Critic ranking\n");
if (standings.length) {
  console.log("| Rank | Idea | Score | W-T-L | Byes | Opp score | Trace |");
  console.log("|---|---|---|---|---|---|---|");
  for (const s of [...standings].sort((a, b) => a.rank - b.rank)) console.log(`| ${s.rank} | ${s.ideaId} | ${s.score} | ${s.wins}-${s.ties}-${s.losses} | ${s.byes} | ${s.opponentScore} | ${s.trace} |`);
  const ties = comparisons.filter((r) => JSON.parse(r.payload_json).result === "tie").length;
  console.log(`\n${comparisons.length} comparisons, ${ties} order flips recorded as ties (${comparisons.length ? Math.round((100 * ties) / comparisons.length) : 0}%).\n`);
} else console.log("No standings.\n");

console.log("## Traces most likely wrong (mechanical shortlist)\n");
type Cand = { score: number; trace: string; idea: string; stage: string; why: string };
const cands: Cand[] = [];
for (const r of kg) {
  const p = JSON.parse(r.payload_json);
  const unknownHard = (p.tests ?? []).filter((t: any) => t.result === "unknown" && ["R001", "T2", "T3", "T7"].includes(t.id)).map((t: any) => t.id);
  if (unknownHard.length) cands.push({ score: 2 + unknownHard.length, trace: r.id, idea: r.idea_id, stage: "kill_gate", why: `hard test(s) ${unknownHard.join(",")} marked unknown, verdict ${r.verdict}` });
  if ((p.runner?.overrides ?? []).length) cands.push({ score: 4, trace: r.id, idea: r.idea_id, stage: "kill_gate", why: `runner override: ${p.runner.overrides.join("; ")}` });
  const fired = JSON.parse(r.rules_fired ?? "[]");
  if (r.verdict === "kill" && fired.length === 1 && !(p.tests ?? []).find((t: any) => t.id === fired[0])?.source_url) cands.push({ score: 3, trace: r.id, idea: r.idea_id, stage: "kill_gate", why: `killed on ${fired[0]} with no source URL` });
  if ((p.competitors ?? []).length === 0 && r.verdict !== "error") cands.push({ score: 2, trace: r.id, idea: r.idea_id, stage: "kill_gate", why: "no competitors found at all" });
  if (r.verdict === "error") cands.push({ score: 1, trace: r.id, idea: r.idea_id, stage: "kill_gate", why: `error: ${p.error}` });
}
for (const r of via) {
  const p = JSON.parse(r.payload_json);
  const moved = p.runner?.unsourced_moved?.length ?? 0;
  if (moved >= 3) cands.push({ score: 2 + Math.min(3, moved - 2), trace: r.id, idea: r.idea_id, stage: "viability", why: `${moved} URLs moved to unsourced` });
  if (r.verdict === "complete" && (r.doc_md?.length ?? 0) < 2500) cands.push({ score: 3, trace: r.id, idea: r.idea_id, stage: "viability", why: `complete but brief is only ${r.doc_md?.length ?? 0} chars` });
  if (r.verdict === "complete" && (p.demand_evidence ?? []).length === 1) cands.push({ score: 2, trace: r.id, idea: r.idea_id, stage: "viability", why: "complete on a single demand quote" });
  if ((p.injection_seen ?? []).length) cands.push({ score: 3, trace: r.id, idea: r.idea_id, stage: "viability", why: `injection_seen: ${p.injection_seen.length}` });
}
for (const r of comparisons) {
  const p = JSON.parse(r.payload_json);
  const conf = `${p.rationale?.ab?.confidence_note ?? ""} ${p.rationale?.ba?.confidence_note ?? ""}`.toLowerCase();
  if (p.result === "tie" && !/thin|close|low confidence|hard to separate|toss-?up|marginal/.test(conf)) cands.push({ score: 3, trace: r.id, idea: `${p.idea_a} vs ${p.idea_b}`, stage: "critic", why: "order flip with confident rationales in both orders" });
}
const byTrace = new Map<string, Cand>();
for (const c of cands) {
  const prev = byTrace.get(c.trace);
  if (!prev) byTrace.set(c.trace, { ...c });
  else (prev.score += c.score, (prev.why += "; " + c.why));
}
const top = [...byTrace.values()].sort((a, b) => b.score - a.score).slice(0, 10);
console.log("| Signal score | Stage | Idea | Trace | Why |");
console.log("|---|---|---|---|---|");
for (const c of top) console.log(`| ${c.score} | ${c.stage} | ${c.idea} | ${c.trace} | ${c.why} |`);
db.close();
