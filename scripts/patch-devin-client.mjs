#!/usr/bin/env node
// Temporary compatibility fix for pi-devin-local@0.3.0; reapply after reinstall.
// Authoritative identity: native CLI GetChatMessage, not catalog/status RPCs
// (those can emit a different identity). --check verifies files, not the live gate.
import { createHash, randomUUID } from "node:crypto";
import { constants, copyFileSync, existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ORIGINAL_SHA256 = "d8410213436857baf83809dd7368f592b1af7ebb5c50a5246254a9cb8ffd3e62";
export const PATCHED_SHA256 = "f62fc547cdf8bac39467265a8fd21df6a00a506562d40db29fa92dde05c459ab";
export const digest = (source) => createHash("sha256").update(source).digest("hex");

const prefix = String.raw`import {
  encodeMessage,
  encodeString,
  encodeTimestampBody,
  encodeVarintField,
} from "./wire.js";

// Matches native Devin CLI 3000.11.3 GetChatMessage metadata (2026-10-07).
// Desktop version/identity is gated separately by the backend.
const override = process.env.DEVIN_CLIENT_VERSION;
export const CLIENT_VERSION = override && /^\d+\.\d+\.\d+$/.test(override)
  ? override : "3000.11.3";
export const CLIENT_IDE = "devin-cli";

`;

export function patchMetadata(source) {
  if (digest(source) === PATCHED_SHA256) return source;
  if (digest(source) !== ORIGINAL_SHA256) {
    throw new Error("Unsupported Devin metadata source; refusing to overwrite local/upstream changes.");
  }
  const result = prefix + source.slice(source.indexOf("export interface MetadataInput"))
    .replace("encodeString(12, ide)", 'encodeString(12, "chisel")')
    .replace("encodeString(28, ide)", 'encodeString(28, "chisel")');
  if (digest(result) !== PATCHED_SHA256) throw new Error("Internal error: patched source checksum mismatch.");
  return result;
}

export function patchPackage(packageDir, { dryRun = false, check = false } = {}) {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  if (manifest.name !== "pi-devin-local" || manifest.version !== "0.3.0") {
    throw new Error("Only pi-devin-local@0.3.0 is supported; review newer packages before patching.");
  }
  const target = join(packageDir, "src/metadata.ts");
  const original = readFileSync(target, "utf8");
  const patched = patchMetadata(original);
  if (patched === original) return "already patched";
  if (check) throw new Error("Devin client compatibility patch is not applied.");
  if (dryRun) return "would patch";

  const backup = `${target}.pi-setup-backup`;
  if (existsSync(backup)) {
    if (digest(readFileSync(backup)) !== ORIGINAL_SHA256) {
      throw new Error("Unexpected Devin metadata backup; refusing to overwrite it.");
    }
  } else {
    copyFileSync(target, backup, constants.COPYFILE_EXCL);
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, patched, { mode: statSync(target).mode & 0o777, flag: "wx" });
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return `patched (backup: ${backup})`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let packageDir = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), "npm/node_modules/pi-devin-local");
    let dryRun = false, check = false;
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === "--dry-run") dryRun = true;
      else if (arg === "--check") check = true;
      else if (arg === "--package-dir" && process.argv[i + 1]) packageDir = resolve(process.argv[++i]);
      else throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
    if (dryRun && check) throw new Error("Use --dry-run or --check, not both.");
    console.log(`Devin: ${patchPackage(packageDir, { dryRun, check })}. Restart Pi or run /reload after applying.`);
  } catch (error) {
    console.error(`Devin patch: ${error.message}`);
    process.exitCode = 1;
  }
}
