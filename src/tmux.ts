import type { LiveTab, AttachContext } from "./types.ts";
import {
  TMUX_SESSION,
  OPENCODE_BIN,
  SHELL_BIN,
  SHELL_PANE_PERCENT,
  HISTORY_LIMIT,
  OPT,
  ROLE,
  dashboardCommand,
} from "./config.ts";

async function tmux(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "inherit",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

async function tmuxOk(args: string[]): Promise<boolean> {
  return (await tmux(args)).code === 0;
}

export async function sessionExists(): Promise<boolean> {
  return tmuxOk(["has-session", "-t", TMUX_SESSION]);
}

export function resolveAttachContext(): AttachContext {
  const tmuxEnv = process.env.TMUX;
  if (!tmuxEnv) return { kind: "outside" };
  const current = process.env.TOPENCODE_CURRENT_SESSION;
  if (current === TMUX_SESSION) return { kind: "inside-topencode" };
  return { kind: "inside-other", sessionName: current ?? "" };
}

async function currentClientSession(): Promise<string | null> {
  if (!process.env.TMUX) return null;
  const r = await tmux(["display-message", "-p", "#{session_name}"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function applySessionOptions(): Promise<void> {
  const set = (args: string[]) =>
    tmux(["set-option", "-t", TMUX_SESSION, ...args]);
  await set(["mouse", "on"]);
  await set(["history-limit", String(HISTORY_LIMIT)]);
  await set(["base-index", "0"]);
  await set(["pane-base-index", "0"]);
  await set(["renumber-windows", "on"]);
  await set(["status", "on"]);
  await set(["status-interval", "5"]);
  await set(["status-position", "bottom"]);
  await set(["status-justify", "left"]);
  await set(["status-left-length", "40"]);
  await set(["status-right-length", "60"]);
  await set(["status-style", "bg=colour236,fg=colour248"]);
  await set(["message-style", "bg=colour39,fg=colour232,bold"]);
  await set(["pane-border-style", "fg=colour238"]);
  await set(["pane-active-border-style", "fg=colour39"]);
  await set([
    "status-left",
    "#[bg=colour39,fg=colour232,bold] ⌂ topencode #[bg=colour236,fg=colour39]#[default] ",
  ]);
  await set([
    "status-right",
    "#[fg=colour240]M2-click tab ▸ close #[fg=colour232,bg=colour244,bold] %H:%M #[default]",
  ]);
  await set([
    "window-status-format",
    "#[fg=colour245,bg=colour236] #I #{?#{==:#{@oc_dir},},·,#{b:@oc_dir}} ",
  ]);
  await set([
    "window-status-current-format",
    "#[fg=colour236,bg=colour39]#[fg=colour232,bg=colour39,bold] #I #{?#{==:#{@oc_dir},},⌂ Home,#{b:@oc_dir}} #[fg=colour39,bg=colour236]#[default]",
  ]);
  await set(["window-status-separator", " "]);

  await tmux([
    "set-hook",
    "-t",
    TMUX_SESSION,
    "pane-died",
    `if -F "#{==:#{@oc_role},${ROLE.shell}}" "respawn-pane -k -c \\"#{pane_current_path}\\" ${SHELL_BIN}"`,
  ]);
  await tmux([
    "set-hook",
    "-a",
    "-t",
    TMUX_SESSION,
    "pane-died",
    `if -F "#{==:#{@oc_role},${ROLE.dashboard}}" "respawn-pane -k ${dashboardCommand()}"`,
  ]);

  await tmux([
    "bind-key",
    "-n",
    "MouseDown2Status",
    "if",
    "-F",
    "#{!=:#{@oc_session},}",
    "kill-window -t=",
  ]);
}

export async function ensureSession(): Promise<void> {
  const lock = "topencode-boot";
  await tmux(["wait-for", "-L", lock]);
  try {
    if (await sessionExists()) return;
    const dashCmd = dashboardCommand();
    await tmux([
      "new-session",
      "-d",
      "-s",
      TMUX_SESSION,
      "-n",
      "home",
      dashCmd,
    ]);
    await applySessionOptions();
    await tmux([
      "set-option",
      "-pq",
      "-t",
      `${TMUX_SESSION}:0.0`,
      OPT.role,
      ROLE.dashboard,
    ]);
    await tmux(["set-option", "-w", "-t", `${TMUX_SESSION}:0`, "remain-on-exit", "on"]);
  } finally {
    await tmux(["wait-for", "-U", lock]);
  }
}

function windowTarget(windowId: string): string {
  return windowId;
}

export async function listTabs(): Promise<LiveTab[]> {
  if (!(await sessionExists())) return [];
  const fmt = [
    "#{window_index}",
    "#{window_id}",
    "#{@oc_session}",
    "#{@oc_dir}",
    "#{window_active}",
  ].join("\t");
  const r = await tmux(["list-windows", "-t", TMUX_SESSION, "-F", fmt]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .filter((l) => l.length > 0)
    .map((line) => {
      const [idx, wid, ses, dir, active] = line.split("\t");
      return {
        windowIndex: Number(idx),
        windowId: wid ?? "",
        sessionId: ses && ses.length > 0 ? ses : undefined,
        directory: dir && dir.length > 0 ? dir : undefined,
        active: active === "1",
      } satisfies LiveTab;
    });
}

async function findWindowBySession(sessionId: string): Promise<LiveTab | null> {
  const tabs = await listTabs();
  return tabs.find((t) => t.sessionId === sessionId) ?? null;
}

async function selectWindow(windowId: string): Promise<void> {
  await tmux(["select-window", "-t", windowTarget(windowId)]);
}

async function createTabWindow(
  directory: string,
  launchCmd: string,
): Promise<string> {
  const r = await tmux([
    "new-window",
    "-t",
    TMUX_SESSION,
    "-c",
    directory,
    "-P",
    "-F",
    "#{window_id}",
    launchCmd,
  ]);
  if (r.code !== 0) {
    throw new Error(`new-window failed: ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

async function splitShell(windowId: string, directory: string): Promise<void> {
  await tmux([
    "split-window",
    "-h",
    "-p",
    String(SHELL_PANE_PERCENT),
    "-t",
    windowTarget(windowId),
    "-c",
    directory,
    SHELL_BIN,
  ]);
}

async function tagWindow(
  windowId: string,
  sessionId: string,
  directory: string,
): Promise<void> {
  await tmux([
    "set-option",
    "-wq",
    "-t",
    windowTarget(windowId),
    OPT.session,
    sessionId,
  ]);
  await tmux([
    "set-option",
    "-wq",
    "-t",
    windowTarget(windowId),
    OPT.dir,
    directory,
  ]);
  await tmux([
    "set-option",
    "-wq",
    "-t",
    windowTarget(windowId),
    "remain-on-exit",
    "on",
  ]);
}

async function tagPaneRoles(windowId: string): Promise<void> {
  const r = await tmux([
    "list-panes",
    "-t",
    windowTarget(windowId),
    "-F",
    "#{pane_id}\t#{pane_index}",
  ]);
  const lines = r.stdout.split("\n").filter((l) => l.length > 0);
  for (const line of lines) {
    const [paneId, idx] = line.split("\t");
    if (!paneId) continue;
    const role = idx === "0" ? ROLE.opencode : ROLE.shell;
    await tmux(["set-option", "-pq", "-t", paneId, OPT.role, role]);
  }
}

async function focusOpencodePane(windowId: string): Promise<void> {
  await tmux(["select-pane", "-t", `${windowTarget(windowId)}.0`]);
}

export async function openSessionTab(
  sessionId: string,
  directory: string,
): Promise<void> {
  await ensureSession();
  const lock = "topencode-open";
  await tmux(["wait-for", "-L", lock]);
  try {
    const existing = await findWindowBySession(sessionId);
    if (existing) {
      await selectWindow(existing.windowId);
      return;
    }
    const launch = `${quoteForTmux(OPENCODE_BIN)} ${quoteForTmux(directory)} -s ${quoteForTmux(sessionId)}`;
    const windowId = await createTabWindow(directory, launch);
    await tagWindow(windowId, sessionId, directory);
    await splitShell(windowId, directory);
    await tagPaneRoles(windowId);
    await focusOpencodePane(windowId);
    await selectWindow(windowId);
  } finally {
    await tmux(["wait-for", "-U", lock]);
  }
}

export async function newSessionTab(directory: string): Promise<void> {
  await ensureSession();
  const lock = "topencode-open";
  await tmux(["wait-for", "-L", lock]);
  try {
    const launch = `${quoteForTmux(OPENCODE_BIN)} ${quoteForTmux(directory)}`;
    const windowId = await createTabWindow(directory, launch);
    await tmux([
      "set-option",
      "-wq",
      "-t",
      windowTarget(windowId),
      OPT.dir,
      directory,
    ]);
    await tmux([
      "set-option",
      "-wq",
      "-t",
      windowTarget(windowId),
      "remain-on-exit",
      "on",
    ]);
    await splitShell(windowId, directory);
    await tagPaneRoles(windowId);
    await focusOpencodePane(windowId);
    await selectWindow(windowId);
  } finally {
    await tmux(["wait-for", "-U", lock]);
  }
}

export async function selectSessionWindow(sessionId: string): Promise<boolean> {
  const w = await findWindowBySession(sessionId);
  if (!w) return false;
  await selectWindow(w.windowId);
  return true;
}

export async function closeTab(ref: string): Promise<boolean> {
  const tabs = await listTabs();
  let target: LiveTab | undefined;
  if (ref.startsWith("ses_")) {
    target = tabs.find((t) => t.sessionId === ref);
  } else {
    const idx = Number(ref);
    if (!Number.isNaN(idx)) target = tabs.find((t) => t.windowIndex === idx);
  }
  if (!target) return false;
  if (target.windowIndex === 0) return false;
  await tmux(["kill-window", "-t", windowTarget(target.windowId)]);
  return true;
}

export async function killSession(): Promise<void> {
  await tmux(["kill-session", "-t", TMUX_SESSION]);
}

export async function detachClient(): Promise<void> {
  await tmux(["detach-client", "-s", TMUX_SESSION]);
}

export async function closeTabByWindowId(windowId: string): Promise<boolean> {
  const tabs = await listTabs();
  const target = tabs.find((t) => t.windowId === windowId);
  if (!target || target.windowIndex === 0) return false;
  await tmux(["kill-window", "-t", windowTarget(windowId)]);
  return true;
}

export async function attach(): Promise<void> {
  const ctx = resolveAttachContext();
  if (ctx.kind === "inside-topencode") {
    await selectWindow("home");
    return;
  }
  if (ctx.kind === "inside-other") {
    const proc = Bun.spawn(["tmux", "switch-client", "-t", TMUX_SESSION], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
    return;
  }
  const proc = Bun.spawn(["tmux", "attach-session", "-t", TMUX_SESSION], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  await proc.exited;
}

function quoteForTmux(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
