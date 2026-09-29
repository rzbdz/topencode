/**
 * Claude Code's session store, read the way Claude Code writes it.
 *
 * There is no database and no `session list` command: a conversation is one
 * JSONL transcript at `~/.claude/projects/<slug-of-cwd>/<session-uuid>.jsonl`,
 * appended to as the turn runs, with a sibling `<uuid>/` directory holding the
 * bulky tool output. Everything here is derived from those files.
 *
 * Transcripts reach tens of megabytes, so nothing ever reads a file whole:
 * metadata comes from a tail read, memoised on size+mtime so the dashboard's
 * 5s refresh only re-reads the transcript that is actually being written.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import type { AgentSession } from "../../types.ts";
import { readHead, readTail, statSafe, type FileStat } from "../../fileutil.ts";

/** Claude Code's config directory; `CLAUDE_CONFIG_DIR` relocates the whole tree. */
export const CONFIG_DIR =
  process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

export const PROJECTS_DIR =
  process.env.TCLAUDE_PROJECTS_DIR ?? join(CONFIG_DIR, "projects");

const CLAUDE_JSON = join(CONFIG_DIR, "..", ".claude.json");
const TAIL_BYTES = 64 * 1024;
const HEAD_BYTES = 16 * 1024;

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Claude Code names a project directory after its cwd with every
 * non-alphanumeric byte replaced by a dash: `/home/u/my-proj` becomes
 * `-home-u-my-proj`. The transform is lossy (a real dash is indistinguishable
 * from a separator), so it is only ever used to *look up* the true path.
 */
export function slugOf(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * slug -> real directory, from ~/.claude.json's project map. That file is the
 * only place the un-slugged paths are recorded, and it is rewritten by every
 * running Claude Code, so it is cached briefly rather than read per session.
 */
let projectMap: { at: number; map: Map<string, string> } | null = null;

export function projectPaths(): Map<string, string> {
  if (projectMap && Date.now() - projectMap.at < 30_000) return projectMap.map;
  const map = new Map<string, string>();
  try {
    const json = JSON.parse(readFileSync(CLAUDE_JSON, "utf8")) as {
      projects?: Record<string, unknown>;
    };
    for (const p of Object.keys(json.projects ?? {})) map.set(slugOf(p), p);
  } catch {}
  projectMap = { at: Date.now(), map };
  return map;
}

export interface SessionMeta {
  title: string;
  cwd: string | null;
  /** Timestamp of the newest user/assistant line. */
  lastTs: number | null;
  /** Role of that line: an assistant line means the turn finished. */
  lastRole: "user" | "assistant" | null;
  firstTs: number | null;
}

/**
 * Intermediate scan state. A title has two candidate sources that sit at
 * different places in a transcript — the generated `ai-title` line and the raw
 * text of the last prompt — so both are collected and ranked once the scan
 * finishes, instead of whichever happens to come last in the file winning.
 */
interface Scan {
  aiTitle: string | null;
  lastPrompt: string | null;
  cwd: string | null;
  lastTs: number | null;
  lastRole: "user" | "assistant" | null;
  firstTs: number | null;
}

const EMPTY_SCAN: Scan = {
  aiTitle: null,
  lastPrompt: null,
  cwd: null,
  lastTs: null,
  lastRole: null,
  firstTs: null,
};

function tsOf(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Walk transcript lines, picking up whatever they carry. */
function scanLines(lines: string[], s: Scan, fromEnd: boolean): void {
  const seq = fromEnd ? [...lines].reverse() : lines;
  for (const line of seq) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof row.cwd === "string") s.cwd ??= row.cwd;
    const t = tsOf(row.timestamp);
    if (t !== null) {
      if (fromEnd) s.lastTs ??= t;
      else s.firstTs ??= t;
    }
    const type = row.type;
    if (type === "ai-title" && typeof row.aiTitle === "string") {
      const v = row.aiTitle.trim();
      if (v) s.aiTitle ??= v;
    }
    if (type === "last-prompt" && typeof row.lastPrompt === "string") {
      const v = row.lastPrompt.trim().replace(/\s+/g, " ").slice(0, 120);
      if (v) s.lastPrompt ??= v;
    }
    if (
      fromEnd &&
      s.lastRole === null &&
      (type === "user" || type === "assistant") &&
      t !== null
    ) {
      s.lastRole = type;
      s.lastTs = t;
    }
  }
}

