// The TypeScript daemon's append path for comparison: node:sqlite, one
// connection, WAL, default synchronous, one implicit transaction per row.
import { DatabaseSync } from "node:sqlite";

const [file, secsArg] = process.argv.slice(2);
if (!file) throw new Error("usage: node-append-bench.ts <state.db copy> [seconds]");
const secs = Number(secsArg ?? 5);
const db = new DatabaseSync(file);
db.exec("PRAGMA journal_mode = WAL");
const insert = db.prepare("INSERT INTO events (worker_id, ts, type, payload) VALUES (?, ?, ?, ?)");
const payload = JSON.stringify({ kind: "text", text: "the quick brown fox jumps over the lazy dog ".repeat(30), seq: 0 });
const start = performance.now();
let n = 0;
while (performance.now() - start < secs * 1000) {
  insert.run("rs-bench-node", n, "text", payload);
  n++;
}
const elapsed = (performance.now() - start) / 1000;
console.log(JSON.stringify({
  sqlite: (db.prepare("select sqlite_version() v").get() as { v: string }).v,
  synchronous: (db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous,
  rows_per_s: Math.round(n / elapsed),
}));
db.close();
