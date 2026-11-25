import type { AccountUsage, Meter } from "../types";
import { errorMessage, titleCase, withTimeout } from "../util";

/**
 * Reads limits from the Codex CLI itself: `codex app-server` speaks JSON-RPC
 * over stdio and exposes `account/read` and `account/rateLimits/read`, the
 * same calls the Codex TUI and desktop app use. Token refresh is handled by
 * Codex, so this never touches ~/.codex/auth.json.
 */

interface RateLimitWindow { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }

interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  planType: string | null;
}

interface RateLimitsResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot | undefined> | null;
  rateLimitResetCredits: { availableCount: number } | null;
}

interface AccountResponse {
  account: { type: string; email?: string | null; planType?: string; workspaceName?: string | null } | null;
}

const PLAN_NAMES: Record<string, string> = { prolite: "Pro Lite", plus: "Plus", pro: "Pro", free: "Free", team: "Team" };

class AppServer {
  private proc = Bun.spawn(["codex", "app-server"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor() {
    this.readLoop();
    this.proc.exited.then((code) => {
      for (const p of this.pending.values()) p.reject(new Error(`codex app-server exited (${code})`));
      this.pending.clear();
    });
  }

  private async readLoop() {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of this.proc.stdout) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
        if (!p || !("result" in msg || "error" in msg)) continue; // notifications, server requests
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  }

  private write(msg: object) {
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
    this.proc.stdin.flush();
  }

  request<T>(method: string, params?: object): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string) {
    this.write({ method });
  }

  close() {
    this.proc.kill();
  }
}

function windowLabel(w: RateLimitWindow): string {
  const m = w.windowDurationMins;
  if (!m) return "Limit";
  if (m === 10080) return "Weekly";
  if (m % 1440 === 0) return `${m / 1440}d`;
  if (m % 60 === 0) return `Session (${m / 60}h)`;
  return `${m}m`;
}

function snapshotMeters(s: RateLimitSnapshot): Meter[] {
  const prefix = s.limitId && s.limitId !== "codex" ? `${s.limitName ?? s.limitId} · ` : "";
  return [s.primary, s.secondary]
    .filter((w): w is RateLimitWindow => !!w)
    .map((w) => {
      const resetsAt = w.resetsAt ? new Date(w.resetsAt * 1000) : undefined;
      const windowStart = resetsAt && w.windowDurationMins ? new Date(resetsAt.getTime() - w.windowDurationMins * 60_000) : undefined;
      return { label: prefix + windowLabel(w), percent: w.usedPercent, resetsAt, windowStart };
    });
}

export async function fetchCodex(label = "Codex"): Promise<AccountUsage> {
  const result: AccountUsage = { provider: "codex", name: label, meters: [], notes: [], source: "codex app-server" };
  let server: AppServer | undefined;
  try {
    server = new AppServer();
    const s = server;
    await withTimeout(
      (async () => {
        await s.request("initialize", {
          clientInfo: { name: "quota", title: "quota", version: "0.1.0" },
          capabilities: { experimentalApi: false, requestAttestation: false },
        });
        s.notify("initialized");
        const [acct, limits] = await Promise.all([
          s.request<AccountResponse>("account/read", {}),
          s.request<RateLimitsResponse>("account/rateLimits/read", { excludeResetCreditDetails: true }),
        ]);

        const a = acct.account;
        if (!a) throw new Error("Not logged in. Run `codex login`.");
        if (a.type !== "chatgpt") result.notes.push(`Signed in with ${a.type}; plan limits only apply to ChatGPT sign-in.`);
        result.email = a.email ?? undefined;
        const plan = a.planType ?? limits.rateLimits.planType ?? undefined;
        result.plan = plan ? (PLAN_NAMES[plan] ?? titleCase(plan)) : undefined;
        if (a.workspaceName) result.plan = `${result.plan ?? ""} (${a.workspaceName})`.trim();

        const snapshots = Object.values(limits.rateLimitsByLimitId ?? {}).filter((x): x is RateLimitSnapshot => !!x);
        for (const snap of snapshots.length ? snapshots : [limits.rateLimits]) {
          result.meters.push(...snapshotMeters(snap));
          const c = snap.credits;
          if (c?.unlimited) result.notes.push("Credits: unlimited");
          else if (c?.hasCredits && c.balance) result.notes.push(`Credits balance: ${c.balance}`);
        }
        const resets = limits.rateLimitResetCredits?.availableCount ?? 0;
        if (resets > 0) result.notes.push(`${resets} rate-limit reset${resets > 1 ? "s" : ""} available (use from Codex)`);
      })(),
      30_000,
      "codex app-server",
    );
  } catch (e) {
    const msg = errorMessage(e);
    result.error = /ENOENT|not found|executable/i.test(msg) ? "`codex` CLI not found on PATH" : msg;
  } finally {
    server?.close();
  }
  return result;
}
