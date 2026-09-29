import type { Heartbeat } from "../../profile.ts";
import { indexSessions } from "./store.ts";

/**
 * Claude Code has no status API, so the heartbeat is the transcript itself: it
 * is appended to as the turn runs, which makes its mtime a truthful "the agent
 * is doing something right now" signal, and the newest user/assistant line says
 * whether a reply is outstanding.
 *
 * A long tool call can go quiet for tens of seconds between appends, so the
 * stalled window in the classifier (90s) is what keeps a working agent from
 * being reported as stopped.
 */
export async function fetchStatuses(
  sessionIds: string[],
): Promise<Map<string, Heartbeat>> {
  const out = new Map<string, Heartbeat>();
  if (sessionIds.length === 0) return out;
  const want = new Set(sessionIds);
  for (const e of await indexSessions()) {
    if (!want.has(e.id)) continue;
    out.set(e.id, {
      sessionId: e.id,
      title: e.title,
      directory: e.directory,
      sessionUpdated: e.updated,
      lastPartUpdated: e.updated,
      lastMsgCreated: e.lastTs,
      lastMsgCompleted: e.lastRole === "assistant" ? e.lastTs : null,
    });
  }
  return out;
}
