/** Terminal-width-aware text helpers shared by the dashboard and the CLI. */

export function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
        ? 2
        : 1;
  }
  return w;
}

export function padW(s: string, width: number): string {
  const w = strWidth(s);
  if (w >= width) return truncW(s, width);
  return s + " ".repeat(width - w);
}

export function truncW(s: string, width: number): string {
  if (width <= 0) return "";
  if (strWidth(s) <= width) return s;
  let acc = "";
  let w = 0;
  for (const ch of s) {
    const cw = strWidth(ch);
    if (w + cw > width - 1) break;
    acc += ch;
    w += cw;
  }
  return acc + "…";
}

export function fmtAge(ms: number | null): string {
  if (ms === null) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)}K`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}M`;
  return `${(n / 1024 ** 3).toFixed(2)}G`;
}
