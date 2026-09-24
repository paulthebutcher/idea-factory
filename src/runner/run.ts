// Creates a run and its tasks, claims each task, runs the stage, and enforces the budget in code.
// v0 step 4 runs the kill gate. Viability and critic tasks arrive in steps 5 and 6.
import { fileURLToPath } from "node:url";
import { ENV, MODELS, PATHS, loadPrompts, type Mode, type PromptSet, type Stage } from "../config.js";
import { openDb, type Db, type RunRow } from "../store/db.js";
import { createSearchClients } from "../search/index.js";
import { createModelClient, BudgetExceededError, type ModelClient } from "../model/client.js";
import { TraceCollector } from "../trace.js";
import { runKillGate, type KillGateRunResult } from "../stages/kill_gate.js";

export interface CreateRunOptions {
  stages: Stage[];
  ideaIds?: string[];
  budgetUsd?: number;
  searchMode?: Mode;
  modelMode?: Mode;
  prompts?: PromptSet;
}

export function createRun(db: Db, opts: CreateRunOptions): RunRow {
  const prompts = opts.prompts ?? loadPrompts();
  const ideaIds = opts.ideaIds ?? db.listAgentSafeIdeas().map((i) => i.id);
  const run = db.createRun({
    stages: opts.stages,
    budgetUsd: opts.budgetUsd ?? ENV.runBudgetUsd,
    configJson: {
      models: MODELS,
      prompt_hashes: { kill_gate: prompts.kill_gate.hash, viability: prompts.viability.hash, critic: prompts.critic.hash },
      search_mode: opts.searchMode ?? ENV.searchMode,
      model_mode: opts.modelMode ?? ENV.modelMode,
      budget_usd: opts.budgetUsd ?? ENV.runBudgetUsd,
      idea_ids: ideaIds,
    },
  });
  if (opts.stages.includes("kill_gate")) db.createTasks(run.id, "kill_gate", ideaIds);
  return run;
}

export interface ExecuteRunOptions {
  agent: string;
  searchMode: Mode;
  modelMode: Mode;
  fixtureDir: string;
  prompts?: PromptSet;
  model?: ModelClient;
  onResult?: (r: KillGateRunResult) => void;
}

export interface ExecuteRunSummary {
  runId: string;
  status: RunRow["status"];
  spentUsd: number;
  results: KillGateRunResult[];
}

/** Execute every open kill_gate task in the run. Stops with budget_exceeded when spend reaches the budget. */
export async function executeRun(db: Db, runId: string, opts: ExecuteRunOptions): Promise<ExecuteRunSummary> {
  const prompts = opts.prompts ?? loadPrompts();
  const model = opts.model ?? createModelClient({ mode: opts.modelMode, fixtureDir: opts.fixtureDir });
  const results: KillGateRunResult[] = [];
  let status: RunRow["status"] = "complete";
  try {
    for (const task of db.listTasks(runId, "open")) {
      const run = db.getRun(runId)!;
      if (run.spent_usd >= run.budget_usd) {
        status = "budget_exceeded";
        break;
      }
      if (task.stage !== "kill_gate" || !task.idea_id) continue;
      if (db.claimTask(task.id, opts.agent) !== "claimed") continue;
      const trace = new TraceCollector();
      const search = createSearchClients({ mode: opts.searchMode, fixtureDir: opts.fixtureDir, trace });
      const r = await runKillGate({ db, runId, taskId: task.id, ideaId: task.idea_id, agent: opts.agent, search, model, trace, prompts });
      results.push(r);
      opts.onResult?.(r);
    }
  } catch (e) {
    if (e instanceof BudgetExceededError) status = "budget_exceeded";
    else {
      db.finishRun(runId, "error");
      throw e;
    }
  }
  const run = db.getRun(runId)!;
  if (status === "complete" && run.spent_usd >= run.budget_usd && db.listTasks(runId, "open").length > 0) status = "budget_exceeded";
  db.finishRun(runId, status);
  return { runId, status, spentUsd: db.getRun(runId)!.spent_usd, results };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split("=");
      out[k] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true");
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stages = (args.stages ?? "kill_gate").split(",").map((s) => s.trim()) as Stage[];
  for (const s of stages) if (!["kill_gate", "viability", "critic"].includes(s)) throw new Error(`unknown stage ${s}`);
  const unsupported = stages.filter((s) => s !== "kill_gate");
  if (unsupported.length) console.error(`note: stages not built yet in this step and skipped: ${unsupported.join(", ")}`);
  const ideaIds = args.ideas ? args.ideas.split(",").map((s) => s.trim()) : undefined;
  const budgetUsd = args.budget ? Number(args.budget) : ENV.runBudgetUsd;
  const db = openDb(PATHS.db);
  const run = createRun(db, { stages, ideaIds, budgetUsd, searchMode: ENV.searchMode, modelMode: ENV.modelMode });
  console.log(`run ${run.id}: stages=${stages.join(",")} ideas=${ideaIds?.length ?? "all"} budget=$${budgetUsd} search=${ENV.searchMode} model=${ENV.modelMode}`);
  const summary = await executeRun(db, run.id, {
    agent: `script:${process.pid}`, searchMode: ENV.searchMode, modelMode: ENV.modelMode, fixtureDir: PATHS.fixtures,
    onResult: (r) => console.log(`  ${r.payload.idea_id}: ${r.verdict}${r.rulesFired.length ? " [" + r.rulesFired.join(",") + "]" : ""} $${r.costUsd.toFixed(4)}`),
  });
  console.log(`run ${summary.runId} ${summary.status}: ${summary.results.length} results, spent $${summary.spentUsd.toFixed(4)}`);
  db.close();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
