-- Idea Factory v0 store. SQLite in WAL mode so Claude Code and Codex can share it.
-- Source of truth for everything. ledger/ and traces/ are generated from this.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Ideas. Agent-visible columns: id, parent_id, idea, customer, source_url, verbatim_quote.
-- Hidden columns (never returned by MCP read tools): seed_source, set_name, test_role, notes.
CREATE TABLE ideas (
  id             TEXT PRIMARY KEY,            -- seed ids (A01, P06, B08, O03) or generated (I0001)
  parent_id      TEXT REFERENCES ideas(id),   -- set when an agent proposes a narrowed variant
  idea           TEXT NOT NULL,               -- immutable after insert
  customer       TEXT,
  source_url     TEXT,
  verbatim_quote TEXT,
  seed_source    TEXT,                        -- research | perplexity | own | agent_variant
  set_name       TEXT,                        -- discovery | backtest
  test_role      TEXT,
  notes          TEXT,
  status         TEXT NOT NULL DEFAULT 'active', -- active | proposed_variant | archived (migration 004)
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER ideas_immutable BEFORE UPDATE OF idea ON ideas
BEGIN SELECT RAISE(ABORT, 'idea text is immutable; create a variant with parent_id'); END;

-- Labels from any labeler. Hidden from agents.
CREATE TABLE labels (
  id         INTEGER PRIMARY KEY,
  idea_id    TEXT NOT NULL REFERENCES ideas(id),
  labeler    TEXT NOT NULL,                   -- paul_gut_v1 | research | perplexity | claude_seed | paul_annotation
  value      TEXT NOT NULL,                   -- yes | conditional | no
  reason     TEXT,                            -- merit | regulatory | other (paul_gut_v1 "no" only)
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Known outcomes for backtest rows. Hidden from agents.
CREATE TABLE outcomes (
  idea_id       TEXT PRIMARY KEY REFERENCES ideas(id),
  outcome       TEXT NOT NULL,
  bucket        TEXT NOT NULL,
  business_name TEXT,                        -- the actual business; drives stage_results.self_found
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ledger decisions (D001...). Paul's calls, with rationale.
CREATE TABLE decisions (
  id         TEXT PRIMARY KEY,
  text       TEXT NOT NULL,
  rationale  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Kill rules and operability tests. Agents may propose; only Paul activates (npm run rule:activate).
-- test_case_ids: {"must_trigger":[], "must_not_trigger":[], "observe":[], "reasons":{id: why}}. observe rows are reported, never asserted.
-- Rule text history: R001 and T2 were rewritten and T8 added by migrations/003 (Checkpoint 1, D006).
CREATE TABLE rules (
  id              TEXT PRIMARY KEY,           -- R001, T2, T3...
  kind            TEXT NOT NULL,              -- kill_rule | hard_test | soft_test
  text            TEXT NOT NULL,
  test_case_ids   TEXT,                       -- JSON array of idea ids that must trigger / must not trigger
  status          TEXT NOT NULL,              -- proposed | active | retired
  proposed_by     TEXT,                       -- paul | claude | codex
  source_run_id   TEXT,
  activated_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE runs (
  id           TEXT PRIMARY KEY,
  stages       TEXT NOT NULL,                 -- JSON array: ["kill_gate","viability","critic"]
  config_json  TEXT NOT NULL,                 -- models, prompt file hashes, search mode, budget
  budget_usd   REAL NOT NULL,
  spent_usd    REAL NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,                 -- running | complete | budget_exceeded | error
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);

-- Work claiming so two agents never run the same task. Claim is atomic:
-- UPDATE tasks SET claimed_by=?, claimed_at=datetime('now'), status='claimed'
--   WHERE id=? AND claimed_by IS NULL;  -- success only if changes() = 1
CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id),
  idea_id     TEXT REFERENCES ideas(id),
  stage       TEXT NOT NULL,
  claimed_by  TEXT,                           -- claude | codex | script:<pid>
  claimed_at  TEXT,
  status      TEXT NOT NULL DEFAULT 'open'    -- open | claimed | done | error
);

CREATE TABLE stage_results (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  idea_id      TEXT NOT NULL REFERENCES ideas(id),
  stage        TEXT NOT NULL,                 -- kill_gate | viability | critic
  verdict      TEXT NOT NULL,                 -- pass | kill | complete | fail_evidence | error
  payload_json TEXT NOT NULL,                 -- validated stage output
  doc_md       TEXT,                          -- viability document
  rules_fired  TEXT,                          -- JSON array of rule ids
  self_found   INTEGER NOT NULL DEFAULT 0,    -- backtest: research found the actual business
  model        TEXT NOT NULL,
  agent        TEXT NOT NULL,
  prompt_hash  TEXT NOT NULL,
  cost_usd     REAL NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per event in a stage call. A stage_result without trace events is invalid.
CREATE TABLE trace_events (
  id              INTEGER PRIMARY KEY,
  stage_result_id TEXT NOT NULL REFERENCES stage_results(id),
  seq             INTEGER NOT NULL,
  kind            TEXT NOT NULL,              -- system | input | model_call | tool_call | tool_result | output | error
  content_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (stage_result_id, seq)
);

CREATE TABLE comparisons (
  id           INTEGER PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id),
  round        INTEGER NOT NULL,
  idea_a       TEXT NOT NULL REFERENCES ideas(id),
  idea_b       TEXT NOT NULL REFERENCES ideas(id),
  order_ab     TEXT NOT NULL,                 -- winner when shown A first: A | B
  order_ba     TEXT NOT NULL,                 -- winner when shown B first: A | B
  result       TEXT NOT NULL,                 -- A | B | tie (tie when the two orders disagree)
  rationale_json TEXT NOT NULL,
  model        TEXT NOT NULL,
  stage_result_id TEXT REFERENCES stage_results(id), -- trace events for this comparison (migration 004)
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Paul's annotations from the review app, imported after each session.
CREATE TABLE annotations (
  id              INTEGER PRIMARY KEY,
  stage_result_id TEXT REFERENCES stage_results(id),
  idea_id         TEXT REFERENCES ideas(id),
  note            TEXT NOT NULL,
  failure_mode    TEXT,                       -- assigned when annotations are clustered
  author          TEXT NOT NULL DEFAULT 'paul',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Seed rows for decisions and rules. Existing stores reach the same state through migrations/*.sql.
INSERT INTO decisions (id, text, rationale) VALUES
 ('D001','Learning-first framing. A survivor of a market test gets one more cycle, then becomes a standalone project or is parked with a written reason.','Goal is documented 0-to-1 decisions with outcomes; evidence of product judgment.'),
 ('D002','Rule R001: kill any idea that makes Paul the regulated party. Ideas that sell to regulated customers pass.','From Paul''s labels: license tracker yes, WCAG Engine yes, expat tax filing no. Cydoc (B09) died on this line.'),
 ('D003','Merit doubts never kill. They are recorded as pre-registered predictions for the viability stage to confirm or overturn.','Gut calls are hypotheses. Overturned gut calls are the most valuable ledger entries.'),
 ('D004','Operability tests T2 to T7 are starter assumptions. T2, T3 and T7 kill; T4 to T6 flag only until error discovery says otherwise.','Paul accepted the starter assumptions; plans to learn to run sales and support with agents.'),
 ('D005','Competitor search uses Exa (neural) and Brave (keyword). "No competitor found" requires both engines to return no direct competitor.','Exa for conceptual matches, Brave for freshness and exact terms.'),
 ('D006','R001 kills only ongoing obligations needing standing legal or compliance capacity. One-time legal setup is a T8 flag.','Paul accepts a one-time legal consult and has regulated-industry experience (banking, payments, healthcare clients). The original wording also targeted filing on a customer''s behalf, which missed his intent.');

INSERT INTO rules (id, kind, text, test_case_ids, status, proposed_by, activated_at) VALUES
 ('R001','kill_rule','The business cannot operate without an ongoing regulatory obligation that needs standing legal or compliance capacity: a license or registration with ongoing regulator supervision or exams (money transmission, investment adviser, broker-dealer, insurance producer, licensed professional practice); acting as the professional of record who bears liability for each output (signing tax returns, giving legal, medical, or investment advice); or holding or moving customer funds. Setup work that a one-time legal consult can resolve does not trigger this rule; it triggers T8.','{"must_trigger":["H01"],"must_not_trigger":["A02","O03","B09","H02"],"observe":["A07"]}','active','paul',datetime('now')),
 ('T2','hard_test','A core function depends on one third party that can revoke access, and the use is not permitted by a sanctioned API or the platform''s terms. Violating the terms is sufficient; enforcement history and competitors operating the same way are irrelevant.','{"must_trigger":["P06","H03"],"must_not_trigger":["A01","H04"],"observe":["A09","B08"],"reasons":{"A09":"T2 requires a revocable dependency plus use not permitted by terms. A DOM filter on the user''s own page may meet neither. The original concern was interface fragility, which T2 does not test.","B08":"Samples split 1 of 3. Substack has no content API, but public RSS feeds are a sanctioned syndication path; whether a cross-publication digest and search exceeds permitted use is unresolved. Observe until the terms question is settled."}}','active','paul',datetime('now')),
 ('T3','hard_test','The operator must buy, store, or ship physical inventory, with no fully outsourced fulfillment path.','{"must_trigger":[],"must_not_trigger":["A11"],"reasons":{"A11":"T3 exempts ideas with a fully outsourced fulfillment path. Swag fulfillment APIs (SwagUp, Swag.com) provide one, so A11 does not meet T3 as written; the planted expectation was wrong, not the model."}}','active','paul',datetime('now')),
 ('T4','soft_test','Closing the first customer requires field sales, enterprise procurement, or a sales team.','{}','active','paul',datetime('now')),
 ('T5','soft_test','Each customer transaction needs human service or support that cannot be automated at scale.','{}','active','paul',datetime('now')),
 ('T6','soft_test','No plausible path to a paying customer within 90 days of launch.','{}','active','paul',datetime('now')),
 ('T7','hard_test','Obvious capital or physical infrastructure requirement beyond one person (hardware manufacturing, defense procurement, fleets, facilities).','{"must_trigger":["P07","P08"],"must_not_trigger":[]}','active','paul',datetime('now')),
 ('T8','soft_test','Launch requires regulatory setup that a one-time legal consult can resolve (BAA templates, HIPAA security program, privacy terms, COPPA consent, state registrations, e-file provider applications). Record what the consult would need to cover.','{"must_trigger":["B09","H02"],"must_not_trigger":[]}','active','paul',datetime('now'));
INSERT INTO rules (id, kind, text, test_case_ids, status, proposed_by) VALUES
 ('T9','soft_test','A core function depends on an undocumented interface (page markup, private endpoints) that can change without notice.','{"must_trigger":["A09"],"must_not_trigger":["A01"]}','proposed','paul');
