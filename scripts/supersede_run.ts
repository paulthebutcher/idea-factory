// Retire a run that later runs superseded: marks it superseded and cancels its open tasks.
//   npm run run:supersede -- live_run_1 live_run_2,live_run_3,live_run_4
import { openDb } from "../src/store/db.js";
import { PATHS } from "../src/config.js";

const [runId, by] = process.argv.slice(2);
if (!runId || !by) {
  console.error("usage: npm run run:supersede -- <run id> <superseding run ids, comma separated>");
  process.exit(1);
}
const db = openDb(PATHS.db);
const before = db.getRun(runId);
const n = db.supersedeRun(runId, by.split(","));
console.log(`${runId}: ${before?.status} -> ${db.getRun(runId)!.status}; cancelled ${n} open tasks`);
db.close();
