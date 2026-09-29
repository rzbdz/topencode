/** A single agent conversation, as the product's store describes it. */
export interface AgentSession {
  id: string;
  title: string;
  updated: number;
  created: number;
  projectId: string;
  directory: string;
}

export interface LiveTab {
  windowIndex: number;
  windowId: string;
  sessionId?: string;
  directory?: string;
  active: boolean;
}

/**
 * A session parked in the recycle bin.
 *
 * The bin keeps its own copy of the title and directory so the bin view still
 * renders after the underlying session has been deleted outside the tool.
 */
export interface BinEntry {
  id: string;
  title: string;
  directory: string;
  /** When it was recycled (epoch ms). */
  hiddenAt: number;
}

export interface SessionView extends AgentSession {
  live: boolean;
  windowIndex?: number;
  windowId?: string;
}

export interface ProjectView {
  directory: string;
  label: string;
  sessions: SessionView[];
  liveCount: number;
}

export type AttachContext =
  | { kind: "outside" }
  | { kind: "inside-other"; sessionName: string }
  | { kind: "inside-own" };

export type StatusKind =
  | "working"
  | "done"
  | "stalled"
  | "stale"
  | "fresh"
  | "dormant";

export interface SessionStatusView {
  sessionId: string;
  title: string;
  directory: string;
  kind: StatusKind;
  heartbeatAgeMs: number | null;
  lastActivity: number;
  windowIndex?: number;
  live: boolean;
}
