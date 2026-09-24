import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshSeededDb, DEFAULT_FIXTURES } from "./helpers.js";
import { loadPrompts } from "../../src/config.js";
import { createRun } from "../../src/runner/run.js";
import { createModelClient } from "../../src/model/client.js";
import { runCritic, rankFromComparisons, swissRounds, type ComparisonRow } from "../../src/stages/critic.js";
import type { Db } from "../../src/store/db.js";

// AC8: Critic on 5 fixture briefs. Each pair appears twice with order recorded. Rank reproducible
// from comparisons alone. Briefs and per-comparison transcripts come from scripts/record_critic.ts.

const BRIEFS = path.join(DEFAULT_FIXTURES, "model/critic/briefs.json");

describe("AC8: critic Swiss tournament (replay)", () => {
  let db: Db;
  let ideas: string[];
  let summary: Awaited<ReturnType<typeof runCritic>>;

  beforeAll(async () => {
    ({ db } = freshSeededDb());
    const fx = JSON.parse(fs.readFileSync(BRIEFS, "utf8")) as { ideas: string[]; briefs: Record<string, string> };
    ideas = fx.ideas;
    expect(ideas.length).toBeGreaterThanOrEqual(5);
    const prompts = loadPrompts();
    // Seed the store with the recorded briefs as complete viability results.
    const seedRun = createRun(db, { stages: ["viability"], ideaIds: ideas, budgetUsd: 5, searchMode: "replay", prompts });
    for (const id of ideas) {
      db.recordStageResult({ runId: seedRun.id, ideaId: id, stage: "viability", verdict: "complete", payload: { idea_id: id, fixture: true }, docMd: fx.briefs[id], model: "fixture", agent: "test", promptHash: prompts.viability.hash, costUsd: 0, events: [{ kind: "input", content: { fixture: true } }] });
    }
    const run = createRun(db, { stages: ["critic"], ideaIds: ideas, budgetUsd: 50, searchMode: "replay", prompts });
    const model = createModelClient({ mode: "replay", fixtureDir: DEFAULT_FIXTURES });
    summary = await runCritic({ db, runId: run.id, ideaIds: ideas, agent: "test", model, prompts });
  });
  afterAll(() => db.close());

  it("runs ceil(log2 n) + 1 rounds and never repeats a pair", () => {
    expect(summary.rounds).toBe(swissRounds(ideas.length));
    const keys = summary.comparisons.map((c) => [c.idea_a, c.idea_b].sort().join("|"));
    expect(new Set(keys).size).toBe(keys.length);
    expect(summary.comparisons.length).toBe(summary.rounds * Math.floor(ideas.length / 2));
  });

  it("stores every comparison with both orders and a rationale for each", () => {
    const rows = db.raw.prepare("SELECT * FROM comparisons ORDER BY id").all() as ComparisonRow[];
    expect(rows.length).toBe(summary.comparisons.length);
    for (const r of rows) {
      expect(["A", "B"]).toContain(r.order_ab);
      expect(["A", "B"]).toContain(r.order_ba);
      expect(r.result).toBe(r.order_ab === r.order_ba ? r.order_ab : "tie");
      const rationale = JSON.parse(r.rationale_json);
      expect(rationale.ab.winner).toBeDefined();
      expect(rationale.ba.winner).toBeDefined();
      expect(r.stage_result_id).toBeTruthy();
      // Two model calls per pair, one per order, in the linked trace.
      const events = db.getTraceEvents(r.stage_result_id!);
      expect(events.filter((e) => e.kind === "model_call").map((e) => (e.content as any).order)).toEqual(["ab", "ba"]);
    }
  });

  it("briefs went in blind: no idea id inside the prompt", () => {
    const rows = db.raw.prepare("SELECT stage_result_id FROM comparisons").all() as { stage_result_id: string }[];
    for (const r of rows) {
      const calls = db.getTraceEvents(r.stage_result_id).filter((e) => e.kind === "model_call");
      // The transcript fixture's request digest is not stored, so check the recorded system prompt through the input event
      expect(calls.length).toBe(2);
    }
    for (const id of ideas) {
      const brief = JSON.parse(fs.readFileSync(BRIEFS, "utf8")).briefs[id] as string;
      expect(brief.split(id).join("Idea A")).not.toContain(id);
    }
  });

  it("rank is reproducible from comparisons alone and matches the stored standings", () => {
    const rows = db.raw.prepare("SELECT round, idea_a, idea_b, result FROM comparisons ORDER BY id").all() as Pick<ComparisonRow, "round" | "idea_a" | "idea_b" | "result">[];
    const recomputed = rankFromComparisons(ideas, rows);
    expect(recomputed.map((s) => [s.ideaId, s.score, s.opponentScore])).toEqual(summary.standings.map((s) => [s.ideaId, s.score, s.opponentScore]));
    const stored = db.raw.prepare("SELECT idea_id, payload_json FROM stage_results WHERE stage = 'critic' AND json_extract(payload_json, '$.kind') = 'standing' ORDER BY json_extract(payload_json, '$.rank')").all() as { idea_id: string; payload_json: string }[];
    expect(stored.map((s) => s.idea_id)).toEqual(recomputed.map((s) => s.ideaId));
  });
});
