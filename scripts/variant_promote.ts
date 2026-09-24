// Paul only. Promote a proposed or archived agent variant to active so live runs pick it up.
//   npm run variant:promote -- I0003
import { openDb } from "../src/store/db.js";
import { PATHS } from "../src/config.js";

const id = process.argv[2];
if (!id) {
  console.error("usage: npm run variant:promote -- <idea id>");
  process.exit(1);
}
const db = openDb(PATHS.db);
const idea = db.getAgentSafeIdea(id);
if (!idea) {
  console.error(`idea ${id} not found`);
  process.exit(1);
}
const before = db.getIdeaStatus(id);
db.setIdeaStatus(id, "active");
console.log(`${id}: ${before} -> active${idea.parent_id ? ` (variant of ${idea.parent_id})` : ""}`);
console.log(`  ${idea.idea}`);
db.close();
