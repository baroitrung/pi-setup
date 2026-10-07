// Real Pi components, no model or clipboard calls. Run: node tests/test-code-block.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const install = join(homedir(), ".pi/agent/install");
const modules = process.env.PI_NODE_MODULES || join(install, "releases", readFileSync(join(install, "current-version"), "utf8").trim(), "node_modules");
const agent = join(modules, "@earendil-works/pi-coding-agent");
const load = (file) => import(pathToFileURL(file).href);
const { createJiti } = await load(join(modules, "jiti/lib/jiti.mjs"));
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": join(agent, "dist/index.js"),
	"@earendil-works/pi-tui": join(modules, "@earendil-works/pi-tui/dist/index.js"),
} });
const { default: extension, fences, CodeBlock, installMarkdownAdapter, renderWithCodeBlockPaint } = await jiti.import(process.env.CODE_BLOCK_SOURCE || resolve("extensions/code-block.ts"));
const { default: compact } = await jiti.import(process.env.COMPACT_TOOLS_SOURCE || resolve("extensions/compact-tools.ts"));
const { backgroundAnsi, colorToRgb, mixColors, rgbColor, Markdown, Text, visibleWidth, stripTerminalSequences: plain } = await load(join(modules, "@earendil-works/pi-tui/dist/index.js"));
const { getMarkdownTheme, setTerminalColors, setTheme, theme } = await load(join(agent, "dist/modes/interactive/theme/theme.js"));
const { AssistantMessageComponent } = await load(join(agent, "dist/modes/interactive/components/assistant-message.js"));
const { ToolExecutionComponent } = await load(join(agent, "dist/modes/interactive/components/tool-execution.js"));
const { withBuiltInRenderers } = await load(join(agent, "dist/core/tools/renderers/index.js"));
const key = Symbol.for("pi-setup.code-block.runtime");
const original = { render: Markdown.prototype.render, token: Markdown.prototype.renderToken, mouse: Markdown.prototype.handleMouse };
const handlers = new Map(), commands = new Map();
let transformer, resolver;
const notifications = [];
const ctx = { mode: "tui", ui: { get theme() { return theme; }, notify: (...args) => notifications.push(args), setToolsExpanded() {} } };
const api = { registerFlag() {}, getFlag: () => false, registerMarkdownTransformer: (fn) => { transformer = fn; },
	registerCommand: (name, command) => commands.set(name, command), on: (name, handler) => handlers.set(name, handler) };
