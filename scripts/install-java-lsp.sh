#!/usr/bin/env bash
# install-java-lsp.sh — Java language support for pi-lens on this machine.
#
# pi-lens launches the Java language server as `$JDTLS_PATH || "jdtls"` and the
# Java formatter as `google-java-format`, so everything here lives in
# ~/.local/bin to stay on PATH.
#
# Why Java 25: JDT LS 1.64 bundles declare `osgi.ee JavaSE 25`. With Java 21 the
# server exits 13 with "An error has occurred" and an OSGi resolution log; with
# Java 25 it starts and answers diagnostics. The project JDK stays whatever mise
# pins globally (corretto-17); Java 25 is side-by-side and used only here.
#
# Usage:
#   bash scripts/install-java-lsp.sh            # install what is missing
#   bash scripts/install-java-lsp.sh --force    # re-download everything
#
# What it writes:
#   ~/.local/share/jdtls/                  Eclipse JDT Language Server
#   ~/.local/share/google-java-format/     google-java-format all-deps jar
#   ~/.local/share/lombok/lombok.jar       Lombok agent for JDT LS
#   ~/.local/bin/jdtls                     wrapper selecting Java 25
#   ~/.local/bin/google-java-format        wrapper for the formatter jar
#
# Shell env it expects (added to ~/.zshrc, not by this script):
#   PI_LENS_LOMBOK_JAR="$HOME/.local/share/lombok/lombok.jar"

set -euo pipefail

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

SHARE="${XDG_DATA_HOME:-$HOME/.local/share}"
JDTLS_HOME="$SHARE/jdtls"
GJF_HOME="$SHARE/google-java-format"
LOMBOK_HOME="$SHARE/lombok"
BIN="${XDG_BIN_HOME:-$HOME/.local/bin}"
JAVA_25="$SHARE/mise/installs/java/temurin-25"
JDTLS_URL="https://download.eclipse.org/jdtls/snapshots/jdt-language-server-latest.tar.gz"
GJF_VERSION="1.24.0"
GJF_URL="https://github.com/google/google-java-format/releases/download/v${GJF_VERSION}/google-java-format-${GJF_VERSION}-all-deps.jar"
LOMBOK_VERSION="1.18.42"
LOMBOK_URL="https://repo1.maven.org/maven2/org/projectlombok/lombok/${LOMBOK_VERSION}/lombok-${LOMBOK_VERSION}.jar"

green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
dim()   { printf '\033[0;2m%s\033[0m\n' "$*"; }
warn()  { printf '\033[0;33m%s\033[0m\n' "$*"; }
die()   { printf '\033[0;31m%s\033[0m\n' "$*" >&2; exit 1; }

command -v mise >/dev/null || die "mise is required (installs Java 25 side by side)"
command -v java >/dev/null || die "no java on PATH; mise install java@corretto-17 first"

mkdir -p "$JDTLS_HOME" "$GJF_HOME" "$LOMBOK_HOME" "$BIN"

# --- Java 25 (only used by jdtls) -------------------------------------------
if [ ! -x "$JAVA_25/bin/java" ]; then
	dim "installing Java 25 (side-by-side, does not change the default JDK)"
	mise install java@temurin-25
else
	dim "java 25: present"
fi
[ -x "$JAVA_25/bin/java" ] || die "Java 25 missing at $JAVA_25; run: mise install java@temurin-25"

# --- JDT LS -----------------------------------------------------------------
if [ ! -x "$JDTLS_HOME/bin/jdtls" ] || [ "$FORCE" = 1 ]; then
	dim "downloading JDT LS (~49 MB)"
	curl -fsSL --max-time 900 "$JDTLS_URL" | tar xz -C "$JDTLS_HOME"
	green "✓ jdtls → $JDTLS_HOME"
else
	dim "jdtls: present"
fi

# --- google-java-format -----------------------------------------------------
if [ ! -f "$GJF_HOME/gjf.jar" ] || [ "$FORCE" = 1 ]; then
	dim "downloading google-java-format ${GJF_VERSION}"
	curl -fsSL --max-time 300 "$GJF_URL" -o "$GJF_HOME/gjf.jar"
	green "✓ google-java-format → $GJF_HOME/gjf.jar"
else
	dim "google-java-format: present"
fi

# --- Lombok agent -----------------------------------------------------------
if [ ! -f "$LOMBOK_HOME/lombok.jar" ] || [ "$FORCE" = 1 ]; then
	dim "downloading Lombok ${LOMBOK_VERSION}"
	curl -fsSL --max-time 180 "$LOMBOK_URL" -o "$LOMBOK_HOME/lombok.jar"
	green "✓ lombok → $LOMBOK_HOME/lombok.jar"
else
	dim "lombok: present"
fi

# --- wrappers ---------------------------------------------------------------
write_wrapper() {
	local target="$1" content="$2"
	if [ -f "$target" ] && [ "$FORCE" = 0 ] && cmp -s <(printf '%s' "$content") "$target"; then
		dim "$(basename "$target"): present"
		return 0
	fi
	printf '%s' "$content" >"$target"
	chmod +x "$target"
	green "✓ $target"
}

write_wrapper "$BIN/jdtls" '#!/bin/sh
# Eclipse JDT Language Server for pi-lens. JDT LS 1.64 needs JavaSE 25; the
# machine default JDK stays pinned by mise, so Java 25 is selected only here.
set -eu
JDTLS_HOME="${JDTLS_HOME:-$HOME/.local/share/jdtls}"
JAVA_25="${JDTLS_JAVA_HOME:-$HOME/.local/share/mise/installs/java/temurin-25}"
[ -x "$JDTLS_HOME/bin/jdtls" ] || { echo "jdtls: missing $JDTLS_HOME/bin/jdtls (run scripts/install-java-lsp.sh)" >&2; exit 1; }
[ -x "$JAVA_25/bin/java" ] || { echo "jdtls: missing Java 25 at $JAVA_25 (mise install java@temurin-25)" >&2; exit 1; }
JAVA_HOME="$JAVA_25"; export JAVA_HOME
exec "$JDTLS_HOME/bin/jdtls" "$@"
'

write_wrapper "$BIN/google-java-format" '#!/bin/sh
# google-java-format for pi-lens.
set -eu
JAR="${GOOGLE_JAVA_FORMAT_JAR:-$HOME/.local/share/google-java-format/gjf.jar}"
[ -f "$JAR" ] || { echo "google-java-format: missing $JAR" >&2; exit 1; }
exec java -jar "$JAR" "$@"
'

# --- verify -----------------------------------------------------------------
"$BIN/google-java-format" --version >/dev/null 2>&1 || die "google-java-format failed to run"
command -v jdtls >/dev/null || warn "jdtls is not on PATH; add ~/.local/bin to PATH"

echo
green "Java LSP ready for pi-lens"
dim "  pi-lens resolves: jdtls (PATH) · google-java-format (PATH) · lombok via PI_LENS_LOMBOK_JAR"
dim "  verify in pi: /lens-health   or edit a .java file and watch the diagnostics"
dim "  shell env needed: export PI_LENS_LOMBOK_JAR=\"\$HOME/.local/share/lombok/lombok.jar\""
