import { Database } from "bun:sqlite";
import { join } from "node:path";
import { statSync, readdirSync, unlinkSync } from "node:fs";
import { DB_PATH } from "./store.ts";
import type { AgentSession } from "../../types.ts";
import type {
  CleanFilter,
  DeleteResult,
  OrphanFile,
  SessionCost,
} from "../../profile.ts";

export async function deleteSession(
  bin: string,
  sessionId: string,
  directory: string,
): Promise<DeleteResult> {
  let proc;
  try {
    proc = Bun.spawn([bin, "session", "delete", sessionId], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" },
    });
  } catch (err) {
    return {
      sessionId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    return {
      sessionId,
      ok: false,
      error: (err || out).trim().slice(0, 200) || `exit ${code}`,
    };
  }
  return { sessionId, ok: true };
}

export function sessionStillExists(sessionId: string): boolean {
  try {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const row = db
        .query(`SELECT 1 FROM session WHERE id = ? LIMIT 1`)
        .get(sessionId);
      return row !== null;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export function measureSessions(
  sessionIds: string[],
): Map<string, SessionCost> {
  const out = new Map<string, SessionCost>();
  if (sessionIds.length === 0) return out;
  try {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const ph = sessionIds.map(() => "?").join(",");
      const rows = db
        .query(
          `SELECT s.id AS sessionId,
                  (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id)      AS messages,
                  (SELECT COUNT(*) FROM part p WHERE p.session_id = s.id)         AS parts,
                  (SELECT COUNT(*) FROM event e WHERE e.aggregate_id = s.id)      AS events,
                  COALESCE((SELECT SUM(LENGTH(e.data)) FROM event e WHERE e.aggregate_id = s.id),0)
                + COALESCE((SELECT SUM(LENGTH(p.data)) FROM part p WHERE p.session_id = s.id),0)
                + COALESCE((SELECT SUM(LENGTH(m.data)) FROM message m WHERE m.session_id = s.id),0)
                                                                                  AS bytes
             FROM session s WHERE s.id IN (${ph})`,
        )
        .all(...sessionIds) as Array<SessionCost & { parts: number; events: number }>;
      for (const r of rows) {
        out.set(r.sessionId, {
          sessionId: r.sessionId,
          messages: r.messages,
          bytes: r.bytes,
          detail: `${r.parts} parts`,
        });
      }
    } finally {
      db.close();
    }
  } catch {
    return out;
  }
  return out;
}

export function countChildren(sessionId: string): number {
  try {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const row = db
        .query(`SELECT COUNT(*) AS n FROM session WHERE parent_id = ?`)
        .get(sessionId) as { n: number } | null;
      return row?.n ?? 0;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

export function selectForCleanup(
  sessions: AgentSession[],
  filter: CleanFilter,
  now = Date.now(),
): AgentSession[] {
  let pool = sessions;
  if (filter.directory) {
    pool = pool.filter((s) => s.directory === filter.directory);
  }
  if (filter.olderThanDays !== undefined) {
    const cutoff = now - filter.olderThanDays * 86400_000;
    pool = pool.filter((s) => s.updated < cutoff);
  }
  if (filter.emptyOnly) {
    const costs = measureSessions(pool.map((s) => s.id));
    pool = pool.filter((s) => (costs.get(s.id)?.messages ?? 0) === 0);
  }
  return pool;
}

export function dbSizeBytes(): number {
  try {
    return statSync(DB_PATH).size;
  } catch {
    return 0;
  }
}

export async function vacuum(
  bin: string,
): Promise<{ ok: boolean; error?: string }> {
  let proc;
  try {
    proc = Bun.spawn([bin, "db", "VACUUM"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" },
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0) {
    return { ok: false, error: (err || out).trim().slice(0, 300) };
  }
  return { ok: true };
}

const STORAGE_DIR = join(DB_PATH, "..", "storage");

const SESSION_KEYED_DIRS = [
  "session_diff",
  "directory-readme",
  "agent-usage-reminder",
];

export function findOrphanFiles(): OrphanFile[] {
  const out: OrphanFile[] = [];
  let live: Set<string>;
  try {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const rows = db.query(`SELECT id FROM session`).all() as Array<{
        id: string;
      }>;
      live = new Set(rows.map((r) => r.id));
    } finally {
      db.close();
    }
  } catch {
    return out;
  }
  for (const sub of SESSION_KEYED_DIRS) {
    const dir = join(STORAGE_DIR, sub);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith("ses_") || !name.endsWith(".json")) continue;
      const sessionId = name.slice(0, -5);
      if (live.has(sessionId)) continue;
      const path = join(dir, name);
      let bytes = 0;
      try {
        bytes = statSync(path).size;
      } catch {}
      out.push({ path, sessionId, bytes });
    }
  }
  return out;
}

export function removeOrphanFiles(files: OrphanFile[]): number {
  let n = 0;
  for (const f of files) {
    try {
      unlinkSync(f.path);
      n++;
    } catch {}
  }
  return n;
}
