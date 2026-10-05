#!/bin/sh
# Usage: get-secret.sh KEY_NAME  [ENV_FILE]
# Prints the value of KEY_NAME from the env file (default ~/.env),
# stripping optional surrounding single/double quotes. Never logs the value.
key="$1"
file="${2:-$HOME/.env}"
[ -n "$key" ] || exit 2
[ -f "$file" ] || exit 3
sed -n "s/^${key}=//p" "$file" | head -1 | sed -e "s/^'//" -e "s/'$//" -e 's/^"//' -e 's/"$//'
