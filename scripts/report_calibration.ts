// Calibration report. The only code that reads labels and outcomes. Compares the latest kill-gate
// verdict and critic rank against paul_gut_v1, research and perplexity labels, and critic rank against
// backtest outcome buckets. Prints tables. Runs after Checkpoint 2 and never feeds back into prompts.
//   npm run report:calibration [-- --run <run id>]
import { openDb } from "../src/store/db.js";
import { PATHS } from "../src/config.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = process.argv[i + 1];
  return i >= 0 && v && !v.startsWith("--") ? v : undefined;
}

const db = openDb(PATHS.db);
const runFilter = arg("run");
const runClause = runFilter ? "AND sr.run_id = ?" : "";
const runArgs = runFilter ? [runFilter] : [];

const kg = db.raw
  .prepare(
    `SELECT sr.idea_id, sr.verdict, sr.rules_fired, sr.self_found FROM stage_results sr
     WHERE sr.stage = 'kill_gate' ${runClause}
       AND sr.rowid = (SELECT s2.rowid FROM stage_results s2 WHERE s2.idea_id = sr.idea_id AND s2.stage = 'kill_gate' ${runClause.replace("sr.", "s2.")} ORDER BY s2.created_at DESC, s2.rowid DESC LIMIT 1)`,
  )
  .all(...runArgs, ...runArgs) as { idea_id: string; verdict: string; rules_fired: string; self_found: number }[];
const labels = db.raw.prepare("SELECT idea_id, labeler, value, reason FROM labels").all() as { idea_id: string; labeler: string; value: string; reason: string | null }[];
const outcomes = db.raw.prepare("SELECT idea_id, bucket FROM outcomes").all() as { idea_id: string; bucket: string }[];
const ranks = db.raw
  .prepare(
    `SELECT sr.idea_id, json_extract(sr.payload_json, '$.rank') AS rank, json_extract(sr.payload_json, '$.score') AS score FROM stage_results sr
     WHERE sr.stage = 'critic' AND json_extract(sr.payload_json, '$.kind') = 'standing' ${runClause}
       AND sr.rowid = (SELECT s2.rowid FROM stage_results s2 WHERE s2.idea_id = sr.idea_id AND s2.stage = 'critic' AND json_extract(s2.payload_json, '$.kind') = 'standing' ${runClause.replace("sr.", "s2.")} ORDER BY s2.created_at DESC, s2.rowid DESC LIMIT 1)`,
  )
  .all(...runArgs, ...runArgs) as { idea_id: string; rank: number; score: number }[];

const labelOf = (id: string, labeler: string) => labels.find((l) => l.idea_id === id && l.labeler === labeler);
const verdictOf = new Map(kg.map((r) => [r.idea_id, r]));
const rankOf = new Map(ranks.map((r) => [r.idea_id, r]));

console.log("## Kill gate verdict vs labels\n");
for (const labeler of ["paul_gut_v1", "research", "perplexity"]) {
  const cells: Record<string, Record<string, number>> = {};
  for (const r of kg) {
    const l = labelOf(r.idea_id, labeler);
    if (!l) continue;
    (cells[l.value] ??= {})[r.verdict] = ((cells[l.value] ??= {})[r.verdict] ?? 0) + 1;
  }
  const verdicts = [...new Set(kg.map((r) => r.verdict))].sort();
  console.log(`### ${labeler}\n`);
  console.log(`| label \\ verdict | ${verdicts.join(" | ")} |`);
  console.log(`|---|${verdicts.map(() => "---").join("|")}|`);
  for (const v of ["yes", "conditional", "no"]) if (cells[v]) console.log(`| ${v} | ${verdicts.map((x) => cells[v][x] ?? 0).join(" | ")} |`);
  console.log("");
}

console.log("## Disagreements: killed but labelled yes, or passed but Paul said no\n");
console.log("| Idea | Verdict | Rules | paul_gut_v1 | reason | research | perplexity | self_found |");
console.log("|---|---|---|---|---|---|---|---|");
for (const r of kg) {
  const paul = labelOf(r.idea_id, "paul_gut_v1");
  const res = labelOf(r.idea_id, "research") ?? labelOf(r.idea_id, "claude_seed");
  const per = labelOf(r.idea_id, "perplexity");
  const killedYes = r.verdict === "kill" && [paul?.value, res?.value, per?.value].includes("yes");
  const passedNo = r.verdict === "pass" && paul?.value === "no";
  if (!killedYes && !passedNo) continue;
  console.log(`| ${r.idea_id} | ${r.verdict} | ${JSON.parse(r.rules_fired ?? "[]").join(",") || "-"} | ${paul?.value ?? "-"} | ${paul?.reason ?? "-"} | ${res?.value ?? "-"} | ${per?.value ?? "-"} | ${r.self_found ? "1" : "0"} |`);
}
console.log("");

console.log("## Critic rank vs labels and backtest outcomes\n");
if (ranks.length === 0) console.log("No critic standings yet.\n");
else {
  console.log("| Rank | Idea | Score | paul_gut_v1 | research | perplexity | outcome bucket | self_found |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of [...ranks].sort((a, b) => a.rank - b.rank)) {
    const o = outcomes.find((x) => x.idea_id === r.idea_id);
    console.log(`| ${r.rank} | ${r.idea_id} | ${r.score} | ${labelOf(r.idea_id, "paul_gut_v1")?.value ?? "-"} | ${(labelOf(r.idea_id, "research") ?? labelOf(r.idea_id, "claude_seed"))?.value ?? "-"} | ${labelOf(r.idea_id, "perplexity")?.value ?? "-"} | ${o?.bucket ?? "-"} | ${verdictOf.get(r.idea_id)?.self_found ? "1" : "0"} |`);
  }
  console.log("");
  const bt = ranks.filter((r) => outcomes.some((o) => o.idea_id === r.idea_id));
  if (bt.length) {
    console.log("### Backtest rows by bucket (mean rank, lower is better)\n");
    const byBucket = new Map<string, number[]>();
    for (const r of bt) {
      const b = outcomes.find((o) => o.idea_id === r.idea_id)!.bucket;
      byBucket.set(b, [...(byBucket.get(b) ?? []), r.rank]);
    }
    console.log("| Bucket | n | mean rank |");
    console.log("|---|---|---|");
    for (const [b, rs] of byBucket) console.log(`| ${b} | ${rs.length} | ${(rs.reduce((a, c) => a + c, 0) / rs.length).toFixed(1)} |`);
    console.log("");
  }
}
console.log(`Kill gate rows: ${kg.length}. Critic standings: ${ranks.length}. Ideas with labels: ${new Set(labels.map((l) => l.idea_id)).size}. Backtest outcomes: ${outcomes.length}.`);
db.close();
