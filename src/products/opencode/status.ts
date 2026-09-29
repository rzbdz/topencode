import { Database } from "bun:sqlite";
import { DB_PATH } from "./store.ts";
import type { Heartbeat } from "../../profile.ts";

export function fetchStatuses(sessionIds: string[]): Map<string, Heartbeat> {
  const out = new Map<string, Heartbeat>();
  if (sessionIds.length === 0) return out;
  try {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const placeholders = sessionIds.map(() => "?").join(",");
      const rows = db
        .query(
          `SELECT
             s.id                                        AS sessionId,
             s.title                                     AS title,
             s.directory                                 AS directory,
             s.time_updated                              AS sessionUpdated,
             (SELECT json_extract(m.data,'$.time.completed')
                FROM message m
               WHERE m.session_id = s.id
                 AND json_extract(m.data,'$.role') = 'assistant'
               ORDER BY m.time_created DESC LIMIT 1)     AS lastMsgCompleted,
             (SELECT m.time_created
                FROM message m
               WHERE m.session_id = s.id
                 AND json_extract(m.data,'$.role') = 'assistant'
               ORDER BY m.time_created DESC LIMIT 1)     AS lastMsgCreated,
             (SELECT MAX(p.time_updated)
                FROM part p
               WHERE p.session_id = s.id)                AS lastPartUpdated
           FROM session s
           WHERE s.id IN (${placeholders})`,
        )
        .all(...sessionIds) as Heartbeat[];
      for (const r of rows) out.set(r.sessionId, r);
    } finally {
      db.close();
    }
  } catch {
    return out;
  }
  return out;
}
