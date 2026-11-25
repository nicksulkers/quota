# quota

A small Bun CLI that shows how much of your AI coding subscriptions you've used: Claude (one or more accounts), Codex and Cursor. One command, one screen, reset times and pace included.

```
Claude · Work  Team 5x · you@work.example
  Session (5h)      ██████████████████░░   88%  ▲  above pace       full in ~31m (16:31) · resets 17:15
  Weekly            ████░░░░░░░░░░░░░░░░   22%  ▼  below pace       resets in 4d 3h (Sun 19:00)
  Weekly · Fable    ██████████████░░░░░░   71%  ▲▲ well above pace  full in ~1d 4h (Thu 20:10) · resets Sun 19:00

Claude · Personal  Max 5x · you@home.example
  Session (5h)      ████████████████████  100%  ■  limit reached    resets in 52m (16:52)
  Weekly            █████████████░░░░░░░   66%  ●  on pace          resets in 2d 6h (Fri 22:00)
  Extra usage off (out of credits): €0.00 / €42.50

Codex  Pro Lite · you@home.example
  Session (5h)      █░░░░░░░░░░░░░░░░░░░    4%  ·  too early        resets in 4h 50m (20:50)
  Weekly            █░░░░░░░░░░░░░░░░░░░    3%  ▼▼ well below pace  resets in 6d 1h (Tue 17:00)
  1 rate-limit reset available (use from Codex)

Cursor  Pro · you@home.example
  Included (total)  █████████████░░░░░░░   64%  ●  on pace          $12.80 / $20.00  resets in 12d 0h (7 Dec 16:00)
  Auto + Composer   ████████░░░░░░░░░░░░   41%  ▼  below pace       resets in 12d 0h (7 Dec 16:00)
  API models        ██████████████████░░   92%  ▲▲ well above pace  full in ~1d 13h (Fri 05:30) · resets 7 Dec 16:00
  Bonus usage on top of plan: $452.77
```

## Usage

```
quota                  every configured account
quota personal         filter by account label
quota codex cursor     filter by provider
quota --json           raw results, for scripts
quota --no-email       hide account emails
quota -v               show where each number came from
quota --plain          no color, ASCII bars (automatic when piped)
```

### Pace

Each meter with a known window shows whether you'll run out before it resets, assuming usage keeps the average rate it has had since the window started.

| Tag | Projected use at reset |
|---|---|
| `▼▼ well below pace` | under 50% |
| `▼  below pace` | 50–90% |
| `●  on pace` | 90–110% |
| `▲  above pace` | 110–150% |
| `▲▲ well above pace` | over 150% |
| `■  limit reached` | already at 100% |
| `·  too early` | less than 10% of the window gone and less than 10% used |

Above pace, the line shows when you'd hit the limit, with the reset after it: `full in ~31m (16:31) · resets 17:15`. `--plain` uses `vv v = ^ ^^ !! .` for the symbols.

Window lengths come from Codex directly. Claude's are fixed (5h session, 7-day weekly), and Cursor's come from the billing cycle. Meters with no window, like Claude's extra usage, get no tag. The projection is a straight line, so a busy morning reads as "above pace" even if you stop at lunch. `--json` includes it as `pace: { status, projectedPercent, fullAt }`.

Exit code is 0 when every account answered, 1 when at least one failed, 2 when no account matched the filter.

## Where the numbers come from

I wanted each provider's own CLI to be the source. That works for Codex. It only partly works for Claude and not at all for Cursor.

| Provider | Source | Notes |
|---|---|---|
| Codex | `codex app-server`, calling `account/read` and `account/rateLimits/read` over stdio JSON-RPC | The official CLI protocol. Codex refreshes its own token, so quota never touches `~/.codex/auth.json`. |
| Claude | `claude auth status --json` for plan and email. Limits come from `https://api.anthropic.com/api/oauth/usage`, called with the token in `<configDir>/.credentials.json`. | Claude Code has no non-interactive usage command. `claude -p "/usage"` gets sent to the model as a normal prompt and costs quota. The endpoint is the one the interactive `/usage` screen uses. |
| Cursor | The Cursor editor's login, read from its `state.vscdb` SQLite file in read-only mode, then `https://cursor.com/api/usage-summary`. Without an editor login, the `agent` CLI's login (`%APPDATA%\cursor\auth.dpapi` on Windows, decrypted with DPAPI; `~/.config/cursor/auth.json` on Linux), then `DashboardService` on `https://api2.cursor.sh`. | Neither the editor nor the `agent` CLI prints usage. `usage-summary` is the endpoint behind cursor.com/dashboard, and it rejects CLI tokens. The api2 endpoints are what the clients themselves call. |

The Claude and Cursor endpoints are internal. They can change without notice, and when they do this tool breaks until someone updates the parser.

quota only reads tokens. It never refreshes them or writes them back, because Claude Code and Cursor rewrite those files themselves and a second writer could log you out. If a login has expired, quota says so. Open the app once and run quota again.

