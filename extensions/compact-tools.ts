import { createReadToolDefinition, getLanguageFromPath, highlightCode, Theme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { numberlessDiff, renderWithCodeBlockPaint, toolCodeBlock, type ToolRenderContext } from "./code-block.ts";
import { backgroundAnsi, Box, Container, mixColors, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

interface NativeState {
	state: Record<string, unknown>;
	call?: Component;
	result?: Component;
}

const EMPTY: Component = { render: () => [], invalidate() {} };

const builtInRead = createReadToolDefinition("");

function isBuiltInRead(tool: string, def?: { renderCall?: unknown; renderResult?: unknown }): boolean {
	return tool === "read" && def?.renderCall === builtInRead.renderCall && def?.renderResult === builtInRead.renderResult;
}

function readRange(args: Record<string, unknown>): string {
	if (args.offset == null && args.limit == null) return "";
	const start = args.offset != null && !Number.isNaN(Number(args.offset)) ? Number(args.offset) : 1;
	const end = args.limit != null && !Number.isNaN(Number(args.limit)) ? start + Number(args.limit) - 1 : "";
	return `:${start}${end !== "" ? `-${end}` : ""}`;
}

function readOverflow(args: Record<string, unknown>, theme: Theme): Component {
	const rawPath = typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
	const target = `${rawPath}${readRange(args)}`;
	return {
		render(width) {
			if (!target || width >= visibleWidth(target) + 12) return [];
			return new Text(theme.fg("dim", target), 0, 0).render(width);
		},
		invalidate() {},
	};
}

function summary(args: Record<string, unknown>, toolName?: string): string {
	if (toolName === "read") {
		const rawPath = typeof args.file_path === "string" ? args.file_path
			: typeof args.path === "string" ? args.path : "";
		if (rawPath) {
			return (rawPath + readRange(args)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
		}
	}
	for (const key of ["path", "file_path", "command", "query", "url", "task", "claim", "pattern"]) {
		const value = args[key];
		if (typeof value === "string") return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
	}
	if (Array.isArray(args.queries)) {
		return args.queries.filter((value) => typeof value === "string").join(" · ")
			.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
	}
	return "";
}

function nativeState(context: ToolRenderContext): NativeState {
	return context.state.compactToolsNative ??= { state: {} };
}

const PANEL_OPACITY = 0.3;
const terminalDefaults = new Map<string, Theme>();

function panelBackground(theme: Theme): string {
	const key = `${theme.appearance}:${theme.getColorMode()}`;
	let defaults = terminalDefaults.get(key);
	if (!defaults) {
		// A public Theme with default tokens resolves Pi's already-reported terminal
		// colors (and its documented fallback). No extra OSC queries or private APIs.
		const foregrounds = Object.fromEntries(
			Object.keys(theme.colors).map((token) => [token, ""]),
		) as ConstructorParameters<typeof Theme>[0];
		defaults = new Theme(foregrounds, {
			selectedBg: "", searchMatchBg: "", userMessageBg: "", customMessageBg: "",
			toolPendingBg: "", toolSuccessBg: "", toolErrorBg: "",
		}, theme.getColorMode(), { appearance: theme.appearance });
		terminalDefaults.set(key, defaults);
	}
	const tint = mixColors(theme.colors.toolPendingBg, theme.colors.text, 0.06, "srgb");
	return backgroundAnsi(mixColors(defaults.colors.toolPendingBg, tint, PANEL_OPACITY, "srgb"), theme.getColorMode());
}

function paintPanelLine(line: string, background: string, ownedCodeRow?: string): string {
	// A known CodeBlock owns its whole row, including its unpainted border cells.
	// Other native/plugin output still uses the single parent panel background.
	const start = ownedCodeRow ? line.indexOf(ownedCodeRow) : -1;
	if (start >= 0 && ownedCodeRow) {
		return paintPanelLine(line.slice(0, start), background) + "\x1b[49m" + ownedCodeRow + "\x1b[49m"
			+ paintPanelLine(line.slice(start + ownedCodeRow.length), background);
	}
	// Flatten native background layers into this one surface, retaining foreground
	// syntax/diff colors. Parse color parameters so RGB values are not mistaken for SGR codes.
	const text = line.replace(/\x1b\[([\d;]*)m/g, (sequence, parameters: string) => {
		const codes = parameters === "" ? [0] : parameters.split(";").map(Number);
		const kept: number[] = [];
		let restore = false;
		for (let i = 0; i < codes.length; i++) {
			const code = codes[i];
			if (code === 38 || code === 48) {
				const count = codes[i + 1] === 2 ? 5 : codes[i + 1] === 5 ? 3 : 1;
				if (code === 38) kept.push(...codes.slice(i, i + count));
				else restore = true;
				i += count - 1;
			} else if ((code >= 40 && code <= 49) || (code >= 100 && code <= 107)) restore = true;
			else { kept.push(code); if (code === 0) restore = true; }
		}
		if (!restore) return sequence;
		return (kept.length ? `\x1b[${kept.join(";")}m` : "") + background;
	});
	return background + text + "\x1b]8;;\x07\x1b[0m" + background + "\x1b[49m";
}

function horizontalRule(width: number, theme: Theme): string {
	// Terminal-native top-edge decoration on spaces: no missing-font glyphs.
	return theme.fg("borderMuted", "\x1b[59;53m" + " ".repeat(width) + "\x1b[55m");
}

function bordered(content: Component, theme: Theme): Component {
	// Edge-aligned strokes meet the filled interior at character-cell boundaries.
	// Border cells remain unshaded so no tint extends outside the frame.
	const safeContent: Component = {
		render: (width) => content.render(Math.max(1, width)).map((line) => truncateToWidth(line, Math.max(0, width))),
		invalidate: () => content.invalidate(),
		handleMouse: (event) => content.handleMouse?.(event),
	};
	const layout = new Box(1, 0);
	layout.addChild(safeContent);
	return {
		render(width) {
			const background = panelBackground(theme);
			if (width < 5) return safeContent.render(width).map((line) =>
				paintPanelLine(line + " ".repeat(Math.max(0, width - visibleWidth(line))), background));
			const rule = horizontalRule(width - 2, theme);
			const top = theme.fg("borderMuted", "▕") + paintPanelLine(rule, background) + theme.fg("borderMuted", "▏");
			const scoped = renderWithCodeBlockPaint(() => layout.render(width - 2));
			const body = scoped.lines.map((line) =>
				theme.fg("borderMuted", "▕") + paintPanelLine(line, background, scoped.ownedRows.get(line.trim())) + theme.fg("borderMuted", "▏"));
			return [top, ...body, " " + rule + " "];
		},
		invalidate() { layout.invalidate(); },
		handleMouse(event) {
			if (event.width < 5) return safeContent.handleMouse?.(event);
			if (event.x < 1 || event.x >= event.width - 1 || event.y < 1 || event.y >= event.height - 1) return;
			return layout.handleMouse({ ...event, x: event.x - 1, y: event.y - 1,
				width: event.width - 2, height: event.height - 2 });
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerToolRenderer((toolName, next) => {
		const original = next();
		return {
			renderShell: "self",
			renderCall(args, theme, context) {
				const marker = context.expanded ? "▾" : "▸";
				const color = context.isError ? "error" : context.isPartial ? "warning" : "success";
				const detail = summary(args as Record<string, unknown>, toolName);
				const status = context.isError ? theme.fg("error", " · error")
					: context.isPartial && context.executionStarted ? theme.fg("dim", " · running") : "";
				const row = `${theme.fg(color, marker)} ${theme.bold(theme.fg("toolTitle", toolName))}${detail ? ` ${theme.fg("dim", detail)}` : ""}${status}`;
				return {
					render: (width) => [truncateToWidth(row, Math.max(0, width))],
					invalidate() {},
				};
			},
			renderResult(result, options, theme, context) {
				if (!options.expanded) return EMPTY;
				const native = nativeState(context);
				const args = context.args as Record<string, unknown>;
				const content = new Container();
				let call: Component | undefined;
				try {
					call = original?.renderCall?.(context.args, theme, {
						...context, state: native.state, lastComponent: native.call,
					});
				} catch { /* Fall back to plain arguments if a plugin renderer fails. */ }
				if (!call) call = new Text(theme.fg("dim", JSON.stringify(context.args, null, 2)), 0, 0);
				native.call = call;
				if (toolName === "write" && !context.isError && typeof args.content === "string") {
					const path = args.path ?? args.file_path;
					const language = typeof path === "string" ? getLanguageFromPath(path) : undefined;
					const text = args.content.replace(/\t/g, "   ");
					const body = new Text((language ? highlightCode(text, language) : [theme.fg("toolOutput", text)]).join("\n"), 0, 0);
					// Only use our write body when the code-block extension is active.
					const block = toolCodeBlock(body, args.content, toolName, context, theme);
					content.addChild(block === body ? call : block);
				} else if (toolName === "edit" && typeof result.details?.diff === "string" && !context.isError) {
					// Keep native preview state intact, but show a clean, number-free diff surface.
					const source = numberlessDiff(result.details.diff);
					const lines = source.replace(/\t/g, "   ").split("\n").map((line) =>
						theme.fg(line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext", line));
					const body = new Text(lines.join("\n"), 0, 0);
					const block = toolCodeBlock(body, source, toolName, context, theme);
					content.addChild(block === body ? call : block);
				} else if (isBuiltInRead(toolName, original)) {
					content.addChild(readOverflow(args, theme));
				} else content.addChild(call);
				let output: Component | undefined;
				try {
					output = original?.renderResult?.(result, options, theme, {
						...context, state: native.state, lastComponent: native.result,
					});
				} catch { /* Keep the tool output accessible even if a plugin renderer fails. */ }
				if (!output) {
					const text = result.content.map((block) => block.type === "text" ? block.text : `[${block.type}]`).join("\n");
					output = new Text(theme.fg(context.isError ? "error" : "toolOutput", text), 0, 0);
				}
				native.result = output;
				const source = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
				content.addChild(["read", "bash"].includes(toolName) && source && !result.content.some((block) => block.type === "image")
					? toolCodeBlock(output, source, toolName, context, theme) : output);
				return bordered(content, theme);
			},
		};
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setToolsExpanded(false);
	});
}