extension(api);
const copied = [];
const start = () => {
	handlers.get("session_start")({}, ctx);
	assert.notEqual(Markdown.prototype.renderToken, original.token, "adapter must activate on supported Pi");
	globalThis[key].copy = async (code) => { copied.push(code); };
};
start();
const terminalBackground = rgbColor(40, 44, 52);
setTerminalColors({ background: { r: 40, g: 44, b: 52 }, foreground: { r: 229, g: 231, b: 235 } });
const stop = () => handlers.get("session_shutdown")({}, ctx);
const render = (component, width = 80) => component.render(width).map(plain);
const clickCopy = (component, width = 80, index = 0) => {
	const lines = render(component, width);
	const headers = lines.map((line, y) => ({ line, y })).filter(({ line }) => /\[Cop(?:y(?:ing)?|ied)\]/.test(line));
	assert(headers[index], "copy header exists");
	const { line, y } = headers[index];
	return component.handleMouse({ type: "click", button: "left", x: line.indexOf("[Cop") + 1, y,
		width, height: lines.length, shift: false, alt: false, ctrl: false });
};
// Track actual cell styling; visible border text alone cannot prove a gap-free fill.
const cells = (line) => {
	const result = [];
	let background = "default", overline = false, offset = 0;
	const append = (text) => result.push(...Array.from({ length: visibleWidth(plain(text)) }, () => ({ background, overline })));
	for (const match of line.matchAll(/\x1b\[[\d;]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g)) {
		append(line.slice(offset, match.index));
		if (match[0].startsWith("\x1b[")) {
			const parameters = match[0].slice(2, -1);
			const codes = parameters === "" ? [0] : parameters.split(";").map(Number);
			for (let i = 0; i < codes.length; i++) {
				const code = codes[i];
				if (code === 38 || code === 48 || code === 58) {
					const count = codes[i + 1] === 2 ? 5 : codes[i + 1] === 5 ? 3 : 1;
					if (code === 48) background = `\x1b[${codes.slice(i, i + count).join(";")}m`;
					i += count - 1;
				} else if (code === 0) { background = "default"; overline = false; }
				else if (code === 49) background = "default";
				else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) background = `\x1b[${code}m`;
				else if (code === 53) overline = true;
				else if (code === 55) overline = false;
			}
		}
		offset = match.index + match[0].length;
	}
	append(line.slice(offset));
	return result;
};
// Paired controls prove a tinted border and an unfilled reset are detectable.
assert.deepEqual(cells("\x1b[44m▕ \x1b[49m▏").map((cell) => cell.background), ["\x1b[44m", "\x1b[44m", "default"]);
assert.deepEqual(cells("\x1b[53m \x1b[55m ").map((cell) => cell.overline), [true, false]);
const expectedBackground = () => backgroundAnsi(mixColors(terminalBackground,
	mixColors(theme.colors.toolPendingBg, theme.colors.text, 0.06, "srgb"), 0.15, "srgb"), theme.getColorMode());
