-- 003: Checkpoint 1 decisions, 2026-09-24. Applied by src/store/db.ts to stores at user_version < 3.
-- Fresh stores get the same end state from schema.sql.

-- D006: R001 narrowed to ongoing obligations; one-time setup becomes a T8 flag.
INSERT OR IGNORE INTO decisions (id, text, rationale) VALUES
 ('D006','R001 kills only ongoing obligations needing standing legal or compliance capacity. One-time legal setup is a T8 flag.','Paul accepts a one-time legal consult and has regulated-industry experience (banking, payments, healthcare clients). The original wording also targeted filing on a customer''s behalf, which missed his intent.');

UPDATE rules SET text = 'The business cannot operate without an ongoing regulatory obligation that needs standing legal or compliance capacity: a license or registration with ongoing regulator supervision or exams (money transmission, investment adviser, broker-dealer, insurance producer, licensed professional practice); acting as the professional of record who bears liability for each output (signing tax returns, giving legal, medical, or investment advice); or holding or moving customer funds. Setup work that a one-time legal consult can resolve does not trigger this rule; it triggers T8.',
  test_case_ids = '{"must_trigger":["H01"],"must_not_trigger":["A02","O03","B09","H02"],"observe":["A07"]}'
 WHERE id = 'R001';

INSERT OR IGNORE INTO rules (id, kind, text, test_case_ids, status, proposed_by, activated_at) VALUES
 ('T8','soft_test','Launch requires regulatory setup that a one-time legal consult can resolve (BAA templates, HIPAA security program, privacy terms, COPPA consent, state registrations, e-file provider applications). Record what the consult would need to cover.','{"must_trigger":["B09","H02"],"must_not_trigger":[]}','active','paul',datetime('now'));

UPDATE rules SET text = 'A core function depends on one third party that can revoke access, and the use is not permitted by a sanctioned API or the platform''s terms. Violating the terms is sufficient; enforcement history and competitors operating the same way are irrelevant.',
  test_case_ids = '{"must_trigger":["A09","P06","H03"],"must_not_trigger":["A01","H04"],"observe":["B08"]}'
 WHERE id = 'T2';

UPDATE rules SET test_case_ids = '{"must_trigger":[],"must_not_trigger":["A11"]}' WHERE id = 'T3';
