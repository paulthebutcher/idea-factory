import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshSeededDb } from "./helpers.js";
import { runKillGateReplay } from "./kill_gate_helpers.js";
import { SAMPLE_IDS } from "./planted.js";
import type { Db } from "../../src/store/db.js";

// AC4: Kill gate on A07 returns a proposed_variant.
// Variant stored as new idea with parent_id = 'A07'. A07 verdict stays kill. A07 idea text unchanged.
// Checked on every recorded sample that proposes a variant; at least one sample must.

describe("AC4: proposed variant on A07", () => {
  let db: Db;
  beforeAll(() => ({ db } = freshSeededDb()));
  afterAll(() => db.close());

  it("stores each proposed variant as a child idea and leaves A07 untouched", async () => {
    const before = (db.raw.prepare("SELECT idea FROM ideas WHERE id = 'A07'").get() as any).idea;
    let proposed = 0;
    for (const s of SAMPLE_IDS) {
      const r = await runKillGateReplay(db, "A07", { sample: s });
      expect(r.verdict, `A07 s${s} verdict`).toBe("kill");
      if (!r.payload.proposed_variant) continue;
      proposed++;
      expect(r.variantId, `A07 s${s} variant id`).toMatch(/^I\d{4}$/);
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
    expect(db.latestStageResult("A07", "kill_gate")!.verdict).toBe("kill");
    const variants = db.raw.prepare("SELECT COUNT(*) AS n FROM ideas WHERE parent_id = 'A07'").get() as any;
    expect(variants.n).toBeLessThanOrEqual(proposed);
  });

  it("replaying the same sample twice does not duplicate its variant", async () => {
    const n0 = (db.raw.prepare("SELECT COUNT(*) AS n FROM ideas WHERE parent_id = 'A07'").get() as any).n;
    await runKillGateReplay(db, "A07", { sample: 1 });
    const n1 = (db.raw.prepare("SELECT COUNT(*) AS n FROM ideas WHERE parent_id = 'A07'").get() as any).n;
    expect(n1).toBe(n0);
  });
});
