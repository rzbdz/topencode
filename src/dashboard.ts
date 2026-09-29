import type { BinEntry, ProjectView, SessionView } from "./types.ts";
import { P } from "./profile.ts";

export interface HealthReport {
  ok: boolean;
  path?: string;
  version?: string;
  problem?: string;
}

export interface DashboardActions {
  loadProjects(): Promise<ProjectView[]>;
  openSession(session: SessionView): Promise<void>;
  newSession(directory: string): Promise<void>;
  closeSession(windowId: string): Promise<void>;
  detach(): Promise<void>;
  exitAll(): Promise<void>;
  blankTab(directory: string): Promise<void>;
  /** Optional probe of the agent binary; a failure is surfaced on the bottom row. */
  checkHealth?(): Promise<HealthReport>;
  /** The recycle bin's contents, newest first. */
  loadBin(): Promise<BinEntry[]>;
  /** Move a session to the recycle bin. Reversible; touches no agent data. */
  recycle(session: SessionView): Promise<void>;
  /** Delete a session for good, through the product's own delete. */
  purge(session: SessionView): Promise<void>;
  /** Take a session back out of the bin. */
  restore(entry: BinEntry): Promise<void>;
  /** Delete a binned session for good. */
  purgeFromBin(entry: BinEntry): Promise<void>;
}

const ESC = "\x1b";
const ENTER = `${ESC}[?1049h${ESC}[?25l${ESC}[?1002h${ESC}[?1006h`;
const LEAVE = `${ESC}[?1006l${ESC}[?1002l${ESC}[?25h${ESC}[?1049l`;

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return "now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ms).toISOString().slice(5, 10);
}

function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function stringWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0)!);
  return w;
}

function truncate(s: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(s) <= width) return s;
  let acc = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > width - 1) break;
    acc += ch;
    w += cw;
  }
  return acc + "…";
}

function padEnd(s: string, width: number): string {
  const w = stringWidth(s);
  if (w >= width) return truncate(s, width);
  return s + " ".repeat(width - w);
}

