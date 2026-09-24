import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshSeededDb, TEST_FIXTURES } from "./helpers.js";
import { runKillGateReplay } from "./kill_gate_helpers.js";
import type { Db } from "../../src/store/db.js";
import { extractJson, repairJsonControlChars } from "../../src/stages/kill_gate.js";

// Critical rule 4 both ways. Only a failed kill rule or hard test with cited evidence can kill, and
// when one has failed with evidence the verdict is kill regardless of what the model wrote.

describe("runner overrides on the kill verdict", () => {
  let db: Db;
  beforeAll(() => ({ db } = freshSeededDb()));
  afterAll(() => db.close());

  it("pass_to_kill: model says pass but R001 failed with evidence", async () => {
    const r = await runKillGateReplay(db, "A07", { fixtureDir: path.join(TEST_FIXTURES, "pass_to_kill") });
    expect(r.verdict).toBe("kill");
    expect(r.rulesFired).toEqual(["R001"]);
    expect(r.payload.runner.model_verdict).toBe("pass");
    const override = r.events.find((e) => e.kind === "runner_override");
    expect(override).toBeTruthy();
    expect((override!.content as any).kind).toBe("pass_to_kill");
    expect((override!.content as any).rules_fired).toEqual(["R001"]);
    expect(db.latestStageResult("A07", "kill_gate")!.verdict).toBe("kill");
    expect(JSON.parse(db.latestStageResult("A07", "kill_gate")!.rules_fired!)).toEqual(["R001"]);
  });

  it("kill_to_pass: model says kill but nothing hard failed with evidence", async () => {
    const r = await runKillGateReplay(db, "A07", { fixtureDir: path.join(TEST_FIXTURES, "kill_to_pass") });
    expect(r.verdict).toBe("pass");
    expect(r.rulesFired).toEqual([]);
    expect(r.payload.runner.model_verdict).toBe("kill");
    const override = r.events.find((e) => e.kind === "runner_override");
    expect((override!.content as any).kind).toBe("kill_to_pass");
    // The soft-test fail was noted, not counted.
    expect(r.events.some((e) => e.kind === "runner_note" && (e.content as any).test === "T5")).toBe(true);
  });
});

describe("model output parsing", () => {
  it("repairs raw control characters inside JSON strings without touching structure", () => {
    const raw = '{"brief_md": "line one\nline two\ttabbed", "n": 1, "quote": "she said \\"hi\\""}';
    expect(() => JSON.parse(raw)).toThrow();
    const fixed = JSON.parse(repairJsonControlChars(raw));
    expect(fixed.brief_md).toBe("line one\nline two\ttabbed");
    expect(fixed.n).toBe(1);
    expect(fixed.quote).toBe('she said "hi"');
    expect(extractJson("Here you go:\n```json\n" + raw + "\n```")).toEqual(fixed);
  });
});
