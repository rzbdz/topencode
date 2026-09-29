import { basename } from "node:path";
import type {
  AgentSession,
  LiveTab,
  ProjectView,
  SessionView,
} from "./types.ts";

/**
 * Project labels are directory basenames, disambiguated with the parent
 * directory only when two projects would otherwise collide — the dashboard
 * column is narrow.
 */
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

/** Merge the product's session list with the live tmux tabs into the TUI model. */
export function buildProjectViews(
  sessions: AgentSession[],
  tabs: LiveTab[],
): ProjectView[] {
  const liveBySession = new Map<
    string,
    { windowIndex: number; windowId: string }
  >();
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
