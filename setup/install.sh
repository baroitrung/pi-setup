#!/usr/bin/env bash
# install.sh — Bootstrap the Pi coding agent global config from this repo.
#
# Safe to run repeatedly. Backs up every file it overwrites.
#
# Usage:
#   bash setup/install.sh            # install, never clobber existing config
#   bash setup/install.sh --force    # overwrite settings.json / models.json / web-search.json too
#   bash setup/install.sh --dry-run  # print what would happen, change nothing
#
# What it does:
#   1. Copies extensions/  → ~/.pi/agent/extensions/
#   2. Copies scripts/     → ~/.pi/agent/scripts/
#   2b. Copies agents/     → ~/.pi/agent/agents/  (subagent profiles)
#   3. Handles settings.json (install if new, otherwise show a diff)
#   4. Handles models.json (provider/model compat overrides; same rule)
#   4b. Handles pi-pretty.json (TUI renderer palette; same rule)
#   5. Handles web-search.json from web-search.example.json (same rule)
#   6. Verifies and prints the remaining manual steps

set -euo pipefail
shopt -s nullglob

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PI_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

FORCE=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --force)   FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

green()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[0;33m%s\033[0m\n' "$*"; }
red()    { printf '\033[0;31m%s\033[0m\n' "$*"; }
dim()    { printf '\033[0;2m%s\033[0m\n' "$*"; }

run() {
  if [ "$DRY_RUN" = 1 ]; then
    dim "    would: $*"
  else
    "$@"
  fi
}

# Install a vendored extension's npm dependencies. Fresh first install is expected to
# take a while (shiki + @shikijs/cli); repeat runs are near-instant thanks to the lock
# file. Failures are reported but do not abort the whole setup: every other extension
# still loads, and the user can rerun this script once the network is back.
run_npm_install() {
  local dir="$1"
  [ -f "$dir/package.json" ] || return 0
  if [ -d "$dir/node_modules" ] && [ -f "$dir/node_modules/.package-lock.json" ] \
     && [ "$dir/package-lock.json" -ot "$dir/node_modules/.package-lock.json" ]; then
    dim "    deps up to date: ${dir/#$HOME/\~}/"
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    yellow "  ⚠  npm not found — run 'npm install --omit=dev --omit=peer' in ${dir/#$HOME/\~}/"
    return 0
  fi
  if ( cd "$dir" && npm install --omit=dev --omit=peer --silent >/dev/null 2>&1 ); then
    green "  ✓ deps installed: ${dir/#$HOME/\~}/"
  else
    yellow "  ⚠  npm install failed in ${dir/#$HOME/\~}/ — the extension may not load"
  fi
  return 0
}

backup() {
  local target="$1"
  [ -e "$target" ] || return 0
  run cp -r "$target" "${target}.backup.${TIMESTAMP}"
  yellow "    backed up: ${target/#$HOME/\~}"
}

# Back up a directory extension OUTSIDE $PI_DIR/extensions: Pi loads any
# subdirectory that contains an index.ts, so a sibling `<name>.backup.<ts>/`
# would register a second copy of the extension's commands and hooks.
backup_tree() {
  local target="$1" dest
  [ -e "$target" ] || return 0
  dest="$PI_DIR/backups/extensions/$(basename "$target").${TIMESTAMP}"
  run mkdir -p "$(dirname "$dest")"
  run cp -a "$target" "$dest"
  yellow "    backed up: ${dest/#$HOME/\~}"
}

# Copy src → dest only when contents differ; back up dest first.
sync_file() {
  local src="$1" dest="$2" mode="${3:-}"
  [ -f "$src" ] || return 0
  if [ -e "$dest" ] && cmp -s "$src" "$dest"; then
    dim "    unchanged: ${dest/#$HOME/\~}"
    return 0
  fi
  backup "$dest"
  run mkdir -p "$(dirname "$dest")"
  run cp "$src" "$dest"
  [ -n "$mode" ] && run chmod "$mode" "$dest"
  green "  ✓ ${dest/#$HOME/\~}"
  return 0
}

# Copy a directory of extension sources (index.ts + lib/*.ts) as one unit.
# Pi loads a directory as a single extension; the whole tree must match.
sync_tree() {
  local src="$1" dest="$2"
  [ -d "$src" ] || return 0
  # Vendored extensions carry node_modules/ installed by this script; never copy or
  # diff them (36MB of shiki + ffmpeg-grade deps, and the dest copy is rebuilt below).
  if [ -d "$dest" ] && diff -r -q -x node_modules "$src" "$dest" >/dev/null 2>&1; then
    dim "    unchanged: ${dest/#$HOME/\~}/"
    return 0
  fi
  backup_tree "$dest"
  run mkdir -p "$dest"
  run rsync -a --exclude node_modules --exclude dist "$src/" "$dest/"
  green "  ✓ ${dest/#$HOME/\~}/"
  return 0
}

echo ""
echo "Pi Bootstrap"
echo "============"
echo "Repo:   $REPO_DIR"
echo "Target: ${PI_DIR/#$HOME/\~}"
[ "$DRY_RUN" = 1 ] && yellow "Mode:   DRY RUN (nothing will change)"
echo ""

if [ ! -d "$PI_DIR" ]; then
  red "Target directory does not exist: $PI_DIR"
  red "Install Pi first, or set PI_CODING_AGENT_DIR."
  exit 1
fi

# --- Step 1: directories -----------------------------------------------------
run mkdir -p "$PI_DIR/extensions" "$PI_DIR/scripts" "$PI_DIR/agents" "$PI_DIR/themes"
green "✓ Directories ready"

# --- Step 2: extensions ------------------------------------------------------
echo ""
echo "Extensions"
for f in "$REPO_DIR/extensions/"*.ts; do
  sync_file "$f" "$PI_DIR/extensions/$(basename "$f")"
done
# Multi-file extensions are directories with an index.ts entry point, or a
# package.json declaring `pi.extensions` (vendored packages such as pi-pretty).
for d in "$REPO_DIR/extensions/"*/; do
  [ -f "${d}index.ts" ] || [ -f "${d}package.json" ] || continue
  name="$(basename "$d")"
  sync_tree "$d" "$PI_DIR/extensions/$name"
  # Vendored packages declare real npm dependencies; pi resolves shiki/@shikijs/cli
  # from the extension's own node_modules, so install them where they now live.
  if [ -f "${d}package.json" ]; then
    if [ "$DRY_RUN" = 1 ]; then
      dim "    [dry-run] npm install --omit=dev --omit=peer in extensions/$name/"
    elif [ -f "$PI_DIR/extensions/$name/package.json" ]; then
      run_npm_install "$PI_DIR/extensions/$name"
    fi
  fi
done

# --- Step 3: scripts ---------------------------------------------------------
echo ""
echo "Scripts"
for f in "$REPO_DIR/scripts/"*; do
  [ -f "$f" ] || continue
  sync_file "$f" "$PI_DIR/scripts/$(basename "$f")" 700
done

# --- Step 3b: subagent profiles ----------------------------------------------
# Custom agent definitions (markdown + frontmatter) live in ~/.pi/agent/agents/.
# They override bundled pi-subagents agents of the same name.
echo ""
echo "Agents"
for f in "$REPO_DIR/agents/"*.md; do
  sync_file "$f" "$PI_DIR/agents/$(basename "$f")"
done

# --- Step 3c: themes ---------------------------------------------------------
echo ""
echo "Themes"
for f in "$REPO_DIR/themes/"*.json; do
  sync_file "$f" "$PI_DIR/themes/$(basename "$f")"
done

# --- Step 4: settings.json ---------------------------------------------------
SETTINGS_SRC="$REPO_DIR/config/settings.json"
SETTINGS_DEST="$PI_DIR/settings.json"
if [ ! -e "$SETTINGS_DEST" ]; then
  sync_file "$SETTINGS_SRC" "$SETTINGS_DEST"
elif [ "$FORCE" = 1 ]; then
  yellow "  settings.json: --force, overwriting"
  sync_file "$SETTINGS_SRC" "$SETTINGS_DEST"
elif cmp -s "$SETTINGS_SRC" "$SETTINGS_DEST"; then
  dim "    unchanged: ${SETTINGS_DEST/#$HOME/\~}"
else
  yellow ""
  yellow "  ⚠  settings.json already exists — not overwriting."
  yellow "     Review the diff and merge what you want:"
  yellow ""
  diff -u "$SETTINGS_DEST" "$SETTINGS_SRC" | sed 's/^/     /' || true
  yellow ""
  yellow "     Template: config/settings.json"
  yellow "     Live:     ${SETTINGS_DEST/#$HOME/\~}"
  yellow "     Re-run with --force to overwrite (a backup is taken)."
fi

# --- Step 5: models.json -----------------------------------------------------
# Provider/model compat overrides only: credentials stay in auth.json, so this file
# is safe to share. Never overwritten silently.
MODELS_SRC="$REPO_DIR/config/models.json"
MODELS_DEST="$PI_DIR/models.json"
if [ ! -e "$MODELS_DEST" ]; then
  sync_file "$MODELS_SRC" "$MODELS_DEST"
elif [ "$FORCE" = 1 ]; then
  yellow "  models.json: --force, overwriting"
  sync_file "$MODELS_SRC" "$MODELS_DEST"
elif cmp -s "$MODELS_SRC" "$MODELS_DEST"; then
  dim "    unchanged: ${MODELS_DEST/#$HOME/\~}"
else
  yellow ""
  yellow "  ⚠  models.json already exists — not overwriting."
  yellow "     Review the compat overrides and merge what you want:"
  yellow ""
  diff -u "$MODELS_DEST" "$MODELS_SRC" | sed 's/^/     /' || true
  yellow ""
  yellow "     Template: config/models.json"
  yellow "     Re-run with --force to overwrite (a backup is taken)."
fi

# --- Step 5b: pi-pretty.json -------------------------------------------------
# Renderer palette for the working/thinking rows. Never clobbered silently: the
# live file is the one a person tunes.
PRETTY_SRC="$REPO_DIR/config/pi-pretty.json"
PRETTY_DEST="$PI_DIR/pi-pretty.json"
if [ ! -e "$PRETTY_DEST" ]; then
  sync_file "$PRETTY_SRC" "$PRETTY_DEST"
elif [ "$FORCE" = 1 ]; then
  yellow "  pi-pretty.json: --force, overwriting"
  sync_file "$PRETTY_SRC" "$PRETTY_DEST"
elif cmp -s "$PRETTY_SRC" "$PRETTY_DEST"; then
  dim "    unchanged: ${PRETTY_DEST/#$HOME/\~}"
else
  yellow ""
  yellow "  ⚠  pi-pretty.json already exists — not overwriting."
  yellow "     Review the diff and merge what you want:"
  yellow ""
  diff -u "$PRETTY_DEST" "$PRETTY_SRC" | sed 's/^/     /' || true
  yellow ""
  yellow "     Template: config/pi-pretty.json"
  yellow "     Live:     ${PRETTY_DEST/#$HOME/\~}"
  yellow "     Re-run with --force to overwrite (a backup is taken)."
fi

# --- Step 6: web-search.json -------------------------------------------------
WS_SRC="$REPO_DIR/config/web-search.example.json"
WS_DEST="$PI_DIR/web-search.json"
if [ ! -e "$WS_DEST" ]; then
  sync_file "$WS_SRC" "$WS_DEST"
  yellow ""
  yellow "  → web-search.json is the EXAMPLE config. Edit it before use:"
  yellow "     • remove any provider you have no key for"
  yellow "     • set allowRemoteHostedProviders to true only if you accept"
  yellow "       sending fetched URLs to third-party hosted services"
elif [ "$FORCE" = 1 ]; then
  yellow "  web-search.json: --force, overwriting"
  sync_file "$WS_SRC" "$WS_DEST"
else
  dim "    unchanged: ${WS_DEST/#$HOME/\~} (not touching your live config)"
fi

# --- Step 7: verify ----------------------------------------------------------
echo ""
echo "Verification"
echo "------------"
count_ext=$(find "$PI_DIR/extensions" -maxdepth 1 -name "*.ts" 2>/dev/null | wc -l | tr -d ' ')
echo "  extensions/     : $count_ext TypeScript extensions"
echo "  scripts/        : $(find "$PI_DIR/scripts" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ') scripts"
echo "  agents/         : $(find "$PI_DIR/agents" -maxdepth 1 -name "*.md" 2>/dev/null | wc -l | tr -d ' ') subagent profiles"
echo "  themes/         : $(find "$PI_DIR/themes" -maxdepth 1 -name "*.json" 2>/dev/null | wc -l | tr -d ' ') custom themes"
echo "  settings.json   : $([ -f "$SETTINGS_DEST" ] && echo present || echo MISSING)"
echo "  models.json     : $([ -f "$MODELS_DEST" ] && echo present || echo MISSING)"
echo "  pi-pretty.json  : $([ -f "$PRETTY_DEST" ] && echo present || echo MISSING)"
echo "  web-search.json : $([ -f "$WS_DEST" ] && echo present || echo MISSING)"

if [ "$DRY_RUN" = 1 ]; then
  echo ""
  yellow "Dry run complete. Nothing was written."
  exit 0
fi

# --- Step 8: version stamp ---------------------------------------------------
if git -C "$REPO_DIR" rev-parse HEAD >/dev/null 2>&1; then
  REPO_REV="$(git -C "$REPO_DIR" rev-parse HEAD)"
  printf '%s\n' "$REPO_REV" > "$PI_DIR/.bootstrap-version"
  green "✓ Bootstrap version stamped ($REPO_REV)"
fi

echo ""
green "Bootstrap complete."
echo ""
echo "Manual steps that remain:"
echo "  1. Put your API keys in ~/.env (chmod 600), one KEY=value per line."
echo "     At minimum, the providers you enabled in web-search.json."
echo "  2. Restart Pi so it picks up the new settings and env."
echo "  3. Authenticate the model providers you use (e.g. antigravity, openai-codex)."
echo "  4. Optional: point skills at your own skill repo."
echo ""
