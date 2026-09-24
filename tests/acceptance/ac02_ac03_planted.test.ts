import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshSeededDb } from "./helpers.js";
import { runKillGateReplay } from "./kill_gate_helpers.js";
import { MUST_TRIGGER, MUST_NOT_TRIGGER, SAMPLE_IDS, SAMPLES, judgeSample, agreementLabel, type PlantedCase } from "./planted.js";
import type { Db } from "../../src/store/db.js";

// AC2: Kill gate on the planted cases in every rule's must_trigger list.
// AC3: Kill gate on must_not_trigger cases.
// Three recorded samples per case are replayed from src/search/fixtures. A case passes only when all
// three samples agree with the expectation. Two of three is reported as UNSTABLE, a distinct failure.

async function judgeCase(db: Db, c: PlantedCase) {
  const outcomes = [];
  for (const s of SAMPLE_IDS) {
    const r = await runKillGateReplay(db, c.ideaId, { sample: s });
    expect(r.events.length, `${c.ideaId} s${s} has trace events`).toBeGreaterThan(0);
    if (r.verdict !== "error") {
      expect(r.events.filter((e) => e.kind === "tool_call").length, `${c.ideaId} s${s} ran searches`).toBeGreaterThanOrEqual(4);
      for (const t of r.payload.tests.filter((t) => t.result === "fail" && r.rulesFired.includes(t.id))) {
        expect(t.evidence.trim().length, `${c.ideaId} s${s} ${t.id} evidence`).toBeGreaterThan(0);
      }
    }
    outcomes.push(judgeSample(c, s, r.verdict, r.rulesFired, r.payload.tests.filter((t) => t.result === "fail").map((t) => t.id)));
  }
  const okCount = outcomes.filter((o) => o.ok).length;
  const detail = outcomes.map((o) => `s${o.sample}=${o.verdict}[${o.rulesFired.join(",")}]${o.ok ? "" : "✗"}`).join(" ");
  const label = agreementLabel(okCount);
  if (label === "unstable") throw new Error(`UNSTABLE: ${c.ideaId} agreed on ${okCount} of ${SAMPLES} samples: ${detail}`);
  expect(okCount, `${c.ideaId} agreement ${okCount}/${SAMPLES}: ${detail}`).toBe(SAMPLES);
}

describe("AC2/AC3: planted kill-gate cases, 3 samples each (replay)", () => {
  let db: Db;
  beforeAll(() => ({ db } = freshSeededDb()));
  afterAll(() => db.close());

  for (const c of MUST_TRIGGER) {
    it(`AC2 ${c.ideaId}: killed with ${c.mustTrigger} fired in 3 of 3 samples`, async () => judgeCase(db, c));
  }
  for (const c of MUST_NOT_TRIGGER) {
    it(`AC3 ${c.ideaId}: ${c.mustNotTrigger} does not fire in 3 of 3 samples`, async () => judgeCase(db, c));
  }
});
