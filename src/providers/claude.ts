import { join, resolve } from "node:path";
import type { AccountUsage, ClaudeAccountConfig, Meter } from "../types";
import { HOME, errorMessage, expandHome, money, run, titleCase } from "../util";

/**
 * Claude Code has no non-interactive usage command (`claude -p /usage` is sent
 * to the model as a prompt), so limits come from the same OAuth endpoint the
 * CLI's /usage screen calls. Identity and plan come from `claude auth status`.
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const DEFAULT_DIR = join(HOME, ".claude");

interface OAuthCreds {
  accessToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface AuthStatus {
  loggedIn?: boolean;
  email?: string;
  orgName?: string;
  subscriptionType?: string;
}

interface Money { amount_minor: number; currency: string; exponent: number }

interface Limit {
  kind: string;
  percent: number;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null; surface?: unknown } | null;
}

interface Window { utilization: number; resets_at?: string | null }

interface UsageResponse {
  limits?: Limit[] | null;
  five_hour?: Window | null;
  seven_day?: Window | null;
  seven_day_opus?: Window | null;
  seven_day_sonnet?: Window | null;
  spend?: {
    used?: Money | null;
    limit?: Money | null;
    enabled?: boolean;
    disabled_reason?: string | null;
    percent?: number;
  } | null;
}

async function readCreds(dir: string): Promise<OAuthCreds | undefined> {
  const file = Bun.file(join(dir, ".credentials.json"));
  if (!(await file.exists())) return undefined;
  return (await file.json())?.claudeAiOauth;
}

async function authStatus(dir: string): Promise<AuthStatus | undefined> {
  // The default account must run without CLAUDE_CONFIG_DIR: with it set, the CLI
  // looks for .claude.json inside the dir instead of at ~/.claude.json.
  const env = { ...process.env };
  if (resolve(dir) === resolve(DEFAULT_DIR)) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = dir;
  try {
    const out = await run(["claude", "auth", "status", "--json"], { env, timeoutMs: 15_000 });
    return JSON.parse(out.slice(out.indexOf("{")));
  } catch {
    return undefined; // identity is nice to have; usage still works without it
  }
}

function planName(sub?: string, tier?: string): string | undefined {
  if (!sub) return undefined;
  const mult = tier?.match(/_(\d+x)$/)?.[1];
  return titleCase(sub) + (mult ? ` ${mult}` : "");
}

function limitLabel(l: Limit): string {
  if (l.kind === "session") return "Session (5h)";
  if (l.kind === "weekly_all") return "Weekly";
  if (l.kind === "weekly_scoped") {
    const model = l.scope?.model?.display_name;
    const surface = l.scope?.surface;
    const name = model ?? (typeof surface === "string" ? surface : (surface as any)?.display_name);
    return name ? `Weekly · ${name}` : "Weekly (scoped)";
  }
  return titleCase(l.kind);
}

const date = (s?: string | null) => (s ? new Date(s) : undefined);

function meters(u: UsageResponse): Meter[] {
  if (u.limits?.length) {
    return u.limits.map((l) => ({ label: limitLabel(l), percent: l.percent, resetsAt: date(l.resets_at) }));
  }
  // Older response shape.
  const legacy: [keyof UsageResponse, string][] = [
    ["five_hour", "Session (5h)"],
    ["seven_day", "Weekly"],
    ["seven_day_opus", "Weekly · Opus"],
    ["seven_day_sonnet", "Weekly · Sonnet"],
  ];
  return legacy.flatMap(([key, label]) => {
    const w = u[key] as Window | null | undefined;
    return w ? [{ label, percent: w.utilization, resetsAt: date(w.resets_at) }] : [];
  });
}

const amount = (m: Money) => money(m.amount_minor / 10 ** m.exponent, m.currency);

export async function fetchClaude(acct: ClaudeAccountConfig): Promise<AccountUsage> {
  const dir = expandHome(acct.configDir);
  const result: AccountUsage = {
    provider: "claude",
    name: `Claude · ${acct.label ?? dir.replace(HOME, "~")}`,
    meters: [],
    notes: [],
    source: "claude auth status + OAuth usage API",
  };

  const [creds, status] = await Promise.all([readCreds(dir).catch(() => undefined), authStatus(dir)]);
  result.plan = planName(status?.subscriptionType ?? creds?.subscriptionType, creds?.rateLimitTier);
  result.email = status?.email;

  if (!creds?.accessToken) {
    result.error = `Not logged in (no ${join(dir, ".credentials.json")})`;
    return result;
  }
  if (creds.expiresAt && creds.expiresAt < Date.now()) {
    result.error = "Login expired. Start `claude` with this account once to refresh it.";
    return result;
  }

  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${creds.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401) {
      result.error = "Token rejected. Start `claude` with this account once to refresh it.";
      return result;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const usage = (await res.json()) as UsageResponse;
    result.meters = meters(usage);

    const s = usage.spend;
    if (s?.used && s.limit) {
      const text = `${amount(s.used)} / ${amount(s.limit)}`;
      if (s.enabled) result.meters.push({ label: "Extra usage", percent: s.percent ?? null, detail: text });
      else result.notes.push(`Extra usage off${s.disabled_reason ? ` (${s.disabled_reason.replace(/_/g, " ")})` : ""}: ${text}`);
    }
  } catch (e) {
    result.error = errorMessage(e);
  }
  return result;
}
