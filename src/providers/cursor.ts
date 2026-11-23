import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { AccountUsage } from "../types";
import { HOME, errorMessage, money, titleCase } from "../util";

/**
 * Neither the Cursor app nor `cursor-agent` has a command that prints usage,
 * so this reads the Cursor app's session from its local state database
 * (read-only) and calls the endpoint behind cursor.com/dashboard.
 */

const SUMMARY_URL = "https://cursor.com/api/usage-summary";

interface Bucket { enabled?: boolean; used?: number; limit?: number | null; remaining?: number | null }

interface UsageSummary {
  billingCycleEnd?: string;
  membershipType?: string;
  isUnlimited?: boolean;
  individualUsage?: {
    plan?: Bucket & {
      breakdown?: { included?: number; bonus?: number; total?: number };
      autoPercentUsed?: number;
      apiPercentUsed?: number;
      totalPercentUsed?: number;
    };
    onDemand?: Bucket;
  };
  teamUsage?: { onDemand?: Bucket };
}

function stateDbPath(): string {
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(HOME, "AppData/Roaming"), "Cursor/User/globalStorage/state.vscdb");
  if (process.platform === "darwin") return join(HOME, "Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  return join(process.env.XDG_CONFIG_HOME ?? join(HOME, ".config"), "Cursor/User/globalStorage/state.vscdb");
}

function readSession(): { token: string; email?: string; membership?: string } | undefined {
  let db: Database | undefined;
  try {
    db = new Database(stateDbPath(), { readonly: true });
    const rows = db
      .query<{ key: string; value: string }, []>("SELECT key, value FROM ItemTable WHERE key LIKE 'cursorAuth/%'")
      .all();
    const kv = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    const token = kv["cursorAuth/accessToken"];
    if (!token) return undefined;
    return { token, email: kv["cursorAuth/cachedEmail"], membership: kv["cursorAuth/stripeMembershipType"] };
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

function jwtPayload(token: string): { sub?: string; exp?: number } {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

const cents = (n?: number | null) => money((n ?? 0) / 100);

export async function fetchCursor(label = "Cursor"): Promise<AccountUsage> {
  const result: AccountUsage = {
    provider: "cursor",
    name: label,
    meters: [],
    notes: [],
    source: "Cursor app session + cursor.com usage API",
  };

  const session = readSession();
  if (!session) {
    result.error = "No Cursor app login found. Sign in to the Cursor editor once.";
    return result;
  }
  result.email = session.email;
  result.plan = session.membership ? titleCase(session.membership) : undefined;

  try {
    const { sub, exp } = jwtPayload(session.token);
    if (exp && exp * 1000 < Date.now()) {
      result.error = "Cursor login expired. Open the Cursor editor to refresh it.";
      return result;
    }
    const userId = sub?.split("|").pop();
    if (!userId) throw new Error("Unexpected Cursor token format");

    const res = await fetch(SUMMARY_URL, {
      headers: {
        Cookie: `WorkosCursorSessionToken=${userId}%3A%3A${session.token}`,
        "User-Agent": "Mozilla/5.0 quota-cli",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      result.error = "Cursor rejected the session. Open the Cursor editor to refresh it.";
      return result;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const u = (await res.json()) as UsageSummary;

    if (u.membershipType) result.plan = titleCase(u.membershipType);
    const resetsAt = u.billingCycleEnd ? new Date(u.billingCycleEnd) : undefined;
    const plan = u.individualUsage?.plan;

    if (u.isUnlimited) result.notes.push("Unlimited plan");
    if (plan) {
      result.meters.push({
        label: "Included (total)",
        percent: plan.totalPercentUsed ?? (plan.limit ? ((plan.used ?? 0) / plan.limit) * 100 : null),
        resetsAt,
        detail: plan.limit != null ? `${cents(plan.used)} / ${cents(plan.limit)}` : undefined,
      });
      if (plan.autoPercentUsed != null) result.meters.push({ label: "Auto + Composer", percent: plan.autoPercentUsed, resetsAt });
      if (plan.apiPercentUsed != null) result.meters.push({ label: "API models", percent: plan.apiPercentUsed, resetsAt });
      const bonus = plan.breakdown?.bonus ?? 0;
      if (bonus > 0) result.notes.push(`Bonus usage on top of plan: ${cents(bonus)}`);
    }

    const od = u.individualUsage?.onDemand;
    if (od?.enabled) {
      result.meters.push({
        label: "On-demand",
        percent: od.limit ? ((od.used ?? 0) / od.limit) * 100 : null,
        resetsAt,
        detail: od.limit != null ? `${cents(od.used)} / ${cents(od.limit)}` : `${cents(od.used)} (no limit)`,
      });
    } else if (od) {
      result.notes.push("On-demand usage: off");
    }
    const team = u.teamUsage?.onDemand;
    if (team?.enabled) result.notes.push(`Team on-demand: ${cents(team.used)}${team.limit != null ? ` / ${cents(team.limit)}` : ""}`);
  } catch (e) {
    result.error = errorMessage(e);
  }
  return result;
}
