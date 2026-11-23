#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { CONFIG_PATH, loadConfig } from "./config";
import { fetchClaude } from "./providers/claude";
import { fetchCodex } from "./providers/codex";
import { fetchCursor } from "./providers/cursor";
import { render } from "./render";
import type { AccountUsage } from "./types";

const VERSION = "0.1.0";

const HELP = `quota ${VERSION} - usage and limits for your Claude, Codex and Cursor subscriptions

Usage: quota [filter...] [options]

Filters match a provider (claude, codex, cursor) or part of an account label,
e.g. \`quota work\` or \`quota codex cursor\`.

Options:
  --json        Print raw results as JSON
  --plain       No color, ASCII bars (also used automatically when piped)
  --no-color    Keep unicode bars, drop color
  --no-email    Hide account emails
  -v, --verbose Show where each number came from
  -h, --help    Show this help
  --version     Show version

Config: ${CONFIG_PATH}
  {
    "claude": [
      { "label": "Work",     "configDir": "~/.claude" },
      { "label": "Personal", "configDir": "~/.claude_ns1" }
    ],
    "codex":  { "label": "Codex" },
    "cursor": { "label": "Cursor" }
  }
  Set a provider to false to skip it. Without "claude", every ~/.claude* dir
  that has a login is picked up automatically.`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "boolean" },
    plain: { type: "boolean" },
    "no-color": { type: "boolean" },
    "no-email": { type: "boolean" },
    verbose: { type: "boolean", short: "v" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean" },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}
if (values.version) {
  console.log(VERSION);
  process.exit(0);
}

const cfg = await loadConfig();
const filters = positionals.map((p) => p.toLowerCase());

type Job = { provider: string; label: string; run: () => Promise<AccountUsage> };
const jobs: Job[] = [];
for (const acct of cfg.claude || []) {
  jobs.push({ provider: "claude", label: acct.label ?? acct.configDir, run: () => fetchClaude(acct) });
}
if (cfg.codex !== false) {
  const label = cfg.codex?.label ?? "Codex";
  jobs.push({ provider: "codex", label, run: () => fetchCodex(label) });
}
if (cfg.cursor !== false) {
  const label = cfg.cursor?.label ?? "Cursor";
  jobs.push({ provider: "cursor", label, run: () => fetchCursor(label) });
}

const selected = filters.length
  ? jobs.filter((j) => filters.some((f) => j.provider === f || j.label.toLowerCase().includes(f)))
  : jobs;
if (!selected.length) {
  console.error(`No accounts match: ${positionals.join(" ")}`);
  process.exit(2);
}

const tty = process.stdout.isTTY && !values.json;
if (tty) process.stderr.write("Fetching usage…\r");
const results = await Promise.all(selected.map((j) => j.run()));
if (tty) process.stderr.write("\x1b[2K\r");

if (values.json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const plain = values.plain || !process.stdout.isTTY;
  console.log(
    render(results, {
      color: !plain && !values["no-color"] && !process.env.NO_COLOR,
      unicode: !plain,
      showEmail: !values["no-email"],
      verbose: !!values.verbose,
    }),
  );
}
process.exit(results.some((r) => r.error) ? 1 : 0);
