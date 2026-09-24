import { describe, it, expect, afterAll } from "vitest";
import { freshSeededDb } from "./helpers.js";
import { runKillGateReplay } from "./kill_gate_helpers.js";
import { plantedCasesFromDb, SAMPLE_IDS, SAMPLES, judgeSample, agreementLabel, describeExpectation, type PlantedCase } from "./planted.js";
import type { Db } from "../../src/store/db.js";

// AC2: Kill gate on the planted cases in every rule's must_trigger list.
// AC3: Kill gate on must_not_trigger cases.
// Cases come from rules.test_case_ids. Three recorded samples per case are replayed from
// src/search/fixtures. A case passes only when all three samples agree with the expectation.
// Two of three is reported as UNSTABLE, a distinct failure. Observe cases are not asserted here.

const { db } = freshSeededDb();
const CASES = plantedCasesFromDb(db);
const cache = new Map<string, Awaited<ReturnType<typeof runKillGateReplay>>>();

async function replay(ideaId: string, sample: number) {
  const key = `${ideaId}.s${sample}`;
  if (!cache.has(key)) cache.set(key, await runKillGateReplay(db, ideaId, { sample }));
  return cache.get(key)!;
}

async function judgeCase(c: PlantedCase) {
  const outcomes = [];
  for (const s of SAMPLE_IDS) {
    const r = await replay(c.ideaId, s);
    expect(r.events.length, `${c.ideaId} s${s} has trace events`).toBeGreaterThan(0);
    if (r.verdict !== "error") {
      expect(r.events.filter((e) => e.kind === "tool_call").length, `${c.ideaId} s${s} ran searches`).toBeGreaterThanOrEqual(4);
      for (const t of r.payload.tests.filter((t) => t.result === "fail" && r.rulesFired.includes(t.id))) {
        expect(t.evidence.trim().length, `${c.ideaId} s${s} ${t.id} evidence`).toBeGreaterThan(0);
      }
    }
    outcomes.push(judgeSample(c, s, { verdict: r.verdict, rulesFired: r.rulesFired, failedTestIds: r.payload.tests.filter((t) => t.result === "fail").map((t) => t.id), flagIds: r.payload.flags.map((f) => f.id) }));
  }
  const okCount = outcomes.filter((o) => o.ok).length;
  const detail = outcomes.map((o) => `s${o.sample}=${o.verdict}[${o.rulesFired.join(",")}]{${o.flagIds.join(",")}}${o.ok ? "" : "✗"}`).join(" ");
  const label = agreementLabel(okCount);
  if (label === "unstable") throw new Error(`UNSTABLE: ${c.ideaId}/${c.ruleId} agreed on ${okCount} of ${SAMPLES} samples: ${detail}`);
  expect(okCount, `${c.ideaId}/${c.ruleId} agreement ${okCount}/${SAMPLES}: ${detail}`).toBe(SAMPLES);
}

describe("AC2/AC3: planted kill-gate cases from rules.test_case_ids, 3 samples each (replay)", () => {
  afterAll(() => db.close());

  for (const c of CASES.filter((c) => c.kind === "must_trigger")) {
    it(`AC2 ${c.ideaId}: ${describeExpectation(c)} in 3 of 3 samples`, async () => judgeCase(c));
  }
  for (const c of CASES.filter((c) => c.kind === "must_not_trigger")) {
    it(`AC3 ${c.ideaId}: ${describeExpectation(c)} in 3 of 3 samples`, async () => judgeCase(c));
  }
});
