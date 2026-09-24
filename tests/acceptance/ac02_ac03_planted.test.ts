import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshSeededDb } from "./helpers.js";
import { runKillGateReplay } from "./kill_gate_helpers.js";
import { MUST_TRIGGER, MUST_NOT_TRIGGER } from "./planted.js";
import type { Db } from "../../src/store/db.js";

// AC2: Kill gate on the planted cases in every rule's must_trigger list.
// AC3: Kill gate on must_not_trigger cases.
// Runs on SEARCH_MODE=replay with recorded fixtures in src/search/fixtures.

describe("AC2/AC3: planted kill-gate cases (replay)", () => {
  let db: Db;
  beforeAll(() => ({ db } = freshSeededDb()));
  afterAll(() => db.close());

  for (const c of MUST_TRIGGER) {
    it(`AC2 ${c.ideaId}: killed with ${c.mustTrigger} fired`, async () => {
      const r = await runKillGateReplay(db, c.ideaId);
      expect(r.verdict, `verdict for ${c.ideaId}`).toBe("kill");
      expect(r.rulesFired, `rules fired for ${c.ideaId}`).toContain(c.mustTrigger);
      const fired = r.payload.tests.find((t) => t.id === c.mustTrigger);
      expect(fired?.result).toBe("fail");
      expect((fired?.evidence ?? "").trim().length).toBeGreaterThan(0);
      expect(r.events.length).toBeGreaterThan(0);
      expect(r.events.filter((e) => e.kind === "tool_call").length).toBeGreaterThanOrEqual(4);
    });
  }

  for (const c of MUST_NOT_TRIGGER) {
    it(`AC3 ${c.ideaId}: ${c.mustNotTrigger} does not fire`, async () => {
      const r = await runKillGateReplay(db, c.ideaId);
      expect(r.verdict).not.toBe("error");
      expect(r.rulesFired, `rules fired for ${c.ideaId}`).not.toContain(c.mustNotTrigger);
      const t = r.payload.tests.find((t) => t.id === c.mustNotTrigger);
      expect(t?.result ?? "pass").not.toBe("fail");
    });
  }
});
