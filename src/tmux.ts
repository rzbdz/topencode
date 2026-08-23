import { basename, join } from "node:path";
import { homedir } from "node:os";
import { statSync } from "node:fs";
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
  await applyWindowFormats();

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
  const windowId = r.stdout.trim();
  await applyWindowFormats();
  return windowId;
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

function truncTitle(s: string, max: number): string {
  let w = 0;
  let out = "";
  for (const ch of s) {
    const cw = (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
    if (w + cw > max) return out + "…";
    out += ch;
    w += cw;
  }
  return out;
}

async function setWindowTitle(windowId: string, title: string): Promise<void> {
  const short = truncTitle(title, 16);
  await tmux([
    "set-option",
    "-wq",
    "-t",
    windowTarget(windowId),
    OPT.title,
    short,
  ]);
  await tmux([
    "set-option",
    "-wq",
    "-t",
    windowTarget(windowId),
    "automatic-rename",
    "off",
  ]);
  await tmux(["rename-window", "-t", windowTarget(windowId), short]);
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
  title?: string,
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
    if (title) await setWindowTitle(windowId, title);
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
    await setWindowTitle(windowId, `＋ ${basename(directory) || directory}`);
    await splitShell(windowId, directory);
    await tagPaneRoles(windowId);
    await focusOpencodePane(windowId);
    await selectWindow(windowId);
  } finally {
    await tmux(["wait-for", "-U", lock]);
  }
}

export async function newBlankTab(directory: string): Promise<void> {
  await ensureSession();
  const lock = "topencode-open";
  await tmux(["wait-for", "-L", lock]);
  try {
    const windowId = await createTabWindow(directory, SHELL_BIN);
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
    await setWindowTitle(windowId, `▫ shell`);
    await splitShell(windowId, directory);
    await tagPaneRoles(windowId);
    await focusOpencodePane(windowId);
    await selectWindow(windowId);
  } finally {
    await tmux(["wait-for", "-U", lock]);
  }
}

export async function sniffPaneSessions(): Promise<
  Array<{ windowId: string; windowIndex: number; sessionId?: string; cwd?: string }>
> {
  const r = await tmux([
    "list-panes",
    "-s",
    "-t",
    TMUX_SESSION,
    "-F",
    "#{window_id}\t#{window_index}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}\t#{@oc_role}",
  ]);
  if (r.code !== 0) return [];
  const out: Array<{
    windowId: string;
    windowIndex: number;
    sessionId?: string;
    cwd?: string;
  }> = [];
  for (const line of r.stdout.split("\n").filter((l) => l.length > 0)) {
    const [windowId, windowIndex, , panePid, cwd, role] = line.split("\t");
    if (role === ROLE.shell) continue;
    if (!panePid) continue;
    const sessionId = await sniffSessionIdFromPid(Number(panePid));
    out.push({
      windowId: windowId ?? "",
      windowIndex: Number(windowIndex),
      sessionId,
      cwd,
    });
  }
  return out;
}

async function sniffSessionIdFromPid(pid: number): Promise<string | undefined> {
  const pids = [pid, ...(await childPids(pid))];
  for (const p of pids) {
    let cmdline = "";
    try {
      cmdline = await Bun.file(`/proc/${p}/cmdline`).text();
    } catch {
      continue;
    }
    const parts = cmdline.split("\0").filter((s) => s.length > 0);
    if (!parts.some((s) => s.includes("opencode"))) continue;
    const i = parts.findIndex((s) => s === "-s" || s === "--session");
    if (i >= 0 && parts[i + 1]?.startsWith("ses_")) return parts[i + 1];
    const inline = parts.find((s) => s.startsWith("ses_"));
    if (inline) return inline;
  }
  return undefined;
}

