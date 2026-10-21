# Pi setup

My [Pi coding agent](https://pi.dev) configuration, versioned.

Bootstrap a new machine from this repo with one script. It installs the
extensions, the secret helper, and the config files, then tells you the few
things only a human can do (API keys, provider logins).

```bash
git clone https://github.com/therealtinhtute/pi-setup.git
cd pi-setup
bash setup/install.sh
```

Preview first if you like — nothing is written:

```bash
bash setup/install.sh --dry-run
```

## What gets installed

| From | To | Notes |
| :--- | :--- | :--- |
| `extensions/*.ts` | `~/.pi/agent/extensions/` | Gradient banner, compact statusline/tool calls, `$skill` autocomplete |
| `extensions/account-pool/` | `~/.pi/agent/extensions/account-pool/` | Multi-file extension: Antigravity account pool with per-model cooldown (`/pool`) |
| `extensions/rewind/` | `~/.pi/agent/extensions/rewind/` | Multi-file extension: trim old tool results from the model context (`/rewind`) |
| `scripts/get-secret.sh` | `~/.pi/agent/scripts/` | Reads one key from `~/.env`; mode `700` |
| `config/settings.json` | `~/.pi/agent/settings.json` | Installed only if absent — otherwise diffed |
| `config/models.json` | `~/.pi/agent/models.json` | Provider/model compat overrides; credentials stay in `auth.json` |
| `config/web-search.example.json` | `~/.pi/agent/web-search.json` | Same rule; **this is an example, edit it** |

`install.sh` is idempotent. It copies a file only when the contents differ, and
backs up anything it overwrites to `<file>.backup.<timestamp>`. A directory under
`extensions/` that contains an `index.ts` is copied as one unit, because that is how
Pi loads a multi-file extension; its backup goes to
`~/.pi/agent/backups/extensions/<name>.<timestamp>/` instead, since Pi would happily
load a `<name>.backup.<timestamp>/` sibling as a second copy of the extension.

Your live `settings.json`, `models.json`, and `web-search.json` are **never
clobbered** on a re-run — the script prints a unified diff and leaves the decision
to you. Pass `--force` to overwrite anyway (a backup is still taken).

## Machine → repo sync

The shared config was last synced from the current machine on 2026-10-20 (Pi 1.3.0).
`config/settings.json` and `config/models.json` match the live configuration. Plugins and
packages uninstalled on the machine have been removed from the repository
(`pi-devin-local`, `agent-stuff`, `pi-advisor-flow`, `pi-smart-fetch`,
`pi-permission-system`, `pi-extension`, `pi-xai-oauth`), along with uninstalled extension
scripts/configs (`decision-compact.ts`, Devin client patch, `advisor.json`). Newly
installed packages on the machine (`@narumitw/pi-goal`, `pi-subagents@0.77.0`) are synced
into the template. The default model is `opencode-go/deepseek-v4.1-flash` with high
thinking; `config/models.json` adds the session-affinity compat overrides that keep that
proxy channel on one backend (credentials stay in `auth.json`).

Orca-generated `orca-*` extensions stay machine-local and are managed by Orca.
`herdr-agent-state.ts` is the same deal: herdr installs it and overwrites it on update.
Do not copy credentials, sessions, caches, trust decisions, browser profiles,
or installed package directories into this repo.

## The secrets pattern

Pi reads provider credentials from `process.env`. That breaks the moment you
edit a key while Pi is already running — the process keeps the environment it
was launched with, so you have to restart before a new key is visible.

This setup avoids that. `get-secret.sh` reads a key from `~/.env` on demand:

```sh
#!/bin/sh
# Usage: get-secret.sh KEY_NAME [ENV_FILE]
key="$1"
file="${2:-$HOME/.env}"
sed -n "s/^${key}=//p" "$file" | head -1 | sed -e "s/^'//" -e "s/'$//" -e 's/^"//' -e 's/"$//'
```

Pi's web-access extension supports a **command credential source**: a config
value starting with `!` is run as a shell command, and its stdout becomes the
credential. So instead of a bare environment reference:

```json
"firecrawlApiKey": "$FIRECRAWL_API_KEY"
```

use the command form:

```json
"firecrawlApiKey": "!$HOME/.pi/agent/scripts/get-secret.sh FIRECRAWL_API_KEY"
```

| | `$ENV_VAR` | `!get-secret.sh KEY` |
| :--- | :--- | :--- |
| Restart needed after rotating a key | yes | no |
| Key present in `process.env` (visible to child processes) | yes | no |
| Works when Pi started before you added the key | no | yes |

Store keys in `~/.env`, one `KEY=value` per line, mode `600`:

```bash
chmod 600 ~/.env
```

```sh
FIRECRAWL_API_KEY=fc-xxxxxxxx
EXA_API_KEY=xxxxxxxx
TINYFISH_API_KEY=sk-tinyfish-xxxxxxxx
```

## Antigravity account pool

`extensions/account-pool/` adds the part `pi-antigravity` leaves out. The provider
already rotates accounts, but only *inside* one request: after a hard quota wall it
walks to the next login, then the next request starts on the exhausted account again.

This extension keeps the memory:

- **Per-model cooldown.** A wall on `gemini-3.8-flash` blocks that model for that
  account until the provider's own reset hint (`Please wait 4h 12m`) passes; other
  models on the same account stay usable.
- **Sticky selection.** Implicit prompt caching is scoped to `(account, projectId)`,
  so the account only moves when it is actually walled. Round-robin would throw the
  cached prefix away on every request.
- **Visibility.** `/pool` prints who is blocked, until when, and who is active.

```text
/pool            status table
/pool next       switch to the best healthy account now
/pool heal       drop expired blocks
/pool reset      clear every block
```

How it steers: it rewrites the `antigravity` entry in `~/.pi/agent/auth.json` and mirrors
`activeAccountId` into `~/.pi/agent/antigravity-accounts.json`. Pi re-reads
`auth.json` whenever its revision changes, so the switch lands on the next request with
no restart. Cooldown bookkeeping lives in `~/.pi/agent/account-pool-state.json`
(mode `600`, no tokens).

Classification is deliberately narrow: only the provider's hard-wall text counts
(`Quota reached.`). Transient throttling (`Rate limited by Antigravity`) and dead models
(`This model is unavailable right now`) do not burn an account. The extension hooks
`agent_end` rather than `after_provider_response`, because a custom API registered
through `registerApiProvider` never calls `options.onResponse` — that hook is blind here.

## Rewind: keep the decisions, drop the bulk

`extensions/rewind/` trims what the model re-reads on every request without editing the
session. Tool results older than the last N messages collapse into one-line stubs; user
and assistant messages are never touched.

```text
/rewind                 arm it (keep 8 messages, min 1500 chars)
/rewind keep 12         keep a larger verbatim tail
/rewind min 400         prune smaller results too
/rewind status          show settings and the last pass
/rewind off             restore the full transcript
```

It works through Pi's `context` hook, whose returned messages are exactly what the
provider receives, so **nothing is written to the session file** — `/rewind off` is
instant and lossless, and a resume restores the armed state from a custom entry. The
first pass announces how much it saved; after that it stays quiet.

## Web search providers

`config/web-search.example.json` routes search through **Exa → TinyFish → Firecrawl →
DuckDuckGo**, cheapest-capable first and keyless last, so an expired or missing key
degrades instead of failing. The first three read their keys from `~/.env` through
`get-secret.sh`; DuckDuckGo needs no credential at all. The existing fetch provider
order is unchanged.

Search falls back on `transient`, `quota`, `network`, `invalid-response`, and
`unsupported` — the only five kinds the loader accepts; anything else refuses to load
the whole extension. A provider whose credential does not resolve is skipped before the
call, which is what lets the keyless tail keep search alive. An explicit provider request
stays strict; it does not use the fallback route. The search allowlist also rejects
explicit requests for other providers.

For an existing installation, merge these fields into
`~/.pi/agent/web-search.json` (keep the rest of your config):

```json
{
  "webSearch": {
    "allowedProviders": ["exa", "tinyfish", "firecrawl", "duckduckgo"]
  },
  "searchRouting": {
    "providers": ["exa", "tinyfish", "firecrawl", "duckduckgo"],
    "fallbackOn": ["transient", "quota", "network", "invalid-response", "unsupported"]
  },
  "exaApiKey": "!$HOME/.pi/agent/scripts/get-secret.sh EXA_API_KEY",
  "tinyfishApiKey": "!$HOME/.pi/agent/scripts/get-secret.sh TINYFISH_API_KEY",
  "firecrawlApiKey": "!$HOME/.pi/agent/scripts/get-secret.sh FIRECRAWL_API_KEY"
}
```

Remove top-level `provider` and `searchProvider` fields if present: they override
`searchRouting`. Run `/reload` after changing the config. The installer leaves
existing live config untouched unless you pass `--force`, which overwrites the
whole file rather than merging it.

Exporting keys inside Pi's bash tool does not update Pi's own environment. With
the command credential sources above, exports and restarts are not needed when
adding or rotating a key in `~/.env`.

Before enabling remote extraction, read these two fields:

**`firecrawlFreshScrape`** — `false` means Firecrawl operates cache-only
(`lockdown: true`): the Firecrawl server will not make fresh outbound requests
to target URLs. Only set `true` for a Firecrawl deployment whose own egress is
isolated or allowlisted. This extension can preflight URLs you submit, but it
cannot control what the Firecrawl server fetches.

**`fetchRouting.allowRemoteHostedProviders`** — remote `fetch_content` calls
skip third-party hosted providers unless this is `true`. Firecrawl is not in
that group, so Firecrawl search works either way; the flag only affects the
hosted *fetch* fallbacks (Jina, TinyFish, and friends). Set it to `false` if you
do not want fetched URLs handed to those services.

Add TinyFish and Firecrawl keys to `~/.env` for the default search route. Other
providers below are supported, but search providers outside the allowlist need
an explicit config change:

| Provider | Key | Role |
| :--- | :--- | :--- |
| Firecrawl | `FIRECRAWL_API_KEY` | Search + extraction fallback |
| Exa | `EXA_API_KEY` | Search |
| TinyFish | `TINYFISH_API_KEY` | Search + fetch |
| Brave | `BRAVE_API_KEY` | Search |
| Tavily | `TAVILY_API_KEY` | Search |

Config file: `~/.pi/agent/web-search.json`.

> Some networks get flagged by hosted scrapers, which then refuse keyless
> requests with HTTP 403. If that happens, a key is mandatory.

## Extensions

**`custom-banner.ts`** — replaces the default TUI header with a gradient
TINHTUTE banner. Centers and truncates using terminal display widths, with a
compact fallback on narrow terminals. Adds `/custom-header` and `/builtin-header`
to switch between headers at runtime.

**`custom-footer.ts`** — replaces the TUI footer with a compact, live statusline:

```text
 👾 Opus 5.5 · low · ──────── 12% · ϟ 2.4k tpm · ★ 85% · ⌥ main
```

Shows the current model in orange (palette 208) and thinking level in ANSI
magenta, matching the Claude Code statusline, plus context usage and Git branch
(omitted outside Git). Matching Claude Code's statusline thresholds, the entire
context segment is monochromatic: gray (`#9e9e9e`) below 50%, yellow (`#facc15`)
from 50%, and red (`#f87171`) from 75%.
Unknown context usage displays `?%` in gray.

The yellow `ϟ N tpm` segment shows the session-average input + output tokens per
minute, using all recorded session usage and wall-clock time since the session
header's creation timestamp. Cached read/write tokens are excluded. Idle time
and time between closing and resuming a session count in the denominator; this
is not output-only generation speed or Claude's own duration counter. The value
updates on redraw, without a timer. It is hidden when tokens or valid elapsed
time are unavailable, or the rate rounds down to zero. Formatting follows Claude:
`999`, `1.0k`, `10k`.

The `★` segment shows the latest assistant's
cache hit rate on the active branch: `cacheRead / (input + cacheRead + cacheWrite)`.
It is hidden until valid usage is available. Matching the Claude Code statusline,
the rate is truncated to a whole percent, and the entire `★ N%` segment is dim
when no tokens were read from cache, red below 70%, yellow from 70%, and green
from 90%. A known zero hit rate displays `★ 0%`.
Other colors follow the active theme and the line truncates to fit the terminal.
Adds `/custom-footer` and `/builtin-footer` to switch at
runtime. The compact footer hides the built-in cwd, usage/cost totals, and other
extension statuses; `/builtin-footer` restores them.

**`dollar-skill.ts`** — types `$skill-name` and rewrites it to
`/skill:skill-name` on submit, plus `$`-triggered autocomplete over installed
skills. Also supports multi-skill pipeline chains such as `$think -> $work`
or `$think ➔ $work`, combining stages sequentially into a single pipeline prompt.

These four extensions are plain TypeScript, loaded directly from
`~/.pi/agent/extensions/`; the header and footer activate automatically in TUI mode.
Tool rendering, code fences, skill chips, and summary cards are back to Pi's stock
presentation — the custom versions were removed on 2026-10-21 and survive only in git
history. Disable any file through `pi config` (or delete it) and `/reload` to change
the look.

### Verify the statusline

With Pi installed, run from the repository root:

```bash
node tests/test-custom-footer.mjs
node tests/test-account-pool.mjs
node tests/test-rewind.mjs
```

Verify the search and package templates without credentials or network calls:

```bash
node tests/test-web-search-config.mjs
node tests/test-package-selection.mjs
```

For npm or other install layouts, set `PI_NODE_MODULES` to the directory
containing Pi's installed dependencies. Tests cover light/dark themes, context
and cache thresholds, hidden unknown cache usage, session TPM and formatting,
narrow terminals, emoji/Unicode, live updates, commands, and subscription cleanup.
After installing, run `/reload` in Pi to check both components visually.

## Packages

`config/settings.json` lists the eight packages this setup keeps. The list was cut
on 2026-10-21 after measuring real usage across 158 sessions rather than guessing:

| Package | Why it stays |
| :--- | :--- |
| `pi-antigravity` | the provider: Antigravity models plus `google_search` / `generate_image` |
| `pi-web-access` | `web_search`, `fetch_content`, `source_check` |
| `@juicesharp/rpiv-todo` | the `todo` tool (738 calls) |
| `@juicesharp/rpiv-ask-user-question` | `ask_user_question` (36 calls) |
| `pi-memory` | six `memory_*` tools plus `scratchpad` |
| `pi-lsp-extension@1.4.0` | `lsp_diagnostics` (151 calls), `code_overview`, `ast_search` |
| `pi-subagents@0.77.0` | `subagent`, `bg_wait`, FleetView |
| `@narumitw/pi-goal` | `goal_*` tools and `/goal` |

Dropped, and why they should not come back without a measurement:

- **`pi-browser-use` + `pi-mcp-adapter`** — 34 of 71 tools in every request for 23
  lifetime calls; the adapter existed to bridge that plugin's `plugin.json`.
- **`@latentminds/pi-quotas`, `pi-context-view`, `pi-session-recap`, `pi-simplify`,
  `pi-cache-optimizer`, `pi-diff-review`** — commands and UI only, zero measured use;
  quota and context state already show in the footer and `/antigravity.usage`.

`pi-lsp-extension` still exposes eleven tools even though only diagnostics is used in
practice; trimming that further means an active-tools filter, which this setup does
not carry yet. LSP servers are installed separately (`typescript-language-server`
plus `typescript` for JS/TS, `jdtls` for Java); without one, the tools fall back to
tree-sitter analysis, which is not type checking.

Restart Pi or run `/reload` after changing the package selection.

### Parallel subagents and goals

- `npm:pi-subagents@0.77.0`: parallel/background delegation and FleetView.
  Use `/subagents-fleet` to inspect runs. Keep only one subagent implementation
  enabled.
- `npm:@narumitw/pi-goal`: the selected standalone goal package, replacing the
  previous filtered `agent-stuff` goal extension.

Restart Pi or run `/reload` after changing the package selection. Provider-backed
delegation needs a separate end-to-end check; configuration sync does not prove it.

## Layout

```
pi-setup/
├── config/
│   ├── models.json
│   ├── settings.json
│   └── web-search.example.json
├── extensions/
│   ├── account-pool/          # /pool
│   ├── custom-banner.ts
│   ├── custom-footer.ts
│   ├── dollar-skill.ts
│   └── rewind/                # /rewind
├── scripts/
│   ├── get-secret.sh
│   └── test-custom-footer.mjs
├── setup/
│   └── install.sh
└── tests/
    ├── test-account-pool.mjs
    ├── test-custom-footer.mjs
    ├── test-package-selection.mjs
    ├── test-rewind.mjs
    └── test-web-search-config.mjs
```

## Manual steps after install

1. Write your keys to `~/.env` and `chmod 600 ~/.env`.
2. Restart Pi so it picks up the new settings.
3. Authenticate the model providers you use (`/login`, or the provider's own flow).
4. For an existing config, merge the TinyFish/Firecrawl route above and run
   `/reload`. Adjust the search allowlist and route if you use other providers.

## Not in this repo

Skills live in a separate tree (`~/.agents/skills`, symlinked into
`~/.pi/agent/skills`) and are mostly third-party installs. Neither is versioned
here. Sessions, caches, the browser profile, `auth.json`, `antigravity-accounts.json`,
and `models-store.json` are machine-local state and are gitignored. Orca manages
its generated `orca-*` extensions separately; they are not copied into this repo.

## Uninstall

Remove what was installed:

```bash
rm ~/.pi/agent/extensions/code-block.ts
rm ~/.pi/agent/extensions/compact-tools.ts
rm ~/.pi/agent/extensions/custom-banner.ts
rm ~/.pi/agent/extensions/custom-footer.ts
rm ~/.pi/agent/extensions/dollar-skill.ts
rm ~/.pi/agent/extensions/skill-highlight-editor.ts
rm ~/.pi/agent/extensions/skill-invoke-chip.ts
rm ~/.pi/agent/extensions/skill-transcript-badge.ts
rm ~/.pi/agent/extensions/transcript-summary-cards.ts
rm ~/.pi/agent/scripts/get-secret.sh
```

Then restore any `*.backup.<timestamp>` file you want back.

---

from therealTINHTUTE with love
