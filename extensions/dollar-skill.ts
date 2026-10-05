import { loadSkills, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

let cachedSkills: Array<{ name: string; description: string }> | null = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 5000;

function refreshSkillsCache(cwd: string) {
	try {
		const result = loadSkills({
			cwd,
			agentDir: getAgentDir(),
			skillPaths: [],
			includeDefaults: true,
		});
		cachedSkills = result.skills.map((s) => ({
			name: s.name,
			description: s.description,
		}));
		lastCacheTime = Date.now();
	} catch {
		cachedSkills = cachedSkills || [];
	}
	return cachedSkills;
}

function getSkills(cwd: string) {
	if (!cachedSkills || Date.now() - lastCacheTime > CACHE_TTL_MS) {
		return refreshSkillsCache(cwd);
	}
	return cachedSkills;
}

function isKnownSkill(cwd: string, skillName: string): boolean {
	const normalized = skillName.toLowerCase();
	let list = getSkills(cwd);
	if (list.some((s) => s.name.toLowerCase() === normalized)) return true;
	list = refreshSkillsCache(cwd);
	return list.some((s) => s.name.toLowerCase() === normalized);
}

export default function dollarSkillExtension(pi: ExtensionAPI) {
	// 1. Hook input: Chuyển $skill [args] thành /skill:skill [args]
	pi.on("input", async (event, ctx) => {
		const trimmed = event.text.trim();
		if (!trimmed.startsWith("$")) {
			return { action: "continue" };
		}

		const withoutDollar = trimmed.slice(1).trim();
		if (!withoutDollar) {
			return { action: "continue" };
		}

		const spaceIndex = withoutDollar.indexOf(" ");
		const rawTarget = spaceIndex === -1 ? withoutDollar : withoutDollar.slice(0, spaceIndex);
		const args = spaceIndex === -1 ? "" : withoutDollar.slice(spaceIndex + 1).trim();

		const skillName = rawTarget.startsWith("skill:") ? rawTarget.slice(6) : rawTarget;

		if (isKnownSkill(ctx.cwd, skillName)) {
			return {
				action: "transform",
				text: `/skill:${skillName}${args ? ` ${args}` : ""}`,
			};
		}

		return { action: "continue" };
	});

	// 2. Hook Autocomplete TUI khi gõ $
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.addAutocompleteProvider((baseProvider) => ({
			triggerCharacters: [...(baseProvider.triggerCharacters || []), "$"],

			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const currentLine = lines[cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, cursorCol);
				const trimmedBefore = textBeforeCursor.trimStart();

				if (trimmedBefore.startsWith("$")) {
					const spaceIndex = trimmedBefore.indexOf(" ");
					// Chỉ gợi ý khi đang gõ tên skill (chưa qua dấu cách)
					if (spaceIndex === -1) {
						const query = trimmedBefore.slice(1).toLowerCase();
						const skills = getSkills(ctx.cwd);

						const matches = skills
							.filter((s) => s.name.toLowerCase().includes(query))
							.map((s) => ({
								value: `$${s.name}`,
								label: `$${s.name}`,
								description: s.description,
							}));

						if (matches.length > 0) {
							return {
								items: matches,
								prefix: trimmedBefore,
							};
						}
						return null;
					}
				}

				return baseProvider.getSuggestions(lines, cursorLine, cursorCol, options);
			},

			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				if (prefix.startsWith("$")) {
					const currentLine = lines[cursorLine] || "";
					const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
					const afterCursor = currentLine.slice(cursorCol);
					const newLine = `${beforePrefix}${item.value} ${afterCursor}`;
					const newLines = [...lines];
					newLines[cursorLine] = newLine;

					return {
						lines: newLines,
						cursorLine,
						cursorCol: beforePrefix.length + item.value.length + 1,
					};
				}
				return baseProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},

			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				const currentLine = lines[cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, cursorCol);
				if (textBeforeCursor.trim().startsWith("$") && !textBeforeCursor.trim().includes(" ")) {
					return false;
				}
				return baseProvider.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	});
}
