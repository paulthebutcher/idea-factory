// Replays recorded kill-gate samples into the real store (data/factory.db) so the traces Paul reviews
// and annotates live in the source of truth. One run per sample: run ids <label>_s1, <label>_s2, ...
//
//   npx tsx scripts/replay_fixtures.ts --ideas A07,B09 --samples 3 --label checkpoint1 [--fixture-dir DIR]
//   npx tsx scripts/replay_fixtures.ts --stage viability --ideas A01,A02 --samples 1 --label fixtures_viability
//   npx tsx scripts/replay_fixtures.ts --stage critic --ideas A01,A02,O03,... --label fixtures_critic
import path from "node:path";
import { PATHS, loadPrompts } from "../src/config.js";
import { openDb } from "../src/store/db.js";
import { createRun } from "../src/runner/run.js";
import { createSearchClients } from "../src/search/index.js";
import { createModelClient, sampleFixtureName } from "../src/model/client.js";
import { TraceCollector } from "../src/trace.js";
import { runKillGate } from "../src/stages/kill_gate.js";
import { runViability } from "../src/stages/viability.js";
import { runCritic } from "../src/stages/critic.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "true";
}

async function main() {
  const ideas = (arg("ideas") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!ideas.length) throw new Error("--ideas is required");
  const samples = Number(arg("samples") ?? 3);
  const stage = (arg("stage") ?? "kill_gate") as "kill_gate" | "viability" | "critic";
  const label = arg("label") ?? `replay_${Date.now()}`;
  const fixtureDir = path.resolve(arg("fixture-dir") ?? PATHS.fixtures);
  const db = openDb(PATHS.db);
  const prompts = loadPrompts();
  const model = createModelClient({ mode: "replay", fixtureDir });
  if (stage === "critic") {
    const runId = label;
    if (db.getRun(runId)) {
      console.log(`${runId}: already exists, skipped`);
    } else {
      createRun(db, { id: runId, stages: ["critic"], ideaIds: ideas, budgetUsd: 100, searchMode: "replay", modelMode: "replay", prompts });
      const c = await runCritic({ db, runId, ideaIds: ideas, agent: `script:${process.pid}`, model, prompts, onComparison: (r) => console.log(`${runId} round ${r.round}: ${r.idea_a} vs ${r.idea_b} -> ${r.result}`) });
      for (const st of c.standings) console.log(`  #${st.rank} ${st.ideaId} score ${st.score} opp ${st.opponentScore}`);
      db.finishRun(runId, "complete");
    }
    db.close();
    return;
  }
  for (let s = 1; s <= samples; s++) {
    const runId = `${label}_s${s}`;
    if (db.getRun(runId)) {
      console.log(`${runId}: already exists, skipped`);
      continue;
    }
    createRun(db, { id: runId, stages: [stage], ideaIds: ideas, budgetUsd: 100, searchMode: "replay", modelMode: "replay", prompts });
    if (stage === "viability") db.createTasks(runId, "viability", ideas);
    for (const task of db.listTasks(runId, "open")) {
      if (db.claimTask(task.id, `script:${process.pid}`) !== "claimed") continue;
      const trace = new TraceCollector();
      const search = createSearchClients({ mode: "replay", fixtureDir, trace });
      const base = { db, runId, taskId: task.id, ideaId: task.idea_id!, agent: `script:${process.pid}`, search, model, trace, prompts, fixtureName: sampleFixtureName(task.idea_id!, s) };
      if (stage === "viability") {
        const r = await runViability(base);
        console.log(`${runId} ${task.idea_id}: ${r.verdict}${r.payload.runner.missing.length ? " missing " + r.payload.runner.missing.join("; ") : ""} -> ${r.stageResultId}`);
      } else {
        const r = await runKillGate(base);
        console.log(`${runId} ${task.idea_id}: ${r.verdict}${r.rulesFired.length ? " [" + r.rulesFired.join(",") + "]" : ""} -> ${r.stageResultId}`);
      }
    }
    db.finishRun(runId, "complete");
  }
  db.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
