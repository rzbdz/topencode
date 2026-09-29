/**
 * The recycle bin: sessions the user has hidden from the listings.
 *
 * This is deliberately *our* state, not the agent's. Hiding writes one id to a
 * local JSON file and touches nothing the agent owns — no database row, no
 * transcript, no file move — so it is instant, works identically for both
 * products, and is trivially reversible. Deleting for real is the opposite:
 * that goes through the product's own delete (see `Profile.cleanup.delete`),
 * because opencode owns its database invariants and Claude Code owns its files.
 *
 * The file is per product, so topencode's bin and tclaude's bin never mix.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import type { BinEntry } from "./types.ts";
import { P } from "./profile.ts";

const FILE_VERSION = 1;

export function stateDir(): string {
  const base = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(base, P().name);
}

export function binPath(): string {
  return join(stateDir(), "hidden.json");
}

/**
 * The bin is a handful of ids and is read on every dashboard refresh, so it is
 * read fresh rather than cached: it is a few hundred bytes, and a cache would
 * only add a way for the bin to disagree with what is on disk.
 */
export function loadBin(): BinEntry[] {
  let raw: string;
  try {
    raw = readFileSync(binPath(), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { sessions?: unknown };
    if (!Array.isArray(parsed.sessions)) return [];
    return (parsed.sessions as BinEntry[]).filter(
      (e) => e && typeof e.id === "string" && e.id.length > 0,
    );
  } catch {
    // A corrupt bin must not take the dashboard down with it; the sessions it
    // listed are still safe in the agent's own store.
    return [];
  }
}

function saveBin(entries: BinEntry[]): void {
  const path = binPath();
  mkdirSync(dirname(path), { recursive: true });
  const body = JSON.stringify(
    { version: FILE_VERSION, sessions: entries },
    null,
    2,
  );
  // Write-and-rename: a crash mid-write leaves the previous bin intact rather
  // than a truncated file that would silently un-hide everything.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${body}\n`);
  renameSync(tmp, path);
}

export function hiddenIds(): Set<string> {
  return new Set(loadBin().map((e) => e.id));
}

export function addToBin(entry: BinEntry): BinEntry[] {
  const entries = loadBin().filter((e) => e.id !== entry.id);
  entries.push(entry);
  saveBin(entries);
  return entries;
}

/** Drop ids from the bin (restore, or purge after a real delete). */
export function removeFromBin(ids: string[]): BinEntry[] {
  const drop = new Set(ids);
  const entries = loadBin().filter((e) => !drop.has(e.id));
  saveBin(entries);
  return entries;
}

export function isHidden(id: string): boolean {
  return loadBin().some((e) => e.id === id);
}
