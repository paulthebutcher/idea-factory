// Store methods behind the review app's annotation writes (viewer/).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { freshSeededDb } from "./helpers.js";
import { StoreError, type Db } from "../../src/store/db.js";

let db: Db;
let dir: string;
let srId: string;
let cmpId: number;

beforeAll(() => {
  ({ db, dir } = freshSeededDb());
  db.createRun({ id: "run_ann", stages: ["kill_gate", "critic"], budgetUsd: 1, configJson: {} });
  srId = db.recordStageResult({
    runId: "run_ann", ideaId: "A01", stage: "kill_gate", verdict: "pass", payload: {},
    model: "m", agent: "test", promptHash: "h", costUsd: 0, events: [{ kind: "system", content: {} }],
  }).id;
  const r = db.raw
    .prepare("INSERT INTO comparisons (run_id, round, idea_a, idea_b, order_ab, order_ba, result, rationale_json, model) VALUES ('run_ann', 1, 'A01', 'A02', 'A', 'B', 'tie', '{}', 'm')")
    .run();
  cmpId = Number(r.lastInsertRowid);
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("annotations", () => {
  it("annotates a stage result, defaulting idea_id to the result's idea and recording blind", () => {
    const a = db.addAnnotation({ stageResultId: srId, verdict: "disagree", note: "R001 should have fired", blind: true });
    expect(a.stage_result_id).toBe(srId);
    expect(a.comparison_id).toBeNull();
    expect(a.idea_id).toBe("A01");
    expect(a.verdict).toBe("disagree");
    expect(a.blind).toBe(1);
    expect(a.author).toBe("paul");
  });

  it("annotates a comparison and records a revealed (non-blind) annotation", () => {
    const a = db.addAnnotation({ comparisonId: cmpId, verdict: "agree", blind: false });
    expect(a.comparison_id).toBe(cmpId);
    expect(a.stage_result_id).toBeNull();
    expect(a.idea_id).toBeNull();
    expect(a.note).toBe("");
    expect(a.blind).toBe(0);
  });

  it("accepts a note without a verdict, and rejects an annotation with neither", () => {
    const a = db.addAnnotation({ stageResultId: srId, note: "see also A07", blind: true });
    expect(a.verdict).toBeNull();
    expect(() => db.addAnnotation({ stageResultId: srId, note: "   ", blind: true })).toThrow(StoreError);
  });

  it("rejects bad targets and bad verdicts", () => {
    expect(() => db.addAnnotation({ note: "x", blind: true })).toThrow(/exactly one/);
    expect(() => db.addAnnotation({ stageResultId: srId, comparisonId: cmpId, note: "x", blind: true })).toThrow(/exactly one/);
    expect(() => db.addAnnotation({ stageResultId: "sr_missing", note: "x", blind: true })).toThrow(/does not exist/);
    expect(() => db.addAnnotation({ comparisonId: 999999, note: "x", blind: true })).toThrow(/does not exist/);
    expect(() => db.addAnnotation({ stageResultId: srId, verdict: "maybe" as never, blind: true })).toThrow(/invalid verdict/);
  });

  it("lists by target and by idea, newest first, and deletes", () => {
    expect(db.listAnnotations({ stageResultId: srId })).toHaveLength(2);
    expect(db.listAnnotations({ comparisonId: cmpId })).toHaveLength(1);
    const byIdea = db.listAnnotations({ ideaId: "A01" });
    expect(byIdea).toHaveLength(2);
    expect(byIdea[0].id).toBeGreaterThan(byIdea[1].id);
    expect(db.deleteAnnotation(byIdea[0].id)).toBe(true);
    expect(db.deleteAnnotation(byIdea[0].id)).toBe(false);
    expect(db.listAnnotations({ stageResultId: srId })).toHaveLength(1);
    expect(db.listAnnotations()).toHaveLength(2);
  });

  it("revealIdea returns hidden fields only through its own path; agent-safe views stay clean", () => {
    const hidden = db.revealIdea("A01");
    expect(hidden).not.toBeNull();
    expect(Object.keys(hidden!).sort()).toEqual(["labels", "notes", "outcome", "seed_source", "set_name", "test_role"]);
    expect(hidden!.labels.length).toBeGreaterThan(0);
    expect(db.revealIdea("nope")).toBeNull();
    const safe = db.listIdeasWithStatus().find((i) => i.id === "A01")!;
    expect(Object.keys(safe).sort()).toEqual(["customer", "id", "idea", "parent_id", "source_url", "status", "verbatim_quote"]);
  });
});
