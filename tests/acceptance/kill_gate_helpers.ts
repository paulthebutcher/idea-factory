import type { Db } from "../../src/store/db.js";
import { createRun } from "../../src/runner/run.js";
import { runKillGate, type KillGateRunResult } from "../../src/stages/kill_gate.js";
import { runViability, type ViabilityRunResult } from "../../src/stages/viability.js";
import { createSearchClients } from "../../src/search/index.js";
import { createModelClient } from "../../src/model/client.js";
import { TraceCollector } from "../../src/trace.js";
import { sampleFixtureName } from "../../src/model/client.js";
import { loadPrompts } from "../../src/config.js";
import { DEFAULT_FIXTURES } from "./helpers.js";

export interface KillGateTestOptions {
  fixtureDir?: string;
  agent?: string;
  budgetUsd?: number;
  /** Recorded sample to replay (fixture <idea>.s<sample>). Omit to replay the unsuffixed fixture <idea>. */
  sample?: number;
  /** Directory holding the model transcripts when it differs from the search fixture dir (e.g. an archive). */
  modelFixtureDir?: string;
}

/**
 * Run the kill gate for one idea in replay mode using the given fixture set.
 * Creates a run and a task, claims the task, runs the stage, and returns the result.
 */
export async function runKillGateReplay(db: Db, ideaId: string, opts: KillGateTestOptions = {}): Promise<KillGateRunResult> {
  const fixtureDir = opts.fixtureDir ?? DEFAULT_FIXTURES;
  const prompts = loadPrompts();
  const run = createRun(db, { stages: ["kill_gate"], ideaIds: [ideaId], budgetUsd: opts.budgetUsd ?? 5, searchMode: "replay", prompts });
  const task = db.listTasks(run.id).find((t) => t.idea_id === ideaId && t.stage === "kill_gate")!;
  const agent = opts.agent ?? "test";
  const claim = db.claimTask(task.id, agent);
  if (claim !== "claimed") throw new Error(`could not claim task ${task.id}: ${claim}`);
  const trace = new TraceCollector();
  const search = createSearchClients({ mode: "replay", fixtureDir, trace });
  const model = createModelClient({ mode: "replay", fixtureDir: opts.modelFixtureDir ?? fixtureDir });
  const fixtureName = opts.sample ? sampleFixtureName(ideaId, opts.sample) : ideaId;
  return runKillGate({ db, runId: run.id, taskId: task.id, ideaId, agent, search, model, trace, prompts, fixtureName });
}

/** Run the viability stage for one idea in replay mode. Uses the latest kill-gate result in db, if any. */
export async function runViabilityReplay(db: Db, ideaId: string, opts: KillGateTestOptions = {}): Promise<ViabilityRunResult> {
  const fixtureDir = opts.fixtureDir ?? DEFAULT_FIXTURES;
  const prompts = loadPrompts();
  const run = createRun(db, { stages: ["viability"], ideaIds: [ideaId], budgetUsd: opts.budgetUsd ?? 5, searchMode: "replay", prompts });
  const [task] = db.createTasks(run.id, "viability", [ideaId]);
  const agent = opts.agent ?? "test";
  if (db.claimTask(task.id, agent) !== "claimed") throw new Error(`could not claim task ${task.id}`);
  const trace = new TraceCollector();
  const search = createSearchClients({ mode: "replay", fixtureDir, trace });
  const model = createModelClient({ mode: "replay", fixtureDir: opts.modelFixtureDir ?? fixtureDir });
  const fixtureName = opts.sample ? sampleFixtureName(ideaId, opts.sample) : ideaId;
  return runViability({ db, runId: run.id, taskId: task.id, ideaId, agent, search, model, trace, prompts, fixtureName });
}
