export interface OpencodeSession {
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

export interface SessionView extends OpencodeSession {
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
  | { kind: "inside-topencode" };

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
