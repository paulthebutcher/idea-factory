// Paul only. Activate a proposed rule so stage prompts start receiving it.
//   npm run rule:activate -- T9
import { openDb } from "../src/store/db.js";
import { PATHS } from "../src/config.js";

const id = process.argv[2];
if (!id) {
  console.error("usage: npm run rule:activate -- <rule id>");
  process.exit(1);
}
const db = openDb(PATHS.db);
const before = db.listRules().find((r) => r.id === id);
if (!before) {
  console.error(`rule ${id} not found`);
  process.exit(1);
}
const r = db.activateRule(id);
console.log(`${r.id} (${r.kind}): ${before.status} -> ${r.status} at ${r.activated_at}`);
console.log(`  ${r.text}`);
console.log(`  test cases: ${r.test_case_ids}`);
db.close();
