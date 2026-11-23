import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join(HOME, p.slice(1)) : p;
}

/** Run a command and return stdout. Throws on non-zero exit or timeout. */
export async function run(
  cmd: string[],
  opts: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<string> {
  const proc = Bun.spawn(cmd, {
    env: opts.env ?? process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 20_000);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${err.trim().split("\n").pop() ?? ""}`);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms)),
  ]);
}

export function money(amount: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

export function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
