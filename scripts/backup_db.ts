// Online backup of the store using SQLite's backup API (safe while the db is in use).
//   npm run backup:db   -> ~/Documents/idea-factory-backups/factory-YYYYMMDD-HHMM.db
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { PATHS } from "../src/config.js";

const dir = path.join(os.homedir(), "Documents", "idea-factory-backups");
fs.mkdirSync(dir, { recursive: true });
const d = new Date();
const p = (n: number) => String(n).padStart(2, "0");
const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
const dest = path.join(dir, `factory-${stamp}.db`);
if (fs.existsSync(dest)) {
  console.error(`${dest} already exists; wait a minute and retry`);
  process.exit(1);
}
const src = new Database(PATHS.db, { readonly: true, fileMustExist: true });
await src.backup(dest);
src.close();
const check = new Database(dest, { readonly: true });
const ok = check.pragma("integrity_check", { simple: true });
check.close();
console.log(`backup written: ${dest} (${fs.statSync(dest).size} bytes, integrity_check: ${ok})`);
if (ok !== "ok") process.exit(1);
