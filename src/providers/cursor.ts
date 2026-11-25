import type { Pointer } from "bun:ffi";
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountUsage } from "../types";
import { HOME, errorMessage, money, titleCase } from "../util";

/**
 * Neither the Cursor app nor the `agent` CLI has a command that prints usage.
 *
 * - Editor login (preferred): read from the Cursor app's state database
 *   (read-only), then the endpoint behind cursor.com/dashboard.
 * - CLI login (fallback): read from the `agent` CLI's token store, then the
 *   DashboardService endpoints on api2.cursor.sh. cursor.com/api/usage-summary
 *   rejects CLI tokens, but api2 accepts them.
 */

const SUMMARY_URL = "https://cursor.com/api/usage-summary";
const DASHBOARD_API = "https://api2.cursor.sh/aiserver.v1.DashboardService";

const cents = (n?: number | null) => money((n ?? 0) / 100);

function jwtPayload(token: string): { sub?: string; exp?: number } {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function tokenExpired(token: string): boolean {
  try {
    const { exp } = jwtPayload(token);
    return !!exp && exp * 1000 < Date.now();
  } catch {
    return false;
  }
}

// ==== Editor login: state.vscdb + cursor.com/api/usage-summary ============

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

function readEditorSession(): { token: string; email?: string; membership?: string } | undefined {
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

async function fetchViaEditor(
  session: { token: string; email?: string; membership?: string },
  result: AccountUsage,
): Promise<AccountUsage> {
  result.source = "Cursor app session + cursor.com usage API";
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

// ==== CLI login: auth.dpapi / auth.json + api2.cursor.sh DashboardService ====

interface PeriodUsage {
  billingCycleEnd?: string;
  planUsage?: {
    totalSpend?: number;
    includedSpend?: number;
    bonusSpend?: number;
    limit?: number;
    autoPercentUsed?: number;
    apiPercentUsed?: number;
    totalPercentUsed?: number;
  };
  spendLimitUsage?: {
    limitType?: string;
    individualLimit?: number;
    individualUsed?: number;
    pooledLimit?: number;
    pooledUsed?: number;
  };
}

interface PlanInfo { planInfo?: { planName?: string } }

interface LimitStatus { usageLimitPolicyStatus?: { isInSlowPool?: boolean; trayLabel?: string } }

/** Decrypts a Windows DPAPI blob for the current user via crypt32!CryptUnprotectData. */
async function dpapiUnprotect(data: Uint8Array): Promise<Uint8Array> {
  const { dlopen, FFIType, ptr, toArrayBuffer, read } = await import("bun:ffi");
  const crypt32 = dlopen("crypt32.dll", {
    CryptUnprotectData: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
  });
  const kernel32 = dlopen("kernel32.dll", { LocalFree: { args: [FFIType.ptr], returns: FFIType.ptr } });
  try {
    // DATA_BLOB on x64: { DWORD cbData; (4 bytes padding); BYTE* pbData }
    const input = new BigUint64Array(2);
    const view = new DataView(input.buffer);
    view.setUint32(0, data.length, true);
    view.setBigUint64(8, BigInt(ptr(data)), true);
    const output = new BigUint64Array(2);
    const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
    if (!crypt32.symbols.CryptUnprotectData(ptr(input), null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, ptr(output))) {
      throw new Error("CryptUnprotectData failed");
    }
    const outPtr = ptr(output);
    const len = read.u32(outPtr, 0);
    const dataPtr = read.ptr(outPtr, 8) as Pointer;
    const copy = new Uint8Array(toArrayBuffer(dataPtr, 0, len)).slice();
    kernel32.symbols.LocalFree(dataPtr);
    return copy;
  } finally {
    crypt32.close();
    kernel32.close();
  }
}

async function readCliSession(): Promise<{ token: string; email?: string } | undefined> {
  try {
    let creds: { accessToken?: string } | undefined;
    if (process.platform === "win32") {
      const path = join(process.env.APPDATA ?? join(HOME, "AppData/Roaming"), "cursor/auth.dpapi");
      if (!existsSync(path)) return undefined;
      const wrapper = JSON.parse(readFileSync(path, "utf8")) as { dpapi?: string };
      if (!wrapper.dpapi) return undefined;
      const plain = await dpapiUnprotect(Buffer.from(wrapper.dpapi, "base64"));
      creds = JSON.parse(Buffer.from(plain).toString("utf8"));
    } else {
      // Linux keeps a plain file here. macOS uses the Keychain, which isn't read yet.
      const path = join(process.env.XDG_CONFIG_HOME ?? join(HOME, ".config"), "cursor/auth.json");
      if (!existsSync(path)) return undefined;
      creds = JSON.parse(readFileSync(path, "utf8"));
    }
    if (!creds?.accessToken) return undefined;

    let email: string | undefined;
    try {
      const cfg = JSON.parse(readFileSync(join(HOME, ".cursor/cli-config.json"), "utf8")) as { authInfo?: { email?: string } };
      email = cfg.authInfo?.email;
    } catch {}
    return { token: creds.accessToken, email };
  } catch {
    return undefined;
  }
}

class AuthError extends Error {}

async function callDashboard<T>(method: string, token: string): Promise<T> {
  const res = await fetch(`${DASHBOARD_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "User-Agent": "quota-cli",
    },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) throw new AuthError();
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function fetchViaCli(session: { token: string; email?: string }, result: AccountUsage): Promise<AccountUsage> {
  result.source = "Cursor CLI session + api2.cursor.sh dashboard API";
  result.email = session.email;

  if (tokenExpired(session.token)) {
    result.error = "Cursor CLI login expired. Run `agent login` to refresh it.";
    return result;
  }

  try {
    const [u, info, status] = await Promise.all([
      callDashboard<PeriodUsage>("GetCurrentPeriodUsage", session.token),
      callDashboard<PlanInfo>("GetPlanInfo", session.token).catch(() => undefined),
      callDashboard<LimitStatus>("GetUsageLimitStatusAndActiveGrants", session.token).catch(() => undefined),
    ]);

    if (info?.planInfo?.planName) result.plan = info.planInfo.planName;
    const resetsAt = u.billingCycleEnd ? new Date(Number(u.billingCycleEnd)) : undefined;
    const plan = u.planUsage;

    if (plan) {
      result.meters.push({
        label: "Included (total)",
        percent: plan.totalPercentUsed ?? (plan.limit ? ((plan.includedSpend ?? 0) / plan.limit) * 100 : null),
        resetsAt,
        detail: plan.limit != null ? `${cents(plan.includedSpend)} / ${cents(plan.limit)}` : undefined,
      });
      if (plan.autoPercentUsed != null) result.meters.push({ label: "Auto + Composer", percent: plan.autoPercentUsed, resetsAt });
      if (plan.apiPercentUsed != null) result.meters.push({ label: "API models", percent: plan.apiPercentUsed, resetsAt });
      if ((plan.bonusSpend ?? 0) > 0) result.notes.push(`Bonus usage on top of plan: ${cents(plan.bonusSpend)}`);
    }

    const sl = u.spendLimitUsage;
    if (sl?.individualLimit) {
      result.meters.push({
        label: "On-demand",
        percent: ((sl.individualUsed ?? 0) / sl.individualLimit) * 100,
        resetsAt,
        detail: `${cents(sl.individualUsed)} / ${cents(sl.individualLimit)}`,
      });
    } else if (sl?.individualUsed) {
      result.notes.push(`On-demand: ${cents(sl.individualUsed)} (no limit)`);
    }
    if (sl?.pooledLimit) result.notes.push(`Team on-demand: ${cents(sl.pooledUsed)} / ${cents(sl.pooledLimit)}`);

    const st = status?.usageLimitPolicyStatus;
    if (st?.isInSlowPool) result.notes.push(st.trayLabel ?? "Over the limit: requests run in the slow queue");
  } catch (e) {
    result.error = e instanceof AuthError ? "Cursor rejected the CLI session. Run `agent login` to refresh it." : errorMessage(e);
  }
  return result;
}

// ==== Entry point ===========================================================

export async function fetchCursor(label = "Cursor"): Promise<AccountUsage> {
  const result: AccountUsage = { provider: "cursor", name: label, meters: [], notes: [], source: "" };

  // The editor login keeps priority and its original behaviour. The CLI login
  // is used when there is no editor login, or when the editor's has expired.
  const editor = readEditorSession();
  if (editor && !tokenExpired(editor.token)) return fetchViaEditor(editor, result);

  const cli = await readCliSession();
  if (cli) return fetchViaCli(cli, result);
  if (editor) return fetchViaEditor(editor, result); // reports the expired editor login

  result.source = "Cursor app session + cursor.com usage API";
  result.error = "No Cursor login found. Sign in to the Cursor editor or run `agent login`.";
  return result;
}
