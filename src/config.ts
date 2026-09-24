import { homedir } from "node:os";
import { join } from "node:path";
import { statSync, accessSync, constants } from "node:fs";

export const TMUX_SESSION = process.env.TOPENCODE_SESSION ?? "topencode";

export const PINNED_OPENCODE_BIN =
  process.env.TOPENCODE_OPENCODE_BIN ??
  join(homedir(), ".opencode", "bin", "opencode");

export const SHELL_BIN = process.env.TOPENCODE_SHELL ?? "zsh";

export const SHELL_PANE_PERCENT = Number(process.env.TOPENCODE_SHELL_PCT ?? 35);

export const HISTORY_LIMIT = 50000;

export const OPT = {
  session: "@oc_session",
  dir: "@oc_dir",
  role: "@oc_role",
  title: "@oc_title",
} as const;

export const ROLE = {
  opencode: "opencode",
  shell: "shell",
  dashboard: "dashboard",
} as const;

export const DASHBOARD_MARKER = "__topencode_dashboard__";

type Unusable = "empty" | "missing" | "not-exec";

function unusableReason(path: string): Unusable | null {
  try {
    const st = statSync(path);
    if (!st.isFile()) return "missing";
    if (st.size === 0) return "empty";
  } catch {
    return "missing";
  }
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return "not-exec";
  }
  return null;
}

function explain(path: string, why: Unusable): string {
  if (why === "empty") return `${path} is empty (0 bytes)`;
  if (why === "not-exec") return `${path} exists but is not executable`;
  return `${path} does not exist`;
}

export interface OpencodeBin {
  path: string;
  /** Where the path came from — "env" is TOPENCODE_OPENCODE_BIN, "pinned" the default location, "path" a PATH lookup. */
  source: "env" | "pinned" | "path";
}

/**
 * Resolve a *working* opencode binary. A pinned path that is present but
 * unusable (truncated download, wrong arch, missing +x) falls through to PATH
 * instead of being launched, since tmux would otherwise report the pane dead
 * with no clue why.
 *
 * An explicit TOPENCODE_OPENCODE_BIN is never silently ignored: if the user
 * named a binary, a broken one is an error worth showing, not a path to
 * quietly route around.
 */
export function chooseOpencodeBin(
  fromEnv: string | undefined,
  pinned: string,
  lookup: (name: string) => string | null,
): OpencodeBin {
  if (fromEnv) {
    const why = unusableReason(fromEnv);
    if (why) {
      throw new Error(
        `TOPENCODE_OPENCODE_BIN=${fromEnv} is unusable: ${explain(fromEnv, why)}`,
      );
    }
    return { path: fromEnv, source: "env" };
  }

  const pinnedWhy = unusableReason(pinned);
  if (!pinnedWhy) return { path: pinned, source: "pinned" };

  const found = lookup("opencode");
  if (found && !unusableReason(found)) return { path: found, source: "path" };

  throw new Error(
    `no usable opencode binary: ${explain(pinned, pinnedWhy)}` +
      (found ? `, and the opencode on PATH (${found}) is unusable too` : "") +
      `. Install opencode, or point TOPENCODE_OPENCODE_BIN at a working binary.`,
  );
}

export function resolveOpencodeBin(): OpencodeBin {
  return chooseOpencodeBin(
    process.env.TOPENCODE_OPENCODE_BIN,
    PINNED_OPENCODE_BIN,
    (name) => Bun.which(name),
  );
}

/** Re-probed on every tab open, so repairing opencode needs no restart. */
export function opencodeBin(): string {
  return resolveOpencodeBin().path;
}

export interface OpencodeHealth {
  ok: boolean;
  path?: string;
  source?: OpencodeBin["source"];
  /** Raw `opencode --version` output when it ran. */
  version?: string;
  /** Human-readable reason it is not usable. */
  problem?: string;
}

/**
 * Full health check: resolves the path and actually runs `opencode --version`,
 * so a binary that exists but cannot execute is caught before the dashboard
 * offers to open tabs with it.
 *
 * The probe spawns a large binary, so a result that is already good is reused
 * for `minIntervalMs` — the dashboard calls this on every refresh, and
 * re-spawning opencode twice a minute would be a waste. A failing check is
 * always re-run, so repairing the binary clears the warning promptly.
 */
let healthy: { key: string; at: number; health: OpencodeHealth } | null = null;

export async function checkOpencode(
  minIntervalMs = 60_000,
  timeoutMs = 8000,
): Promise<OpencodeHealth> {
  let bin: OpencodeBin;
  try {
    bin = resolveOpencodeBin();
  } catch (err) {
    healthy = null;
    return {
      ok: false,
      problem: err instanceof Error ? err.message : String(err),
    };
  }

  // Static checks pass, but they say nothing about the file's *contents* — a
  // truncated or wrong-arch binary is executable and non-empty. Key the cache
  // on size+mtime too, so an in-place replacement re-probes.
  const st = statSync(bin.path);
  const key = `${bin.path}:${st.size}:${st.mtimeMs}`;
  if (healthy && healthy.key === key && Date.now() - healthy.at < minIntervalMs) {
    return healthy.health;
  }

  const proc = Bun.spawn([bin.path, "--version"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);

  if (code !== 0) {
    const detail = (err || out).trim().split("\n")[0] ?? "";
    healthy = null;
    return {
      ok: false,
      path: bin.path,
      source: bin.source,
      problem:
        `${bin.path} exited ${code} on --version` + (detail ? `: ${detail}` : ""),
    };
  }
  const health: OpencodeHealth = {
    ok: true,
    path: bin.path,
    source: bin.source,
    version: out.trim().split("\n").pop()?.trim(),
  };
  healthy = { key, at: Date.now(), health };
  return health;
}

/**
 * Command tmux runs (and the `pane-died` hook respawns) for the dashboard pane.
 *
 * A compiled binary re-enters itself with the `dashboard` subcommand. Under
 * `bun run bin/topencode.ts`, though, execPath is the bun runtime, which has no
 * such subcommand — `bun dashboard` fails with "Script not found". Point bun at
 * the entry script explicitly in that case.
 */
export function dashboardCommand(): string {
  if (Bun.main.startsWith("/$bunfs/")) {
    return `${quoteArg(process.execPath)} dashboard`;
  }
  return `${quoteArg(process.execPath)} run ${quoteArg(Bun.main)} dashboard`;
}

export function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
