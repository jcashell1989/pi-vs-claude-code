/**
 * Unit tests for loadAgentDef from pi-shell/spawn.ts
 *
 * We copy the function here for clean unit testing since it's not exported.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { parse as yamlParse } from "yaml";

// ── Copied from extensions/pi-shell/spawn.ts ──────────────────────────

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
}

function loadAgentDef(agentName: string, cwd: string): AgentDef | null {
	const filePath = join(cwd, ".pi", "agents", `${agentName}.md`);
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter = yamlParse(match[1]) as Record<string, string>;
		if (!frontmatter?.name) return null;

		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: frontmatter.tools || "read,grep,find,ls",
			systemPrompt: match[2].trim(),
		};
	} catch {
		return null;
	}
}

// ── Test Helpers ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
	if (condition) {
		console.log(`  PASS: ${message}`);
		passed++;
	} else {
		console.log(`  FAIL: ${message}`);
		failed++;
	}
}

// ── Test Suite ────────────────────────────────────────────────────────

const CWD = join(import.meta.dir, "..");

const agents = ["scout", "planner", "builder", "reviewer", "red-team", "orchestrator"];

console.log("=== Test 1: Parse real agent files ===\n");

for (const agentName of agents) {
	console.log(`Agent: ${agentName}`);
	const def = loadAgentDef(agentName, CWD);

	assert(def !== null, `${agentName}: loadAgentDef returns non-null`);

	if (def) {
		assert(def.name.length > 0, `${agentName}: name is populated ("${def.name}")`);
		assert(def.tools.length > 0, `${agentName}: tools is non-empty ("${def.tools}")`);
		assert(def.systemPrompt.length > 0, `${agentName}: systemPrompt is non-empty (${def.systemPrompt.length} chars)`);
		assert(def.description.length > 0, `${agentName}: description exists ("${def.description}")`);
	}
	console.log();
}

console.log("=== Test 2: Nonexistent agent returns null ===\n");

const missing = loadAgentDef("does-not-exist", CWD);
assert(missing === null, "nonexistent agent returns null");
console.log();

console.log("=== Test 3: Frontmatter edge cases ===\n");

// We can't use loadAgentDef with synthetic content directly since it reads
// from disk, so we'll test the regex and yaml parsing inline.

const regex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

// Edge case: extra whitespace in frontmatter values
const extraWhitespace = `---
name:   spacey-agent
description:   has extra spaces
tools:   read,write
---
Body text here.`;

{
	const match = extraWhitespace.match(regex);
	assert(match !== null, "extra whitespace: regex matches");
	if (match) {
		const fm = yamlParse(match[1]) as Record<string, string>;
		assert(fm.name === "spacey-agent", `extra whitespace: name parsed correctly ("${fm.name}")`);
		assert(fm.description === "has extra spaces", `extra whitespace: description trimmed ("${fm.description}")`);
		assert(fm.tools === "read,write", `extra whitespace: tools trimmed ("${fm.tools}")`);
		assert(match[2].trim() === "Body text here.", `extra whitespace: body parsed ("${match[2].trim()}")`);
	}
}

// Edge case: missing fields (should still parse what's there)
const missingFields = `---
name: minimal-agent
---
Just a body.`;

{
	const match = missingFields.match(regex);
	assert(match !== null, "missing fields: regex matches");
	if (match) {
		const fm = yamlParse(match[1]) as Record<string, string>;
		assert(fm.name === "minimal-agent", `missing fields: name parsed ("${fm.name}")`);
		assert(fm.description === undefined, "missing fields: description is undefined");
		assert(fm.tools === undefined, "missing fields: tools is undefined");

		// Verify loadAgentDef would use defaults for missing fields
		const def: AgentDef = {
			name: fm.name,
			description: fm.description || "",
			tools: fm.tools || "read,grep,find,ls",
			systemPrompt: match[2].trim(),
		};
		assert(def.description === "", "missing fields: description defaults to empty string");
		assert(def.tools === "read,grep,find,ls", "missing fields: tools defaults to read,grep,find,ls");
	}
}

// Edge case: no frontmatter at all
const noFrontmatter = `Just plain markdown without frontmatter.`;
{
	const match = noFrontmatter.match(regex);
	assert(match === null, "no frontmatter: regex does not match");
}

// Edge case: frontmatter without name (loadAgentDef returns null)
const noName = `---
description: no name field
tools: read
---
Body.`;
{
	const match = noName.match(regex);
	assert(match !== null, "no name field: regex matches");
	if (match) {
		const fm = yamlParse(match[1]) as Record<string, string>;
		assert(fm.name === undefined, "no name field: name is undefined");
		// loadAgentDef would return null here because !frontmatter?.name
		assert(!fm.name, "no name field: would cause loadAgentDef to return null");
	}
}

console.log();
console.log(`=== Results: ${passed} passed, ${failed} failed ===`);

if (failed > 0) {
	process.exit(1);
}
