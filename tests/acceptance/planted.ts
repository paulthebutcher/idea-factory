// Planted cases from the rules' test_case_ids in schema.sql (AC2, AC3).
// Expected verdicts come from the acceptance criteria table in docs/HANDOFF.md.

export interface PlantedCase {
  ideaId: string;
  expectedVerdict: "kill" | "pass" | null; // null: verdict not asserted, only the rule
  mustTrigger?: string;
  mustNotTrigger?: string;
}

export const MUST_TRIGGER: PlantedCase[] = [
  { ideaId: "A07", expectedVerdict: "kill", mustTrigger: "R001" },
  { ideaId: "B09", expectedVerdict: "kill", mustTrigger: "R001" },
  { ideaId: "A09", expectedVerdict: "kill", mustTrigger: "T2" },
  { ideaId: "P06", expectedVerdict: "kill", mustTrigger: "T2" },
  { ideaId: "B08", expectedVerdict: "kill", mustTrigger: "T2" },
  { ideaId: "A11", expectedVerdict: "kill", mustTrigger: "T3" },
  { ideaId: "P07", expectedVerdict: "kill", mustTrigger: "T7" },
  { ideaId: "P08", expectedVerdict: "kill", mustTrigger: "T7" },
];

export const MUST_NOT_TRIGGER: PlantedCase[] = [
  { ideaId: "A02", expectedVerdict: null, mustNotTrigger: "R001" },
  { ideaId: "O03", expectedVerdict: null, mustNotTrigger: "R001" },
  { ideaId: "A01", expectedVerdict: null, mustNotTrigger: "T2" },
];

export const PLANTED_CASES: PlantedCase[] = [...MUST_TRIGGER, ...MUST_NOT_TRIGGER];

/** Recorded samples per planted case. A case passes AC2/AC3 only at full agreement. */
export const SAMPLES = 3;
export const SAMPLE_IDS = Array.from({ length: SAMPLES }, (_, i) => i + 1);

export interface SampleOutcome {
  sample: number;
  verdict: string;
  rulesFired: string[];
  /** Did this sample meet the case's expectation? */
  ok: boolean;
}

/** Judge one sample against a planted case. */
export function judgeSample(c: PlantedCase, sample: number, verdict: string, rulesFired: string[], failedTestIds: string[]): SampleOutcome {
  const ok = c.mustTrigger
    ? verdict === "kill" && rulesFired.includes(c.mustTrigger)
    : verdict !== "error" && !failedTestIds.includes(c.mustNotTrigger!);
  return { sample, verdict, rulesFired, ok };
}

export function agreementLabel(okCount: number): "pass" | "unstable" | "fail" {
  if (okCount === SAMPLES) return "pass";
  if (okCount === SAMPLES - 1) return "unstable";
  return "fail";
}
