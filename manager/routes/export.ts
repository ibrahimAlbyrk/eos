import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Router } from "./Router.ts";
import type { Container } from "../container.ts";
import { writeJson } from "../middleware/errorHandler.ts";
import type { WorkerEventRow } from "../../contracts/src/events.ts";

// Read template once at module load
let cachedTemplate: string | null = null;
function getTemplate(): string {
  if (cachedTemplate) return cachedTemplate;
  const dir = dirname(fileURLToPath(import.meta.url));
  const tmplPath = join(dir, "..", "templates", "export.html");
  if (!existsSync(tmplPath)) {
    throw new Error("export template not found at " + tmplPath);
  }
  cachedTemplate = readFileSync(tmplPath, "utf-8");
  return cachedTemplate;
}

interface ExportWorkerMeta {
  name: string;
  is_orchestrator: boolean;
}

interface ExportEvent {
  worker_id: string;
  worker_name: string;
  event_id: number;
  ts: number;
  type: string;
  payload: unknown;
}

interface ExportData {
  exported_at: string;
  workers: Record<string, ExportWorkerMeta>;
  events: ExportEvent[];
}

function collectDescendantIds(workerRepo: Container["workers"], parentId: string): string[] {
  const ids: string[] = [parentId];
  const direct = workerRepo.findChildrenIds(parentId);
  for (const childId of direct) {
    ids.push(...collectDescendantIds(workerRepo, childId));
  }
  return ids;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function registerExportRoutes(r: Router, c: Container): void {
  r.get(/^\/workers\/(?<id>[^/]+)\/export$/, async ({ params, url, res }) => {
    const workerId = params.id;
    const tree = url.searchParams.get("tree") === "true";

    // Look up the requested worker
    const rootWorker = c.workers.findById(workerId);
    if (!rootWorker) {
      writeJson(res, 404, { error: "worker not found" });
      return;
    }

    // Collect worker IDs
    const workerIds = tree
      ? collectDescendantIds(c.workers, workerId)
      : [workerId];

    // Build workers map + collect all events
    const workers: Record<string, ExportWorkerMeta> = {};
    const allEvents: ExportEvent[] = [];

    for (const wid of workerIds) {
      const w = c.workers.findById(wid);
      if (!w) continue;

      workers[wid] = {
        name: w.name ?? wid,
        is_orchestrator: w.is_orchestrator === 1,
      };

      const rows = c.events.list({ workerId: wid, since: 0, limit: 1_000_000, order: "asc" });
      for (const row of rows) {
        let payload: unknown = null;
        try {
          payload = row.payload ? JSON.parse(row.payload) : null;
        } catch {
          payload = row.payload;
        }
        allEvents.push({
          worker_id: wid,
          worker_name: w.name ?? wid,
          event_id: row.id,
          ts: row.ts,
          type: row.type,
          payload,
        });
      }
    }

    // Sort events by ts ascending
    allEvents.sort((a, b) => a.ts - b.ts);

    const data: ExportData = {
      exported_at: new Date().toISOString(),
      workers,
      events: allEvents,
    };

    const template = getTemplate();
    // Escape < so the HTML parser never sees </script> inside the JSON block
    const jsonStr = JSON.stringify(data).replace(/</g, "\\u003c");
    // Use indexOf+slice instead of .replace() — replacement strings with $' or $& would
    // be misinterpreted by String.prototype.replace as special substitution patterns.
    const placeholder = '<script id="export-data" type="application/json">{}</script>';
    const idx = template.indexOf(placeholder);
    const html = idx === -1 ? template :
      template.slice(0, idx) +
      `<script id="export-data" type="application/json">${jsonStr}</script>` +
      template.slice(idx + placeholder.length);

    const workerName = rootWorker.name ?? workerId;
    const dateStr = formatDate(Date.now());
    const filename = `export-${workerName}-${dateStr}.html`;

    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    });
    res.end(html);
  });
}
