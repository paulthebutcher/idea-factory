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
