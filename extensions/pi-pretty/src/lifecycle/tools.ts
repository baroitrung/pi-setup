/**
 * Register pi-pretty's renderers for the five file tools.
 *
 * Each tool is re-registered with a pretty renderer, keeping the original
 * definition from the host SDK. A tool is skipped when the config disables it or
 * the host does not provide a factory for it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as hostSdk from "@earendil-works/pi-coding-agent";
import { withClaudeToolStyleApi } from "../claude-style.js";
import type { FffService } from "../fff.js";
import { registerBashTool } from "../tools/bash.js";
import { registerFindTool } from "../tools/find.js";
import { registerGrepTool } from "../tools/grep.js";
import { registerLsTool } from "../tools/ls.js";
import { registerReadTool } from "../tools/read.js";
import type { PiPrettyDeps, SdkTools } from "../types.js";

export interface ToolRegistrationOptions {
	pi: ExtensionAPI;
	cwd: string;
	fffService: FffService | null;
	isToolEnabled(name: string): boolean;
	claudeStyle: boolean;
	/** Injected Text component for custom rendering; falls back to the host's. */
	textComponent: PiPrettyDeps["TextComponent"];
	depsSdk?: SdkTools;
}

export function registerPrettyTools(options: ToolRegistrationOptions): void {
	const { pi, cwd, fffService, isToolEnabled, claudeStyle, textComponent, depsSdk } = options;

	// Pi aliases static SDK imports to its host package for managed extensions.
	// Native dynamic imports bypass that alias because the managed npm root omits
	// Pi peer dependencies.
	const sdk: SdkTools = depsSdk ?? {
		createReadToolDefinition: hostSdk.createReadToolDefinition,
		createBashToolDefinition: hostSdk.createBashToolDefinition,
		createLsToolDefinition: hostSdk.createLsToolDefinition,
		createFindToolDefinition: hostSdk.createFindToolDefinition,
		createGrepToolDefinition: hostSdk.createGrepToolDefinition,
	};
	const createReadTool = sdk.createReadToolDefinition ?? sdk.createReadTool;
	const createBashTool = sdk.createBashToolDefinition ?? sdk.createBashTool;
	const createLsTool = sdk.createLsToolDefinition ?? sdk.createLsTool;
	const createFindTool = sdk.createFindToolDefinition ?? sdk.createFindTool;
	const createGrepTool = sdk.createGrepToolDefinition ?? sdk.createGrepTool;

	const toolPi = claudeStyle ? withClaudeToolStyleApi(pi) : pi;
	if (isToolEnabled("read") && createReadTool) {
		registerReadTool(toolPi, cwd, null, createReadTool(cwd), textComponent);
	}
	if (isToolEnabled("bash") && createBashTool) {
		registerBashTool(toolPi, cwd, null, createBashTool(cwd), textComponent);
	}
	if (isToolEnabled("ls") && createLsTool) {
		registerLsTool(toolPi, cwd, null, createLsTool(cwd), textComponent);
	}
	if (isToolEnabled("find") && createFindTool) {
		registerFindTool(toolPi, cwd, fffService, createFindTool(cwd), textComponent);
	}
	if (isToolEnabled("grep") && createGrepTool) {
		registerGrepTool(toolPi, cwd, fffService, createGrepTool(cwd), textComponent);
	}
}
