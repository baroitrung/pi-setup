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
| `extensions/*.ts` | `~/.pi/agent/extensions/` | Custom header banner, `$skill` autocomplete |
| `config/quotas.json` | `~/.pi/agent/extensions/` | Config for the `pi-quotas` package |
| `scripts/get-secret.sh` | `~/.pi/agent/scripts/` | Reads one key from `~/.env`; mode `700` |
| `config/advisor.json` | `~/.pi/agent/advisor.json` | Advisor model selection |
| `config/settings.json` | `~/.pi/agent/settings.json` | Installed only if absent — otherwise diffed |
| `config/web-search.example.json` | `~/.pi/agent/web-search.json` | Same rule; **this is an example, edit it** |

`install.sh` is idempotent. It copies a file only when the contents differ, and
backs up anything it overwrites to `<file>.backup.<timestamp>`.

Your live `settings.json` and `web-search.json` are **never clobbered** on a
re-run — the script prints a unified diff and leaves the decision to you. Pass
`--force` to overwrite anyway (a backup is still taken).

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

## Web search providers

`config/web-search.example.json` enables Firecrawl and keeps the default fetch
provider order. Before using it, read these two fields:

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

Provider keys are optional. Enable only what you have:

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

**`custom-banner.ts`** — replaces the default TUI header with a custom banner.
Adds `/custom-header` and `/builtin-header` to switch between them at runtime.

**`dollar-skill.ts`** — types `$skill-name` and rewrites it to
`/skill:skill-name` on submit, plus `$`-triggered autocomplete over installed
skills.

Both are plain TypeScript and are loaded directly from
`~/.pi/agent/extensions/`.

## Packages

`config/settings.json` lists the Pi packages this setup expects. Pi installs
them on start:

```json
"packages": [
  "npm:pi-antigravity",
  "npm:pi-web-access",
  "npm:pi-subagents",
  "npm:pi-memory",
  "npm:pi-browser-use",
  "npm:pi-smart-fetch",
  "npm:pi-mcp-adapter"
]
```

Trim this list to what you actually use — every entry is downloaded and loaded
at startup.

## Layout

```
pi-setup/
├── config/
│   ├── advisor.json
│   ├── quotas.json
│   ├── settings.json
│   └── web-search.example.json
├── extensions/
│   ├── custom-banner.ts
│   └── dollar-skill.ts
├── scripts/
│   └── get-secret.sh
└── setup/
    └── install.sh
```

## Manual steps after install

1. Write your keys to `~/.env` and `chmod 600 ~/.env`.
2. Restart Pi so it picks up the new settings.
3. Authenticate the model providers you use (`/login`, or the provider's own flow).
4. Edit `~/.pi/agent/web-search.json` — drop providers you have no key for.

## Not in this repo

Skills live in a separate tree (`~/.agents/skills`, symlinked into
`~/.pi/agent/skills`) and are mostly third-party installs. Neither is versioned
here. Sessions, caches, the browser profile, `auth.json`, `antigravity-accounts.json`,
and `models-store.json` are machine-local state and are gitignored.

## Uninstall

Remove what was installed:

```bash
rm ~/.pi/agent/extensions/custom-banner.ts
rm ~/.pi/agent/extensions/dollar-skill.ts
rm ~/.pi/agent/scripts/get-secret.sh
rm ~/.pi/agent/advisor.json
```

Then restore any `*.backup.<timestamp>` file you want back.

---

from therealTINHTUTE with love
