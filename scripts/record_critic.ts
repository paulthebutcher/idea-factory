// Records critic fixtures: runs the Swiss tournament live over a set of complete viability briefs and
// writes one model transcript per comparison order under <fixture-dir>/model/critic/. The briefs come
// from complete viability recordings replayed into a scratch store, and are saved next to the
// transcripts as briefs.json so tests can replay the tournament without the viability stage.
//
//   npx tsx scripts/record_critic.ts --ideas A01,A02,O03,H02,H04 --cap 1.5 [--fixture-dir DIR]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS, loadPrompts } from "../src/config.js";
import { openDb } from "../src/store/db.js";
import { seedIdeas } from "./seed.js";
import { createRun } from "../src/runner/run.js";
import { createSearchClients } from "../src/search/index.js";
import { createModelClient, BudgetExceededError, sampleFixtureName } from "../src/model/client.js";
import { TraceCollector } from "../src/trace.js";
import { runViability } from "../src/stages/viability.js";
import { runCritic } from "../src/stages/critic.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = process.argv[i + 1];
  return i >= 0 && v && !v.startsWith("--") ? v : undefined;
}

async function main() {
  const ideas = (arg("ideas") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ideas.length < 2) throw new Error("--ideas needs at least two idea ids with complete viability recordings");
  const cap = Number(arg("cap") ?? 1.5);
  const fixtureDir = path.resolve(arg("fixture-dir") ?? PATHS.fixtures);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "idea-factory-critic-"));
  const db = openDb(path.join(dir, "factory.db"));
  seedIdeas(db);
  const prompts = loadPrompts();

  // Replay viability sample 1 for each idea to get its brief into the scratch store.
  const replayModel = createModelClient({ mode: "replay", fixtureDir });
  const briefs: Record<string, string> = {};
  for (const ideaId of ideas) {
    const run = createRun(db, { stages: ["viability"], ideaIds: [ideaId], budgetUsd: cap, searchMode: "replay", modelMode: "replay", prompts });
    const [task] = db.createTasks(run.id, "viability", [ideaId]);
    db.claimTask(task.id, "replay");
    const trace = new TraceCollector();
    const search = createSearchClients({ mode: "replay", fixtureDir, trace });
    const r = await runViability({ db, runId: run.id, taskId: task.id, ideaId, agent: "replay", search, model: replayModel, trace, prompts, fixtureName: sampleFixtureName(ideaId, 1) });
    console.log(`  viability replay ${ideaId}: ${r.verdict}`);
    if (r.verdict !== "complete") throw new Error(`${ideaId} viability is ${r.verdict}; the critic needs complete briefs`);
    briefs[ideaId] = r.docMd!;
  }

  let spent = 0;
  const onSpend = (usd: number) => {
    spent += usd;
    if (spent > cap) throw new BudgetExceededError(`live spend $${spent.toFixed(4)} exceeded cap $${cap}`);
  };
  const model = createModelClient({ mode: "record", fixtureDir, onSpend });
  const run = createRun(db, { stages: ["critic"], ideaIds: ideas, budgetUsd: cap, searchMode: "record", modelMode: "record", prompts });
  try {
    const c = await runCritic({
      db, runId: run.id, ideaIds: ideas, agent: `script:${process.pid}`, model, prompts,
      onComparison: (row) => console.log(`  round ${row.round}: ${row.idea_a} vs ${row.idea_b} -> ab=${row.order_ab} ba=${row.order_ba} result=${row.result}  total $${spent.toFixed(4)}`),
    });
    for (const s of c.standings) console.log(`  #${s.rank} ${s.ideaId} score ${s.score} (W${s.wins} T${s.ties} L${s.losses} bye${s.byes}) opp ${s.opponentScore}`);
  } catch (e) {
    if (e instanceof BudgetExceededError) console.log(`stopped: ${e.message}`);
    else throw e;
  }
  const out = path.join(fixtureDir, "model/critic");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "briefs.json"), JSON.stringify({ recorded_at: new Date().toISOString(), ideas, briefs }, null, 2) + "\n");
  fs.appendFileSync(path.join(fixtureDir, "recording_log.jsonl"), JSON.stringify({ recorded_at: new Date().toISOString(), stage: "critic", ideas, cap_usd: cap, live_spend_usd: Number(spent.toFixed(4)) }) + "\n");
  console.log(`live spend this recording: $${spent.toFixed(4)}`);
  db.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
