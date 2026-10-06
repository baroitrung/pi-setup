// Run from the repository root: node tests/test-compact-tools.mjs
// Uses Pi's actual ToolExecutionComponent and mouse dispatch; no model calls.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const install = join(homedir(), ".pi/agent/install");
const modules = process.env.PI_NODE_MODULES || join(install, "releases",
	readFileSync(join(install, "current-version"), "utf8").trim(), "node_modules");
const agent = join(modules, "@earendil-works/pi-coding-agent");
const load = (path) => import(pathToFileURL(path).href);
const { createJiti } = await load(join(modules, "jiti/lib/jiti.mjs"));
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": join(agent, "dist/index.js"),
	"@earendil-works/pi-tui": join(modules, "@earendil-works/pi-tui/dist/index.js"),
} });
const { default: extension } = await jiti.import(process.env.COMPACT_TOOLS_SOURCE || resolve("extensions/compact-tools.ts"));
const { backgroundAnsi, colorToRgb, mixColors, rgbColor, stripTerminalSequences, Text, visibleWidth } = await load(join(modules, "@earendil-works/pi-tui/dist/index.js"));
const { loadThemeFromPath, setTerminalColors, setTheme, setThemeInstance, theme: activeTheme } = await load(join(agent, "dist/modes/interactive/theme/theme.js"));
let terminalBackground = rgbColor(40, 44, 52); // Reporter screenshot: #282c34.
setTerminalColors({ background: { r: 40, g: 44, b: 52 }, foreground: { r: 229, g: 231, b: 235 } });
const { withBuiltInRenderers } = await load(join(agent, "dist/core/tools/renderers/index.js"));
const { ToolExecutionComponent } = await load(join(agent, "dist/modes/interactive/components/tool-execution.js"));
const handlers = new Map();
let resolver;
extension({ registerToolRenderer: (fn) => { resolver = fn; }, on: (name, fn) => handlers.set(name, fn) });
let collapsed = 0;
handlers.get("session_start")({}, { mode: "tui", ui: { setToolsExpanded: (value) => { assert.equal(value, false); collapsed++; } } });
for (const mode of ["rpc", "print", "json"]) handlers.get("session_start")({}, { mode, ui: { setToolsExpanded() { assert.fail("non-TUI mutation"); } } });
assert.equal(collapsed, 1);
const plain = stripTerminalSequences;
const nonempty = (component, width = 120) => component.render(width).map(plain).filter((line) => line.trim());
const click = (component) => component.handleMouse({ type: "click", button: "left", x: 1, y: 1,
	width: 120, height: component.render(120).length, shift: false, alt: false, ctrl: false });