const metaCache = new Map<string, { key: string; meta: SessionMeta }>();

/** Transcript metadata, memoised on size+mtime so a quiet file is read once. */
export async function readMeta(
  path: string,
  st: FileStat,
): Promise<SessionMeta> {
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = metaCache.get(path);
  if (hit && hit.key === key) return hit.meta;

  const s: Scan = { ...EMPTY_SCAN };
  const tail = await readTail(path, TAIL_BYTES);
  const lines = tail.split("\n");
  const whole = st.size <= TAIL_BYTES;
  scanLines(whole ? lines : lines.slice(1), s, true);

  // A session created but never prompted holds only a header line, so the tail
  // can be entirely empty of cwd, title and timestamps. The head can also hold
  // the only ai-title when a long transcript has scrolled past the tail window.
  if (s.cwd === null || s.firstTs === null || !(s.aiTitle ?? s.lastPrompt)) {
    const head = await readHead(path, HEAD_BYTES);
    scanLines(head.split("\n"), s, false);
  }

  const meta: SessionMeta = {
    title: s.aiTitle ?? s.lastPrompt ?? "",
    cwd: s.cwd,
    lastTs: s.lastTs ?? s.firstTs,
    lastRole: s.lastRole,
    firstTs: s.firstTs ?? (st.birthtimeMs || st.mtimeMs),
  };

  metaCache.set(path, { key, meta });
  return meta;
}

export interface SessionEntry {
  id: string;
  path: string;
  /** The project directory name, i.e. the cwd slug. */
  dirSlug: string;
  directory: string;
  title: string;
  created: number;
  updated: number;
  size: number;
  lastTs: number | null;
  lastRole: "user" | "assistant" | null;
}

/**
 * Every top-level conversation on disk. Subagent work is written *inside* the
 * parent transcript (isSidechain lines) plus the sibling directory, so only
 * top-level `<uuid>.jsonl` files are sessions.
 */
export async function indexSessions(): Promise<SessionEntry[]> {
  const out: SessionEntry[] = [];
  const map = projectPaths();
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const full = join(PROJECTS_DIR, dir);
    let entries: string[];
    try {
      entries = readdirSync(full);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const id = entry.slice(0, -".jsonl".length);
      if (!UUID_RE.test(id)) continue;
      const path = join(full, entry);
      const st = statSafe(path);
      if (!st) continue;
      const meta = await readMeta(path, st);
      out.push({
        id,
        path,
        dirSlug: dir,
        directory: meta.cwd ?? map.get(dir) ?? "",
        title: meta.title,
        created: st.birthtimeMs || meta.firstTs || st.mtimeMs,
        updated: st.mtimeMs,
        size: st.size,
        lastTs: meta.lastTs,
        lastRole: meta.lastRole,
      });
    }
  }
  return out;
}

export async function fetchSessions(): Promise<AgentSession[]> {
  const index = await indexSessions();
  return index.map((e) => ({
    id: e.id,
    title: e.title,
    updated: e.updated,
    created: e.created,
    projectId: e.dirSlug,
    directory: e.directory,
  }));
}

/** Locate a session's transcript without reading any of it. */
export function findSessionFile(id: string): string | null {
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = join(PROJECTS_DIR, dir, `${id}.jsonl`);
    try {
      if (statSafe(candidate)) return candidate;
    } catch {}
  }
  return null;
}

export async function findSession(id: string): Promise<SessionEntry | null> {
  const index = await indexSessions();
  return index.find((e) => e.id === id) ?? null;
}

/** The `<uuid>/` directory Claude Code keeps next to a transcript. */
export function siblingDirOf(jsonlPath: string): string {
  return jsonlPath.slice(0, -".jsonl".length);
}

export async function sessionTitle(sessionId: string): Promise<string | null> {
  const hit = await findSession(sessionId);
  return hit && hit.title ? hit.title : null;
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
