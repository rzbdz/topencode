/**
 * The seam between the shared tmux/TUI engine and the agent CLI it drives.
 *
 * Everything above this file (tmux driver, dashboard, status rendering, CLI
 * plumbing) is product-agnostic; everything product-shaped — where sessions
 * live, how the agent is launched, what the tmux session is called — is
 * supplied by a `Profile`. `topencode` (opencode) and `tclaude` (Claude Code)
 * are two implementations of it, each compiled into its own binary so either
 * can be updated without touching the other.
 *
 * The profile is a process-wide singleton rather than a threaded argument:
 * the entry point picks one before anything else runs, and the engine reads it
 * through `P()`. That keeps the engine's call sites readable and makes a
 * missing selection a loud error instead of defaulting to the wrong product.
 */
import type { AgentSession } from "./types.ts";

export interface AgentBin {
  path: string;
  /** Where the path came from — helps the health line explain a bad binary. */
  source: "env" | "pinned" | "path";
}

export interface AgentHealth {
  ok: boolean;
  path?: string;
  source?: AgentBin["source"];
  version?: string;
  problem?: string;
}

export interface SessionCost {
  sessionId: string;
  messages: number;
  bytes: number;
  /** Product-specific detail for the CLI, e.g. "12 parts". */
  detail?: string;
}

export interface DeleteResult {
  sessionId: string;
  ok: boolean;
  error?: string;
}

export interface OrphanFile {
  path: string;
  sessionId: string;
  bytes: number;
}

export interface CleanFilter {
  olderThanDays?: number;
  emptyOnly?: boolean;
  directory?: string;
}

/** What a live tab's conversation looks like to the status classifier. */
export interface Heartbeat {
  sessionId: string;
  title: string;
  directory: string;
  lastMsgCreated: number | null;
  lastMsgCompleted: number | null;
  /** Timestamp of the most recent progress within the turn, if the product has one. */
  lastPartUpdated: number | null;
  sessionUpdated: number;
}

export interface Profile {
  /**
   * Product name: the default tmux session, the env-var prefix, the install
   * name, and the label shown in the tmux status bar and dashboard title.
   */
  name: string;
  /** The agent CLI being driven: "opencode" | "claude". */
  agentName: string;
  tmuxSession: string;
  /** tmux user-option names holding per-window/per-pane state. */
  opt: { session: string; dir: string; role: string; title: string };
  /** Values stored in `opt.role`, used by the pane-died hooks. */
  roles: { agent: string; shell: string; dashboard: string };
  shellBin: string;
  shellPanePercent: number;
  historyLimit: number;
  /** Env var a nested process can read to discover it is inside our session. */
  currentSessionEnv: string;

  /** Resolve a usable agent binary, or throw with a readable reason. */
  resolveBin(): AgentBin;
  health(minIntervalMs?: number, timeoutMs?: number): Promise<AgentHealth>;
  /**
   * Command string tmux runs for the agent pane of a tab. `sessionId`
   * undefined means "start a fresh conversation here".
   */
  launch(directory: string, sessionId?: string): string;
  /** Pull a session id out of a `/proc/<pid>/cmdline` argv, if present. */
  sniffSessionId(argv: string[]): string | undefined;

  sessions: {
    list(): Promise<AgentSession[]>;
    title(sessionId: string): Promise<string | null>;
    newestUnclaimed(
      directory: string,
      taken: Set<string>,
    ): Promise<{ id: string; title: string } | null>;
  };

  cleanup: {
    delete(sessionId: string, directory: string): Promise<DeleteResult>;
    stillExists(sessionId: string): boolean;
    measure(sessionIds: string[]): Promise<Map<string, SessionCost>>;
    childrenOf(sessionId: string): number;
    selectForCleanup(
      sessions: AgentSession[],
      filter: CleanFilter,
      now?: number,
    ): Promise<AgentSession[]>;
    /** Files the agent's delete leaves behind, matched to dead sessions. */
    findOrphans(): OrphanFile[];
    removeOrphans(files: OrphanFile[]): number;
    /** Bytes the whole session store occupies on disk. */
    storeSize(): Promise<number>;
    /** Compact the store. Products without a compactable store report a note. */
    reclaim(): Promise<{ ok: boolean; error?: string; note?: string }>;
  };

  status: {
    /** Heartbeats for live tabs, keyed by session id. */
    heartbeats(sessionIds: string[]): Promise<Map<string, Heartbeat>>;
  };
}

let current: Profile | null = null;

export function setProfile(profile: Profile): void {
  current = profile;
}

/** The active product. Throws when an entry point forgot to select one. */
export function P(): Profile {
  if (!current) {
    throw new Error(
      "no profile selected — an entry point must call setProfile() before using the engine",
    );
  }
  return current;
}