const assertFill = (component, width = 80) => {
	const raw = component.render(width);
	const output = raw.map(plain);
	assert(output[0].startsWith("▕") && output[0].endsWith("▏"), "edge strokes touch the interior; no centered/rounded border cells");
	for (const line of raw.slice(0, -1)) {
		assert.deepEqual(cells(line).map((cell) => cell.background), ["default", ...Array(width - 2).fill(expectedBackground()), "default"], "every interior cell is tinted, both outside border cells stay default");
	}
	assert.deepEqual(cells(raw.at(-1)).map((cell) => cell.background), Array(width).fill("default"), "nothing below the bottom rule is tinted");
	assert.deepEqual(cells(raw.at(-1)).map((cell) => cell.overline), [false, ...Array(width - 2).fill(true), false], "bottom rule is at the top edge of unpainted cells");
	const header = cells(raw[0]);
	assert(!header[0].overline && !header.at(-1).overline);
	const titleColumn = output[0].indexOf("typescript"), actionColumn = output[0].indexOf("[Cop");
	assert(titleColumn >= 0 && actionColumn >= 0);
	assert(!header.slice(titleColumn, titleColumn + 10).some((cell) => cell.overline), "top rule doesn't cross the label");
	assert(!header.slice(actionColumn, actionColumn + 6).some((cell) => cell.overline), "top rule doesn't cross Copy");
	assert(header.slice(titleColumn + 10, actionColumn).some((cell) => cell.overline), "top stroke exists between metadata and action");
};
// Header must live on the top stroke, not consume a row plus a divider.
setTheme("dark");
const borderFixture = new CodeBlock(new Text("first line\nsecond line", 0, 0), "first line\nsecond line", "typescript", "✓ Complete");
const borderLines = render(borderFixture);
assert(borderLines[0].startsWith("▕") && borderLines[0].includes("typescript") && borderLines[0].includes("[Copy]"), "language/status/copy are embedded in the top border");
assertFill(borderFixture);
const nestedColors = new CodeBlock(new Text("\x1b[44mA\x1b[49mB\x1b[0mC\x1b[0;48;2;3;4;5mD\x1b[39;49mE\x1b[38;2;49;0;53mF", 0, 0), "ABCDEF", "typescript", "Complete");
const nestedBody = nestedColors.render(80)[1];
assert.deepEqual(cells(nestedBody).slice(2, 8).map((cell) => cell.background), ["\x1b[44m", expectedBackground(), expectedBackground(), "\x1b[48;2;3;4;5m", expectedBackground(), expectedBackground()], "native nested backgrounds survive only their cells; simple/combined resets restore the code tint and RGB channels aren't reset codes");
assert(cells(nestedBody)[0].background === "default" && cells(nestedBody).at(-1).background === "default");
const scoped = renderWithCodeBlockPaint(() => borderFixture.render(80));
assert.equal(scoped.ownedRows.size, 4, "paint ownership records only this render's code rows");
assert.equal(globalThis[key].paintScope, undefined, "no paint ownership leaks past a synchronous render");
assert.throws(() => renderWithCodeBlockPaint(() => { throw new Error("probe render"); }), /probe render/);
assert.equal(globalThis[key].paintScope, undefined, "throwing renders also release paint ownership");
assert.equal(borderLines.length, 4, "two code lines need only top/body/body/bottom, with no header or divider row");
assert(borderLines[1].includes("first line"), "code starts immediately under the top border");
const borderCopyX = borderLines[0].indexOf("[Copy]") + 1;
const borderEvent = { type: "click", button: "left", x: borderCopyX, y: 1, width: 80, height: 4, shift: false, alt: false, ctrl: false };
assert.equal(borderFixture.handleMouse(borderEvent), undefined, "old header row is now code, not a copy target");
assert(borderFixture.handleMouse({ ...borderEvent, y: 0 })?.handled, "top-border copy is clickable");
await new Promise((resolve) => setImmediate(resolve));
const wideHeading = new CodeBlock(new Text("body", 0, 0), "body", "模型🙂typescript", "✓ Complete");
const pendingHeading = new CodeBlock(new Text("body", 0, 0), "body", "typescript", "● Generating", undefined, undefined, undefined, { pending: true });
for (const width of [16, 17, 20, 32, 33, 40, 80]) {
	for (const item of [borderFixture, wideHeading, pendingHeading]) {
		const lines = item.render(width);
		assert(lines.every((line) => visibleWidth(line) === width), `label and copy feedback align both borders at width ${width}`);
	}
}
let bodyClick;
const clickableBody = new CodeBlock({ render: () => ["native body"], invalidate() {}, handleMouse(event) { bodyClick = event; return { handled: true }; } }, "native body", "text", "Done");
render(clickableBody);
assert(clickableBody.handleMouse({ type: "click", button: "left", x: 3, y: 1, width: 80, height: 3, shift: false, alt: false, ctrl: false })?.handled);
assert.equal(bodyClick.x, 1); assert.equal(bodyClick.y, 0); assert.equal(bodyClick.height, 1);
const source = "Before\n\n```typescript path=src/demo.ts\n\tconst hello = '模型🙂';\n\nconsole.log(hello);\n```\n\nAfter";
const message = { role: "assistant", content: [{ type: "text", text: source }], stopReason: "stop" };
const assistant = () => new AssistantMessageComponent(message, true, getMarkdownTheme(), "Thinking...", 1, [transformer]);
for (const name of ["dark", "light", "system"]) {
	setTheme(name);
	assertFill(new CodeBlock(new Text("colored\n\x1b[0mreset\x1b[39;49m remains filled", 0, 0), "source", "typescript", "✓ Complete"));
	const base = colorToRgb(terminalBackground);
	const target = colorToRgb(mixColors(theme.colors.toolPendingBg, theme.colors.text, 0.06, "srgb"));
	const reduced = colorToRgb(mixColors(terminalBackground, mixColors(theme.colors.toolPendingBg, theme.colors.text, 0.06, "srgb"), 0.15, "srgb"));
	for (const channel of ["r", "g", "b"]) assert(Math.abs(reduced[channel] - base[channel]) <= Math.abs(target[channel] - base[channel]), "15% tint is closer to the terminal background");
	const component = assistant();
	const output = render(component).join("\n");
	assert(output.includes("▕") && output.includes("✓ Complete") && output.includes("typescript"));
	assert(!output.includes("src/demo.ts"), "paths hidden by default");
	assert(!output.includes("```"), "native fence delimiters replaced");
	assert(output.includes("Before") && output.includes("After") && output.includes("模型🙂"));
	assert(!/▕\s*\d+\s/.test(output), "no line numbers added");
	assert(clickCopy(component)?.handled, "real assistant Container routes click to Markdown");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(copied.at(-1), "\tconst hello = '模型🙂';\n\nconsole.log(hello);", "copy preserves tabs, Unicode, blank lines and excludes frame/path");
	assert(render(component).join("\n").includes("[Copied]"), "assistant copy feedback survives redraw");
	for (const width of [1, 4, 15, 16, 20, 40, 80, 120]) {
		component.invalidate();
		assert(component.render(width).every((line) => visibleWidth(line) <= width), `${name} width ${width}`);
	}
	console.log(`PASS ${name}: real assistant rendering, source copy and widths`);
}
const component = assistant();
render(component);
await commands.get("codeblock-path").handler("on", ctx);
assert(render(component).join("\n").includes("src/demo.ts"));
await commands.get("codeblock-path").handler("off", ctx);
assert(!render(component).join("\n").includes("src/demo.ts"));
const streamed = assistant();
streamed.updateContent({ ...message, content: [{ type: "text", text: "```js\nconst x = 1" }] }, true);
assert(render(streamed).join("\n").includes("Generating"));
assert(render(streamed).join("\n").includes("▌"), "open streaming code has a caret that is not copied");
assert(clickCopy(streamed)?.handled);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(copied.at(-1), "const x = 1");
streamed.updateContent({ ...message, content: [{ type: "text", text: "```js\nconst x = 12\n```" }] }, false);
assert(render(streamed).join("\n").includes("Complete"));
assert(clickCopy(streamed)?.handled);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(copied.at(-1), "const x = 12", "stream copy is not stale");
const multi = new AssistantMessageComponent({ ...message, content: [{ type: "text", text: "```js\none\n```\n\n```js\ntwo\n```" }] }, true, getMarkdownTheme(), "Thinking...", 1, [transformer]);
assert(clickCopy(multi, 80, 1)?.handled);
await new Promise((resolve) => setImmediate(resolve));
assert.equal(copied.at(-1), "two");
const nested = new Markdown("> ```js\n> nested\n> ```\n\n- list\n\n  ```js\n  listed\n  ```", 0, 0, getMarkdownTheme(), undefined,
	{ transform: (text, availableWidth) => transformer(text, { messageType: "assistant", isStreaming: false, availableWidth }) });
