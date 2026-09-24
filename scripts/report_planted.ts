// Replays every recorded sample of the planted kill-gate cases into a scratch store and prints the
// Checkpoint 1 table: per-sample verdicts and rules, agreement rate, evidence cited. A case passes at
// full agreement, is "unstable" at all-but-one, and fails otherwise.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS, loadPrompts } from "../src/config.js";
import { openDb } from "../src/store/db.js";
import { seedIdeas } from "./seed.js";
import { createRun } from "../src/runner/run.js";
import { createSearchClients } from "../src/search/index.js";
import { createModelClient, sampleFixtureName } from "../src/model/client.js";
import { TraceCollector } from "../src/trace.js";
import { runKillGate } from "../src/stages/kill_gate.js";
import { PLANTED_CASES, SAMPLE_IDS, SAMPLES, judgeSample, agreementLabel } from "../tests/acceptance/planted.js";

function fixtureSpend(dir: string): { model: number; search: number; calls: number; transcripts: number } {
  let model = 0, search = 0, calls = 0, transcripts = 0;
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith(".json")) {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        if (Array.isArray(j.calls)) {
          transcripts++;
          for (const c of j.calls) (model += c.cost_usd ?? 0, calls++);
        } else if (typeof j.cost_usd === "number") search += j.cost_usd;
      }
    }
  };
  walk(dir);
  return { model, search, calls, transcripts };
}

async function main() {
  const fixtureDir = PATHS.fixtures;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idea-factory-report-"));
  const db = openDb(path.join(dir, "factory.db"));
  seedIdeas(db);
  const prompts = loadPrompts();
  const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s).replace(/\|/g, "/").replace(/\s+/g, " ");
  const rows: string[] = [];
  const evidenceRows: string[] = [];
  const problems: string[] = [];
  const tally = { pass: 0, unstable: 0, fail: 0 };

  for (const c of PLANTED_CASES) {
    const outcomes = [];
    const evidence: string[] = [];
    for (const s of SAMPLE_IDS) {
      const run = createRun(db, { stages: ["kill_gate"], ideaIds: [c.ideaId], budgetUsd: 5, searchMode: "replay", modelMode: "replay", prompts });
      const task = db.listTasks(run.id)[0];
      db.claimTask(task.id, "report");
      const trace = new TraceCollector();
      const search = createSearchClients({ mode: "replay", fixtureDir, trace });
      const model = createModelClient({ mode: "replay", fixtureDir });
      const r = await runKillGate({ db, runId: run.id, taskId: task.id, ideaId: c.ideaId, agent: "report", search, model, trace, prompts, fixtureName: sampleFixtureName(c.ideaId, s) });
      const failed = r.payload.tests.filter((t) => t.result === "fail");
      const o = judgeSample(c, s, r.verdict, r.rulesFired, failed.map((t) => t.id));
      outcomes.push({ ...o, flags: r.payload.flags.map((f) => f.id), error: r.payload.error ?? null, overrides: r.payload.runner.overrides, selfFound: r.selfFound, cost: r.costUsd });
      for (const t of failed) evidence.push(`s${s} ${t.id}: ${t.evidence}${t.source_url ? ` <${t.source_url}>` : ""}`);
      if (r.verdict === "error") problems.push(`${c.ideaId} s${s}: verdict error: ${r.payload.error}`);
      if (r.payload.runner.overrides.length) problems.push(`${c.ideaId} s${s}: runner override: ${r.payload.runner.overrides.join("; ")}`);
      if (r.selfFound) problems.push(`${c.ideaId} s${s}: self_found = 1`);
      if (c.mustNotTrigger && failed.some((t) => t.id === c.mustNotTrigger)) problems.push(`${c.ideaId} s${s}: ${c.mustNotTrigger} fired but must not`);
      if (c.mustTrigger && !o.ok) problems.push(`${c.ideaId} s${s}: expected kill with ${c.mustTrigger}, got ${r.verdict} with [${r.rulesFired.join(",")}]`);
    }
    const okCount = outcomes.filter((o) => o.ok).length;
    const label = agreementLabel(okCount);
    tally[label]++;
    const expected = c.mustTrigger ? `kill / ${c.mustTrigger}` : `${c.mustNotTrigger} silent`;
    const perSample = outcomes.map((o) => `${o.verdict}${o.rulesFired.length ? "[" + o.rulesFired.join(",") + "]" : ""}${o.flags.length ? "{" + o.flags.join(",") + "}" : ""}${o.ok ? "" : " ✗"}`).join(" · ");
    rows.push(`| ${c.ideaId} | ${expected} | ${perSample} | ${okCount}/${SAMPLES} | ${label.toUpperCase()} |`);
    evidenceRows.push(`- **${c.ideaId}**: ${evidence.length ? evidence.map((e) => short(e, 220)).join("<br>") : "no test marked fail"}`);
  }

  console.log("| Idea | Expected | Sample verdicts (s1 · s2 · s3), [rules fired] {flags} | Agreement | Result |");
  console.log("|---|---|---|---|---|");
  for (const r of rows) console.log(r);
  console.log(`\nCases: ${tally.pass} pass, ${tally.unstable} unstable, ${tally.fail} fail (of ${PLANTED_CASES.length})`);
  console.log("\nEvidence cited on failed tests:");
  for (const r of evidenceRows) console.log(r);
  console.log("");
  console.log(problems.length ? "Findings:\n" + problems.map((p) => `- ${p}`).join("\n") : "No rule fired on the wrong case; no overrides; no errors.");
  const spend = fixtureSpend(fixtureDir);
  console.log(`\nRecorded fixture cost in ${path.relative(process.cwd(), fixtureDir)}: model $${spend.model.toFixed(4)} over ${spend.calls} calls in ${spend.transcripts} transcripts, search $${spend.search.toFixed(4)}`);
  db.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
