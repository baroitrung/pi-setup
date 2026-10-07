// Run: node tests/test-devin-client.mjs
// Assert the installed wire metadata without patching: add --metadata /path/to/metadata.ts
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { digest, ORIGINAL_SHA256, PATCHED_SHA256, patchMetadata, patchPackage } from "../scripts/patch-devin-client.mjs";

// Published 0.3.0 fixture: no real credentials, catalog or provider payloads.
const original = String.raw`import { existsSync, readFileSync } from "node:fs";
import {
  encodeMessage,
  encodeString,
  encodeTimestampBody,
  encodeVarintField,
} from "./wire.js";

/**
 * Cognition gates Devin Local-only models (every GPT-5.6 variant: Sol, Terra,
 * Luna) by client ide name. With ide="windsurf" GetChatMessage rejects them
 * with "This model is only in Devin Local."; with ide="devin-desktop" the
 * server serves them and the response header echoes the exact model
 * (verified: "GPT-5.6 Sol High Thinking" for gpt-5-6-sol-high, 2026-08-29).
 */
// Verified against Devin Desktop 3.10.27 during the 0.3.0 protocol audit.
const FALLBACK_WINDSURF_VERSION = "3.10.27";
const PRODUCT_JSON =
  "/Applications/Devin.app/Contents/Resources/app/product.json";

function desktopWindsurfVersion(): string {
  const override = process.env.DEVIN_CLIENT_VERSION;
  if (override && /^\d+\.\d+\.\d+$/.test(override)) return override;
  try {
    if (!existsSync(PRODUCT_JSON)) return FALLBACK_WINDSURF_VERSION;
    const product = JSON.parse(readFileSync(PRODUCT_JSON, "utf8")) as {
      windsurfVersion?: string;
    };
    return product.windsurfVersion || FALLBACK_WINDSURF_VERSION;
  } catch {
    return FALLBACK_WINDSURF_VERSION;
  }
}

export const CLIENT_VERSION = desktopWindsurfVersion();
export const CLIENT_IDE = "devin-desktop";

export interface MetadataInput {
  apiKey: string;
  userJwt?: string;
  sessionId: string;
  requestId: bigint;
  triggerId: string;
  version?: string;
  ide?: string;
}

export function buildMetadata(input: MetadataInput): Buffer {
  const version = input.version ?? CLIENT_VERSION;
  const ide = input.ide ?? CLIENT_IDE;
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "windows"
        : "linux";
  const parts: Buffer[] = [
    encodeString(1, ide),
    encodeString(2, version),
    encodeString(3, input.apiKey),
    encodeString(4, "en"),
    encodeString(5, os),
    encodeString(7, version),
    encodeVarintField(9, input.requestId),
    encodeString(10, input.sessionId),
    encodeString(12, ide),
    encodeMessage(16, encodeTimestampBody()),
    encodeString(25, input.triggerId),
    encodeString(26, "Unset"),
    encodeString(28, ide),
  ];
  if (input.userJwt) parts.push(encodeString(21, input.userJwt));
  return Buffer.concat(parts);
}
`;

