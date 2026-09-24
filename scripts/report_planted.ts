// Replays every recorded sample of the planted kill-gate cases (from rules.test_case_ids) into a
// scratch store and prints: per-sample verdicts, agreement rate, a before/after column for cases that
// were re-recorded (before = the store's checkpoint1 runs), every T8 flag with its obligations, and
// evidence cited. A case passes at full agreement, is "unstable" at all-but-one, and fails otherwise.
//
//   npm run report:planted [-- --before-label checkpoint1]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { PATHS, loadPrompts } from "../src/config.js";
import { openDb } from "../src/store/db.js";
import { seedIdeas } from "./seed.js";
import { createRun } from "../src/runner/run.js";
import { createSearchClients } from "../src/search/index.js";
import { createModelClient, sampleFixtureName } from "../src/model/client.js";
import { TraceCollector } from "../src/trace.js";
import { runKillGate } from "../src/stages/kill_gate.js";
import { plantedCasesFromDb, SAMPLE_IDS, SAMPLES, judgeSample, agreementLabel, describeExpectation } from "../tests/acceptance/planted.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : undefined;
}

function fixtureSpend(dir: string): { model: number; search: number; calls: number; transcripts: number } {
  let model = 0, search = 0, calls = 0, transcripts = 0;
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) {
        if (f.name !== "archive") walk(p);
      } else if (f.name.endsWith(".json")) {
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

/** Before column: verdicts per sample from the real store's <label>_s<n> runs, if present. */
function beforeFromStore(label: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!fs.existsSync(PATHS.db)) return out;
  const raw = new Database(PATHS.db, { readonly: true });
  try {
    const rows = raw.prepare("SELECT run_id, idea_id, verdict, rules_fired FROM stage_results WHERE run_id LIKE ? ORDER BY run_id").all(`${label}_s%`) as { run_id: string; idea_id: string; verdict: string; rules_fired: string }[];
    for (const r of rows) {
      const fired = JSON.parse(r.rules_fired ?? "[]") as string[];
      const list = out.get(r.idea_id) ?? [];
      list.push(`${r.verdict}${fired.length ? "[" + fired.join(",") + "]" : ""}`);
      out.set(r.idea_id, list);
    }
  } finally {
    raw.close();
  }
  return out;
}

