import { statSync, accessSync, constants } from "node:fs";

export function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

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

export interface BinChoice {
  path: string;
  /** Where the path came from — "env" is the product's override variable. */
  source: "env" | "pinned" | "path";
}

/**
 * Resolve a *working* agent binary. A pinned path that is present but unusable
 * (truncated download, wrong arch, missing +x) falls through to PATH instead of
 * being launched, since tmux would otherwise report the pane dead with no clue
 * why.
 *
 * An explicit override variable is never silently ignored: if the user named a
 * binary, a broken one is an error worth showing, not a path to quietly route
 * around.
 */
export function chooseAgentBin(opts: {
  agentName: string;
  envName: string;
  fromEnv: string | undefined;
  /** Default install location to try before falling back to PATH. */
  pinned?: string;
  lookup: (name: string) => string | null;
  installHint: string;
}): BinChoice {
  const { agentName, envName, fromEnv, pinned, lookup, installHint } = opts;

  if (fromEnv) {
    const why = unusableReason(fromEnv);
    if (why) {
      throw new Error(`${envName}=${fromEnv} is unusable: ${explain(fromEnv, why)}`);
    }
    return { path: fromEnv, source: "env" };
  }

  const pinnedWhy = pinned ? unusableReason(pinned) : "missing";
  if (pinned && !pinnedWhy) return { path: pinned, source: "pinned" };

  const found = lookup(agentName);
  if (found && !unusableReason(found)) return { path: found, source: "path" };

  throw new Error(
    `no usable ${agentName} binary: ${pinned ? explain(pinned, pinnedWhy as Unusable) : `${agentName} is not on PATH`}` +
      (found ? `, and the ${agentName} on PATH (${found}) is unusable too` : "") +
      `. ${installHint}`,
  );
}

/**
 * Command tmux runs (and the `pane-died` hook respawns) for the dashboard pane.
 *
 * A compiled binary re-enters itself with the `dashboard` subcommand. Under
 * `bun run bin/<product>.ts`, though, execPath is the bun runtime, which has no
 * such subcommand — `bun dashboard` fails with "Script not found". Point bun at
 * the entry script explicitly in that case.
 */
export function dashboardCommand(): string {
  if (Bun.main.startsWith("/$bunfs/")) {
    return `${quoteArg(process.execPath)} dashboard`;
  }
  return `${quoteArg(process.execPath)} run ${quoteArg(Bun.main)} dashboard`;
}

/**
 * Run `command` under the user's interactive login shell. Must be interactive
 * and login: `-l` alone skips ~/.zshrc where proxy envs live.
 *
 * `exec: false` keeps that shell alive around `command`, so a chained fallback
 * shell still runs after the agent exits — that is what keeps a tab usable
 * rather than "Pane is dead" once you quit the agent.
 */
export function shellLaunch(opts: {
  shell: string;
  command: string;
  exec?: boolean;
}): string {
  const body = opts.exec === false ? opts.command : `exec ${opts.command}`;
  return `${quoteArg(opts.shell)} -il -c ${quoteArg(body)}`;
}

/**
 * Shown inside the pane instead of exec'ing a binary we know is broken, so the
 * failure is readable in the tab rather than just "Pane is dead".
 */
export function agentErrorLaunch(opts: {
  agentName: string;
  message: string;
  shell: string;
}): string {
  const body = [
    `printf '%s\\n\\n' ${quoteArg(`${opts.agentName} pane: cannot start ${opts.agentName} — ${opts.message}`)}`,
    `printf '%s\\n' 'Fix the binary, then reopen this session from the dashboard (no restart needed).'`,
    `exec ${quoteArg(opts.shell)} -il`,
  ].join("; ");
  return `${quoteArg(opts.shell)} -c ${quoteArg(body)}`;
}

export interface ProbeResult {
  ok: boolean;
  version?: string;
  problem?: string;
}

/**
 * Run the agent once to prove it can execute at all. A static check (exists,
 * non-empty, +x) says nothing about the file's contents — a truncated download
 * or a wrong-architecture binary passes all three and still dies on launch.
 */
export async function probeVersion(opts: {
  bin: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}): Promise<ProbeResult> {
  const args = opts.args ?? ["--version"];
  let proc;
  try {
    proc = Bun.spawn([opts.bin, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...opts.env },
    });
  } catch (err) {
    return {
      ok: false,
      problem: err instanceof Error ? err.message : String(err),
    };
  }
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 8000);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0) {
    const detail = (err || out).trim().split("\n")[0] ?? "";
    return {
      ok: false,
      problem:
        `${opts.bin} exited ${code} on ${args.join(" ")}` +
        (detail ? `: ${detail}` : ""),
    };
  }
  return { ok: true, version: out.trim().split("\n").pop()?.trim() };
}
