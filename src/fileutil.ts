import { statSync } from "node:fs";

export interface FileStat {
  size: number;
  mtimeMs: number;
  /** 0 when the filesystem does not record a creation time. */
  birthtimeMs: number;
}

export function statSafe(path: string): FileStat | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return {
      size: st.size,
      mtimeMs: st.mtimeMs,
      birthtimeMs: st.birthtimeMs || 0,
    };
  } catch {
    return null;
  }
}

/**
 * Read up to `bytes` from the end of a file. Agent transcripts grow to many
 * megabytes and only the tail matters for "what happened last", so nothing
 * ever loads a whole one.
 */
export async function readTail(path: string, bytes: number): Promise<string> {
  const file = Bun.file(path);
  const size = file.size;
  if (size === 0) return "";
  const start = Math.max(0, size - bytes);
  return await file.slice(start, size).text();
}

/** Like readTail, but drops the first line when the tail started mid-line. */
export async function readTailLines(
  path: string,
  bytes: number,
): Promise<string[]> {
  const tail = await readTail(path, bytes);
  const lines = tail.split("\n");
  if (lines.length > 1 && !tail.startsWith("\n")) lines.shift();
  return lines.filter((l) => l.trim().length > 0);
}

/**
 * Read up to `bytes` from the start of a file. Used when a transcript's tail
 * carries no metadata at all (a session created but never prompted writes only
 * a header line).
 */
export async function readHead(path: string, bytes: number): Promise<string> {
  const file = Bun.file(path);
  if (file.size === 0) return "";
  return await file.slice(0, Math.min(bytes, file.size)).text();
}
