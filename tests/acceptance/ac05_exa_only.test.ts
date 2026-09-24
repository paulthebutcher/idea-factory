import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshSeededDb, TEST_FIXTURES } from "./helpers.js";
import { runKillGateReplay } from "./kill_gate_helpers.js";
import type { Db } from "../../src/store/db.js";

// AC5: Kill gate fixture with only Exa queries recorded. Verdict error. Nothing recorded as pass.
// The fixture set in tests/acceptance/fixtures/exa_only holds a model transcript that only calls
// exa_search and reports no Brave queries. Its final JSON says "pass"; the runner must not accept it.

describe("AC5: missing Brave queries set verdict error", () => {
  let db: Db;
  beforeAll(() => ({ db } = freshSeededDb()));
  afterAll(() => db.close());

  it("records verdict error and never pass", async () => {
    const r = await runKillGateReplay(db, "A01", { fixtureDir: path.join(TEST_FIXTURES, "exa_only") });
    expect(r.verdict).toBe("error");
    const rows = db.raw.prepare("SELECT verdict FROM stage_results WHERE idea_id = 'A01'").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows.map((x) => x.verdict)).toEqual(["error"]);
    expect(r.events.some((e) => e.kind === "error")).toBe(true);
    const errorEvent = r.events.find((e) => e.kind === "error")!;
    expect(JSON.stringify(errorEvent.content)).toMatch(/brave/i);
  });
});
