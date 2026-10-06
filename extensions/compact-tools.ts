import { Theme, type ExtensionAPI, type ToolRenderContext } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, Box, Container, mixColors, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

interface NativeState {
	state: Record<string, unknown>;
	call?: Component;
	result?: Component;
}

const EMPTY: Component = { render: () => [], invalidate() {} };

function summary(args: Record<string, unknown>): string {
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

function paintInterior(line: string, background: string): string {
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

function bordered(content: Component, theme: Theme): Component {
	// The only background-owning layout: output, padding and blank lines share one Box.
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
			layout.setBgFn((line) => paintInterior(line, background));
			if (width < 5) return safeContent.render(width)
				.map((line) => paintInterior(truncateToWidth(line, Math.max(0, width), "...", true), background));
			// Edge-aligned strokes touch the interior pixels. Centered ╭│─ glyphs
			// cannot do this without coloring the border cells as well.
			const body = layout.render(width - 2).map((line) =>
				theme.fg("borderMuted", "▕") + line + theme.fg("borderMuted", "▏"));
			return [" " + theme.fg("borderMuted", "▁".repeat(width - 2)) + " ", ...body,
				" " + theme.fg("borderMuted", "▔".repeat(width - 2)) + " "];
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
				const detail = summary(args);
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
				const content = new Container();
				let call: Component | undefined;
				try {
					call = original?.renderCall?.(context.args, theme, {
						...context, state: native.state, lastComponent: native.call,
					});
				} catch { /* Fall back to plain arguments if a plugin renderer fails. */ }
				if (!call) call = new Text(theme.fg("dim", JSON.stringify(context.args, null, 2)), 0, 0);
				native.call = call;
				content.addChild(call);
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
				content.addChild(output);
				return bordered(content, theme);
			},
		};
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setToolsExpanded(false);
	});
}
