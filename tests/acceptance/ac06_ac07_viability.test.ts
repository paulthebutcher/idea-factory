import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshSeededDb, TEST_FIXTURES } from "./helpers.js";
import { runViabilityReplay } from "./kill_gate_helpers.js";
import type { Db } from "../../src/store/db.js";

// AC6: Viability fixture missing demand_evidence -> verdict fail_evidence.
// AC7: Viability fixture citing a URL absent from tool results -> URL moved to unsourced_claims, trace event logged.

describe("AC6/AC7: viability runner checks", () => {
  let db: Db;
  beforeAll(() => ({ db } = freshSeededDb()));
  afterAll(() => db.close());

  it("AC6: missing demand_evidence makes the verdict fail_evidence", async () => {
    const r = await runViabilityReplay(db, "A01", { fixtureDir: path.join(TEST_FIXTURES, "via_missing_demand") });
    expect(r.verdict).toBe("fail_evidence");
    expect(r.payload.runner.missing).toEqual(["demand_evidence"]);
    expect(r.payload.runner.unsourced_moved).toEqual([]);
    const row = db.latestStageResult("A01", "viability")!;
    expect(row.verdict).toBe("fail_evidence");
    expect(row.doc_md).toContain("# A01 brief");
    expect(r.events.some((e) => e.kind === "runner_check" && (e.content as any).check === "completeness" && (e.content as any).ok === false)).toBe(true);
  });

  it("AC7: a URL the model never retrieved is moved to unsourced_claims and logged", async () => {
    const r = await runViabilityReplay(db, "A01", { fixtureDir: path.join(TEST_FIXTURES, "via_unsourced_url") });
    const bad = "https://example.com/never-fetched/pricing";
    expect(r.payload.payer.comparable_url).toBe("NOT FOUND");
    expect(r.payload.unsourced_claims.some((c) => c.includes(bad))).toBe(true);
    expect(r.payload.runner.unsourced_moved).toEqual([{ field: "payer.comparable_url", url: bad }]);
    const ev = r.events.find((e) => e.kind === "runner_override" && (e.content as any).kind === "unsourced_url_moved");
    expect(ev).toBeTruthy();
    expect(JSON.stringify(ev!.content)).toContain(bad);
    // Everything else was sourced, so the only gap is the moved URL.
    expect(r.verdict).toBe("fail_evidence");
    expect(r.payload.runner.missing).toEqual(["payer.comparable_url"]);
  });

  it("a fully sourced, complete brief gets verdict complete", async () => {
    // Same transcript family with nothing removed: rebuild it from the missing-demand set by restoring demand_evidence via the unsourced set's evidence.
    const r = await runViabilityReplay(db, "A01", { fixtureDir: path.join(TEST_FIXTURES, "via_unsourced_url") });
    expect(r.payload.demand_evidence.length).toBe(1);
    expect(r.payload.competitors[0].url).toBe("https://example.com/api-monitor");
  });
});
