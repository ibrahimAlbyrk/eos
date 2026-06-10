// In-memory MessageQueueRepo double shared by the dispatch/drain test suites.

import type { MessageQueueRepo } from "../../ports/MessageQueueRepo.ts";

export interface QueueRow {
  id: number; workerId: string; clientMsgId: string | null;
  text: string; createdAt: number; dispatchedAt: number | null;
}

export function fakeQueue(): { rows: QueueRow[]; repo: MessageQueueRepo } {
  const rows: QueueRow[] = [];
  let nextId = 1;
  return {
    rows,
    repo: {
      insert(row) {
        if (row.clientMsgId !== null && rows.some((r) => r.workerId === row.workerId && r.clientMsgId === row.clientMsgId)) return null;
        const id = nextId++;
        rows.push({ id, ...row });
        return id;
      },
      listPending: (wid) => rows
        .filter((r) => r.workerId === wid && r.dispatchedAt === null)
        .map(({ id, workerId, clientMsgId, text, createdAt }) => ({ id, workerId, clientMsgId, text, createdAt })),
      markDispatched(ids, ts) { for (const r of rows) if (ids.includes(r.id)) r.dispatchedAt = ts; },
      removeById(id) { const i = rows.findIndex((r) => r.id === id); if (i >= 0) rows.splice(i, 1); },
      removePending(wid, id) {
        const i = rows.findIndex((r) => r.workerId === wid && r.id === id && r.dispatchedAt === null);
        if (i < 0) return false;
        rows.splice(i, 1);
        return true;
      },
      clearPending(wid) {
        let n = 0;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].workerId === wid && rows[i].dispatchedAt === null) { rows.splice(i, 1); n++; }
        }
        return n;
      },
      hasRecentDispatch: (wid, text, since) => rows.some(
        (r) => r.workerId === wid && r.text === text && r.dispatchedAt !== null && r.dispatchedAt > since,
      ),
      deleteByWorker(wid) {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i].workerId === wid) rows.splice(i, 1);
      },
      prune(before) {
        for (let i = rows.length - 1; i >= 0; i--) {
          const d = rows[i].dispatchedAt;
          if (d !== null && d < before) rows.splice(i, 1);
        }
      },
    },
  };
}
