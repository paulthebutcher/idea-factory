// Generates the hand-written fixture sets used by AC5 and the runner-override tests.
//   npx tsx tests/acceptance/fixtures/synthetic.ts
// Each set is a model transcript plus the search fixtures its tool calls need. The final JSON is
// deliberately wrong in a way the runner must catch.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFixture } from "../../../src/search/fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const usage = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const msg = (id: string, content: unknown[], stop_reason: string) => ({ id, type: "message", role: "assistant", model: "claude-sonnet-5", content, stop_reason, stop_sequence: null, usage });
const call = (index: number, response: unknown) => ({ index, request_digest: "synthetic", usage, cost_usd: 0.004, response });

function searchFixture(dir: string, engine: "exa" | "brave", query: string, snippet: string, url: string) {
  writeFixture(dir, { engine, query, params: {}, recorded_at: "2026-09-23T00:00:00.000Z", cost_usd: 0, response: { engine, query, results: [{ title: "Example", url, snippet, published: null }] } });
}

function writeTranscript(dir: string, ideaId: string, calls: unknown[], stage = "kill_gate") {
  const file = path.join(dir, "model", stage, `${ideaId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ stage, idea_id: ideaId, model: "claude-sonnet-5", recorded_at: "2026-09-23T00:00:00.000Z", calls }, null, 2) + "\n");
}

const base = (ideaId: string) => ({
  idea_id: ideaId,
  flags: [],
  competitors: [{ name: "Example Co", url: "https://example.com/product", relationship: "adjacent", pricing: null, evidence: "Adjacent product." }],
  proposed_variant: null,
  injection_seen: [],
});

// AC5: A01, Exa only. Final JSON claims pass and lists no Brave queries.
{
  const dir = path.join(here, "exa_only");
  const q1 = "service that monitors third-party API breaking changes and opens pull requests";
  const q2 = "automated API migration agent for SDK deprecations";
  searchFixture(dir, "exa", q1, "Tracks API changelogs and alerts engineering teams.", "https://example.com/api-monitor");
  searchFixture(dir, "exa", q2, "Opens PRs to update deprecated SDK calls.", "https://example.com/migration-bot");
  const final = {
    ...base("A01"),
    verdict: "pass",
    tests: [
      { id: "R001", result: "pass", evidence: "Software for engineering teams; the operator is not a regulated party.", source_url: null },
      { id: "T2", result: "pass", evidence: "Works across many API vendors through the GitHub App API, which is sanctioned.", source_url: null },
      { id: "T3", result: "pass", evidence: "Software only.", source_url: null },
      { id: "T7", result: "pass", evidence: "No physical infrastructure.", source_url: null },
    ],
    queries: { exa: [q1, q2], brave: [] },
  };
  writeTranscript(dir, "A01", [
    call(0, msg("msg_synthetic_1", [
      { type: "tool_use", id: "toolu_synthetic_1", name: "exa_search", input: { query: q1, num_results: 5 } },
      { type: "tool_use", id: "toolu_synthetic_2", name: "exa_search", input: { query: q2, num_results: 5 } },
    ], "tool_use")),
    call(1, msg("msg_synthetic_2", [{ type: "text", text: JSON.stringify(final, null, 2) }], "end_turn")),
  ]);
}

// Runner overrides: A07 with full search coverage.
//   pass_to_kill: model says pass although R001 failed with evidence.
//   kill_to_pass: model says kill although no hard test failed with evidence.
for (const [set, verdict, tests] of [
  ["pass_to_kill", "pass", [
    { id: "R001", result: "fail", evidence: "The product files US and foreign returns on the customer's behalf, making the operator a tax preparer.", source_url: "https://www.irs.gov/tax-professionals/ptin-requirements-for-tax-return-preparers" },
    { id: "T2", result: "pass", evidence: "No single revocable platform dependency.", source_url: null },
    { id: "T3", result: "pass", evidence: "Software only.", source_url: null },
    { id: "T7", result: "pass", evidence: "No physical infrastructure.", source_url: null },
  ]],
  ["kill_to_pass", "kill", [
    { id: "R001", result: "unknown", evidence: "Could not determine whether the operator files returns.", source_url: null },
    { id: "T2", result: "pass", evidence: "No single revocable platform dependency.", source_url: null },
    { id: "T3", result: "pass", evidence: "Software only.", source_url: null },
    { id: "T7", result: "pass", evidence: "No physical infrastructure.", source_url: null },
    { id: "T5", result: "fail", evidence: "Soft tests never kill, even when marked fail.", source_url: null },
  ]],
] as const) {
  const dir = path.join(here, set);
  const e1 = "tax filing software for American expats";
  const e2 = "US expat tax preparation service";
  const b1 = "expat tax filing US citizens abroad software";
  const b2 = "TurboTax for expats alternative";
  searchFixture(dir, "exa", e1, "Expat tax preparation service.", "https://example.com/expat-tax");
  searchFixture(dir, "exa", e2, "US returns for citizens abroad.", "https://example.com/us-abroad");
  searchFixture(dir, "brave", b1, "Software for filing from overseas.", "https://example.com/overseas");
  searchFixture(dir, "brave", b2, "Alternatives to TurboTax for expats.", "https://example.com/alternatives");
  const final = { ...base("A07"), verdict, tests: [...tests], queries: { exa: [e1, e2], brave: [b1, b2] } };
  writeTranscript(dir, "A07", [
    call(0, msg("msg_synthetic_1", [
      { type: "tool_use", id: "toolu_synthetic_1", name: "exa_search", input: { query: e1 } },
      { type: "tool_use", id: "toolu_synthetic_2", name: "exa_search", input: { query: e2 } },
    ], "tool_use")),
    call(1, msg("msg_synthetic_2", [
      { type: "tool_use", id: "toolu_synthetic_3", name: "brave_search", input: { query: b1 } },
      { type: "tool_use", id: "toolu_synthetic_4", name: "brave_search", input: { query: b2 } },
    ], "tool_use")),
    call(2, msg("msg_synthetic_3", [{ type: "text", text: "```json\n" + JSON.stringify(final, null, 2) + "\n```" }], "end_turn")),
  ]);
}
// Viability sets for A01. Both share two searches and one fetched page.
//   via_missing_demand: every field sourced except demand_evidence, which is empty -> fail_evidence (AC6).
//   via_unsourced_url: payer.comparable_url cites a URL no tool returned -> moved to unsourced_claims (AC7).
{
  const e1 = "API breaking change monitoring service pricing";
  const b1 = "developer tool for third-party API deprecations pull requests";
  const page = "https://example.com/api-monitor/pricing";
  const forum = "https://example.com/forum/api-breaking-changes";
  const viaBase = {
    idea_id: "A01",
    payer: { who: "Engineering managers at API-heavy startups", price_hypothesis: "$99 per repo per month", comparable_url: page },
    competitors: [{ name: "Example API Monitor", url: "https://example.com/api-monitor", pricing: "$99/month", pricing_url: page }],
    competitors_not_found_queries: [],
    acquisition_channel: [{ channel: "GitHub Marketplace listing", cost_estimate: "Free listing, ~$0 CAC", source_url: "https://example.com/api-monitor" }],
    demand_evidence: [{ quote: "Every quarter some vendor breaks our integration and we find out in prod.", url: forum }],
    case_for: "Pure software with a GitHub App distribution channel and a recurring, well-understood pain.",
    case_against: "Vendors already publish changelogs and SDK bots; the neutral third party may not be trusted with code access.",
    open_questions: ["Will teams grant write access to a third-party app?"],
    regulatory_setup: null,
    unsourced_claims: [],
    injection_seen: [],
    brief_md: "# A01 brief\n\nComparable pricing: " + page + "\n\nDemand: " + forum + "\n",
  };
  for (const [set, patch] of [
    ["via_missing_demand", { demand_evidence: [] }],
    ["via_unsourced_url", { payer: { ...viaBase.payer, comparable_url: "https://example.com/never-fetched/pricing" } }],
  ] as const) {
    const dir = path.join(here, set);
    searchFixture(dir, "exa", e1, "Example API Monitor: plans from $99/month.", "https://example.com/api-monitor");
    searchFixture(dir, "brave", b1, "Thread: every quarter some vendor breaks our integration.", forum);
    writeFixture(dir, { engine: "exa_contents", query: page, params: {}, recorded_at: "2026-09-23T00:00:00.000Z", cost_usd: 0, response: { url: page, title: "Pricing", text: "Starter $99/month per repository. Team $299/month." } });
    const final = { ...viaBase, ...patch };
    writeTranscript(dir, "A01", [
      call(0, msg("msg_via_1", [
        { type: "tool_use", id: "toolu_via_1", name: "exa_search", input: { query: e1 } },
        { type: "tool_use", id: "toolu_via_2", name: "brave_search", input: { query: b1 } },
      ], "tool_use")),
      call(1, msg("msg_via_2", [{ type: "tool_use", id: "toolu_via_3", name: "fetch_page", input: { url: page } }], "tool_use")),
      call(2, msg("msg_via_3", [{ type: "text", text: JSON.stringify(final, null, 2) }], "end_turn")),
    ], "viability");
  }
}
console.log("synthetic fixture sets written: exa_only, pass_to_kill, kill_to_pass, via_missing_demand, via_unsourced_url");
