import { join } from "node:path";
import { statSync } from "node:fs";
import type {
  AgentBin,
  AgentHealth,
  DeleteResult,
  Heartbeat,
  OrphanFile,
  Profile,
  SessionCost,
} from "../../profile.ts";
import type { AgentSession } from "../../types.ts";
import {
  agentErrorLaunch,
  chooseAgentBin,
  probeVersion,
  quoteArg,
  shellLaunch,
} from "../../config.ts";
import * as store from "./store.ts";
import * as cleanup from "./cleanup.ts";
import { fetchStatuses } from "./status.ts";

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

let healthy: { key: string; at: number; health: AgentHealth } | null = null;

/**
 * tclaude drives Claude Code, whose binary lives wherever the user installed it
 * (a release script, a version manager, a wrapper). Unlike opencode there is no
 * canonical ~/.<tool>/bin path to pin, so resolution is the override variable
 * followed by PATH.
 */
const profile: Profile = {
  name: "tclaude",
  agentName: "claude",
  tmuxSession: process.env.TCLAUDE_SESSION ?? "tclaude",
  opt: {
    session: "@tc_session",
    dir: "@tc_dir",
    role: "@tc_role",
    title: "@tc_title",
  },
  roles: { agent: "claude", shell: "shell", dashboard: "dashboard" },
  shellBin: process.env.TCLAUDE_SHELL ?? "zsh",
  shellPanePercent: Number(process.env.TCLAUDE_SHELL_PCT ?? 35),
  historyLimit: 50000,
  currentSessionEnv: "TCLAUDE_CURRENT_SESSION",

  resolveBin(): AgentBin {
    return chooseAgentBin({
      agentName: "claude",
      envName: "TCLAUDE_CLAUDE_BIN",
      fromEnv: process.env.TCLAUDE_CLAUDE_BIN,
      lookup: (name) => Bun.which(name),
      installHint:
        "Install Claude Code, or point TCLAUDE_CLAUDE_BIN at the claude binary.",
    });
  },

  async health(minIntervalMs = 60_000, timeoutMs = 10_000): Promise<AgentHealth> {
    let bin: AgentBin;
    try {
      bin = profile.resolveBin();
    } catch (err) {
      healthy = null;
      return { ok: false, problem: msg(err) };
    }
    let key = bin.path;
    try {
      const st = statSync(bin.path);
      key = `${bin.path}:${st.size}:${st.mtimeMs}`;
    } catch {}
    if (
      healthy &&
      healthy.key === key &&
      Date.now() - healthy.at < minIntervalMs
    ) {
      return healthy.health;
    }
    // Claude Code is a large Node program: --version costs a few hundred ms,
    // which is why a healthy result is cached rather than re-probed per refresh.
    const probe = await probeVersion({ bin: bin.path, timeoutMs });
    if (!probe.ok) {
      healthy = null;
      return {
        ok: false,
        path: bin.path,
        source: bin.source,
        problem: probe.problem,
      };
    }
    const health: AgentHealth = {
      ok: true,
      path: bin.path,
      source: bin.source,
      version: probe.version,
    };
    healthy = { key, at: Date.now(), health };
    return health;
  },

  /**
   * `--resume <uuid>` for an existing conversation; a bare `claude` starts a
   * new one in the pane's cwd. The directory itself is not an argument — Claude
   * Code keys its store on the process's cwd, which tmux sets via `-c`.
   *
   * The fallback shell matters more here than for opencode: quitting Claude
   * Code with Ctrl-C is routine, and without it the tab would be a dead pane.
   */
  launch(_directory: string, sessionId?: string): string {
    let bin: string;
    try {
      bin = profile.resolveBin().path;
    } catch (err) {
      return agentErrorLaunch({
        agentName: profile.agentName,
        message: msg(err),
        shell: profile.shellBin,
      });
    }
    const args = sessionId ? ` --resume ${quoteArg(sessionId)}` : "";
    const run = `${quoteArg(bin)}${args}`;
    return shellLaunch({
      shell: profile.shellBin,
      command: `${run}; exec ${quoteArg(profile.shellBin)} -il`,
      exec: false,
    });
  },

  sniffSessionId(argv: string[]): string | undefined {
    const isAgent = argv.some(
      (s) => /(^|\/)claude(\.js)?$/.test(s) || s.includes("claude-code"),
    );
    if (!isAgent) return undefined;
    for (const flag of ["--resume", "-r", "--session-id"]) {
      const i = argv.findIndex((s) => s === flag);
      const next = i >= 0 ? argv[i + 1] : undefined;
      if (next && store.UUID_RE.test(next)) return next;
    }
    return argv.find((s) => store.UUID_RE.test(s));
  },

  sessions: {
    list: (): Promise<AgentSession[]> => store.fetchSessions(),
    title: (id: string) => store.sessionTitle(id),
    newestUnclaimed: (directory: string, taken: Set<string>) =>
      store.newestUnclaimedSession(directory, taken),
  },

  cleanup: {
    delete: (sessionId: string, directory: string): Promise<DeleteResult> =>
      cleanup.deleteSession(sessionId, directory),
    stillExists: (id: string) => cleanup.sessionStillExists(id),
    measure: (ids: string[]): Promise<Map<string, SessionCost>> =>
      cleanup.measureSessions(ids),
    childrenOf: (id: string) => cleanup.countChildren(id),
    selectForCleanup: (sessions, filter, now) =>
      cleanup.selectForCleanup(sessions, filter, now),
    findOrphans: (): OrphanFile[] => cleanup.findOrphans(),
    removeOrphans: (files: OrphanFile[]) => cleanup.removeOrphans(files),
    storeSize: () => cleanup.storeSize(),
    reclaim: () => cleanup.reclaim(),
  },

  status: {
    heartbeats: (ids: string[]): Promise<Map<string, Heartbeat>> =>
      fetchStatuses(ids),
  },
};

export const claudeProfile: Profile = profile;
