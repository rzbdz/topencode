import type {
  OpencodeSession,
  SessionView,
  ProjectView,
  LiveTab,
} from "./types.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { basename } from "node:path";
import { Database } from "bun:sqlite";

const DB_PATH =
  process.env.OPENCODE_DB_PATH ??
  join(homedir(), ".local", "share", "opencode", "opencode.db");

export async function fetchSessions(): Promise<OpencodeSession[]> {
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

function dedupeLabels(dirs: string[]): Map<string, string> {
  const byBase = new Map<string, string[]>();
  for (const d of dirs) {
    const b = basename(d) || d;
    const arr = byBase.get(b) ?? [];
    arr.push(d);
    byBase.set(b, arr);
  }
  const labels = new Map<string, string>();
  for (const [base, group] of byBase) {
    if (group.length === 1) {
      labels.set(group[0]!, base);
    } else {
      for (const d of group) {
        const parts = d.split("/").filter(Boolean);
        const parent = parts.length >= 2 ? parts[parts.length - 2] : "";
        labels.set(d, parent ? `${parent}/${base}` : base);
      }
    }
  }
  return labels;
}

export function buildProjectViews(
  sessions: OpencodeSession[],
  tabs: LiveTab[],
): ProjectView[] {
  const liveBySession = new Map<string, { windowIndex: number; windowId: string }>();
  for (const t of tabs) {
    if (t.sessionId)
      liveBySession.set(t.sessionId, {
        windowIndex: t.windowIndex,
        windowId: t.windowId,
      });
  }

  const byDir = new Map<string, SessionView[]>();
  for (const s of sessions) {
    const hit = liveBySession.get(s.id);
    const view: SessionView = {
      ...s,
      live: hit !== undefined,
      windowIndex: hit?.windowIndex,
      windowId: hit?.windowId,
    };
    const arr = byDir.get(s.directory) ?? [];
    arr.push(view);
    byDir.set(s.directory, arr);
  }

  const labels = dedupeLabels([...byDir.keys()]);
  const projects: ProjectView[] = [];
  for (const [directory, sviews] of byDir) {
    sviews.sort((a, b) => b.updated - a.updated);
    projects.push({
      directory,
      label: labels.get(directory) ?? directory,
      sessions: sviews,
      liveCount: sviews.filter((s) => s.live).length,
    });
  }

  projects.sort((a, b) => {
    const am = Math.max(...a.sessions.map((s) => s.updated), 0);
    const bm = Math.max(...b.sessions.map((s) => s.updated), 0);
    return bm - am;
  });
  return projects;
}
