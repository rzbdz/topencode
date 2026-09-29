import { runDashboard, type DashboardActions } from "./dashboard.ts";
import { buildProjectViews } from "./views.ts";
import type { LiveTab, SessionStatusView, SessionView } from "./types.ts";
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
  claimUntaggedTabs,
  newBlankTab,
  adoptRuntimeSessions,
} from "./tmux.ts";
import { buildStatusViews, LAMP, DESC } from "./status.ts";
import { fmtAge, fmtBytes, padW, strWidth, truncW } from "./format.ts";
import { resolve } from "node:path";
import { P } from "./profile.ts";

async function cmdList(): Promise<void> {
  const [sessions, tabs] = await Promise.all([P().sessions.list(), listTabs()]);
  const projects = buildProjectViews(sessions, tabs);
  if (projects.length === 0) {
    console.log(`No ${P().agentName} sessions found.`);
    return;
  }
  for (const p of projects) {
    console.log(`\n\x1b[1m${p.label}\x1b[0m  \x1b[2m${p.directory}\x1b[0m`);
    for (const s of p.sessions) {
      const mark = s.live ? "\x1b[32m●\x1b[0m" : "\x1b[2m○\x1b[0m";
      const idx = s.live ? ` \x1b[2m[tab ${s.windowIndex}]\x1b[0m` : "";
      console.log(
        `  ${mark} ${s.title || "(untitled)"}  \x1b[2m${s.id}\x1b[0m${idx}`,
      );
    }
  }
}

function renderStatus(views: SessionStatusView[]): string {
  const lines: string[] = [];
  if (views.length === 0) {
    lines.push(`No open session tabs. Run \`${P().name}\` to open some.`);
    return lines.join("\n");
  }
  const titleW = Math.min(
    44,
    Math.max(12, ...views.map((v) => Math.min(44, strWidth(v.title)))),
  );
  lines.push(
    `\x1b[1m  ${padW("TAB", 4)}${padW("", 2)}${padW("SESSION", titleW)}  ${padW("STATUS", 22)}${"AGE".padStart(5)}\x1b[0m`,
  );
  for (const v of views) {
    const tab = v.windowIndex !== undefined ? `${v.windowIndex}` : "-";
    lines.push(
      `  ${padW(tab, 4)}${LAMP[v.kind]} ${padW(truncW(v.title, titleW), titleW)}  ${padW(DESC[v.kind], 22)}${fmtAge(v.heartbeatAgeMs).padStart(5)}`,
    );
  }
  const working = views.filter((v) => v.kind === "working").length;
  const stalled = views.filter((v) => v.kind === "stalled").length;
  lines.push("");
  lines.push(
    `\x1b[2m  ${views.length} open · ${working} progressing · ${stalled} may need you\x1b[0m`,
  );
  return lines.join("\n");
}

async function refreshTabs(): Promise<LiveTab[]> {
  await adoptRuntimeSessions((id) => P().sessions.title(id));
  await claimUntaggedTabs(
    (directory, taken) => P().sessions.newestUnclaimed(directory, taken),
    (id) => P().sessions.title(id),
  );
  return listTabs();
}

async function cmdStatus(): Promise<void> {
  const tabs = await refreshTabs();
  console.log(renderStatus(await buildStatusViews(tabs)));
}

