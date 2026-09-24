import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshSeededDb, runKillGateReplay } from "./helpers.js";
import type { Db } from "../../src/store/db.js";

// AC4: Kill gate on A07 returns a proposed_variant.
// Variant stored as new idea with parent_id = 'A07'. A07 verdict stays kill. A07 idea text unchanged.

describe("AC4: proposed variant on A07", () => {
  let db: Db;
  beforeAll(() => ({ db } = freshSeededDb()));
  afterAll(() => db.close());

  it("stores the variant as a child idea and leaves A07 untouched", async () => {
    const before = db.raw.prepare("SELECT idea FROM ideas WHERE id = 'A07'").get() as any;
    const r = await runKillGateReplay(db, "A07");
    expect(r.payload.proposed_variant).toBeTruthy();
    expect(r.verdict).toBe("kill");

    const variants = db.raw.prepare("SELECT * FROM ideas WHERE parent_id = 'A07'").all() as any[];
    expect(variants.length).toBe(1);
    expect(variants[0].idea).toBe(r.payload.proposed_variant!.idea);
    expect(variants[0].seed_source).toBe("agent_variant");
    expect(variants[0].id).toMatch(/^I\d{4}$/);

    const after = db.raw.prepare("SELECT idea FROM ideas WHERE id = 'A07'").get() as any;
    expect(after.idea).toBe(before.idea);

    const latest = db.latestStageResult("A07", "kill_gate")!;
    expect(latest.verdict).toBe("kill");

    // The variant is agent-visible with its parent link.
    const safe = db.getAgentSafeIdea(variants[0].id)!;
    expect(safe.parent_id).toBe("A07");
    expect(Object.keys(safe).sort()).toEqual(["customer", "id", "idea", "parent_id", "source_url", "verbatim_quote"]);
  });

  it("re-running does not duplicate the variant", async () => {
    await runKillGateReplay(db, "A07");
    const variants = db.raw.prepare("SELECT COUNT(*) AS n FROM ideas WHERE parent_id = 'A07'").get() as any;
    expect(variants.n).toBe(1);
  });
});
