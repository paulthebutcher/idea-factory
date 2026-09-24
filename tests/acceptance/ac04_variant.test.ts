import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshSeededDb, DEFAULT_FIXTURES } from "./helpers.js";
import { runKillGateReplay } from "./kill_gate_helpers.js";
import { SAMPLE_IDS } from "./planted.js";
import type { Db } from "../../src/store/db.js";

// AC4: Kill gate on A07 returns a proposed_variant.
// Variant stored as new idea with parent_id = 'A07'. A07 verdict unchanged by the variant. A07 idea
// text unchanged. Asserted on every recorded sample that proposes a variant, independent of the
// verdict itself (Checkpoint 1 decision 9). At least one sample must propose one. Since the R001
// rewrite A07 passes and the model has no trigger to remove, so the archived checkpoint 1 recordings
// (old rules, where sample 1 proposed a variant) are replayed alongside the current ones.

const RECORDINGS = [
  { label: "current", modelFixtureDir: DEFAULT_FIXTURES },
  { label: "checkpoint1 archive", modelFixtureDir: path.join(DEFAULT_FIXTURES, "archive/checkpoint1") },
];

describe("AC4: proposed variant on A07", () => {
  let db: Db;
  beforeAll(() => ({ db } = freshSeededDb()));
  afterAll(() => db.close());

  it("stores each proposed variant as a child idea without touching A07", async () => {
    const before = (db.raw.prepare("SELECT idea FROM ideas WHERE id = 'A07'").get() as any).idea;
    let proposed = 0;
    for (const rec of RECORDINGS) for (const s of SAMPLE_IDS) {
      const r = await runKillGateReplay(db, "A07", { sample: s, modelFixtureDir: rec.modelFixtureDir });
      expect(r.verdict, `A07 ${rec.label} s${s} verdict is a real verdict`).not.toBe("error");
      if (!r.payload.proposed_variant) continue;
      proposed++;
      // The variant did not move the verdict: the stored verdict is what the runner decided from the tests alone.
      const modelVerdict = r.payload.runner.model_verdict;
      const expected = r.payload.runner.overrides.length ? (modelVerdict === "kill" ? "pass" : "kill") : modelVerdict;
      expect(r.verdict, `A07 ${rec.label} s${s} verdict unchanged by variant`).toBe(expected);
      expect(db.latestStageResult("A07", "kill_gate")!.verdict).toBe(r.verdict);

      expect(r.variantId, `A07 ${rec.label} s${s} variant id`).toMatch(/^I\d{4}$/);
      const row = db.raw.prepare("SELECT * FROM ideas WHERE id = ?").get(r.variantId) as any;
      expect(row.parent_id).toBe("A07");
      expect(row.idea).toBe(r.payload.proposed_variant.idea.trim());
      expect(row.seed_source).toBe("agent_variant");
      const safe = db.getAgentSafeIdea(r.variantId!)!;
      expect(Object.keys(safe).sort()).toEqual(["customer", "id", "idea", "parent_id", "source_url", "verbatim_quote"]);
    }
    expect(proposed, "at least one sample proposes a variant").toBeGreaterThanOrEqual(1);
    const after = (db.raw.prepare("SELECT idea FROM ideas WHERE id = 'A07'").get() as any).idea;
    expect(after).toBe(before);
    const variants = db.raw.prepare("SELECT COUNT(*) AS n FROM ideas WHERE parent_id = 'A07'").get() as any;
    expect(variants.n).toBeLessThanOrEqual(proposed);
  });

  it("replaying the same sample twice does not duplicate its variant", async () => {
    const n0 = (db.raw.prepare("SELECT COUNT(*) AS n FROM ideas WHERE parent_id = 'A07'").get() as any).n;
    await runKillGateReplay(db, "A07", { sample: 1, modelFixtureDir: RECORDINGS[1].modelFixtureDir });
    const n1 = (db.raw.prepare("SELECT COUNT(*) AS n FROM ideas WHERE parent_id = 'A07'").get() as any).n;
    expect(n1).toBe(n0);
  });
});