async function childPids(pid: number): Promise<number[]> {
  const proc = Bun.spawn(["pgrep", "-P", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out
    .split("\n")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
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

export async function claimUntaggedTabs(
  resolve: (directory: string, takenIds: Set<string>) => Promise<
    { id: string; title: string } | null
  >,
  titleOf?: (sessionId: string) => Promise<string | null>,
): Promise<number> {
  const tabs = await listTabs();
  const taken = new Set(
    tabs.filter((t) => t.sessionId).map((t) => t.sessionId as string),
  );
  const pending = tabs.filter(
    (t) => !t.sessionId && t.directory && t.windowIndex !== 0,
  );
  let claimed = 0;
  for (const t of pending) {
    const hit = await resolve(t.directory as string, taken);
    if (!hit) continue;
    await tmux([
      "set-option",
      "-wq",
      "-t",
      windowTarget(t.windowId),
      OPT.session,
      hit.id,
    ]);
    await setWindowTitle(t.windowId, hit.title);
    taken.add(hit.id);
    claimed++;
  }

  if (titleOf) {
    for (const t of tabs) {
      if (!t.sessionId || t.windowIndex === 0) continue;
      const cur = await tmux([
        "display-message",
        "-p",
        "-t",
        windowTarget(t.windowId),
        "#{window_name}",
      ]);
      const name = cur.stdout.trim();
      if (name !== "opencode" && name !== "zsh" && name !== "bash") continue;
      const title = await titleOf(t.sessionId);
      if (title) await setWindowTitle_safe(t.windowId, title);
    }
  }
  return claimed;
}

async function setWindowTitle_safe(windowId: string, title: string) {
  await setWindowTitle(windowId, title);
}

export async function adoptRuntimeSessions(
  titleOf: (sessionId: string) => Promise<string | null>,
): Promise<number> {
  const sniffed = await sniffPaneSessions();
  const tabs = await listTabs();
  const byWindow = new Map(tabs.map((t) => [t.windowId, t]));
  let adopted = 0;
  for (const s of sniffed) {
    if (!s.sessionId || s.windowIndex === 0) continue;
    const tab = byWindow.get(s.windowId);
    if (!tab) continue;
    if (tab.sessionId === s.sessionId) continue;
    await tmux([
      "set-option",
      "-wq",
      "-t",
      windowTarget(s.windowId),
      OPT.session,
      s.sessionId,
    ]);
    if (s.cwd) {
      await tmux([
        "set-option",
        "-wq",
        "-t",
        windowTarget(s.windowId),
        OPT.dir,
        s.cwd,
      ]);
    }
    const title = await titleOf(s.sessionId);
    if (title) await setWindowTitle(s.windowId, title);
    adopted++;
  }
  return adopted;
}

export async function closeTabByWindowId(windowId: string): Promise<boolean> {
  const tabs = await listTabs();
  const target = tabs.find((t) => t.windowId === windowId);
  if (!target || target.windowIndex === 0) return false;
  await tmux(["kill-window", "-t", windowTarget(windowId)]);
  return true;
}

const WIN_STATUS_FORMAT = "#[fg=colour245,bg=colour237] #I #W ";
const WIN_STATUS_CURRENT_FORMAT =
  "#[fg=colour237,bg=colour39]#[fg=colour16,bg=colour39,bold] #I  #W #[fg=colour39,bg=colour237]#[default]";

export async function applyWindowFormats(): Promise<void> {
  const r = await tmux([
    "list-windows",
    "-t",
    TMUX_SESSION,
    "-F",
    "#{window_id}",
  ]);
  const ids = r.stdout.split("\n").filter((l) => l.length > 0);
  for (const id of ids) {
    await tmux([
      "set-option",
      "-w",
      "-t",
      id,
      "window-status-format",
      WIN_STATUS_FORMAT,
    ]);
    await tmux([
      "set-option",
      "-w",
      "-t",
      id,
      "window-status-current-format",
      WIN_STATUS_CURRENT_FORMAT,
    ]);
    await tmux(["set-option", "-w", "-t", id, "window-status-separator", ""]);
    await tmux(["set-option", "-w", "-t", id, "automatic-rename", "off"]);
  }
}

export async function reapplyConfig(): Promise<void> {
  if (!(await sessionExists())) return;
  await applySessionOptions();
  await applyWindowFormats();
  await sourceShellRc();
  await syncProxyEnv();
}

async function syncProxyEnv(): Promise<void> {
  const vars = [
    "http_proxy",
    "https_proxy",
    "ftp_proxy",
    "no_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "FTP_PROXY",
    "NO_PROXY",
  ];
  for (const v of vars) {
    const val = process.env[v];
    if (val !== undefined) {
      await tmux(["set-environment", "-t", TMUX_SESSION, v, val]);
    }
  }
}

async function sourceShellRc(): Promise<void> {
  const shell = process.env.SHELL ?? "/bin/bash";
  const home = homedir();
  let rcFiles: string[] = [];
  if (shell.includes("zsh")) {
    rcFiles = [join(home, ".zshrc"), join(home, ".zprofile")];
  } else if (shell.includes("bash")) {
    rcFiles = [
      join(home, ".bash_profile"),
      join(home, ".bashrc"),
      join(home, ".profile"),
    ];
  }
  const existing = rcFiles.filter((f) => {
    try {
      statSync(f);
      return true;
    } catch {
      return false;
    }
  });
  if (existing.length === 0) return;
  const cmd =
    shell.includes("zsh") ? `source ${existing[0]}` : `. ${existing[0]}`;
  const proc = Bun.spawn([shell, "-c", `${cmd}; env`], {
    stdout: "pipe",
    stderr: "ignore",
    env: process.env,
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const lines = out.split("\n");
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq);
    const v = line.slice(eq + 1);
    if (k && v && !k.startsWith("_") && k.match(/^[A-Za-z_][A-Za-z0-9_]*$/)) {
      await tmux(["set-environment", "-t", TMUX_SESSION, k, v]);
    }
  }
}

export async function attach(): Promise<void> {
  await reapplyConfig();
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