async function main() {
  const fixtureDir = PATHS.fixtures;
  const beforeLabel = arg("before-label") ?? "checkpoint1";
  const before = beforeFromStore(beforeLabel);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idea-factory-report-"));
  const db = openDb(path.join(dir, "factory.db"));
  seedIdeas(db);
  const prompts = loadPrompts();
  const cases = plantedCasesFromDb(db);
  const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s).replace(/\|/g, "/").replace(/\s+/g, " ");

  // Replay each idea's samples once.
  const ideaIds = [...new Set(cases.map((c) => c.ideaId))];
  const results = new Map<string, Awaited<ReturnType<typeof runKillGate>>[]>();
  for (const ideaId of ideaIds) {
    const list = [];
    for (const s of SAMPLE_IDS) {
      const run = createRun(db, { stages: ["kill_gate"], ideaIds: [ideaId], budgetUsd: 5, searchMode: "replay", modelMode: "replay", prompts });
      const task = db.listTasks(run.id)[0];
      db.claimTask(task.id, "report");
      const trace = new TraceCollector();
      const search = createSearchClients({ mode: "replay", fixtureDir, trace });
      const model = createModelClient({ mode: "replay", fixtureDir });
      list.push(await runKillGate({ db, runId: run.id, taskId: task.id, ideaId, agent: "report", search, model, trace, prompts, fixtureName: sampleFixtureName(ideaId, s) }));
    }
    results.set(ideaId, list);
  }

  const rows: string[] = [];
  const problems: string[] = [];
  const tally = { pass: 0, unstable: 0, fail: 0, observe: 0 };
  for (const c of cases) {
    const rs = results.get(c.ideaId)!;
    const outcomes = rs.map((r, i) => judgeSample(c, i + 1, { verdict: r.verdict, rulesFired: r.rulesFired, failedTestIds: r.payload.tests.filter((t) => t.result === "fail").map((t) => t.id), flagIds: r.payload.flags.map((f) => f.id) }));
    const okCount = outcomes.filter((o) => o.ok).length;
    const label = c.kind === "observe" ? "observe" : agreementLabel(okCount);
    tally[label]++;
    const perSample = outcomes.map((o) => `${o.verdict}${o.rulesFired.length ? "[" + o.rulesFired.join(",") + "]" : ""}{${o.flagIds.join(",")}}${o.ok || c.kind === "observe" ? "" : " ✗"}`).join(" · ");
    const b = before.get(c.ideaId);
    const changed = b && JSON.stringify(b) !== JSON.stringify(outcomes.map((o) => `${o.verdict}${o.rulesFired.length ? "[" + o.rulesFired.join(",") + "]" : ""}`));
    const beforeCol = b ? (changed ? b.join(" · ") : "same") : "n/a";
    rows.push(`| ${c.ideaId} | ${describeExpectation(c)} | ${beforeCol} | ${perSample} | ${c.kind === "observe" ? "-" : `${okCount}/${SAMPLES}`} | ${label.toUpperCase()} |`);
    rs.forEach((r, i) => {
      const s = i + 1;
      if (r.verdict === "error") problems.push(`${c.ideaId} s${s}: verdict error: ${r.payload.error}`);
      if (c.kind === "must_trigger" && !outcomes[i].ok) problems.push(`${c.ideaId} s${s}: expected ${describeExpectation(c)}, got ${r.verdict} with [${r.rulesFired.join(",")}] flags {${r.payload.flags.map((f) => f.id).join(",")}}`);
      if (c.kind === "must_not_trigger" && !outcomes[i].ok) problems.push(`${c.ideaId} s${s}: ${c.ruleId} fired but must not`);
    });
  }
  // Per-idea findings that do not depend on the rule.
  for (const [ideaId, rs] of results) {
    rs.forEach((r, i) => {
      const s = i + 1;
      if (r.payload.runner.overrides.length) problems.push(`${ideaId} s${s}: runner override: ${r.payload.runner.overrides.join("; ")}`);
      if (r.selfFound) problems.push(`${ideaId} s${s}: self_found = 1`);
      if (r.payload.runner.notes.some((n) => n.includes("T8"))) problems.push(`${ideaId} s${s}: T8 flag without named obligations`);
    });
  }

  console.log(`| Idea | Expected | Before (${beforeLabel}) | Sample verdicts (s1 · s2 · s3), [rules fired] {flags} | Agreement | Result |`);
  console.log("|---|---|---|---|---|---|");
  for (const r of rows) console.log(r);
  console.log(`\nCases: ${tally.pass} pass, ${tally.unstable} unstable, ${tally.fail} fail, ${tally.observe} observe-only (of ${cases.length})`);

  console.log("\nT8 flags and the obligations they named:");
  let anyT8 = false;
  for (const [ideaId, rs] of results) {
    rs.forEach((r, i) => {
      for (const f of r.payload.flags.filter((f) => f.id === "T8")) {
        anyT8 = true;
        console.log(`- ${ideaId} s${i + 1}: ${f.obligations.length ? f.obligations.map((o) => short(o, 140)).join("; ") : "(no obligations named)"}`);
      }
    });
  }
  if (!anyT8) console.log("- none");

  console.log("\nEvidence cited on failed tests:");
  for (const [ideaId, rs] of results) {
    const ev: string[] = [];
    rs.forEach((r, i) => {
      for (const t of r.payload.tests.filter((t) => t.result === "fail")) ev.push(`s${i + 1} ${t.id}: ${t.evidence}${t.source_url ? ` <${t.source_url}>` : ""}`);
    });
    console.log(`- **${ideaId}**: ${ev.length ? ev.map((e) => short(e, 220)).join("<br>") : "no test marked fail"}`);
  }
  console.log("");
  console.log(problems.length ? "Findings:\n" + problems.map((p) => `- ${p}`).join("\n") : "No rule fired on the wrong case; no overrides; no errors.");
  const spend = fixtureSpend(fixtureDir);
  console.log(`\nRecorded fixture cost in ${path.relative(process.cwd(), fixtureDir)} (excluding archive): model $${spend.model.toFixed(4)} over ${spend.calls} calls in ${spend.transcripts} transcripts, search $${spend.search.toFixed(4)}`);
  db.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
