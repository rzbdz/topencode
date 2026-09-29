/**
 * Deleting a Claude Code session means deleting files: there is no delete
 * command to shell out to. A conversation owns the transcript, the sibling
 * `<uuid>/` directory holding its tool output, and two session-keyed
 * directories under the config dir — all four are removed together, and
 * anything left without a transcript is swept as an orphan.
 */
import { join, basename } from "node:path";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import type { AgentSession } from "../../types.ts";
import type {
  CleanFilter,
  DeleteResult,
  OrphanFile,
  SessionCost,
} from "../../profile.ts";
import {
  CONFIG_DIR,
  PROJECTS_DIR,
  UUID_RE,
  findSessionFile,
  indexSessions,
  siblingDirOf,
} from "./store.ts";

const SESSION_KEYED_DIRS = ["file-history", "session-env"];

/**
 * Reading a whole transcript to count messages is fine for the handful of
 * sessions a cleanup names, but not for a store full of huge ones. Above this
 * size the count is reported as unknown rather than guessed: claiming "0
 * messages" would make `--empty` delete a conversation with real work in it.
 */
const COUNT_LIMIT_BYTES = 64 * 1024 * 1024;

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dirBytes(path: string): number {
  let total = 0;
  let st;
  try {
    st = statSync(path);
  } catch {
    return 0;
  }
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let entries: string[];
  try {
    entries = readdirSync(path);
  } catch {
    return 0;
  }
  for (const e of entries) total += dirBytes(join(path, e));
  return total;
}

function countMessages(path: string): number {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return -1;
  }
  let n = 0;
  for (const line of raw.split("\n")) {
    if (line.includes('"type":"user"') || line.includes('"type":"assistant"')) {
      n++;
    }
  }
  return n;
}

/** Subagent transcripts Claude Code parks next to the parent transcript. */
export function countChildren(sessionId: string): number {
  const path = findSessionFile(sessionId);
  if (!path) return 0;
  const sub = join(siblingDirOf(path), "subagents");
  try {
    return readdirSync(sub).filter((f) => f.endsWith(".jsonl")).length;
  } catch {
    return 0;
  }
}

export function sessionArtifacts(sessionId: string, jsonlPath: string): string[] {
  return [
    jsonlPath,
    siblingDirOf(jsonlPath),
    join(CONFIG_DIR, "file-history", sessionId),
    join(CONFIG_DIR, "session-env", sessionId),
  ];
}

export async function deleteSession(
  sessionId: string,
  _directory: string,
): Promise<DeleteResult> {
  const path = findSessionFile(sessionId);
  if (!path) {
    return {
      sessionId,
      ok: false,
      error: "no transcript on disk for this session id",
    };
  }
  const failures: string[] = [];
  for (const p of sessionArtifacts(sessionId, path)) {
    try {
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    } catch (err) {
      failures.push(`${basename(p)}: ${msg(err)}`);
    }
  }
  if (failures.length > 0) {
    return { sessionId, ok: false, error: failures.join("; ") };
  }
  return { sessionId, ok: true };
}

export function sessionStillExists(sessionId: string): boolean {
  return findSessionFile(sessionId) !== null;
}

export async function measureSessions(
  sessionIds: string[],
): Promise<Map<string, SessionCost>> {
  const out = new Map<string, SessionCost>();
  if (sessionIds.length === 0) return out;
  const index = new Map((await indexSessions()).map((e) => [e.id, e]));
  for (const id of sessionIds) {
    const entry = index.get(id);
    const path = entry?.path ?? findSessionFile(id);
    if (!path) continue;
    let bytes = entry?.size ?? 0;
    for (const p of sessionArtifacts(id, path)) {
      if (p !== path) bytes += dirBytes(p);
    }
    const known = (entry?.size ?? Number.POSITIVE_INFINITY) <= COUNT_LIMIT_BYTES;
    const messages = known ? countMessages(path) : -1;
    const subagents = countChildren(id);
    out.set(id, {
      sessionId: id,
      messages,
      bytes,
      detail: subagents > 0 ? `${subagents} subagent(s)` : undefined,
    });
  }
  return out;
}

export async function selectForCleanup(
  sessions: AgentSession[],
  filter: CleanFilter,
  now = Date.now(),
): Promise<AgentSession[]> {
  let pool = sessions;
  if (filter.directory) {
    pool = pool.filter((s) => s.directory === filter.directory);
  }
  if (filter.olderThanDays !== undefined) {
    const cutoff = now - filter.olderThanDays * 86400_000;
    pool = pool.filter((s) => s.updated < cutoff);
  }
  if (filter.emptyOnly) {
    const costs = await measureSessions(pool.map((s) => s.id));
    // An unknown count is never treated as empty.
    pool = pool.filter((s) => costs.get(s.id)?.messages === 0);
  }
  return pool;
}

/** Every session id with a transcript on disk, read without opening any file. */
function liveIds(): Set<string> {
  const ids = new Set<string>();
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {
    return ids;
  }
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(join(PROJECTS_DIR, dir));
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.endsWith(".jsonl")) ids.add(e.slice(0, -".jsonl".length));
    }
  }
  return ids;
}

export function findOrphans(): OrphanFile[] {
  const out: OrphanFile[] = [];
  const live = liveIds();

  // A `<uuid>/` directory whose transcript is gone — the residue of a session
  // deleted by hand, or by an interrupted delete.
  let dirs: string[] = [];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {}
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(join(PROJECTS_DIR, dir));
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!UUID_RE.test(e) || live.has(e)) continue;
      const p = join(PROJECTS_DIR, dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      out.push({ path: p, sessionId: e, bytes: dirBytes(p) });
    }
  }

  for (const sub of SESSION_KEYED_DIRS) {
    const base = join(CONFIG_DIR, sub);
    let names: string[];
    try {
      names = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!UUID_RE.test(name) || live.has(name)) continue;
      const p = join(base, name);
      out.push({ path: p, sessionId: name, bytes: dirBytes(p) });
    }
  }
  return out;
}

export function removeOrphans(files: OrphanFile[]): number {
  let n = 0;
  for (const f of files) {
    try {
      rmSync(f.path, { recursive: true, force: true });
      n++;
    } catch {}
  }
  return n;
}

export async function storeSize(): Promise<number> {
  const index = await indexSessions();
  let total = 0;
  for (const e of index) {
    total += e.size;
    total += dirBytes(siblingDirOf(e.path));
  }
  return total;
}

export async function reclaim(): Promise<{
  ok: boolean;
  error?: string;
  note?: string;
}> {
  return {
    ok: true,
    note: "Claude Code transcripts are plain JSONL files — there is no database to compact. Deleting sessions is what frees the space.",
  };
}
