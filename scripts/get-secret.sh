#!/bin/sh
# Usage: get-secret.sh KEY_NAME  [ENV_FILE]
#
# Prints the value of KEY_NAME, checking two sources in order:
#   1. the process environment (an exported variable wins, so a one-off
#      `HIVE_API_KEY=... pi` overrides the stored file without editing it)
#   2. the env file (default ~/.env), with optional surrounding quotes stripped
#
# Same precedence the extension config uses ("an env var wins over the config
# file"), so a key behaves identically whether it comes from models.json,
# web-search.json, or the shell.
#
# Never logs the value. Exit codes: 2 = bad KEY_NAME, 3 = env file missing and the
# variable is not exported either.
key="$1"
file="${2:-$HOME/.env}"

[ -n "$key" ] || exit 2
# Only accept names a shell could export. This keeps the value out of an eval and
# keeps the sed pattern below from being a regex.
case "$key" in
	*[!A-Za-z0-9_]* | [0-9]* | "") exit 2 ;;
esac

# 1. Exported variable (including an explicitly empty one, which counts as unset).
if value=$(printenv "$key" 2>/dev/null) && [ -n "$value" ]; then
	printf '%s\n' "$value"
	exit 0
fi

# 2. The env file.
[ -f "$file" ] || exit 3
sed -n "s/^${key}=//p" "$file" | head -1 | sed -e "s/^'//" -e "s/'$//" -e 's/^"//' -e 's/"$//'
