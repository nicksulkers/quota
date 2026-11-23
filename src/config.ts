import { readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ClaudeAccountConfig, Config } from "./types";
import { HOME, expandHome } from "./util";

export const CONFIG_PATH = process.env.QUOTA_CONFIG ?? join(HOME, ".config", "quota", "config.json");

/** Claude config dirs: ~/.claude, any ~/.claude_* / ~/.claude-* dir that has a login, and $CLAUDE_CONFIG_DIR. */
function discoverClaude(): ClaudeAccountConfig[] {
  const dirs = new Set<string>();
  const hasLogin = (d: string) => existsSync(join(d, ".credentials.json"));
  const def = join(HOME, ".claude");
  if (hasLogin(def)) dirs.add(def);
  for (const entry of readdirSync(HOME, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\.claude[_-]/.test(entry.name) && hasLogin(join(HOME, entry.name))) {
      dirs.add(join(HOME, entry.name));
    }
  }
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && hasLogin(env)) dirs.add(resolve(env));
  return [...dirs].map((d) => ({ configDir: d, label: d === def ? "default" : d.slice(HOME.length + 1) }));
}

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(CONFIG_PATH);
  const cfg: Config = (await file.exists()) ? await file.json() : {};
  if (cfg.claude === undefined) cfg.claude = discoverClaude();
  else if (cfg.claude) cfg.claude = cfg.claude.map((c) => ({ ...c, configDir: expandHome(c.configDir) }));
  return cfg;
}
