import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb, type Db } from "../src/store/db.js";
import { PATHS } from "../src/config.js";

interface SeedRow {
  id: string;
  set: string;
  seed_source: string;
  idea: string;
  source_url: string | null;
  verbatim_quote: string | null;
  customer: string | null;
  operability_label: string | null;
  operability_note: string | null;
  perplexity_operability: string | null;
  known_outcome: string | null;
  outcome_bucket: string | null;
  test_role: string | null;
  notes: string | null;
  paul_gut_v1: string | null;
  paul_gut_v1_reason: string | null;
}

const SEED_LABELERS = ["research", "claude_seed", "perplexity", "paul_gut_v1"];

/**
 * Idempotent seed load. Idea rows are inserted once (idea text is immutable). Seed labels are
 * replaced per (idea, labeler) so corrected seed files take effect. Outcomes are upserted.
 * Labels written by paul_annotation are never touched.
 */
export function seedIdeas(db: Db, jsonlPath: string = PATHS.seed): { ideas: number; labels: number; outcomes: number } {
  const lines = fs.readFileSync(jsonlPath, "utf8").split("\n").filter((l) => l.trim());
  const rows = lines.map((l) => JSON.parse(l) as SeedRow);
  const insertIdea = db.raw.prepare(
    `INSERT OR IGNORE INTO ideas (id, parent_id, idea, customer, source_url, verbatim_quote, seed_source, set_name, test_role, notes)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteLabel = db.raw.prepare("DELETE FROM labels WHERE idea_id = ? AND labeler = ?");
  const insertLabel = db.raw.prepare("INSERT INTO labels (idea_id, labeler, value, reason, note) VALUES (?, ?, ?, ?, ?)");
  const upsertOutcome = db.raw.prepare(
    `INSERT INTO outcomes (idea_id, outcome, bucket) VALUES (?, ?, ?)
     ON CONFLICT(idea_id) DO UPDATE SET outcome = excluded.outcome, bucket = excluded.bucket`,
  );
  let labels = 0;
  let outcomes = 0;
  db.raw.transaction(() => {
    for (const r of rows) {
      insertIdea.run(r.id, r.idea, r.customer ?? null, r.source_url ?? null, r.verbatim_quote ?? null, r.seed_source ?? null, r.set ?? null, r.test_role ?? null, r.notes ?? null);
      for (const labeler of SEED_LABELERS) deleteLabel.run(r.id, labeler);
      if (r.operability_label) {
        insertLabel.run(r.id, r.seed_source === "own" ? "claude_seed" : "research", r.operability_label, null, r.operability_note ?? null);
        labels++;
      }
      if (r.perplexity_operability) {
        insertLabel.run(r.id, "perplexity", r.perplexity_operability, null, null);
        labels++;
      }
      if (r.paul_gut_v1) {
        insertLabel.run(r.id, "paul_gut_v1", r.paul_gut_v1, r.paul_gut_v1_reason ?? null, null);
        labels++;
      }
      if (r.known_outcome && r.outcome_bucket) {
        upsertOutcome.run(r.id, r.known_outcome, r.outcome_bucket);
        outcomes++;
      }
    }
  })();
  return { ideas: db.countIdeas(), labels, outcomes };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = openDb();
  const r = seedIdeas(db);
  console.log(`seeded: ${r.ideas} ideas in store, ${r.labels} seed labels written, ${r.outcomes} outcomes`);
  db.close();
}
