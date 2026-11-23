import type { AccountUsage, Meter } from "./types";

export interface RenderOptions {
  color: boolean;
  unicode: boolean;
  showEmail: boolean;
  verbose: boolean;
}

const BAR_WIDTH = 20;

function paint(opts: RenderOptions) {
  const wrap = (code: string) => (s: string) => (opts.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { bold: wrap("1"), dim: wrap("2"), red: wrap("31"), green: wrap("32"), yellow: wrap("33"), cyan: wrap("36") };
}

export function relative(to: Date, now = new Date()): string {
  const mins = Math.round((to.getTime() - now.getTime()) / 60_000);
  if (mins <= 0) return "now";
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

function absolute(exact: Date, now = new Date()): string {
  // Reset timestamps jitter by a second between calls (e.g. 02:59:59.9); round to the minute.
  const to = new Date(Math.round(exact.getTime() / 60_000) * 60_000);
  const time = to.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const sameDay = to.toDateString() === now.toDateString();
  if (sameDay) return time;
  const days = (to.getTime() - now.getTime()) / 86_400_000;
  const day = days < 6.5
    ? to.toLocaleDateString("en-GB", { weekday: "short" })
    : to.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `${day} ${time}`;
}

function bar(pct: number, opts: RenderOptions): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * BAR_WIDTH);
  const [full, empty] = opts.unicode ? ["█", "░"] : ["#", "-"];
  const c = paint(opts);
  const tint = pct >= 90 ? c.red : pct >= 70 ? c.yellow : c.green;
  return tint(full.repeat(filled)) + c.dim(empty.repeat(BAR_WIDTH - filled));
}

function meterLine(m: Meter, labelWidth: number, opts: RenderOptions): string {
  const c = paint(opts);
  const parts = [`  ${m.label.padEnd(labelWidth)}`];
  if (m.percent != null) {
    const pct = `${Math.round(m.percent)}%`.padStart(4);
    parts.push(bar(m.percent, opts), m.percent >= 100 ? c.red(pct) : pct);
  }
  if (m.detail) parts.push(m.detail);
  if (m.resetsAt) parts.push(c.dim(`resets in ${relative(m.resetsAt)} (${absolute(m.resetsAt)})`));
  return parts.join("  ");
}

export function render(accounts: AccountUsage[], opts: RenderOptions): string {
  const c = paint(opts);
  const labelWidth = Math.max(14, ...accounts.flatMap((a) => a.meters.map((m) => m.label.length)));
  const blocks = accounts.map((a) => {
    const meta = [a.plan, opts.showEmail ? a.email : undefined].filter(Boolean).join(" · ");
    const lines = [c.bold(c.cyan(a.name)) + (meta ? `  ${c.dim(meta)}` : "")];
    if (a.error) lines.push(`  ${c.red(`${opts.unicode ? "✗" : "x"} ${a.error}`)}`);
    for (const m of a.meters) lines.push(meterLine(m, labelWidth, opts));
    for (const n of a.notes) lines.push(`  ${c.dim(n)}`);
    if (!a.error && !a.meters.length && !a.notes.length) lines.push(`  ${c.dim("No limits reported")}`);
    if (opts.verbose) lines.push(`  ${c.dim(`source: ${a.source}`)}`);
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}
