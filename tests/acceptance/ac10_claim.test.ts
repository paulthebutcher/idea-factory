import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { freshSeededDb, spawnMcpClient, toolJson } from "./helpers.js";
import type { Db } from "../../src/store/db.js";

// AC10: Two processes claim the same task at once. Exactly one gets claimed.

describe("AC10: atomic task claims across processes", () => {
  let db: Db;
  let dbPath: string;
  beforeAll(() => ({ db, dbPath } = freshSeededDb()));
  afterAll(() => db.close());

  it("exactly one of two MCP server processes wins the claim", async () => {
    const run = db.createRun({ stages: ["kill_gate"], budgetUsd: 1, configJson: {} });
    const [task] = db.createTasks(run.id, "kill_gate", ["A01"]);

    const a = await spawnMcpClient(dbPath, "agent-a");
    const b = await spawnMcpClient(dbPath, "agent-b");
    try {
      const results = await Promise.all([
        a.client.callTool({ name: "claim_task", arguments: { task_id: task.id, agent: "claude" } }),
        b.client.callTool({ name: "claim_task", arguments: { task_id: task.id, agent: "codex" } }),
      ]);
      const statuses = results.map((r) => toolJson(r).status).sort();
      expect(statuses).toEqual(["already_claimed", "claimed"]);
      const row = db.raw.prepare("SELECT claimed_by, status FROM tasks WHERE id = ?").get(task.id) as any;
      expect(row.status).toBe("claimed");
      expect(["claude", "codex"]).toContain(row.claimed_by);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("repeated racing claims never double-claim (50 tasks, two processes each)", async () => {
    const run = db.createRun({ stages: ["kill_gate"], budgetUsd: 1, configJson: {} });
    const ids = Array.from({ length: 50 }, (_, i) => (i < 46 ? undefined : undefined));
    const ideaIds = (db.raw.prepare("SELECT id FROM ideas ORDER BY id LIMIT 46").all() as any[]).map((r) => r.id);
    const tasks = db.createTasks(run.id, "kill_gate", ideaIds);
    void ids;
    const a = await spawnMcpClient(dbPath, "agent-a");
    const b = await spawnMcpClient(dbPath, "agent-b");
    try {
      let claimed = 0;
      for (const t of tasks) {
        const results = await Promise.all([
          a.client.callTool({ name: "claim_task", arguments: { task_id: t.id, agent: "claude" } }),
          b.client.callTool({ name: "claim_task", arguments: { task_id: t.id, agent: "codex" } }),
        ]);
        const wins = results.filter((r) => toolJson(r).status === "claimed").length;
        expect(wins).toBe(1);
        claimed += wins;
      }
      expect(claimed).toBe(tasks.length);
    } finally {
      await a.close();
      await b.close();
    }
  });
});