async function cmdWatch(): Promise<void> {
  const out = process.stdout;
  out.write("\x1b[?25l");
  const cleanup = () => {
    out.write("\x1b[?25h\n");
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("exit", cleanup);
  for (;;) {
    const tabs = await refreshTabs();
    const body = renderStatus(await buildStatusViews(tabs));
    out.write(
      `\x1b[H\x1b[2J\x1b[1m ${P().name} watch \x1b[0m\x1b[2m  ${new Date().toLocaleTimeString()}  (Ctrl-C to exit)\x1b[0m\n\n${body}\n`,
    );
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function cmdOpen(sessionId: string): Promise<void> {
  const sessions = await P().sessions.list();
  const s = sessions.find((x) => x.id === sessionId);
  if (!s) {
    console.error(`Session not found: ${sessionId}`);
    process.exit(1);
  }
  const selected = await selectSessionWindow(sessionId);
  if (!selected) await openSessionTab(sessionId, s.directory, s.title);
  await attach();
}

async function cmdNew(dir?: string): Promise<void> {
  const directory = resolve(dir ?? process.cwd());
  await newSessionTab(directory);
  await attach();
}

async function confirmPrompt(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `);
  const dec = new TextDecoder();
  for await (const chunk of process.stdin) {
    const ans = dec.decode(chunk).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  }
  return false;
}

/** A negative count means "too big to count cheaply", never "none". */
function fmtMessages(n: number | undefined): string {
  if (n === undefined) return "? msgs";
  return n < 0 ? "? msgs" : `${n} msgs`;
}

async function cmdDelete(ids: string[], force: boolean): Promise<void> {
  const sessions = await P().sessions.list();
  const tabs = await listTabs();
  const liveIds = new Set(
    tabs.filter((t) => t.sessionId).map((t) => t.sessionId as string),
  );
  const targets = ids
    .map((id) => sessions.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined);
  const missing = ids.filter((id) => !sessions.some((s) => s.id === id));
  for (const m of missing) console.error(`\x1b[33mnot found:\x1b[0m ${m}`);
  if (targets.length === 0) return;

  const costs = await P().cleanup.measure(targets.map((s) => s.id));
  let totalBytes = 0;
  console.log("\nWill permanently delete:");
  for (const s of targets) {
    const c = costs.get(s.id);
    totalBytes += c?.bytes ?? 0;
    const kids = P().cleanup.childrenOf(s.id);
    const liveMark = liveIds.has(s.id) ? " \x1b[33m[TAB OPEN]\x1b[0m" : "";
    const kidMark = kids > 0 ? ` \x1b[36m[+${kids} sub-sessions]\x1b[0m` : "";
    const detail = c?.detail ? ` · ${c.detail}` : "";
    console.log(
      `  \x1b[31m✗\x1b[0m ${s.title}${liveMark}${kidMark}\n    ${s.id}  \x1b[2m${fmtMessages(c?.messages)} · ${fmtBytes(c?.bytes ?? 0)}${detail}\x1b[0m`,
    );
  }
  console.log(`\n  total: ${targets.length} session(s), ${fmtBytes(totalBytes)}`);

  const blocked = targets.filter((s) => liveIds.has(s.id));
  if (blocked.length > 0 && !force) {
    console.error(
      `\n\x1b[31mAborted.\x1b[0m ${blocked.length} session(s) have an open tab. Close them first, or pass --force.`,
    );
    process.exit(1);
  }

  if (!force) {
    const ok = await confirmPrompt("\nThis cannot be undone. Proceed?");
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }

  let done = 0;
  for (const s of targets) {
    if (liveIds.has(s.id)) await closeTab(s.id);
    const r = await P().cleanup.delete(s.id, s.directory);
    if (r.ok && !P().cleanup.stillExists(s.id)) {
      console.log(`  \x1b[32m✓\x1b[0m deleted ${s.id}`);
      done++;
    } else {
      console.error(
        `  \x1b[31m✗\x1b[0m failed ${s.id}: ${r.error ?? "still present"}`,
      );
    }
  }
  const orphans = P().cleanup.findOrphans();
  if (orphans.length > 0) {
    const bytes = orphans.reduce((a, o) => a + o.bytes, 0);
    const n = P().cleanup.removeOrphans(orphans);
    console.log(
      `  \x1b[32m✓\x1b[0m removed ${n} leftover file(s) the agent does not clean (${fmtBytes(bytes)})`,
    );
  }
  console.log(
    `\n${done}/${targets.length} deleted. Run \`${P().name} vacuum\` to reclaim disk space.`,
  );
}

async function cmdClean(args: string[]): Promise<void> {
  const force = args.includes("--force") || args.includes("-f");
  const apply = args.includes("--apply") || force;
  const emptyOnly = args.includes("--empty");
  const daysArg = args.find((a) => a.startsWith("--older-than="));
  const dirArg = args.find((a) => a.startsWith("--dir="));
  const olderThanDays = daysArg ? Number(daysArg.split("=")[1]) : undefined;
  const directory = dirArg ? resolve(dirArg.split("=")[1] ?? "") : undefined;

  if (olderThanDays === undefined && !emptyOnly && !directory) {
    console.log(`${P().name} clean — bulk session cleanup (uses ${P().agentName}'s own delete)

Usage:
  ${P().name} clean --older-than=<days>   sessions not updated in N days
  ${P().name} clean --empty               sessions with zero messages
  ${P().name} clean --dir=<path>          only this project
  (filters combine)

  --apply     actually delete (default is a dry run)
  --force     skip confirmation and ignore open tabs

Examples:
  ${P().name} clean --empty
  ${P().name} clean --older-than=60 --apply
  ${P().name} clean --older-than=30 --dir=~/work/foo --apply`);
    return;
  }

  const sessions = await P().sessions.list();
  const tabs = await listTabs();
  const liveIds = new Set(
    tabs.filter((t) => t.sessionId).map((t) => t.sessionId as string),
  );
  let picked = await P().cleanup.selectForCleanup(sessions, {
    olderThanDays,
    emptyOnly,
    directory,
  });
  if (!force) picked = picked.filter((s) => !liveIds.has(s.id));

  if (picked.length === 0) {
    console.log("Nothing matches those filters.");
    return;
  }

  const costs = await P().cleanup.measure(picked.map((s) => s.id));
  const totalBytes = picked.reduce(
    (a, s) => a + (costs.get(s.id)?.bytes ?? 0),
    0,
  );
  const byDir = new Map<string, typeof picked>();
  for (const s of picked) {
    const arr = byDir.get(s.directory) ?? [];
    arr.push(s);
    byDir.set(s.directory, arr);
  }

  console.log(
    apply ? "\nDeleting:" : "\n\x1b[1mDRY RUN\x1b[0m — nothing will be deleted:",
  );
  for (const [dir, list] of byDir) {
    console.log(`\n  \x1b[1m${dir}\x1b[0m`);
    for (const s of list) {
      const c = costs.get(s.id);
      console.log(
        `    \x1b[2m${new Date(s.updated).toISOString().slice(0, 10)}\x1b[0m  ${truncW(s.title, 46).padEnd(46)} \x1b[2m${fmtMessages(c?.messages).padStart(7)} ${fmtBytes(c?.bytes ?? 0).padStart(7)}\x1b[0m`,
      );
    }
  }
  console.log(
    `\n  ${picked.length} session(s), ${fmtBytes(totalBytes)} of session data`,
  );

  const existingOrphans = P().cleanup.findOrphans();
  if (existingOrphans.length > 0) {
    const b = existingOrphans.reduce((a, o) => a + o.bytes, 0);
    console.log(
      `  \x1b[2m+ ${existingOrphans.length} leftover file(s) from previously deleted sessions (${fmtBytes(b)}) will also be removed\x1b[0m`,
    );
  }

  if (!apply) {
    console.log(`\nRe-run with \x1b[1m--apply\x1b[0m to delete.`);
    return;
  }
  if (!force) {
    const ok = await confirmPrompt("\nThis cannot be undone. Proceed?");
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }

  let done = 0;
  for (const s of picked) {
    if (liveIds.has(s.id)) await closeTab(s.id);
    const r = await P().cleanup.delete(s.id, s.directory);
    if (r.ok && !P().cleanup.stillExists(s.id)) done++;
    else console.error(`  \x1b[31m✗\x1b[0m ${s.id}: ${r.error ?? "still present"}`);
    process.stdout.write(`\r  deleted ${done}/${picked.length}...`);
  }
  const orphans = P().cleanup.findOrphans();
  if (orphans.length > 0) {
    const bytes = orphans.reduce((a, o) => a + o.bytes, 0);
    const n = P().cleanup.removeOrphans(orphans);
    console.log(
      `\n  \x1b[32m✓\x1b[0m removed ${n} leftover file(s) the agent does not clean (${fmtBytes(bytes)})`,
    );
  }
  console.log(
    `\n${done}/${picked.length} deleted. Run \x1b[1m${P().name} vacuum\x1b[0m to reclaim disk space.`,
  );
}

async function cmdVacuum(): Promise<void> {
  const orphans = P().cleanup.findOrphans();
  if (orphans.length > 0) {
    const bytes = orphans.reduce((a, o) => a + o.bytes, 0);
    const n = P().cleanup.removeOrphans(orphans);
    console.log(
      `Removed ${n} leftover file(s) (${fmtBytes(bytes)}) that ${P().agentName}'s delete leaves behind.`,
    );
  }
  const before = await P().cleanup.storeSize();
  console.log(`Session store: ${fmtBytes(before)}`);
  const r = await P().cleanup.reclaim();
  if (!r.ok) {
    console.error(`\x1b[31mreclaim failed:\x1b[0m ${r.error}`);
    process.exit(1);
  }
  if (r.note) {
    console.log(r.note);
    return;
  }
  console.log("Running VACUUM (this can take a while on a large database)...");
  const after = await P().cleanup.storeSize();
  const saved = before - after;
  console.log(
    `Done. ${fmtBytes(before)} → ${fmtBytes(after)}  \x1b[32m(${saved > 0 ? "reclaimed " + fmtBytes(saved) : "no change"})\x1b[0m`,
  );
}

async function cmdClose(ref: string): Promise<void> {
  const ok = await closeTab(ref);
  console.log(ok ? `Closed tab ${ref}` : `No tab matching ${ref}`);
}

function makeActions(): DashboardActions {
  return {
    loadProjects: async () => {
      const tabs = await refreshTabs();
      const sessions = await P().sessions.list();
      return buildProjectViews(sessions, tabs);
    },
    openSession: async (s: SessionView) => {
      if (s.live) {
        await selectSessionWindow(s.id);
      } else {
        await openSessionTab(s.id, s.directory, s.title);
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
    exitAll: async () => {
      await killSession();
    },
    blankTab: async (directory: string) => {
      await newBlankTab(directory);
    },
    checkHealth: async () => P().health(),
  };
}

async function cmdAttach(): Promise<void> {
  await ensureSession();
  await attach();
}

function usage(): void {
  const p = P().name;
  console.log(`${p} — manage ${P().agentName} sessions as mouse-driven tmux tabs

Usage:
  ${p}                 attach (create the session if needed)
  ${p} attach          same as above
  ${p} list            list all sessions grouped by project
  ${p} status          show status of every open session tab
  ${p} watch           live-refreshing status view
  ${p} open <id>       open/select a tab for session id
  ${p} new [dir]       start a new ${P().agentName} session tab (default: cwd)
  ${p} close <tab|id>  close a tab (does not delete the session)
  ${p} delete <id...>  permanently delete session(s) and all their data
  ${p} clean [filters] bulk cleanup (dry run by default)
  ${p} vacuum          reclaim disk space after deleting
  ${p} kill            kill the whole ${p} tmux session
`);
}

export async function main(): Promise<void> {
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
    case "status":
      await cmdStatus();
      break;
    case "watch":
      await cmdWatch();
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
    case "delete":
    case "rm": {
      const force = rest.includes("--force") || rest.includes("-f");
      const ids = rest.filter((a) => !a.startsWith("-"));
      if (ids.length === 0) return usage();
      await cmdDelete(ids, force);
      break;
    }
    case "clean":
      await cmdClean(rest);
      break;
    case "vacuum":
      await cmdVacuum();
      break;
    case "kill":
      await killSession();
      console.log(`Killed ${P().name} session.`);
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
