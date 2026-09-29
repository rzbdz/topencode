import type { LiveTab, SessionStatusView, StatusKind } from "./types.ts";
import type { Heartbeat } from "./profile.ts";
import { P } from "./profile.ts";

const WORKING_MS = 10_000;
const STALLED_MS = 90_000;

/**
 * "Is this conversation still moving?" is answered by the product's own
 * heartbeat: the last time the agent produced something. A turn that has
 * started but not finished, with recent progress, is working; a turn that
 * started and went quiet is the interesting state — the agent stopped and is
 * waiting on a human.
 */
function classify(
  r: Heartbeat,
  now: number,
): { kind: StatusKind; heartbeatAgeMs: number | null } {
  const heartbeat = r.lastPartUpdated;
  const age = heartbeat === null ? null : now - heartbeat;

  if (r.lastMsgCreated === null) {
    return { kind: "done", heartbeatAgeMs: age };
  }
  if (r.lastMsgCompleted !== null) {
    return { kind: "done", heartbeatAgeMs: age };
  }
  if (age === null) return { kind: "stale", heartbeatAgeMs: null };
  if (age < WORKING_MS) return { kind: "working", heartbeatAgeMs: age };
  if (age < STALLED_MS) return { kind: "stalled", heartbeatAgeMs: age };
  return { kind: "stale", heartbeatAgeMs: age };
}

export async function buildStatusViews(
  tabs: LiveTab[],
  now = Date.now(),
): Promise<SessionStatusView[]> {
  const sessionTabs = tabs.filter(
    (t) => t.sessionId !== undefined || t.directory !== undefined,
  );
  const liveIds = sessionTabs
    .filter((t) => t.sessionId)
    .map((t) => t.sessionId as string);
  const raw = await P().status.heartbeats(liveIds);
  const views: SessionStatusView[] = [];
  for (const t of sessionTabs) {
    if (!t.sessionId) {
      views.push({
        sessionId: "",
        title: t.directory ? `(new session in ${t.directory})` : "(new session)",
        directory: t.directory ?? "",
        kind: "fresh",
        heartbeatAgeMs: null,
        lastActivity: 0,
        windowIndex: t.windowIndex,
        live: true,
      });
      continue;
    }
    const r = raw.get(t.sessionId);
    if (!r) {
      views.push({
        sessionId: t.sessionId,
        title: "(unknown session)",
        directory: t.directory ?? "",
        kind: "stale",
        heartbeatAgeMs: null,
        lastActivity: 0,
        windowIndex: t.windowIndex,
        live: true,
      });
      continue;
    }
    const { kind, heartbeatAgeMs } = classify(r, now);
    views.push({
      sessionId: r.sessionId,
      title: r.title,
      directory: r.directory,
      kind,
      heartbeatAgeMs,
      lastActivity: r.lastPartUpdated ?? r.sessionUpdated,
      windowIndex: t.windowIndex,
      live: true,
    });
  }
  views.sort((a, b) => {
    const rank: Record<StatusKind, number> = {
      working: 0,
      stalled: 1,
      fresh: 2,
      done: 3,
      stale: 4,
      dormant: 5,
    };
    const d = rank[a.kind] - rank[b.kind];
    return d !== 0 ? d : b.lastActivity - a.lastActivity;
  });
  return views;
}

export const LAMP: Record<StatusKind, string> = {
  working: "\x1b[38;5;226m●\x1b[0m",
  stalled: "\x1b[38;5;208m●\x1b[0m",
  done: "\x1b[38;5;42m●\x1b[0m",
  stale: "\x1b[38;5;244m○\x1b[0m",
  fresh: "\x1b[38;5;39m◌\x1b[0m",
  dormant: "\x1b[38;5;238m○\x1b[0m",
};

export const DESC: Record<StatusKind, string> = {
  working: "progressing...",
  stalled: "waiting / may need you",
  done: "done",
  stale: "stopped",
  fresh: "new · awaiting first prompt",
  dormant: "not open",
};
