/** One usage meter, e.g. "Session (5h)" at 42%. */
export interface Meter {
  label: string;
  /** 0-100, or null when only an amount is known. */
  percent: number | null;
  /** Reset time, if the window has one. */
  resetsAt?: Date;
  /** Extra text shown after the bar, e.g. "$12.00 / $20.00". */
  detail?: string;
}

export interface AccountUsage {
  provider: "claude" | "codex" | "cursor";
  /** Display name, e.g. "Claude · Work". */
  name: string;
  plan?: string;
  email?: string;
  meters: Meter[];
  /** Short notes shown under the meters (extra usage, credits, warnings). */
  notes: string[];
  /** Where the data came from, e.g. "codex app-server". */
  source: string;
  error?: string;
}

export interface ClaudeAccountConfig {
  label?: string;
  /** Claude Code config dir; "~" is expanded. Default account is "~/.claude". */
  configDir: string;
}

export interface Config {
  claude?: ClaudeAccountConfig[] | false;
  codex?: { label?: string } | false;
  cursor?: { label?: string } | false;
}
