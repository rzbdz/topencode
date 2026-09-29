import { homedir } from "node:os";
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

const PINNED_BIN =
  process.env.TOPENCODE_OPENCODE_BIN ??
  join(homedir(), ".opencode", "bin", "opencode");

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A probe spawns a large binary, so a result that is already good is reused for
 * the cache window — the dashboard calls this on every refresh, and re-spawning
 * opencode twice a minute would be a waste. A failing check is always re-run, so
 * repairing the binary clears the warning promptly.
 */
let healthy: { key: string; at: number; health: AgentHealth } | null = null;

const profile: Profile = {
  name: "topencode",
  agentName: "opencode",
  tmuxSession: process.env.TOPENCODE_SESSION ?? "topencode",
  opt: {
    session: "@oc_session",
    dir: "@oc_dir",
    role: "@oc_role",
    title: "@oc_title",
  },
  roles: { agent: "opencode", shell: "shell", dashboard: "dashboard" },
  shellBin: process.env.TOPENCODE_SHELL ?? "zsh",
  shellPanePercent: Number(process.env.TOPENCODE_SHELL_PCT ?? 35),
  historyLimit: 50000,
  currentSessionEnv: "TOPENCODE_CURRENT_SESSION",

  resolveBin(): AgentBin {
    return chooseAgentBin({
      agentName: "opencode",
      envName: "TOPENCODE_OPENCODE_BIN",
      fromEnv: process.env.TOPENCODE_OPENCODE_BIN,
      pinned: PINNED_BIN,
      lookup: (name) => Bun.which(name),
      installHint:
        "Install opencode, or point TOPENCODE_OPENCODE_BIN at a working binary.",
    });
  },

  async health(minIntervalMs = 60_000, timeoutMs = 8000): Promise<AgentHealth> {
    let bin: AgentBin;
    try {
      bin = profile.resolveBin();
    } catch (err) {
      healthy = null;
      return { ok: false, problem: msg(err) };
    }

    // Static checks pass, but they say nothing about the file's *contents* — a
    // truncated or wrong-arch binary is executable and non-empty. Key the cache
    // on size+mtime too, so an in-place replacement re-probes.
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

    const probe = await probeVersion({
      bin: bin.path,
      env: { OPENCODE_DISABLE_AUTOUPDATE: "1" },
      timeoutMs,
    });
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

  // Resolution is re-probed per open, so repairing opencode needs no restart.
  //
  // Quitting opencode (Ctrl-C) hands the pane to an interactive login shell
  // instead of ending the pane's process, so the tab stays usable for other
  // commands rather than going "Pane is dead". `;` rather than `&&`: opencode
  // killed by a signal exits non-zero, and that is exactly the case we want a
  // shell for.
  launch(directory: string, sessionId?: string): string {
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
    const sessionArg = sessionId ? ` -s ${quoteArg(sessionId)}` : "";
    const run = `${quoteArg(bin)} ${quoteArg(directory)}${sessionArg}`;
    return shellLaunch({
      shell: profile.shellBin,
      command: `${run}; exec ${quoteArg(profile.shellBin)} -il`,
      exec: false,
    });
  },

  sniffSessionId(argv: string[]): string | undefined {
    if (!argv.some((s) => s.includes("opencode"))) return undefined;
    const i = argv.findIndex((s) => s === "-s" || s === "--session");
    if (i >= 0 && argv[i + 1]?.startsWith("ses_")) return argv[i + 1];
    return argv.find((s) => s.startsWith("ses_"));
  },

  sessions: {
    list: (): Promise<AgentSession[]> => store.fetchSessions(),
    title: (id: string) => store.sessionTitle(id),
    newestUnclaimed: (directory: string, taken: Set<string>) =>
      store.newestUnclaimedSession(directory, taken),
  },

  cleanup: {
    delete: (sessionId: string, directory: string): Promise<DeleteResult> =>
      cleanup.deleteSession(profile.resolveBin().path, sessionId, directory),
    stillExists: (id: string) => cleanup.sessionStillExists(id),
    measure: (ids: string[]): Promise<Map<string, SessionCost>> =>
      Promise.resolve(cleanup.measureSessions(ids)),
    childrenOf: (id: string) => cleanup.countChildren(id),
    selectForCleanup: (sessions, filter, now) =>
      Promise.resolve(cleanup.selectForCleanup(sessions, filter, now)),
    findOrphans: (): OrphanFile[] => cleanup.findOrphanFiles(),
    removeOrphans: (files: OrphanFile[]) => cleanup.removeOrphanFiles(files),
    storeSize: () => Promise.resolve(cleanup.dbSizeBytes()),
    reclaim: () => cleanup.vacuum(profile.resolveBin().path),
  },

  status: {
    heartbeats: (ids: string[]): Promise<Map<string, Heartbeat>> =>
      Promise.resolve(fetchStatuses(ids)),
  },
};

export const opencodeProfile: Profile = profile;
