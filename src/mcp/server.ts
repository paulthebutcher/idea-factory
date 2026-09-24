// Idea Factory MCP server. Claude Code and Codex both talk to the same SQLite store through these
// seven tools. Read tools return agent-safe views only (critical rule 2).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb, StoreError, type Db } from "../store/db.js";
import { PATHS } from "../config.js";

const STAGES = ["kill_gate", "viability", "critic"] as const;
const VERDICTS = ["pass", "kill", "complete", "fail_evidence", "error"] as const;

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }], structuredContent: payload as Record<string, unknown> };
}
function fail(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}
function guard<T>(fn: () => T) {
  try {
    return ok(fn());
  } catch (e) {
    if (e instanceof StoreError) return fail(e.message);
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export function buildServer(db: Db): McpServer {
  const server = new McpServer({ name: "idea-factory", version: "0.1.0" });

  server.registerTool(
    "create_idea",
    {
      description: "Insert an idea. Set parent_id to propose a narrower variant of an existing idea; the original's verdict stands. Idea text is immutable once inserted.",
      inputSchema: {
        idea: z.string().min(1),
        customer: z.string().nullable().optional(),
        source_url: z.string().nullable().optional(),
        verbatim_quote: z.string().nullable().optional(),
        parent_id: z.string().nullable().optional(),
      },
    },
    async (args) => guard(() => db.createIdea(args)),
  );

  server.registerTool(
    "get_idea",
    { description: "Return one idea (agent-safe view: id, parent_id, idea, customer, source_url, verbatim_quote).", inputSchema: { id: z.string() } },
    async ({ id }) =>
      guard(() => {
        const idea = db.getAgentSafeIdea(id);
        if (!idea) throw new StoreError(`idea ${id} not found`);
        return idea;
      }),
  );

  server.registerTool(
    "list_ideas",
    { description: "List ideas (agent-safe view) with the latest verdict per stage.", inputSchema: {} },
    async () =>
      guard(() => {
        const verdicts = db.latestVerdicts();
        const ideas = db.listAgentSafeIdeas().map((i) => ({ ...i, verdicts: verdicts[i.id] ?? {} }));
        return { count: ideas.length, ideas };
      }),
  );

  server.registerTool(
    "claim_task",
    {
      description: "Claim an open task before working on it. Returns status 'claimed' or 'already_claimed'. If already_claimed, pick another task.",
      inputSchema: { task_id: z.string(), agent: z.string().min(1).describe("claude | codex | script:<pid>") },
    },
    async ({ task_id, agent }) => guard(() => ({ task_id, status: db.claimTask(task_id, agent) })),
  );

  server.registerTool(
    "record_result",
    {
      description: "Write a stage result with its trace events. Rejected when events is empty: a stage result without trace events is invalid.",
      inputSchema: {
        run_id: z.string(),
        idea_id: z.string(),
        stage: z.enum(STAGES),
        verdict: z.enum(VERDICTS),
        payload: z.record(z.string(), z.unknown()),
        doc_md: z.string().nullable().optional(),
        rules_fired: z.array(z.string()).optional(),
        self_found: z.boolean().optional(),
        model: z.string(),
        agent: z.string(),
        prompt_hash: z.string(),
        cost_usd: z.number().min(0).default(0),
        events: z.array(z.object({ kind: z.string(), content: z.unknown() })),
        task_id: z.string().nullable().optional(),
      },
    },
    async (a) =>
      guard(() => {
        const row = db.recordStageResult({
          runId: a.run_id, ideaId: a.idea_id, stage: a.stage, verdict: a.verdict, payload: a.payload, docMd: a.doc_md ?? null,
          rulesFired: a.rules_fired ?? [], selfFound: a.self_found ?? false, model: a.model, agent: a.agent, promptHash: a.prompt_hash,
          costUsd: a.cost_usd ?? 0, events: a.events, taskId: a.task_id ?? null,
        });
        return { stage_result_id: row.id, verdict: row.verdict, events: a.events.length };
      }),
  );

  server.registerTool(
    "propose_rule",
    {
      description: "Propose a kill rule or test with status 'proposed'. Requires test_case_ids naming ideas that must trigger and must not trigger it. Only Paul activates rules.",
      inputSchema: {
        kind: z.enum(["kill_rule", "hard_test", "soft_test"]),
        text: z.string().min(1),
        test_case_ids: z.object({ must_trigger: z.array(z.string()).default([]), must_not_trigger: z.array(z.string()).default([]) }),
        proposed_by: z.string().min(1),
        source_run_id: z.string().nullable().optional(),
      },
    },
    async (a) =>
      guard(() => {
        const r = db.proposeRule(a);
        return { id: r.id, kind: r.kind, text: r.text, status: r.status, test_case_ids: JSON.parse(r.test_case_ids ?? "{}") };
      }),
  );

  server.registerTool(
    "list_rules",
    { description: "List rules by status (proposed | active | retired). Omit status for all.", inputSchema: { status: z.enum(["proposed", "active", "retired"]).optional() } },
    async ({ status }) => guard(() => ({ rules: db.agentSafeRules(status) })),
  );

  return server;
}

async function main() {
  const db = openDb(PATHS.db);
  const server = buildServer(db);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const shutdown = () => {
    try {
      db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((e) => {
  console.error("idea-factory mcp server failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