interface Region {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** Click targets drawn on the row at a given y, rebuilt on every render. */
interface RowHits {
  /** windowId of a live tab, for its close button. */
  close?: string;
  recycle?: SessionView;
  purge?: SessionView;
  restore?: BinEntry;
  purgeBin?: BinEntry;
}

export async function runDashboard(actions: DashboardActions): Promise<void> {
  const out = process.stdout;
  const inp = process.stdin;

  let projects: ProjectView[] = [];
  let selectedProject = 0;
  let leftScroll = 0;
  let rightScroll = 0;
  let focus: "left" | "right" = "left";
  let selectedRow = 0;
  let cols = out.columns || 80;
  let rows = out.rows || 24;

  let leftRegion: Region = { x0: 0, x1: 0, y0: 0, y1: 0 };
  let rightRegion: Region = { x0: 0, x1: 0, y0: 0, y1: 0 };
  let leftColW = 0;
  let detachRegion = { x0: 0, x1: 0, y: 0 };
  let exitRegion = { x0: 0, x1: 0, y: 0 };
  let confirmExit = false;
  /**
   * Deleting for good is the one irreversible thing this UI does, so the red
   * button arms on the first click and acts on the second.
   */
  let confirmPurge: string | null = null;
  let bin: BinEntry[] = [];
  const rowHits = new Map<number, RowHits>();
  let health: HealthReport | null = null;

  // Row buttons live in a right-aligned strip: [♻/↩] [✗] [✕].
  const BTN_SLOTS = 3;
  const BTN_STRIDE = 2;
  const BTN_W = BTN_SLOTS * BTN_STRIDE;
  const slotX = (slot: number) => cols - 1 - (BTN_SLOTS - 1 - slot) * BTN_STRIDE;
  /** The red ✗, brightened while it is armed for a confirming second click. */
  const purgeMark = (armed: boolean) =>
    armed
      ? `${ESC}[48;5;196m${ESC}[38;5;231m${ESC}[1m✗${ESC}[0m`
      : `${ESC}[38;5;203m✗${ESC}[0m`;

  let tornDown = false;

  const teardown = () => {
    if (tornDown) return;
    tornDown = true;
    try {
      out.write(LEAVE);
      if (inp.isTTY) inp.setRawMode(false);
      inp.pause();
    } catch {}
  };

  const write = (s: string) => {
    try {
      out.write(s);
    } catch {}
  };

  function computeLayout() {
    cols = out.columns || 80;
    rows = out.rows || 24;
    leftColW = Math.max(16, Math.floor(cols * 0.34));
    const contentTop = 3;
    const contentBottom = rows - 1;
    leftRegion = { x0: 1, x1: leftColW, y0: contentTop, y1: contentBottom };
    rightRegion = {
      x0: leftColW + 2,
      x1: cols,
      y0: contentTop,
      y1: contentBottom,
    };
  }

  /** The left column: one row per project, plus the recycle bin when used. */
  function leftRows(): Array<
    { kind: "project"; p: ProjectView } | { kind: "bin" }
  > {
    const list: Array<{ kind: "project"; p: ProjectView } | { kind: "bin" }> =
      projects.map((p) => ({ kind: "project" as const, p }));
    if (bin.length > 0) list.push({ kind: "bin" as const });
    return list;
  }

  /** The bin is a pseudo-project living one past the real ones. */
  const binSelected = () =>
    bin.length > 0 && selectedProject === projects.length;

  function rightRows(): Array<
    | { kind: "new" }
    | { kind: "blank" }
    | { kind: "session"; s: SessionView }
    | { kind: "binned"; e: BinEntry }
  > {
    if (binSelected()) return bin.map((e) => ({ kind: "binned", e }));
    const proj = projects[selectedProject];
    if (!proj) return [];
    const list: Array<
      | { kind: "new" }
      | { kind: "blank" }
      | { kind: "session"; s: SessionView }
      | { kind: "binned"; e: BinEntry }
    > = [{ kind: "new" }, { kind: "blank" }];
    for (const s of proj.sessions) list.push({ kind: "session", s });
    return list;
  }

  function clampScroll() {
    const leftVisible = leftRegion.y1 - leftRegion.y0 + 1;
    const rightVisible = rightRegion.y1 - rightRegion.y0 + 1;
    const maxLeft = Math.max(0, leftRows().length - leftVisible);
    const maxRight = Math.max(0, rightRows().length - rightVisible);
    if (leftScroll > maxLeft) leftScroll = maxLeft;
    if (leftScroll < 0) leftScroll = 0;
    if (rightScroll > maxRight) rightScroll = maxRight;
    if (rightScroll < 0) rightScroll = 0;
  }

  function render() {
    computeLayout();
    clampScroll();
    rowHits.clear();
    const lines: string[] = [];
    lines.push(`${ESC}[H${ESC}[2J`);

    const brand = `${ESC}[48;5;39m${ESC}[38;5;232m${ESC}[1m ⌂ ${P().name} ${ESC}[0m`;
    lines.push(`${ESC}[1;1H${brand}`);
    const exitLabel = confirmExit ? " ⚠ click again to EXIT ALL " : " ⏻ exit all ";
    const exitW = exitLabel.length;
    exitRegion = { x0: cols - exitW + 1, x1: cols, y: 1 };
    const exitStyle = confirmExit
      ? `${ESC}[48;5;196m${ESC}[38;5;231m${ESC}[1m`
      : `${ESC}[48;5;52m${ESC}[38;5;210m`;
    lines.push(`${ESC}[1;${exitRegion.x0}H${exitStyle}${exitLabel}${ESC}[0m`);

    const detachLabel = " ⏏ detach ";
    const detachW = detachLabel.length;
    detachRegion = { x0: exitRegion.x0 - detachW - 1, x1: exitRegion.x0 - 2, y: 1 };
    lines.push(
      `${ESC}[1;${detachRegion.x0}H${ESC}[48;5;238m${ESC}[38;5;255m${detachLabel}${ESC}[0m`,
    );

    const inBin = binSelected();
    const armed = confirmPurge !== null;
    const hintText = armed
      ? "⚠ click ✗ again to delete for good"
      : inBin
        ? "↑↓ move  ↩ restore  ✗ delete for good  q detach"
        : "↑↓ move  ←→ column  ⏎ open  ♻ recycle  ✗ delete  ✕ close  q detach";
    const hintX = Math.max(14, Math.floor((cols - hintText.length) / 2));
    if (hintX + hintText.length < detachRegion.x0 - 1) {
      const hintStyle = armed ? `${ESC}[1m${ESC}[38;5;203m` : `${ESC}[38;5;240m`;
      lines.push(`${ESC}[1;${hintX}H${hintStyle}${hintText}${ESC}[0m`);
    }

    const proj = projects[selectedProject];
    const leftHdr = focus === "left" ? `${ESC}[38;5;39m▸ PROJECTS` : "PROJECTS";
    const rightHdrLabel = inBin
      ? `♻ RECYCLE BIN (${bin.length})`
      : proj
        ? `SESSIONS — ${proj.label}`
        : "SESSIONS";
    const rightHdr =
      focus === "right" ? `${ESC}[38;5;39m▸ ${rightHdrLabel}` : rightHdrLabel;
    lines.push(
      `${ESC}[2;1H${ESC}[1m${padEnd(leftHdr, leftColW)}${ESC}[0m`,
    );
    lines.push(
      `${ESC}[2;${leftColW + 2}H${ESC}[1m${truncate(rightHdr, cols - leftColW - 1)}${ESC}[0m`,
    );

    for (let y = leftRegion.y0; y <= leftRegion.y1; y++) {
      lines.push(`${ESC}[${y};${leftColW + 1}H${ESC}[38;5;238m│${ESC}[0m`);
    }

    const leftVisible = leftRegion.y1 - leftRegion.y0 + 1;
    const lrows = leftRows();
    if (lrows.length === 0) {
      lines.push(`${ESC}[${leftRegion.y0};1H${ESC}[2mNo projects${ESC}[0m`);
    }
    for (let i = 0; i < leftVisible; i++) {
      const idx = i + leftScroll;
      const row = lrows[idx];
      if (!row) break;
      const y = leftRegion.y0 + i;
      let dot: string;
      let label: string;
      if (row.kind === "bin") {
        dot = `${ESC}[38;5;208m♻${ESC}[0m `;
        label = `recycle bin  (${bin.length})`;
      } else {
        dot = row.p.liveCount > 0 ? `${ESC}[38;5;42m●${ESC}[0m ` : "  ";
        label = `${row.p.label}  (${row.p.liveCount}/${row.p.sessions.length})`;
      }
      const isSel = idx === selectedProject;
      const text = padEnd(` ${dot}${label}`, leftColW);
      if (isSel && focus === "left") {
        lines.push(`${ESC}[${y};1H${ESC}[48;5;39m${ESC}[38;5;232m${text}${ESC}[0m`);
      } else if (isSel) {
        lines.push(`${ESC}[${y};1H${ESC}[48;5;238m${text}${ESC}[0m`);
      } else {
        lines.push(`${ESC}[${y};1H${text}`);
      }
    }

    const rrows = rightRows();
    const rightVisible = rightRegion.y1 - rightRegion.y0 + 1;
    const rightW = cols - rightRegion.x0 + 1;
    if (!proj && !inBin) {
      lines.push(
        `${ESC}[${rightRegion.y0};${rightRegion.x0}H${ESC}[2mSelect a project ←${ESC}[0m`,
      );
    } else {
      for (let i = 0; i < rightVisible; i++) {
        const idx = i + rightScroll;
        if (idx >= rrows.length) break;
        const row = rrows[idx]!;
        const y = rightRegion.y0 + i;
        const isSel = focus === "right" && idx === selectedRow;
        const selOn = isSel ? `${ESC}[48;5;39m${ESC}[38;5;232m` : "";
        const selOff = isSel ? `${ESC}[0m` : "";
        if (row.kind === "new") {
          const txt = padEnd(" ＋ New session", rightW);
          lines.push(
            `${ESC}[${y};${rightRegion.x0}H${selOn}${isSel ? "" : `${ESC}[38;5;36m`}${txt}${ESC}[0m`,
          );
        } else if (row.kind === "blank") {
          const txt = padEnd(
            ` ▫ Blank tab (shell ⇢ start ${P().agentName} yourself)`,
            rightW,
          );
          lines.push(
            `${ESC}[${y};${rightRegion.x0}H${selOn}${isSel ? "" : `${ESC}[38;5;245m`}${txt}${ESC}[0m`,
          );
        } else if (row.kind === "binned") {
          // Bin rows carry only the two buttons: restore, and delete for good.
          const e = row.e;
          const rt = relTime(e.hiddenAt);
          const titleW = Math.max(4, rightW - 4 - rt.length - BTN_W);
          const t = truncate(e.title || "(untitled)", titleW);
          if (isSel) {
            const body = padEnd(
              ` ♻ ${padEnd(t, titleW)} ${rt}`,
              rightW - BTN_W,
            );
            lines.push(`${ESC}[${y};${rightRegion.x0}H${selOn}${body}${selOff}`);
          } else {
            const body = ` ${ESC}[38;5;208m♻${ESC}[0m ${padEnd(t, titleW)} ${ESC}[38;5;244m${rt}${ESC}[0m`;
            lines.push(`${ESC}[${y};${rightRegion.x0}H${body}`);
          }
          rowHits.set(y, { restore: e, purgeBin: e });
          lines.push(`${ESC}[${y};${slotX(0)}H${ESC}[38;5;42m↩${ESC}[0m`);
          lines.push(`${ESC}[${y};${slotX(1)}H${purgeMark(confirmPurge === e.id)}`);
        } else {
          const s = row.s;
          const rt = relTime(s.updated);
          const titleW = Math.max(4, rightW - 4 - rt.length - BTN_W);
          const t = truncate(s.title || "(untitled)", titleW);
          if (isSel) {
            const body = padEnd(
              ` ${s.live ? "●" : "○"} ${padEnd(t, titleW)} ${rt}`,
              rightW - BTN_W,
            );
            lines.push(`${ESC}[${y};${rightRegion.x0}H${selOn}${body}${selOff}`);
          } else {
            const dot = s.live
              ? `${ESC}[38;5;42m●${ESC}[0m`
              : `${ESC}[38;5;244m○${ESC}[0m`;
            const body = ` ${dot} ${padEnd(t, titleW)} ${ESC}[38;5;244m${rt}${ESC}[0m`;
            lines.push(`${ESC}[${y};${rightRegion.x0}H${body}`);
          }
          rowHits.set(y, {
            recycle: s,
            purge: s,
            close: s.live ? s.windowId : undefined,
          });
          // Orange: hide it (reversible). Red: delete it (armed first).
          lines.push(`${ESC}[${y};${slotX(0)}H${ESC}[38;5;208m♻${ESC}[0m`);
          lines.push(`${ESC}[${y};${slotX(1)}H${purgeMark(confirmPurge === s.id)}`);
          if (s.live && s.windowId) {
            lines.push(`${ESC}[${y};${slotX(2)}H${ESC}[38;5;203m✕${ESC}[0m`);
          }
        }
      }
    }

    // Last row: agent health. A broken binary is the difference between
    // "this tab is broken" and "you cannot open any tab", so it is worth a line.
    if (health && !health.ok) {
      const msg = truncate(
        `⚠ ${P().agentName} unusable — ${health.problem ?? "unknown"}`,
        cols - 2,
      );
      lines.push(
        `${ESC}[${rows};1H${ESC}[48;5;52m${ESC}[38;5;210m ${padEnd(msg, cols - 1)}${ESC}[0m`,
      );
    }

    write(lines.join(""));
  }

  function activateRight(idx: number) {
    const rrows = rightRows();
    const row = rrows[idx];
    if (!row) return;
    // Bin rows act only through their buttons.
    if (row.kind === "binned") return;
    const proj = projects[selectedProject];
    if (!proj) return;
    if (row.kind === "new") {
      void actions.newSession(proj.directory).then(refresh).catch(() => {});
    } else if (row.kind === "blank") {
      void actions.blankTab(proj.directory).then(refresh).catch(() => {});
    } else {
      void actions.openSession(row.s).then(refresh).catch(() => {});
    }
  }

  /** Arm the red button; a second click within the window is what deletes. */
  function armPurge(id: string) {
    confirmPurge = id;
    render();
    setTimeout(() => {
      if (confirmPurge === id) {
        confirmPurge = null;
        render();
      }
    }, 4000);
  }

  function hitTest(x: number, y: number): void {
    if (y === exitRegion.y && x >= exitRegion.x0 && x <= exitRegion.x1) {
      if (confirmExit) {
        void actions.exitAll().catch(() => {});
      } else {
        confirmExit = true;
        render();
        setTimeout(() => {
          if (confirmExit) {
            confirmExit = false;
            render();
          }
        }, 4000);
      }
      return;
    }
    if (confirmExit) {
      confirmExit = false;
      render();
    }
    if (y === detachRegion.y && x >= detachRegion.x0 && x <= detachRegion.x1) {
      void actions.detach().catch(() => {});
      return;
    }
    const hits = rowHits.get(y);
    if (hits) {
      if ((x === slotX(2) || x === cols) && hits.close) {
        void actions.closeSession(hits.close).then(refresh).catch(() => {});
        return;
      }
      if (x === slotX(1)) {
        if (hits.purgeBin) {
          if (confirmPurge === hits.purgeBin.id) {
            confirmPurge = null;
            void actions.purgeFromBin(hits.purgeBin).then(refresh).catch(() => {});
          } else {
            armPurge(hits.purgeBin.id);
          }
          return;
        }
        if (hits.purge) {
          if (confirmPurge === hits.purge.id) {
            confirmPurge = null;
            void actions.purge(hits.purge).then(refresh).catch(() => {});
          } else {
            armPurge(hits.purge.id);
          }
          return;
        }
      }
      if (x === slotX(0)) {
        if (hits.restore) {
          void actions.restore(hits.restore).then(refresh).catch(() => {});
          return;
        }
        if (hits.recycle) {
          void actions.recycle(hits.recycle).then(refresh).catch(() => {});
          return;
        }
      }
    }
    if (confirmPurge) {
      confirmPurge = null;
      render();
    }
    if (
      x >= leftRegion.x0 &&
      x <= leftRegion.x1 &&
      y >= leftRegion.y0 &&
      y <= leftRegion.y1
    ) {
      const idx = y - leftRegion.y0 + leftScroll;
      if (idx >= 0 && idx < leftRows().length) {
        focus = "left";
        selectedProject = idx;
        selectedRow = 0;
        rightScroll = 0;
        render();
      }
      return;
    }
    if (
      x >= rightRegion.x0 &&
      x <= rightRegion.x1 &&
      y >= rightRegion.y0 &&
      y <= rightRegion.y1
    ) {
      const idx = y - rightRegion.y0 + rightScroll;
      if (idx >= 0 && idx < rightRows().length) {
        focus = "right";
        selectedRow = idx;
        render();
        activateRight(idx);
      }
    }
  }

  function onWheel(x: number, up: boolean) {
    const step = 3;
    const overLeft = x <= leftColW;
    if (overLeft) {
      leftScroll += up ? -step : step;
    } else {
      rightScroll += up ? -step : step;
    }
    render();
  }

  function ensureVisible() {
    const leftVisible = leftRegion.y1 - leftRegion.y0 + 1;
    const rightVisible = rightRegion.y1 - rightRegion.y0 + 1;
    if (focus === "left") {
      if (selectedProject < leftScroll) leftScroll = selectedProject;
      if (selectedProject >= leftScroll + leftVisible)
        leftScroll = selectedProject - leftVisible + 1;
    } else {
      if (selectedRow < rightScroll) rightScroll = selectedRow;
      if (selectedRow >= rightScroll + rightVisible)
        rightScroll = selectedRow - rightVisible + 1;
    }
  }

  function moveVert(delta: number) {
    if (focus === "left") {
      const n = leftRows().length;
      if (n === 0) return;
      selectedProject = Math.max(0, Math.min(n - 1, selectedProject + delta));
      selectedRow = 0;
      rightScroll = 0;
    } else {
      const n = rightRows().length;
      if (n === 0) return;
      selectedRow = Math.max(0, Math.min(n - 1, selectedRow + delta));
    }
    ensureVisible();
    render();
  }

  function setFocus(f: "left" | "right") {
    if (f === "right" && rightRows().length === 0) return;
    focus = f;
    if (f === "right" && selectedRow === 0) selectedRow = 0;
    ensureVisible();
    render();
  }

  function onKey(seq: string): boolean {
    if (seq === "q" || seq === "\x03") {
      void actions.detach().catch(() => {});
      return true;
    }
    if (seq === "\x1b[A" || seq === "k") {
      moveVert(-1);
      return true;
    }
    if (seq === "\x1b[B" || seq === "j") {
      moveVert(1);
      return true;
    }
    if (seq === "\x1b[D" || seq === "h") {
      setFocus("left");
      return true;
    }
    if (seq === "\x1b[C" || seq === "l") {
      if (focus === "left") setFocus("right");
      return true;
    }
    if (seq === "\r" || seq === "\n") {
      if (focus === "left") setFocus("right");
      else activateRight(selectedRow);
      return true;
    }
    return false;
  }

  async function refresh() {
    projects = await actions.loadProjects();
    bin = await actions.loadBin();
    if (selectedProject >= leftRows().length) selectedProject = 0;
    if (selectedRow >= rightRows().length) selectedRow = 0;
    render();
  }

  let buf = "";
  function feed(chunk: Buffer | string) {
    buf += chunk.toString("binary");
    let m: RegExpExecArray | null;
    const sgr = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
    let lastIndex = 0;
    while ((m = sgr.exec(buf)) !== null) {
      lastIndex = sgr.lastIndex;
      const b = Number(m[1]);
      const x = Number(m[2]);
      const y = Number(m[3]);
      const press = m[4] === "M";
      if (b === 64) {
        onWheel(x, true);
      } else if (b === 65) {
        onWheel(x, false);
      } else if ((b & 0x43) === 0 && press) {
        hitTest(x, y);
      }
    }
    buf = buf.slice(lastIndex);

    const arrowRe = /\x1b\[[ABCD]/;
    const arrowMatch = buf.match(arrowRe);
    if (arrowMatch) {
      const seq = arrowMatch[0];
      onKey(seq);
      buf = buf.slice(buf.indexOf(seq) + seq.length);
    }

    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];
      if (ch === "q" || ch === "\x03" || ch === "\r" || ch === "\n" || ch === "h" || ch === "j" || ch === "k" || ch === "l") {
        onKey(ch);
        buf = buf.slice(i + 1);
        break;
      }
    }

    if (buf.length > 32) buf = buf.slice(-16);
  }

  computeLayout();
  if (inp.isTTY) inp.setRawMode(true);
  inp.resume();
  write(ENTER);

  process.on("exit", teardown);
  const onResize = () => render();
  out.on("resize", onResize);

  await refresh();

  const recheckHealth = async () => {
    if (!actions.checkHealth) return;
    try {
      health = await actions.checkHealth();
    } catch (err) {
      health = {
        ok: false,
        problem: err instanceof Error ? err.message : String(err),
      };
    }
    render();
  };
  void recheckHealth();

  const refreshInterval = setInterval(() => {
    void refresh();
    void recheckHealth();
  }, 5000);

  inp.on("data", feed);

  await new Promise<never>(() => {});
}

function makeFakeActions(): DashboardActions {
  const now = Date.now();
  const bigSessions: SessionView[] = [];
  for (let i = 0; i < 30; i++) {
    bigSessions.push({
      id: `ses_fake${i}`,
      title: `session number ${i} doing some long task description here`,
      updated: now - i * 3600_000,
      created: now - i * 7200_000,
      projectId: "global",
      directory: "/home/user/big-project",
      live: i % 5 === 0,
      windowIndex: i % 5 === 0 ? i : undefined,
    });
  }
  const projects: ProjectView[] = [
    {
      directory: "/home/user/big-project",
      label: "big-project",
      sessions: bigSessions,
      liveCount: bigSessions.filter((s) => s.live).length,
    },
    {
      directory: "/home/user/alpha",
      label: "alpha",
      sessions: [
        {
          id: "ses_a1",
          title: "fix login bug",
          updated: now - 120_000,
          created: now - 200_000,
          projectId: "global",
          directory: "/home/user/alpha",
          live: true,
          windowIndex: 1,
        },
      ],
      liveCount: 1,
    },
    {
      directory: "/home/user/beta",
      label: "beta",
      sessions: [
        {
          id: "ses_b1",
          title: "write docs",
          updated: now - 86400_000,
          created: now - 90000_000,
          projectId: "global",
          directory: "/home/user/beta",
          live: false,
        },
      ],
      liveCount: 0,
    },
  ];
  return {
    loadProjects: async () => projects,
    openSession: async (s) => {
      await Bun.write(
        "/tmp/topencode-dash-test.log",
        `open ${s.id} ${new Date().toISOString()}\n`,
      );
    },
    newSession: async (dir) => {
      await Bun.write(
        "/tmp/topencode-dash-test.log",
        `new ${dir} ${new Date().toISOString()}\n`,
      );
    },
    closeSession: async (wid) => {
      await Bun.write(
        "/tmp/topencode-dash-test.log",
        `close ${wid} ${new Date().toISOString()}\n`,
      );
    },
    detach: async () => {
      await Bun.write(
        "/tmp/topencode-dash-test.log",
        `detach ${new Date().toISOString()}\n`,
      );
      process.exit(0);
    },
    exitAll: async () => {
      await Bun.write(
        "/tmp/topencode-dash-test.log",
        `exitAll ${new Date().toISOString()}\n`,
      );
      process.exit(0);
    },
    blankTab: async (dir) => {
      await Bun.write(
        "/tmp/topencode-dash-test.log",
        `blankTab ${dir} ${new Date().toISOString()}\n`,
      );
    },
    loadBin: async () => [],
    recycle: async (s) => {
      await Bun.write(
        "/tmp/topencode-dash-test.log",
        `recycle ${s.id} ${new Date().toISOString()}\n`,
      );
    },
    purge: async (s) => {
      await Bun.write(
        "/tmp/topencode-dash-test.log",
        `purge ${s.id} ${new Date().toISOString()}\n`,
      );
    },
    restore: async (e) => {
      await Bun.write(
        "/tmp/topencode-dash-test.log",
        `restore ${e.id} ${new Date().toISOString()}\n`,
      );
    },
    purgeFromBin: async (e) => {
      await Bun.write(
        "/tmp/topencode-dash-test.log",
        `purgeFromBin ${e.id} ${new Date().toISOString()}\n`,
      );
    },
  };
}

if (import.meta.main) {
  runDashboard(makeFakeActions()).then(() => process.exit(0));
}
