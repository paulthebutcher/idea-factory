import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshSeededDb, spawnMcpClient, toolJson, allKeys, HIDDEN_FIELDS } from "./helpers.js";
import type { Db } from "../../src/store/db.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

// AC1: Seed, then call get_idea and list_ideas for B01 and A07 through MCP.
// 46 ideas loaded. Responses contain no labels, outcomes, seed_source, set_name, test_role, or notes.

describe("AC1: store, seed, agent-safe MCP reads", () => {
  let db: Db;
  let dbPath: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, dbPath } = freshSeededDb());
    ({ client, close } = await spawnMcpClient(dbPath));
  });
  afterAll(async () => {
    await close();
    db.close();
  });

  // 46 seed rows plus the four holdout ideas H01-H04 added at Checkpoint 1 (seed_source 'holdout').
  const IDEA_COUNT = 50;

  it("loads the seed ideas, labels and outcomes, idempotently", async () => {
    expect(db.countIdeas()).toBe(IDEA_COUNT);
    const { seedIdeas } = await import("../../scripts/seed.js");
    const { SEED_PATH } = await import("./helpers.js");
    seedIdeas(db, SEED_PATH); // second load must not duplicate
    expect(db.countIdeas()).toBe(IDEA_COUNT);
    const labels = db.raw.prepare("SELECT labeler, COUNT(*) AS n FROM labels GROUP BY labeler ORDER BY labeler").all() as any[];
    const byLabeler = Object.fromEntries(labels.map((l) => [l.labeler, l.n]));
    // Seed file: 41 non-own rows carry operability_label -> research; 3 of 5 own rows -> claude_seed;
    // 19 rows carry perplexity_operability; 45 carry paul_gut_v1 (O05 has none).
    expect(byLabeler.research).toBe(41);
    expect(byLabeler.claude_seed).toBe(3);
    expect(byLabeler.perplexity).toBe(19);
    expect(byLabeler.paul_gut_v1).toBe(45);
    const outcomes = db.raw.prepare("SELECT COUNT(*) AS n FROM outcomes").get() as any;
    expect(outcomes.n).toBe(14); // backtest rows
  });

  it("exposes exactly the seven tools", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["claim_task", "create_idea", "get_idea", "list_ideas", "list_rules", "propose_rule", "record_result"]);
  });

  for (const id of ["B01", "A07"]) {
    it(`get_idea ${id} returns the agent-safe view only`, async () => {
      const res = await client.callTool({ name: "get_idea", arguments: { id } });
      const idea = toolJson(res);
      expect(idea.id).toBe(id);
      expect(Object.keys(idea).sort()).toEqual(["customer", "id", "idea", "parent_id", "source_url", "verbatim_quote"]);
      const keys = allKeys(idea);
      for (const f of HIDDEN_FIELDS) expect(keys.has(f), `hidden field ${f} leaked`).toBe(false);
      const text = JSON.stringify(res);
      for (const leak of ["Zigpoll", "over_50k_mrr", "planted_regulated", "backtest", "discovery", "paul_gut"]) {
        expect(text.includes(leak), `hidden value ${leak} leaked`).toBe(false);
      }
    });
  }

  it("list_ideas returns every idea as an agent-safe row with latest verdicts and no hidden fields", async () => {
    const res = await client.callTool({ name: "list_ideas", arguments: {} });
    const body = toolJson(res);
    const ideas: any[] = body.ideas ?? body;
    expect(ideas.length).toBe(IDEA_COUNT);
    const keys = allKeys(ideas);
    for (const f of HIDDEN_FIELDS) expect(keys.has(f), `hidden field ${f} leaked`).toBe(false);
    const b01 = ideas.find((i) => i.id === "B01");
    const a07 = ideas.find((i) => i.id === "A07");
    expect(b01).toBeTruthy();
    expect(a07).toBeTruthy();
    expect(b01).toHaveProperty("verdicts");
    const text = JSON.stringify(res);
    for (const leak of ["Zigpoll", "Cydoc", "StackDigest", "WCAG Engine", "over_50k_mrr", "failed_platform", "planted_", "label_conflict", "crowded_market", "holdout"]) {
      expect(text.includes(leak), `hidden value ${leak} leaked`).toBe(false);
    }
  });

  it("record_result is rejected without trace events (critical rule 7)", async () => {
    const run = db.createRun({ stages: ["kill_gate"], budgetUsd: 1, configJson: {} });
    const res = await client.callTool({
      name: "record_result",
      arguments: {
        run_id: run.id, idea_id: "A01", stage: "kill_gate", verdict: "pass",
        payload: { idea_id: "A01" }, model: "test", agent: "test", prompt_hash: "x", cost_usd: 0, events: [],
      },
    });
    expect(res.isError).toBe(true);
    const n = (db.raw.prepare("SELECT COUNT(*) AS n FROM stage_results").get() as any).n;
    expect(n).toBe(0);
  });

  it("idea text is immutable at the store level", () => {
    expect(() => db.raw.prepare("UPDATE ideas SET idea = 'changed' WHERE id = 'A01'").run()).toThrow(/immutable/);
  });
});
