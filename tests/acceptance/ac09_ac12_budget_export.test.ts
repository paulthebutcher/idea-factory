import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshSeededDb, DEFAULT_FIXTURES, allKeys, HIDDEN_FIELDS } from "./helpers.js";
import { loadPrompts } from "../../src/config.js";
import { createRun, executeRun } from "../../src/runner/run.js";
import { createModelClient } from "../../src/model/client.js";
import { exportTraces } from "../../scripts/export_traces.js";
import { renderAll } from "../../scripts/render.js";
import type { Db } from "../../src/store/db.js";

// AC9: Budget set to $0.01, run starts. Run stops with status budget_exceeded. No stage result after the stop.
// AC12: npm run export:traces. Valid JSONL, one line per stage result, no hidden fields.

describe("AC9: budget enforcement", () => {
  let db: Db;
  beforeAll(() => ({ db } = freshSeededDb()));
  afterAll(() => db.close());

  it("stops with budget_exceeded and records nothing after the stop", async () => {
    const prompts = loadPrompts();
    // Recorded fixtures replay with their recorded cost, so the first task alone exceeds one cent.
    const run = createRun(db, { stages: ["kill_gate", "viability", "critic"], ideaIds: ["P06", "P07", "A01"], budgetUsd: 0.01, searchMode: "replay", modelMode: "replay", prompts });
    const model = createModelClient({ mode: "replay", fixtureDir: DEFAULT_FIXTURES });
    // Point sample fixtures at the run: the runner uses the idea id as fixture name, so alias sample 1.
    const s = await executeRun(db, run.id, { agent: "test", searchMode: "replay", modelMode: "replay", fixtureDir: DEFAULT_FIXTURES, prompts, model: aliasSample1(model) });
    expect(s.status).toBe("budget_exceeded");
    expect(db.getRun(run.id)!.status).toBe("budget_exceeded");
    const results = db.listStageResults({ runId: run.id });
    expect(results.length).toBe(1);
    expect(db.getRun(run.id)!.spent_usd).toBeGreaterThanOrEqual(0.01);
    // The remaining tasks were never claimed or run.
    expect(db.listTasks(run.id, "open").length).toBe(2);
    expect(db.listStageResults({ runId: run.id, stage: "viability" }).length).toBe(0);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM comparisons WHERE run_id = ?").get(run.id)).toEqual({ n: 0 });
  });
});

describe("AC12: trace export", () => {
  let db: Db;
  let dir: string;
  beforeAll(async () => {
    ({ db, dir } = freshSeededDb());
    const prompts = loadPrompts();
    const run = createRun(db, { stages: ["kill_gate"], ideaIds: ["P06", "A01", "B09"], budgetUsd: 5, searchMode: "replay", modelMode: "replay", prompts });
    const model = createModelClient({ mode: "replay", fixtureDir: DEFAULT_FIXTURES });
    await executeRun(db, run.id, { agent: "test", searchMode: "replay", modelMode: "replay", fixtureDir: DEFAULT_FIXTURES, prompts, model: aliasSample1(model) });
  });
  afterAll(() => db.close());

  it("writes valid JSONL, one line per stage result, with no hidden fields", () => {
    const out = path.join(dir, "traces.jsonl");
    const r = exportTraces(db, out);
    const lines = fs.readFileSync(out, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBe(r.count);
    expect(lines.length).toBe(db.listStageResults().length);
    expect(lines.length).toBe(3);
    for (const line of lines) {
      const obj = JSON.parse(line);
      for (const k of ["trace_id", "idea_id", "stage", "model", "prompt_hash", "system_prompt", "input", "events", "output", "verdict", "cost_usd"]) expect(obj).toHaveProperty(k);
      expect(obj.events.length).toBeGreaterThan(0);
      const keys = allKeys(obj);
      for (const f of HIDDEN_FIELDS) expect(keys.has(f), `hidden field ${f} in trace ${obj.trace_id}`).toBe(false);
    }
    const text = fs.readFileSync(out, "utf8");
    for (const leak of ["Cydoc", "planted_", "backtest_low_contamination", "failed_regulated", "paul_gut"]) expect(text.includes(leak), `hidden value ${leak} leaked into export`).toBe(false);
    // Nothing needed scrubbing: stage code never saw a hidden field.
    expect(r.dropped).toEqual([]);
  });

  it("renders a ledger file per idea with results", () => {
    const out = path.join(dir, "ledger");
    expect(renderAll(db, out)).toBe(3);
    const md = fs.readFileSync(path.join(out, "P06.md"), "utf8");
    expect(md).toContain("# P06");
    expect(md).toContain("## Kill gate");
    expect(md).toContain("Verdict **kill**");
    expect(md).not.toContain("planted_");
  });
});

/** The run orchestrator names fixtures by idea id; recorded fixtures are per sample. Route <idea> to <idea>.s1. */
function aliasSample1(model: ReturnType<typeof createModelClient>): ReturnType<typeof createModelClient> {
  return { ...model, session: (stage, ideaId, fixtureName) => model.session(stage, ideaId, fixtureName && fixtureName !== ideaId ? fixtureName : `${ideaId}.s1`) };
}
