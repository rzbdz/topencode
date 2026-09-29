import type { AgentSession } from "../../types.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

export const DB_PATH =
  process.env.OPENCODE_DB_PATH ??
  join(homedir(), ".local", "share", "opencode", "opencode.db");

export async function fetchSessions(): Promise<AgentSession[]> {
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const rows = db
      .query(
        `SELECT id, project_id as projectId, directory, title, time_created as created, time_updated as updated
         FROM session
         WHERE parent_id IS NULL AND time_archived IS NULL
         ORDER BY time_updated DESC`,
      )
      .all() as Array<{
      id: string;
      projectId: string;
      directory: string;
      title: string;
      created: number;
      updated: number;
    }>;
    db.close();
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      updated: r.updated,
      created: r.created,
      projectId: r.projectId,
      directory: r.directory,
    }));
  } catch (err) {
    console.error("fetchSessions DB error:", err);
    return [];
  }
}

export async function sessionTitle(sessionId: string): Promise<string | null> {
  try {
    const db = new Database(DB_PATH, { readonly: true });
    try {
      const row = db
        .query(`SELECT title FROM session WHERE id = ? LIMIT 1`)
        .get(sessionId) as { title: string } | null;
      return row?.title ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function newestUnclaimedSession(
  directory: string,
  taken: Set<string>,
): Promise<{ id: string; title: string } | null> {
  const sessions = await fetchSessions();
  const candidates = sessions
    .filter((s) => s.directory === directory && !taken.has(s.id))
    .sort((a, b) => b.created - a.created);
  const hit = candidates[0];
  return hit ? { id: hit.id, title: hit.title } : null;
}