## Setup on a new machine

These steps are written so a person or a coding agent can follow them top to bottom. They assume Windows with PowerShell, because that's where this was built and tested. Linux works the same way with the paths swapped. On macOS, see the limitation further down.

### 1. Prerequisites

Check what's installed:

```powershell
bun --version          # need 1.2 or newer
claude --version       # only for Claude accounts
codex --version        # only for Codex
git --version
```

Install Bun if it's missing:

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Then open a new terminal so `bun` is on PATH.

Each provider also needs a login on this machine:

- **Claude.** Each account needs its own Claude Code config folder with a login in it. The default account lives in `~\.claude`. A second account usually lives in a folder like `~\.claude_personal`, used by starting Claude with `CLAUDE_CONFIG_DIR` pointing at it. A folder counts as logged in when it contains `.credentials.json`.
- **Codex.** `codex login` with a ChatGPT account. API-key logins have no plan limits to show.
- **Cursor.** Sign in to the Cursor editor, or run `agent login` for the CLI. Either login works.

You can skip any provider you don't use (see step 4).

### 2. Clone and build

```powershell
git clone https://github.com/nicksulkers/quota.git $HOME\src\quota
cd $HOME\src\quota
bun install
bun run typecheck
bun build src/index.ts --compile --outfile $HOME\.local\bin\quota.exe
```

The `--compile` step produces a single `quota.exe` with Bun built in. It doesn't need the source folder or Bun at runtime. Rebuild after pulling changes.

### 3. Put it on PATH

Skip this if `$HOME\.local\bin` is already on PATH. Check with:

```powershell
$env:Path -split ';' | Select-String '\.local\\bin'
```

If nothing prints, add it to the user PATH and open a new terminal:

```powershell
$bin = "$HOME\.local\bin"
[Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User').TrimEnd(';') + ";$bin", 'User')
```

### 4. Configure accounts

Without a config file, quota picks up `~\.claude` plus every `~\.claude_*` or `~\.claude-*` folder that contains `.credentials.json`. It labels each account by folder name and also checks Codex and Cursor. That default is usually enough to start with.

To get readable labels, find your Claude folders first:

```powershell
Get-ChildItem $HOME -Directory -Force -Filter '.claude*' |
  Where-Object { Test-Path (Join-Path $_.FullName '.credentials.json') } |
  Select-Object FullName
```

Then create `~\.config\quota\config.json`:

```json
{
  "claude": [
    { "label": "Work", "configDir": "~/.claude" },
    { "label": "Personal", "configDir": "~/.claude_personal" }
  ],
  "codex": { "label": "Codex" },
  "cursor": { "label": "Cursor" }
}
```

- `configDir` accepts `~`.
- Set a provider to `false` to skip it, for example `"cursor": false` on a machine without Cursor.
- `"claude": false` turns Claude off entirely. Leaving the `claude` key out brings back auto-discovery.
- Set `QUOTA_CONFIG` to use a config file somewhere else.

If you're not sure which folder belongs to which account, run `quota -v`. The header of each block shows the plan and email for that folder.

### 5. Verify

```powershell
quota
```

Every account should show at least one bar. If an account shows a red `✗` line instead, find the message below.

| Message | Fix |
|---|---|
| `Not logged in (no ...\.credentials.json)` | Wrong `configDir`, or that account never logged in. Start `claude` with `CLAUDE_CONFIG_DIR` set to that folder and log in. |
| `Login expired` / `Token rejected` (Claude) | Start `claude` with that account once so it refreshes the token. |
| `` `codex` CLI not found on PATH `` | Install Codex or set `"codex": false`. |
| `Not logged in. Run codex login.` | Run `codex login`. |
| `No Cursor login found` | Sign in to the Cursor editor or run `agent login`, or set `"cursor": false`. |
| `Cursor rejected the session` | Open the Cursor editor or run `agent login` to refresh the login. |
| `HTTP 4xx/5xx` | The provider changed or broke its endpoint. Check `quota --json` and update the matching file in `src/providers/`. |

## macOS limitation

Claude Code on macOS stores its login in the Keychain, not in `.credentials.json`, so the Claude provider reports "Not logged in" there. Codex works. Cursor should work too, since quota looks for its database under `~/Library/Application Support/Cursor`, but nobody has tested that yet. Adding Keychain support means reading `security find-generic-password -s "Claude Code-credentials" -w` in `src/providers/claude.ts`.

## Project layout

```
src/index.ts              CLI arguments, runs providers in parallel, prints
src/config.ts             config file and Claude folder discovery
src/render.ts             bars, colors, reset times
src/pace.ts               pace projection from percent and window
src/providers/claude.ts   claude auth status + OAuth usage endpoint
src/providers/codex.ts    JSON-RPC client for codex app-server
src/providers/cursor.ts   Cursor editor/CLI login + api2 dashboard API
```

Every provider returns the same `AccountUsage` shape from `src/types.ts`, so adding a provider means writing one fetch function and registering it in `src/index.ts`.