const packageDir = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), "npm/node_modules/pi-devin-local");
const metadataFlag = process.argv.indexOf("--metadata");
const wirePath = join(metadataFlag < 0 ? join(packageDir, "src") : dirname(process.argv[metadataFlag + 1]), "wire.ts");
const wireUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(readFileSync(wirePath, "utf8"))).toString("base64")}`;
const { iterFields } = await import(wireUrl);
let imports = 0;
async function loadMetadata(source, override) {
  const previous = process.env.DEVIN_CLIENT_VERSION;
  try {
    if (override === undefined) delete process.env.DEVIN_CLIENT_VERSION;
    else process.env.DEVIN_CLIENT_VERSION = override;
    const js = stripTypeScriptTypes(source).replace('"./wire.js"', JSON.stringify(wireUrl));
    return await import(`data:text/javascript;base64,${Buffer.from(`${js}\n// import ${imports++}`).toString("base64")}`);
  } finally {
    if (previous === undefined) delete process.env.DEVIN_CLIENT_VERSION;
    else process.env.DEVIN_CLIENT_VERSION = previous;
  }
}
const input = { apiKey: "fixture-api-key", userJwt: "fixture-jwt", sessionId: "fixture-session", requestId: 123n, triggerId: "fixture-trigger" };
function assertMetadata(module, version = "3000.11.3") {
  const fields = new Map([...iterFields(module.buildMetadata(input))].map(({ num, value }) => [num, Buffer.isBuffer(value) ? value.toString("utf8") : value]));
  assert.equal(fields.get(1), "devin-cli", "wire IDE must match native GetChatMessage, not Desktop");
  assert.equal(fields.get(2), version);
  assert.equal(fields.get(7), version);
  assert.equal(fields.get(12), "chisel", "extension identity differs from IDE identity");
  assert.equal(fields.get(28), "chisel", "chat RPC includes extension identity field28");
  assert.equal(fields.get(5), process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux");
  for (const [number, value] of [[3, input.apiKey], [9, input.requestId], [10, input.sessionId], [21, input.userJwt], [25, input.triggerId]]) {
    assert.equal(fields.get(number), value, `preserve field ${number}`);
  }
}

if (metadataFlag >= 0) {
  assertMetadata(await loadMetadata(readFileSync(process.argv[metadataFlag + 1], "utf8")));
  console.log("PASS: installed Devin CLI identity and version on the protobuf wire");
} else {
  assert.equal(digest(original), ORIGINAL_SHA256, "fixture must exactly match published source");
  const patched = patchMetadata(original);
  assert.equal(digest(patched), PATCHED_SHA256);
  // Red/green with the same wire assertion: old code must fail, patched code must pass.
  const oldModule = await loadMetadata(original);
  assert.throws(() => assertMetadata(oldModule), /wire IDE must match native GetChatMessage/);
  assertMetadata(await loadMetadata(patched));
  assertMetadata(await loadMetadata(patched, "3000.12.0"), "3000.12.0");
  assertMetadata(await loadMetadata(patched, "invalid"));
  assert.equal(patchMetadata(patched), patched, "patch is idempotent");
  assert.throws(() => patchMetadata(`${original}\n// local change`), /Unsupported/);

  const root = mkdtempSync(join(tmpdir(), "devin-patch-test-"));
  try {
    mkdirSync(join(root, "src"));
    const manifestPath = join(root, "package.json"), target = join(root, "src/metadata.ts"), backup = `${target}.pi-setup-backup`;
    const manifest = { name: "pi-devin-local", version: "0.3.0" };
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(target, original);
    assert.equal(patchPackage(root, { dryRun: true }), "would patch");
    assert.deepEqual(readdirSync(join(root, "src")), ["metadata.ts"]);
    assert.equal(readFileSync(target, "utf8"), original);
    assert.throws(() => patchPackage(root, { check: true }), /not applied/);
    assert.match(patchPackage(root), /^patched/);
    assert.equal(readFileSync(backup, "utf8"), original);
    assert.equal(readFileSync(target, "utf8"), patched);
    assert.equal(patchPackage(root), "already patched");
    assert.equal(patchPackage(root, { check: true }), "already patched");
    assert.deepEqual(readdirSync(join(root, "src")).sort(), ["metadata.ts", "metadata.ts.pi-setup-backup"]);
    writeFileSync(target, `${original}\n// custom change`);
    assert.throws(() => patchPackage(root), /Unsupported/);
    assert.equal(readFileSync(target, "utf8"), `${original}\n// custom change`);
    writeFileSync(target, original);
    writeFileSync(backup, "unexpected backup");
    assert.throws(() => patchPackage(root), /Unexpected/);
    assert.equal(readFileSync(target, "utf8"), original);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "0.4.0" }));
    assert.throws(() => patchPackage(root), /Only pi-devin-local/);
    assert.equal(readFileSync(target, "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log("PASS: Devin wire red/green, version override, auth preservation, idempotency, dry-run, backup and refusal guards");
}
