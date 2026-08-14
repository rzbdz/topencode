import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";
import { OPENCODE_BIN } from "./config.ts";
import type { OpencodeSession } from "./types.ts";

const DB_PATH =
  process.env.OPENCODE_DB_PATH ??
  join(homedir(), ".local", "share", "opencode", "opencode.db");

export interface SessionCost {
  sessionId: string;
  messages: number;
  parts: number;
  events: number;
  bytes: number;
}

export interface DeleteResult {
  sessionId: string;
  ok: boolean;
  error?: string;
}

export async function deleteSession(
  sessionId: string,
  directory: string,
): Promise<DeleteResult> {
  const proc = Bun.spawn([OPENCODE_BIN, "session", "delete", sessionId], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" },
  });
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

export function measureSessions(sessionIds: string[]): Map<string, SessionCost> {
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
        .all(...sessionIds) as SessionCost[];
      for (const r of rows) out.set(r.sessionId, r);
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

export interface CleanFilter {
  olderThanDays?: number;
  emptyOnly?: boolean;
  directory?: string;
}

export function selectForCleanup(
  sessions: OpencodeSession[],
  filter: CleanFilter,
  now = Date.now(),
): OpencodeSession[] {
  let pool = sessions;
  if (filter.directory) {
    pool = pool.filter((s) => s.directory === filter.directory);
  }
  if (filter.olderThanDays !== undefined) {
    const cutoff = now - filter.olderThanDays * 86400_000;
    pool = pool.filter((s) => s.updated < cutoff);
  }
  if (filter.emptyOnly) {
    const ids = pool.map((s) => s.id);
    const costs = measureSessions(ids);
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

export async function vacuum(): Promise<{ ok: boolean; error?: string }> {
  const proc = Bun.spawn([OPENCODE_BIN, "db", "VACUUM"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" },
  });
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

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)}K`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}M`;
  return `${(n / 1024 ** 3).toFixed(2)}G`;
}
