// Creates a run and its tasks, claims each task, runs the stage, and enforces the budget in code.
// v0 step 4 runs the kill gate. Viability and critic tasks arrive in steps 5 and 6.
import { fileURLToPath } from "node:url";
import { ENV, MODELS, PATHS, loadPrompts, type Mode, type PromptSet, type Stage } from "../config.js";
import { openDb, type Db, type RunRow } from "../store/db.js";
import { createSearchClients } from "../search/index.js";
import { createModelClient, BudgetExceededError, FatalApiError, type ModelClient } from "../model/client.js";
import { TraceCollector } from "../trace.js";
import { runKillGate, type KillGateRunResult } from "../stages/kill_gate.js";
import { runViability, type ViabilityRunResult } from "../stages/viability.js";
import { runCritic, type CriticRunSummary } from "../stages/critic.js";

export interface CreateRunOptions {
  id?: string;
  stages: Stage[];
  ideaIds?: string[];
  budgetUsd?: number;
  searchMode?: Mode;
  modelMode?: Mode;
  prompts?: PromptSet;
}

export function createRun(db: Db, opts: CreateRunOptions): RunRow {
  const prompts = opts.prompts ?? loadPrompts();
  const ideaIds = opts.ideaIds ?? db.activeIdeaIds();
  const run = db.createRun({
    id: opts.id,
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
  onResult?: (r: StageRunResult) => void;
  onCritic?: (summary: CriticRunSummary) => void;
  /** Tasks (and critic pairs within a round) run this many at a time. Default 1. */
  concurrency?: number;
}

export type StageRunResult = ({ stage: "kill_gate" } & KillGateRunResult) | ({ stage: "viability" } & ViabilityRunResult);

export interface ExecuteRunSummary {
  runId: string;
  status: RunRow["status"];
  spentUsd: number;
  results: StageRunResult[];
  critic?: CriticRunSummary;
}

/**
 * Execute the run's stages in order: kill gate on the run's ideas, viability on the ideas whose latest
 * kill-gate verdict is pass, critic on the ideas whose latest viability verdict is complete. Every task
 * is claimed before it runs. Spend is checked against the budget before each task; reaching it stops
 * the run with status budget_exceeded.
 */
export async function executeRun(db: Db, runId: string, opts: ExecuteRunOptions): Promise<ExecuteRunSummary> {
  const prompts = opts.prompts ?? loadPrompts();
  // In record mode a transcript already on disk is replayed, so a resumed run (after a budget stop or
  // an outage) only pays for calls it has not made before. Critic pairs are keyed by idea pair and order.
  const model = opts.model ?? createModelClient({ mode: opts.modelMode, fixtureDir: opts.fixtureDir, reuseExisting: opts.modelMode === "record" });
  const run0 = db.getRun(runId)!;
  const stages = JSON.parse(run0.stages) as Stage[];
  const ideaIds = (JSON.parse(run0.config_json).idea_ids as string[] | undefined) ?? db.activeIdeaIds();
  const results: StageRunResult[] = [];
  let status: RunRow["status"] = "complete";
  let critic: CriticRunSummary | undefined;

  const overBudget = () => {
    const run = db.getRun(runId)!;
    return run.spent_usd >= run.budget_usd;
  };
  const latestIs = (stage: Stage, verdict: string) => ideaIds.filter((id) => db.latestStageResult(id, stage)?.verdict === verdict);

  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const runStage = async (stage: "kill_gate" | "viability"): Promise<boolean> => {
    const tasks = db.listTasks(runId, "open").filter((t) => t.stage === stage && t.idea_id);
    let next = 0;
    let stoppedForBudget = false;
    let failure: unknown = null;
    const worker = async () => {
      while (true) {
        if (failure || stoppedForBudget) return;
        const task = tasks[next++];
        if (!task) return;
        if (overBudget()) {
          stoppedForBudget = true;
          return;
        }
        if (db.claimTask(task.id, opts.agent) !== "claimed") continue;
        try {
          const trace = new TraceCollector();
          const search = createSearchClients({ mode: opts.searchMode, fixtureDir: opts.fixtureDir, trace });
          const base = { db, runId, taskId: task.id, ideaId: task.idea_id!, agent: opts.agent, search, model, trace, prompts };
          const r: StageRunResult = stage === "kill_gate" ? { stage, ...(await runKillGate(base)) } : { stage, ...(await runViability(base)) };
          results.push(r);
          opts.onResult?.(r);
        } catch (e) {
          failure = e;
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    if (failure) throw failure;
    return !stoppedForBudget;
  };

  try {
    if (stages.includes("kill_gate")) {
      if (!(await runStage("kill_gate"))) status = "budget_exceeded";
    }
    if (status === "complete" && stages.includes("viability")) {
      const passes = latestIs("kill_gate", "pass");
      const existing = new Set(db.listTasks(runId).filter((t) => t.stage === "viability").map((t) => t.idea_id));
      db.createTasks(runId, "viability", passes.filter((id) => !existing.has(id)));
      if (!(await runStage("viability"))) status = "budget_exceeded";
    }
    if (status === "complete" && stages.includes("critic")) {
      const completes = latestIs("viability", "complete");
      if (overBudget()) status = "budget_exceeded";
      else if (completes.length >= 2) {
        critic = await runCritic({
          db, runId, ideaIds: completes, agent: opts.agent, model, prompts, concurrency,
          beforeCall: () => {
            if (overBudget()) throw new BudgetExceededError(`budget reached before critic call (spent $${db.getRun(runId)!.spent_usd.toFixed(4)})`);
          },
        });
        opts.onCritic?.(critic);
      }
    }
  } catch (e) {
    if (e instanceof BudgetExceededError) status = "budget_exceeded";
    else if (e instanceof FatalApiError) {
      // Credits, key or permission: nothing else in this run can succeed. Stop here; open tasks stay open for a resume.
      db.finishRun(runId, "error");
      console.error(`run ${runId} aborted: ${e.message}`);
      return { runId, status: "error", spentUsd: db.getRun(runId)!.spent_usd, results, critic };
    } else {
      db.finishRun(runId, "error");
      throw e;
    }
  }
  if (status === "complete" && overBudget() && db.listTasks(runId, "open").length > 0) status = "budget_exceeded";
  db.finishRun(runId, status);
  return { runId, status, spentUsd: db.getRun(runId)!.spent_usd, results, critic };
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
  const ideaIds = args.ideas ? args.ideas.split(",").map((s) => s.trim()) : undefined;
  const budgetUsd = args.budget ? Number(args.budget) : ENV.runBudgetUsd;
  const concurrency = args.concurrency ? Number(args.concurrency) : 1;
  const db = openDb(PATHS.db);
  const run = createRun(db, { id: args.id, stages, ideaIds, budgetUsd, searchMode: ENV.searchMode, modelMode: ENV.modelMode });
  console.log(`run ${run.id}: stages=${stages.join(",")} ideas=${ideaIds?.length ?? "all active"} budget=$${budgetUsd} search=${ENV.searchMode} model=${ENV.modelMode} fixtures=${PATHS.fixtures} concurrency=${concurrency}`);
  const summary = await executeRun(db, run.id, {
    agent: `script:${process.pid}`, searchMode: ENV.searchMode, modelMode: ENV.modelMode, fixtureDir: PATHS.fixtures, concurrency,
    onResult: (r) => console.log(`  ${r.stage} ${r.payload.idea_id}: ${r.verdict}${r.stage === "kill_gate" && r.rulesFired.length ? " [" + r.rulesFired.join(",") + "]" : ""} $${r.costUsd.toFixed(4)}`),
    onCritic: (c) => {
      console.log(`  critic: ${c.ideaIds.length} ideas, ${c.rounds} rounds, ${c.comparisons.length} comparisons, $${c.costUsd.toFixed(4)}`);
      for (const s of c.standings) console.log(`    #${s.rank} ${s.ideaId}  score ${s.score} (W${s.wins} T${s.ties} L${s.losses} bye${s.byes})  opp ${s.opponentScore}`);
    },
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