const ui = { requestRender() {} };
const panelTint = () => mixColors(activeTheme.colors.toolPendingBg, activeTheme.colors.text, 0.06, "srgb");
const panelBackground = () => backgroundAnsi(mixColors(terminalBackground, panelTint(), 0.3, "srgb"), activeTheme.getColorMode());
const assertFrame = (component, width = 120) => {
	const lines = nonempty(component, width);
	assert.equal(lines[1], ` ${"▁".repeat(width - 2)} `, "top stroke touches the next row's interior");
	assert.equal(lines.at(-1), ` ${"▔".repeat(width - 2)} `, "bottom stroke touches the previous row's interior");
	assert(lines.slice(2, -1).every((line) => line.startsWith("▕ ") && line.endsWith(" ▏") && visibleWidth(line) === width),
		"content has aligned side borders");
	const background = panelBackground();
	assert(background !== "\x1b[49m", "dim background is explicit even for the system theme");
	const raw = component.render(width).filter((line) => plain(line).trim());
	assert(!raw[0].includes(background), "summary header keeps its normal background");
	assert(!raw[1].includes(background) && !raw.at(-1).includes(background), "border caps have no panel background");
	const left = activeTheme.fg("borderMuted", "▕"), right = activeTheme.fg("borderMuted", "▏");
	assert(raw.slice(2, -1).every((line) => line.startsWith(left + background) && line.endsWith("\x1b[49m" + right)),
		"one interior surface fills padding and output, but never the border cells");
	const interiors = raw.slice(2, -1).map((line) => line.slice(left.length, -right.length));
	assert(interiors.every((line) => [...line.matchAll(/\x1b\[(?:0|49)?m/g)].every((match) =>
		match.index + match[0].length === line.length || line.startsWith(background, match.index + match[0].length))),
		"native ANSI resets restore the interior surface only");
};

const modernDarkPath = join(homedir(), ".pi/agent/git/github.com/mitsuhiko/agent-stuff/themes/modern-dark.json");
const themes = ["dark", "light", "system", ...(existsSync(modernDarkPath) ? ["modern-dark"] : [])];
const selectTheme = (name) => name === "modern-dark" ? setThemeInstance(loadThemeFromPath(modernDarkPath)) : setTheme(name);
for (const theme of themes) {
	selectTheme(theme);
	const base = colorToRgb(terminalBackground), tint = colorToRgb(panelTint());
	const mixed = colorToRgb(mixColors(terminalBackground, panelTint(), 0.3, "srgb"));
	for (const channel of ["r", "g", "b"]) assert(Math.abs(mixed[channel] - base[channel]) <= Math.abs(tint[channel] - base[channel]),
		"30% tint is closer to the actual terminal background than the old opaque surface");
	for (const [name, args] of [
		["read", { path: "sample.ts" }], ["bash", { command: "npm test\necho done" }],
		["write", { path: "sample.ts", content: "HIDDEN WRITE CONTENT\nmore" }],
		["edit", { path: "sample.ts", edits: [{ oldText: "a", newText: "b" }] }],
		["lsp_diagnostics", { path: "sample.ts" }], ["mcp__demo__lookup", { query: "a query" }],
		["web_search", { queries: ["query A", "query B"] }], ["subagent", { task: "Check the code" }],
	]) {
		const result = { content: [{ type: "text", text: "HIDDEN RESULT\nsecond line\nthird line" }],
			details: name === "edit" ? { diff: "-1 a\n+1 HIDDEN EDIT DIFF" } : undefined };
		const expandedText = name === "write" ? "HIDDEN WRITE CONTENT" : name === "edit" ? "HIDDEN EDIT DIFF" : "HIDDEN RESULT";
		const snapshot = JSON.stringify({ args, result });
		const definition = resolver(name, () => withBuiltInRenderers(name));
		const component = new ToolExecutionComponent(name, `test-${name}`, args, { showImages: false }, definition, ui, process.cwd());
		component.markExecutionStarted();
		assert.equal(nonempty(component).length, 1, "pending tool is one line");
		component.updateResult(result, false);
		assert.equal(nonempty(component).length, 1, "completed tool defaults to one line");
		assert(nonempty(component)[0].startsWith(`▸ ${name}`));
		assert(!nonempty(component).join("\n").includes("HIDDEN"));
		assert(click(component)?.handled, "header click must be handled by Pi");
		assert(nonempty(component)[0].startsWith(`▾ ${name}`));
		assert(nonempty(component).join("\n").includes(expandedText), `click reveals the native output for ${name}`);
		for (const width of [0, 1, 4, 5, 10, 20, 40, 80, 120]) {
			assert(component.render(width).every((line) => visibleWidth(line) <= width), `expanded ${name} fits width ${width}`);
			if (width >= 5) assertFrame(component, width);
		}
		component.updateResult(result, true);
		assertFrame(component);
		assert(nonempty(component)[0].includes("running"), "streaming output remains framed");
		component.updateResult(result, false);
		assert(click(component)?.handled);
		assert.equal(nonempty(component).length, 1, "second click collapses again");
		component.setExpanded(true); // native Ctrl+O path
		assert(nonempty(component).join("\n").includes(expandedText));
		component.setExpanded(false);
		component.updateResult({ ...result, isError: true }, false);
		assert(nonempty(component)[0].includes("error"), "collapsed errors remain visible");
		component.setExpanded(true);
		assertFrame(component);
		component.setExpanded(false);
		for (const width of [0, 1, 10, 20, 40, 80, 120]) {
			assert.equal(component.render(width).filter((line) => plain(line).trim()).length <= 1, true);
			assert(component.render(width).every((line) => visibleWidth(line) <= width));
		}
		assert.equal(JSON.stringify({ args, result }), snapshot, "renderers must not alter model-facing args/results");
	}
	let calls = 0, results = 0, previousCall, previousResult, originalState;
	const custom = {
		renderCall(_args, _theme, ctx) {
			calls++;
			if (calls > 1) assert.equal(ctx.lastComponent, previousCall);
			originalState ??= ctx.state;
			assert.equal(ctx.state, originalState);
			return previousCall = new Text("CUSTOM ARGS", 0, 0);
		},
		renderResult(_result, options, _theme, ctx) {
			results++;
			assert(options.expanded);
			assert.equal(ctx.state, originalState);
			if (results > 1) assert.equal(ctx.lastComponent, previousResult);
			return previousResult = new Text("\x1b[31mCUSTOM OUTPUT\x1b[0m after reset \x1b[44mhighlight\x1b[49m after highlight\n\x1b[38;2;48;49;50mRGB foreground\x1b[48;2;49;50;51mRGB background\x1b[39;49mreset", 0, 0);
		},
	};
	const a = new ToolExecutionComponent("custom", "a", { path: "模型🙂\n\x1b[31mfile" }, { showImages: false }, resolver("custom", () => custom), ui, process.cwd());
	const b = new ToolExecutionComponent("custom", "b", {}, { showImages: false }, resolver("custom", () => custom), ui, process.cwd());
	const result = { content: [{ type: "text", text: "plain fallback" }], details: {} };
	a.updateResult(result, false); b.updateResult(result, false);
	assert.equal(calls, 0); assert.equal(results, 0);
	click(a);
	assert(nonempty(a).join("\n").includes("CUSTOM OUTPUT"));
	assertFrame(a);
	assert(a.render(120).join("\n").includes("\x1b[31m"), "native foreground colors are preserved");
	assert(!a.render(120).join("\n").includes("\x1b[44m"), "native background layers are flattened into one surface");
	assert(a.render(120).join("\n").includes("\x1b[38;2;48;49;50m"), "foreground RGB channels matching SGR codes are preserved");
	assert(!a.render(120).join("\n").includes("\x1b[48;2;49;50;51m"), "RGB background layers are flattened too");
	assert.equal(nonempty(b).length, 1, "click expands only the selected tool");
	a.invalidate();
	assert(calls > 1 && results > 1, "native components/state are reused on redraw");
	for (const width of [0, 1, 10, 20, 40, 80]) assert(b.render(width).every((line) => visibleWidth(line) <= width));
	const broken = { renderCall() { throw Error("renderer failed"); }, renderResult() { throw Error("renderer failed"); } };
	const fallback = new ToolExecutionComponent("broken", "f", { query: "test" }, { showImages: false }, resolver("broken", () => broken), ui, process.cwd());
	fallback.updateResult(result, false); click(fallback);
	assert(nonempty(fallback).join("\n").includes("plain fallback"));
	assertFrame(fallback);
	let nativeClick;
	const interactive = new ToolExecutionComponent("interactive", "i", {}, { showImages: false }, resolver("interactive", () => ({
		renderResult() {
			return { render: (width) => new Text("CLICKABLE 模型🙂", 0, 0).render(width), invalidate() {},
				handleMouse(event) { nativeClick = event; return { handled: true }; } };
		},
	})), ui, process.cwd());
	interactive.updateResult(result, false); click(interactive);
	assertFrame(interactive);
	const mouse = { type: "click", button: "left", width: 120, height: interactive.render(120).length,
		shift: false, alt: false, ctrl: false, screenX: 13, screenY: 24, x: 3, y: 4 };
	assert(interactive.handleMouse(mouse)?.handled);
	assert.equal(nativeClick.x, 1); assert.equal(nativeClick.y, 0);
	assert.equal(nativeClick.width, 116); assert.equal(nativeClick.height, 1);
	assert.equal(nativeClick.screenX, 13); assert.equal(nativeClick.screenY, 24);
	assert(nonempty(interactive)[0].startsWith("▾"), "native interactive content does not collapse the tool");
	assert(interactive.handleMouse({ ...mouse, x: 0, y: 2 })?.handled, "border click still reaches Pi's collapse handler");
	assert.equal(nonempty(interactive).length, 1, "collapsed tools have no frame");
	assert(interactive.render(120).every((line) => !line.includes(panelBackground())),
		"collapsed tools have no panel background");
	setTheme(theme === "light" ? "dark" : "light");
	fallback.invalidate();
	assertFrame(fallback);
	selectTheme(theme);
	terminalBackground = rgbColor(55, 61, 72);
	setTerminalColors({ background: { r: 55, g: 61, b: 72 }, foreground: { r: 229, g: 231, b: 235 } });
	fallback.invalidate();
	assertFrame(fallback); // The cached default-color Theme must pick up late terminal replies.
	terminalBackground = rgbColor(40, 44, 52);
	setTerminalColors({ background: { r: 40, g: 44, b: 52 }, foreground: { r: 229, g: 231, b: 235 } });
	console.log(`PASS ${theme}: one-line calls, single interior Box/30% tint, unshaded edge-aligned borders, native foreground preservation, theme changes, native clicks/Ctrl+O, streaming/errors, widths, unchanged model data`);
}
