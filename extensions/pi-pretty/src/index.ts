/**
 * pi-pretty — Pretty terminal output for pi built-in tools.
 *
 * Enhances read, bash, ls, find, and grep with:
 *   • Syntax-highlighted file content (Shiki)
 *   • Colored bash exit status + output
 *   • Tree-view directory listings with file-type icons
 *   • FFF-accelerated find/grep with SDK fallback
 *   • Custom ANSI rendering for all tools
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	MessageEndEvent,
	MessageUpdateEvent,
	SessionInfoChangedEvent,
} from "@earendil-works/pi-coding-agent";
import * as hostSdk from "@earendil-works/pi-coding-agent";
import { createFffAutocompleteProvider } from "./autocomplete.js";
import {
	installClaudeChatGrouping,
	installClaudeExternalToolRenderers,
	resetClaudeStyleSessionState,
	setClaudeStyleAgentActive,
	setClaudeStyleTheme,
	withClaudeToolStyleApi,
} from "./claude-style.js";
import {
	applyConfig,
	getDefaultAgentDir,
	loadConfig,
	normalizeToolList,
	resolveFffScanSettings,
	resolveToolSets,
} from "./config.js";
import { type FffInitOptions, type FffService, getSharedFffService, isFffRestrictedBasePathError } from "./fff.js";
import { registerFffCommands } from "./lifecycle/fff-commands.js";
import { installSessionLifecycle } from "./lifecycle/session.js";
import { registerPrettyTools } from "./lifecycle/tools.js";
import { createPromptEditorClass } from "./prompt-editor.js";
import { registerBashTool } from "./tools/bash.js";
import { registerFindTool } from "./tools/find.js";
import { registerGrepTool } from "./tools/grep.js";
import { registerLsTool } from "./tools/ls.js";
import { registerReadTool } from "./tools/read.js";
import type { PiPrettyDeps, SdkTools } from "./types.js";
import { installUserRail, setUserRail } from "./user-rail.js";
import {
	createThinkingLabelAnimator,
	createThinkingTimer,
	installPerRowThinkingLabels,
	installWorkingIndicator,
	type PerRowThinkingLabels,
	resolveThinkingIndicatorSettings,
	resolveWorkingIndicatorSettings,
	setClaudeThinkingLabels,
	type ThinkingTimer,
	thinkingBlockActive,
	WORKING_INTERVAL_MS,
	type WorkingIndicatorController,
} from "./working-indicator.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_DISABLED_TOOLS = new Set(["ls"]);
const USER_MESSAGE_ICON = "❯";
type EditorFactory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
type EditorUiCompatibility = {
	setEditorComponent?: (factory: EditorFactory) => void;
	getEditorComponent?: () => EditorFactory;
};

function envTools(name: "PRETTY_DISABLE_TOOLS" | "PRETTY_ENABLE_TOOLS"): Set<string> {
	return new Set(normalizeToolList((process.env[name] ?? "").split(",")));
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export type { PiPrettyDeps };

export default async function piPrettyExtension(pi: ExtensionAPI, deps?: PiPrettyDeps): Promise<void> {
	const config = loadConfig();
	applyConfig(config);
	const claudeStyle = config.toolStyle === "claudecode";
	setClaudeThinkingLabels(claudeStyle);
	// claudecode style keeps user messages plain; the default style prefixes them with a prompt icon.
	if (!claudeStyle) {
		pi.registerMarkdownTransformer?.((markdown, context) => {
			if (context.messageType !== "user" || markdown.trim() === "") return markdown;
			return ` ${USER_MESSAGE_ICON} ${markdown}`;
		});
	}
	pi.registerFlag?.("pretty-fff-home-scan", {
		description: "Allow FFF to index the home directory when Pi starts there",
		type: "boolean",
	});
	pi.registerFlag?.("pretty-fff-root-scan", {
		description: "Allow FFF to index the filesystem root when Pi starts there",
		type: "boolean",
	});
	const fffScanSettings = resolveFffScanSettings(config, {
		enableHomeScanning: pi.getFlag?.("pretty-fff-home-scan"),
		enableRootScanning: pi.getFlag?.("pretty-fff-root-scan"),
	});
	const fffInitOptions: FffInitOptions = {
		enableHomeDirScanning: fffScanSettings.enableHomeScanning,
		enableFsRootScanning: fffScanSettings.enableRootScanning,
	};
	const { disabledTools, enabledTools } = resolveToolSets(
		envTools("PRETTY_DISABLE_TOOLS"),
		envTools("PRETTY_ENABLE_TOOLS"),
		config,
	);
	const isToolEnabled = (name: string) => {
		const normalizedName = name.toLowerCase();
		return (
			!disabledTools.has(normalizedName) &&
			(!DEFAULT_DISABLED_TOOLS.has(normalizedName) || enabledTools.has(normalizedName))
		);
	};
	const cwd = process.cwd();

	// ------------------------------------------------------------------
	// FFF service init
	// ------------------------------------------------------------------
	// Keep FFF independent from the Pi SDK import. Published extension installs
	// run in Pi's isolated npm root; importing a nested Pi SDK at activation time
	// has proven crash-prone across host Pi versions. FFF commands and indexing
	// should still work even when SDK tool factories are unavailable.

	const maybeGetAgentDir = deps?.sdk?.getAgentDir;
	const agentDir = typeof maybeGetAgentDir === "function" ? maybeGetAgentDir() : getDefaultAgentDir();
	const fffService: FffService | null = getSharedFffService(deps?.fffModule, agentDir);

	// Text component for custom rendering (DI-friendly)
	const TextComp = deps?.TextComponent;

	registerFffCommands(pi, fffService);

	// ------------------------------------------------------------------

	installSessionLifecycle({ pi, config, claudeStyle, fffService, fffInitOptions, deps });

	registerPrettyTools({
		pi,
		cwd,
		fffService,
		isToolEnabled,
		claudeStyle,
		textComponent: TextComp,
		depsSdk: deps?.sdk,
	});
}
