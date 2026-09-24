// Replays the planted kill-gate cases from recorded fixtures into a scratch store and prints the
// Checkpoint 1 table: idea, expected verdict and rule, actual verdict, tests fired, evidence cited.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS, loadPrompts } from "../src/config.js";
import { openDb } from "../src/store/db.js";
import { seedIdeas } from "./seed.js";
import { createRun } from "../src/runner/run.js";
import { createSearchClients } from "../src/search/index.js";
import { createModelClient } from "../src/model/client.js";
import { TraceCollector } from "../src/trace.js";
import { runKillGate } from "../src/stages/kill_gate.js";
import { PLANTED_CASES } from "../tests/acceptance/planted.js";

function fixtureSpend(dir: string): { model: number; search: number; calls: number } {
  let model = 0, search = 0, calls = 0;
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith(".json")) {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        if (Array.isArray(j.calls)) for (const c of j.calls) (model += c.cost_usd ?? 0, calls++);
        else if (typeof j.cost_usd === "number") search += j.cost_usd;
      }
    }
  };
  walk(dir);
  return { model, search, calls };
}

async function main() {
  const fixtureDir = PATHS.fixtures;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idea-factory-report-"));
  const db = openDb(path.join(dir, "factory.db"));
  seedIdeas(db);
  const prompts = loadPrompts();
  const rows: string[] = [];
  const problems: string[] = [];
  const short = (s: string, n = 110) => (s.length > n ? s.slice(0, n - 1) + "…" : s).replace(/\|/g, "/").replace(/\s+/g, " ");

  for (const c of PLANTED_CASES) {
    const run = createRun(db, { stages: ["kill_gate"], ideaIds: [c.ideaId], budgetUsd: 5, searchMode: "replay", modelMode: "replay", prompts });
    const task = db.listTasks(run.id)[0];
    db.claimTask(task.id, "report");
    const trace = new TraceCollector();
    const search = createSearchClients({ mode: "replay", fixtureDir, trace });
    const model = createModelClient({ mode: "replay", fixtureDir });
    const r = await runKillGate({ db, runId: run.id, taskId: task.id, ideaId: c.ideaId, agent: "report", search, model, trace, prompts });
    const expected = c.mustTrigger ? `kill / ${c.mustTrigger}` : `not ${c.mustNotTrigger}`;
    const fired = r.payload.tests.filter((t) => t.result === "fail").map((t) => t.id);
    const evidence = r.payload.tests
      .filter((t) => t.result === "fail")
      .map((t) => `${t.id}: ${t.evidence}${t.source_url ? ` (${t.source_url})` : ""}`)
      .join(" · ");
    const flags = r.payload.flags.map((f) => f.id).join(",");
    rows.push(`| ${c.ideaId} | ${expected} | ${r.verdict}${r.payload.error ? " (" + short(r.payload.error, 60) + ")" : ""} | ${r.rulesFired.join(",") || "-"}${flags ? ` (flags ${flags})` : ""} | ${short(evidence || "-", 160)} |`);
    if (c.mustTrigger && (r.verdict !== "kill" || !r.rulesFired.includes(c.mustTrigger))) problems.push(`${c.ideaId}: expected kill with ${c.mustTrigger}, got ${r.verdict} with [${r.rulesFired.join(",")}]`);
    if (c.mustNotTrigger && fired.includes(c.mustNotTrigger)) problems.push(`${c.ideaId}: ${c.mustNotTrigger} fired but must not`);
    if (r.verdict === "error") problems.push(`${c.ideaId}: verdict error: ${r.payload.error}`);
    if (r.payload.runner.overrides.length) problems.push(`${c.ideaId}: runner override: ${r.payload.runner.overrides.join("; ")}`);
    if (r.selfFound) problems.push(`${c.ideaId}: self_found = 1 (backtest business surfaced by search)`);
  }

  console.log("| Idea | Expected | Actual verdict | Rules fired | Evidence cited |");
  console.log("|---|---|---|---|---|");
  for (const r of rows) console.log(r);
  console.log("");
  console.log(problems.length ? "Problems:\n" + problems.map((p) => `- ${p}`).join("\n") : "No rule fired on the wrong case.");
  const spend = fixtureSpend(fixtureDir);
  console.log(`\nRecorded fixture cost in ${path.relative(process.cwd(), fixtureDir)}: model $${spend.model.toFixed(4)} over ${spend.calls} calls, search $${spend.search.toFixed(4)}`);
  db.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
