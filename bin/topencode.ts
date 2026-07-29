#!/usr/bin/env bun
import { runDashboard, type DashboardActions } from "../src/dashboard.ts";
import { fetchSessions, buildProjectViews } from "../src/opencode.ts";
import {
  ensureSession,
  attach,
  listTabs,
  openSessionTab,
  newSessionTab,
  selectSessionWindow,
  closeTab,
  killSession,
  detachClient,
  closeTabByWindowId,
} from "../src/tmux.ts";
import type { SessionView } from "../src/types.ts";
import { resolve } from "node:path";

async function cmdList(): Promise<void> {
  const [sessions, tabs] = await Promise.all([fetchSessions(), listTabs()]);
  const projects = buildProjectViews(sessions, tabs);
  if (projects.length === 0) {
    console.log("No opencode sessions found.");
    return;
  }
  for (const p of projects) {
    console.log(`\n\x1b[1m${p.label}\x1b[0m  \x1b[2m${p.directory}\x1b[0m`);
    for (const s of p.sessions) {
      const mark = s.live ? "\x1b[32m●\x1b[0m" : "\x1b[2m○\x1b[0m";
      const idx = s.live ? ` \x1b[2m[tab ${s.windowIndex}]\x1b[0m` : "";
      console.log(`  ${mark} ${s.title || "(untitled)"}  \x1b[2m${s.id}\x1b[0m${idx}`);
    }
  }
}

async function cmdOpen(sessionId: string): Promise<void> {
  const sessions = await fetchSessions();
  const s = sessions.find((x) => x.id === sessionId);
  if (!s) {
    console.error(`Session not found: ${sessionId}`);
    process.exit(1);
  }
  const selected = await selectSessionWindow(sessionId);
  if (!selected) await openSessionTab(sessionId, s.directory);
  await attach();
}

async function cmdNew(dir?: string): Promise<void> {
  const directory = resolve(dir ?? process.cwd());
  await newSessionTab(directory);
  await attach();
}

async function cmdClose(ref: string): Promise<void> {
  const ok = await closeTab(ref);
  console.log(ok ? `Closed tab ${ref}` : `No tab matching ${ref}`);
}

function makeActions(): DashboardActions {
  return {
    loadProjects: async () => {
      const [sessions, tabs] = await Promise.all([fetchSessions(), listTabs()]);
      return buildProjectViews(sessions, tabs);
    },
    openSession: async (s: SessionView) => {
      if (s.live) {
        await selectSessionWindow(s.id);
      } else {
        await openSessionTab(s.id, s.directory);
      }
    },
    newSession: async (directory: string) => {
      await newSessionTab(directory);
    },
    closeSession: async (windowId: string) => {
      await closeTabByWindowId(windowId);
    },
    detach: async () => {
      await detachClient();
    },
  };
}

async function cmdAttach(): Promise<void> {
  await ensureSession();
  await attach();
}

function usage(): void {
  console.log(`topencode — manage opencode sessions as mouse-driven tmux tabs

Usage:
  topencode                 attach (create the session if needed)
  topencode attach          same as above
  topencode list            list all sessions grouped by project
  topencode open <id>       open/select a tab for session id
  topencode new [dir]       start a new opencode session tab (default: cwd)
  topencode close <tab|id>  close a tab (does not delete the session)
  topencode kill            kill the whole topencode tmux session
`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case "attach":
      await cmdAttach();
      break;
    case "dashboard":
      await runDashboard(makeActions());
      break;
    case "list":
      await cmdList();
      break;
    case "open":
      if (!rest[0]) return usage();
      await cmdOpen(rest[0]);
      break;
    case "new":
      await cmdNew(rest[0]);
      break;
    case "close":
      if (!rest[0]) return usage();
      await cmdClose(rest[0]);
      break;
    case "kill":
      await killSession();
      console.log("Killed topencode session.");
      break;
    case "-h":
    case "--help":
    case "help":
      usage();
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      usage();
      process.exit(1);
  }
}

main();
