// Run from the repo root: node tests/test-web-search-config.mjs
// No credentials, installed Pi, or network access needed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(
	new URL("../config/web-search.example.json", import.meta.url), "utf8",
));

// Chain order is a cost decision: paid semantic search first, keyless last so a
// missing or expired key degrades instead of failing.
const providers = ["exa", "tinyfish", "firecrawl", "duckduckgo"];
const keyed = ["exa", "tinyfish", "firecrawl"];

assert.deepEqual(config.webSearch.allowedProviders, providers);
assert.deepEqual(config.searchRouting.providers, providers);
assert.deepEqual(config.searchRouting.fallbackOn, [
	"transient", "quota", "credential", "auth", "network", "invalid-response",
]);
for (const field of ["provider", "searchProvider"]) {
	assert(!Object.hasOwn(config, field), `${field} would override the fallback route`);
}
for (const provider of keyed) {
	assert.equal(
		config[`${provider}ApiKey`],
		`!$HOME/.pi/agent/scripts/get-secret.sh ${provider.toUpperCase()}_API_KEY`,
		`${provider} credentials must be resolved through get-secret.sh`,
	);
}
assert(!Object.hasOwn(config, "duckduckgoApiKey"), "the keyless tail must stay keyless");
assert.equal(config.firecrawlFreshScrape, false);
assert.deepEqual(config.fetchRouting.providers, [
	"http", "firecrawl", "crawl4ai", "jina", "tinyfish", "search1api", "querit",
	"kagi", "ollama", "parallel", "brightdata", "gemini",
]);
assert.equal(config.fetchRouting.allowRemoteHostedProviders, true);
console.log("PASS: exa → tinyfish → firecrawl → keyless duckduckgo, credential fallback, command credentials, unchanged fetch policy");
