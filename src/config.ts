import { homedir } from "node:os";
import { join } from "node:path";

export const TMUX_SESSION = process.env.TOPENCODE_SESSION ?? "topencode";

export const OPENCODE_BIN =
  process.env.TOPENCODE_OPENCODE_BIN ??
  join(homedir(), ".opencode", "bin", "opencode");

export const SHELL_BIN = process.env.TOPENCODE_SHELL ?? "zsh";

export const SHELL_PANE_PERCENT = Number(process.env.TOPENCODE_SHELL_PCT ?? 35);

export const HISTORY_LIMIT = 50000;

export const OPT = {
  session: "@oc_session",
  dir: "@oc_dir",
  role: "@oc_role",
} as const;

export const ROLE = {
  opencode: "opencode",
  shell: "shell",
  dashboard: "dashboard",
} as const;

export const DASHBOARD_MARKER = "__topencode_dashboard__";

export function dashboardCommand(): string {
  return `${quoteArg(process.execPath)} dashboard`;
}

export function quoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
