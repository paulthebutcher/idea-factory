// Planted cases come from rules.test_case_ids in the store (schema.sql plus migrations), so the
// tests, the report and the rules never disagree. Expected outcomes follow docs/HANDOFF.md AC2/AC3:
//   must_trigger on a kill rule or hard test: verdict kill with that rule fired
//   must_trigger on a soft test: that flag present
//   must_not_trigger: the rule is not fired (hard) or not flagged (soft), and the verdict is not error
//   observe: reported, never asserted
import type { Db } from "../../src/store/db.js";

export type CaseKind = "must_trigger" | "must_not_trigger" | "observe";

export interface PlantedCase {
  ideaId: string;
  ruleId: string;
  ruleKind: "kill_rule" | "hard_test" | "soft_test";
  kind: CaseKind;
}

export function plantedCasesFromDb(db: Db): PlantedCase[] {
  const out: PlantedCase[] = [];
  for (const r of db.listRules("active")) {
    const ids = JSON.parse(r.test_case_ids ?? "{}") as Partial<Record<CaseKind, string[]>>;
    for (const kind of ["must_trigger", "must_not_trigger", "observe"] as CaseKind[]) {
      for (const ideaId of ids[kind] ?? []) out.push({ ideaId, ruleId: r.id, ruleKind: r.kind, kind });
    }
  }
  return out;
}

/** Recorded samples per planted case. A case passes AC2/AC3 only at full agreement. */
export const SAMPLES = 3;
export const SAMPLE_IDS = Array.from({ length: SAMPLES }, (_, i) => i + 1);

export interface SampleResult {
  verdict: string;
  rulesFired: string[];
  failedTestIds: string[];
  flagIds: string[];
}

export interface SampleOutcome extends SampleResult {
  sample: number;
  ok: boolean;
}

/** Judge one sample against a planted case. Observe cases are always ok. */
export function judgeSample(c: PlantedCase, sample: number, r: SampleResult): SampleOutcome {
  let ok: boolean;
  if (c.kind === "observe") ok = true;
  else if (c.kind === "must_trigger") ok = c.ruleKind === "soft_test" ? r.flagIds.includes(c.ruleId) : r.verdict === "kill" && r.rulesFired.includes(c.ruleId);
  else ok = r.verdict !== "error" && (c.ruleKind === "soft_test" ? !r.flagIds.includes(c.ruleId) : !r.failedTestIds.includes(c.ruleId));
  return { sample, ok, ...r };
}

export function agreementLabel(okCount: number): "pass" | "unstable" | "fail" {
  if (okCount === SAMPLES) return "pass";
  if (okCount === SAMPLES - 1) return "unstable";
  return "fail";
}

export function describeExpectation(c: PlantedCase): string {
  if (c.kind === "observe") return `observe ${c.ruleId}`;
  if (c.kind === "must_trigger") return c.ruleKind === "soft_test" ? `flag ${c.ruleId}` : `kill / ${c.ruleId}`;
  return `${c.ruleId} silent`;
}
