import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LiveTab, SessionStatusView, StatusKind } from "./types.ts";

const DB_PATH =
  process.env.OPENCODE_DB_PATH ??
  join(homedir(), ".local", "share", "opencode", "opencode.db");

const WORKING_MS = 10_000;
const STALLED_MS = 90_000;

interface RawStatus {
  sessionId: string;
  title: string;
  directory: string;
  lastMsgCompleted: number | null;
  lastMsgCreated: number | null;
  lastPartUpdated: number | null;
  sessionUpdated: number;
}

function classify(r: RawStatus, now: number): {
  kind: StatusKind;
  heartbeatAgeMs: number | null;
} {
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

export function fetchStatuses(sessionIds: string[]): Map<string, RawStatus> {
  const out = new Map<string, RawStatus>();
  if (sessionIds.length === 0) return out;
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
      .all(...sessionIds) as RawStatus[];
    for (const r of rows) out.set(r.sessionId, r);
  } finally {
    db.close();
  }
  return out;
}

export function buildStatusViews(
  tabs: LiveTab[],
  now = Date.now(),
): SessionStatusView[] {
  const sessionTabs = tabs.filter(
    (t) => t.sessionId !== undefined || t.directory !== undefined,
  );
  const liveIds = sessionTabs
    .filter((t) => t.sessionId)
    .map((t) => t.sessionId as string);
  const raw = fetchStatuses(liveIds);
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

export function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
        ? 2
        : 1;
  }
  return w;
}

export function padW(s: string, width: number): string {
  const w = strWidth(s);
  if (w >= width) return truncW(s, width);
  return s + " ".repeat(width - w);
}

export function truncW(s: string, width: number): string {
  if (width <= 0) return "";
  if (strWidth(s) <= width) return s;
  let acc = "";
  let w = 0;
  for (const ch of s) {
    const cw = strWidth(ch);
    if (w + cw > width - 1) break;
    acc += ch;
    w += cw;
  }
  return acc + "…";
}

export function fmtAge(ms: number | null): string {
  if (ms === null) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