assert(render(nested).join("\n").includes("```js"), "nested blocks intentionally retain native layout");
const user = new Markdown("```js\nuser input\n```", 0, 0, getMarkdownTheme(), undefined,
	{ transform: (text, availableWidth) => transformer(text, { messageType: "user", isStreaming: false, availableWidth }) });
assert(render(user).join("\n").includes("```js"), "do not change user message blocks");
assert.deepEqual(fences("~~~~ts path=a.ts\n```\n~~~~"), [{ code: "```", language: "ts", path: "a.ts", open: false }]);
assert.equal(fences("```\nhello\n")[0].code, "hello");
assert.equal(fences("```\nhello\n\n```")[0].code, "hello\n");
assert.equal(fences("   ```js\n   hello\n   ```")[0].code, "hello");
assert.deepEqual(fences("<!--\n```js\nnot code\n```\n-->"), [], "HTML comment fences are not code");
const nestedThenTop = "- list\n\n  ```js path=nested.ts\n  same\n  ```\n\n```js path=top.ts\nsame\n```";
assert.deepEqual(fences(nestedThenTop).map((fence) => fence.path), ["top.ts"]);
await commands.get("codeblock-path").handler("on", ctx);
const metadata = new AssistantMessageComponent({ ...message, content: [{ type: "text", text: nestedThenTop }] }, true, getMarkdownTheme(), "Thinking...", 1, [transformer]);
const metadataHeader = render(metadata).find((line) => line.includes("[Copy]"));
assert(metadataHeader.includes("top.ts") && !metadataHeader.includes("nested.ts"), "nested code cannot steal top-level path metadata");
await commands.get("codeblock-path").handler("off", ctx);
for (const tail of ["`", "``", "```", "~", "~~", "~~~"]) {
	const marker = tail[0].repeat(3);
	const partial = new AssistantMessageComponent({ ...message, content: [{ type: "text", text: `${marker}js\nconst x=1\n${tail}` }] }, true, getMarkdownTheme(), "Thinking...", 1, [transformer]);
	partial.updateContent(partial.lastMessage, true);
	assert(render(partial).join("\n").includes("[Copy]"), `partial closer ${tail} does not flicker to native`);
	assert(clickCopy(partial)?.handled);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(copied.at(-1), "const x=1");
}
const retained = Array.from({ length: 501 }, () => assistant());
for (const item of retained) render(item);
await commands.get("codeblock-path").handler("on", ctx);
assert(render(retained[0]).join("\n").includes("src/demo.ts"), "path revision bypasses old render cache even after tracking-index eviction");
await commands.get("codeblock-path").handler("off", ctx);
let releasePending;
let pendingCalls = 0;
globalThis[key].copy = () => { pendingCalls++; return new Promise((resolve) => { releasePending = resolve; }); };
const pendingAssistant = assistant();
assert(clickCopy(pendingAssistant)?.handled);
assert(render(pendingAssistant).join("\n").includes("[Copying]"));
assert(clickCopy(pendingAssistant)?.handled);
assert.equal(pendingCalls, 1, "pending copy survives redraw and ignores duplicate click");
releasePending();
await new Promise((resolve) => setImmediate(resolve));
assert(render(pendingAssistant).join("\n").includes("[Copied]"));
globalThis[key].copy = async (code) => { copied.push(code); };
let choices;
const copyCtx = { ...ctx, sessionManager: { getBranch: () => [
	{ type: "message", message: { role: "assistant", content: [
		{ type: "text", text: "<!--\n```js\nnot code\n```\n-->\n\n```js\nreal code\n```" },
		{ type: "toolCall", id: "edit-copy", name: "edit", arguments: { path: "a.ts" } },
	] } },
	{ type: "message", message: { role: "toolResult", toolCallId: "edit-copy", content: [{ type: "text", text: "success" }], details: { diff: "-1 a\n+1 b" } } },
] }, ui: { ...ctx.ui, select: async (_title, options) => { choices = options; return options[0]; } } };
await commands.get("code-copy").handler("", copyCtx);
assert.equal(choices.length, 2, "keyboard picker excludes non-code HTML content");
assert.equal(copied.at(-1), "- a\n+ b", "keyboard copy uses numberless edit source");
compact({ registerToolRenderer: (fn) => { resolver = fn; }, on() {} });
for (const tool of ["read", "bash", "write", "edit"]) {
	const args = tool === "bash" ? { command: "echo hi" } : tool === "write" ? { path: "sample.ts", content: "\tconst written = 1;" }
		: tool === "edit" ? { path: "sample.ts", edits: [{ oldText: "a", newText: "b" }] } : { path: "sample.ts" };
	const result = { content: [{ type: "text", text: "\tconst hello = '模型🙂';" }], details: tool === "edit" ? { diff: "-1 a\n+1 b", firstChangedLine: 1 } : undefined };
	const snapshot = JSON.stringify({ args, result });
	const toolComponent = new ToolExecutionComponent(tool, `id-${tool}`, args, { showImages: false }, resolver(tool, () => withBuiltInRenderers(tool)), { requestRender() {} }, process.cwd());
	toolComponent.markExecutionStarted();
	toolComponent.updateResult(result, false);
	assert(!render(toolComponent).join("\n").includes("[Copy]"), "collapsed tools stay compact");
	toolComponent.setExpanded(true);
	assert(render(toolComponent).join("\n").includes("[Copy]"), `${tool} expanded panel has copy`);
	const toolHeader = toolComponent.render(80).find((line) => plain(line).includes("[Copy]"));
	const toolHeaderText = plain(toolHeader), codeStart = toolHeaderText.indexOf("▕", toolHeaderText.indexOf("▕") + 1);
	const codeEnd = toolHeaderText.lastIndexOf("▏", toolHeaderText.lastIndexOf("▏") - 1);
	const toolCells = cells(toolHeader);
	assert.equal(toolCells[codeStart].background, "default", "nested codeblock's left stroke remains untinted");
	assert.equal(toolCells[codeEnd].background, "default", "nested codeblock's right stroke remains untinted");
	assert(toolCells.slice(codeStart + 1, codeEnd).every((cell) => cell.background === expectedBackground()), `${tool} parent panel must not flatten the codeblock's reduced tint`);
	assert(clickCopy(toolComponent)?.handled, `${tool} real nested mouse routing`);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(copied.at(-1), tool === "write" ? args.content : tool === "edit" ? "- a\n+ b" : result.content[0].text);
	assert(render(toolComponent).join("\n").includes("[Copied]"), "tool copy feedback survives invalidation");
	if (tool === "edit") {
		const code = render(toolComponent).slice(3).join("\n");
		assert(!code.includes("-1 a") && !code.includes("+1 b"), "native diff line numbers removed");
		assert(!code.includes("edit sample.ts"), "native call title/path not duplicated in code body");
	}
	for (const width of [0, 1, 4, 5, 15, 16, 20, 40, 80]) {
		assert(toolComponent.render(width).every((line) => visibleWidth(line) <= width), `${tool} width ${width}`);
	}
	toolComponent.updateResult(result, true);
	assert(render(toolComponent).join("\n").includes("Running"));
	toolComponent.updateResult({ ...result, isError: true }, false);
	if (["read", "bash"].includes(tool)) assert(render(toolComponent).join("\n").includes("Error"));
	assert.equal(JSON.stringify({ args, result }), snapshot, "model-facing payload unchanged");
}
// A scoped code row preserves intentional nested colors; unrelated equal colors don't gain ownership.
const nestedTool = new ToolExecutionComponent("bash", "nested-bg", { command: "colors" }, { showImages: false }, resolver("bash", () => ({
	renderResult: () => new Text("\x1b[44mA\x1b[49mB", 0, 0),
})), { requestRender() {} }, process.cwd());
nestedTool.updateResult({ content: [{ type: "text", text: "AB" }], details: {} }, false);
nestedTool.setExpanded(true);
const nestedToolLine = nestedTool.render(80).find((line) => plain(line).includes("AB"));
const nestedA = plain(nestedToolLine).indexOf("AB");
assert.equal(cells(nestedToolLine)[nestedA].background, "\x1b[44m", "nested ANSI override survives composed tool rendering");
assert.equal(cells(nestedToolLine)[nestedA + 1].background, expectedBackground(), "reset inside composed tool restores code tint");
const unrelated = new ToolExecutionComponent("unrelated", "unrelated-bg", {}, { showImages: false }, resolver("unrelated", () => ({
	renderResult: () => new Text(expectedBackground() + "UNRELATED" + "\x1b[49m", 0, 0),
})), { requestRender() {} }, process.cwd());
unrelated.updateResult({ content: [{ type: "text", text: "UNRELATED" }], details: {} }, false);
unrelated.setExpanded(true);
const unrelatedLine = unrelated.render(80).find((line) => plain(line).includes("UNRELATED"));
const unrelatedBg = cells(unrelatedLine)[plain(unrelatedLine).indexOf("UNRELATED")].background;
const parentBackground = backgroundAnsi(mixColors(terminalBackground, mixColors(theme.colors.toolPendingBg, theme.colors.text, 0.06, "srgb"), 0.3, "srgb"), theme.getColorMode());
assert.equal(unrelatedBg, parentBackground, "unrelated/plugin output still gets native background flattening, even if it uses the same color as a codeblock");
assert.notEqual(unrelatedBg, expectedBackground(), "color coincidence never grants paint ownership");
assert.equal(globalThis[key].paintScope, undefined);
let redraws = 0;
const block = new CodeBlock(new Text("source", 0, 0), "raw source", "text", "✓ Complete", undefined, () => redraws++);
render(block);
globalThis[key].copy = async () => { throw new Error("clipboard unavailable"); };
await block.copy();
assert(notifications.some(([text, kind]) => text.includes("clipboard unavailable") && kind === "error"));
assert(redraws > 0);
// A pending mouse copy must not notify/redraw a stale context after reload.
let finishReloadCopy;
let staleTouched = 0;
globalThis[key].copy = () => new Promise((resolve) => { finishReloadCopy = resolve; });
globalThis[key].notify = () => { staleTouched++; throw new Error("stale ctx"); };
const reloading = new CodeBlock(new Text("reload", 0, 0), "reload", "text", "Complete", undefined, () => {});
render(reloading);
assert(clickCopy(reloading)?.handled);
stop();
finishReloadCopy();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(staleTouched, 0, "outstanding copy never accesses old context after teardown");
assert.equal(Markdown.prototype.render, original.render);
assert.equal(Markdown.prototype.renderToken, original.token);
assert.equal(Markdown.prototype.handleMouse, original.mouse);
// The managed CLI embeds minified Pi classes; spacing must not break the guard.
const renderString = String(original.render), tokenString = String(original.token);
original.render.toString = () => renderString.replace('replace(/\\t/g, "   ")', 'replace(/\\t/g,"   ")');
original.token.toString = () => tokenString.replace('case "code"', 'case"code"');
try { const minified = installMarkdownAdapter(); assert(minified, "minified embedded renderer is supported"); minified.restore(); }
finally { delete original.render.toString; delete original.token.toString; }
start(); stop();
for (const mode of ["rpc", "print", "json"]) {
	handlers.get("session_start")({}, { ...ctx, mode });
	assert.equal(Markdown.prototype.renderToken, original.token, `${mode} stays native`);
	assert.equal(globalThis[key], undefined);
}
const savedToken = Markdown.prototype.renderToken;
Markdown.prototype.renderToken = () => [];
assert.equal(installMarkdownAdapter(), undefined, "unsupported renderer falls back without patching");
Markdown.prototype.renderToken = undefined;
assert.equal(installMarkdownAdapter(), undefined, "missing private renderer method keeps native rendering");
Markdown.prototype.renderToken = savedToken;
original.render.toString = () => "unknown-renderer-shape";
try {
	handlers.get("session_start")({}, ctx);
	assert.equal(Markdown.prototype.render, original.render, "declined adapter leaves native render method untouched");
	assert.equal(Markdown.prototype.renderToken, original.token);
	assert(render(new Markdown("```js\nnative still works\n```", 0, 0, getMarkdownTheme())).join("\n").includes("```js"), "guard failure remains usable, native, and does not throw");
	assert(notifications.some(([text, kind]) => text.includes("unsupported") && kind === "warning"));
	stop();
} finally { delete original.render.toString; }
console.log("PASS path toggle, streaming, nested/user fallback, multiple blocks, raw tool copy, errors, teardown/reload, non-TUI, compatibility guard");
