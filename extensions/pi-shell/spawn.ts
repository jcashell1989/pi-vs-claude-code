/**
 * spawnSubagent — Shared subprocess spawner for pi-shell
 *
 * Used by both `dispatch_agent` and `answer` tools.
 * Spawns a `pi` child process in --mode json, parses JSONL events from
 * stdout, extracts cost data, streams progress, and handles timeout /
 * cancellation.
 */

import { spawn, execSync } from "child_process";
import { readFileSync, mkdirSync, appendFileSync, existsSync } from "fs";
import { join } from "path";
import { parse as yamlParse } from "yaml";

// ── Types ──────────────────────────────────────────────────────────────

export interface SpawnOptions {
	agent: string;           // agent name (maps to .pi/agents/<name>.md)
	task: string;            // task prompt for the subagent
	model?: string;          // model override (from config agent_models)
	branch?: string;         // git branch to work on (dispatch_agent passes this)
	cwd: string;             // working directory
	timeout: number;         // max runtime in seconds
	maxResultTokens: number; // truncation limit for result
	sessionDir: string;      // directory for session files (.pi/tasks/sessions/)
	taskId: number;          // task ID for session file naming
	signal?: AbortSignal;    // for cancellation
	onUpdate?: (data: { type: string; content: string }) => void;  // streaming updates
	onCostUpdate?: (cost: number) => void;  // cost extracted from message_end events
}

export interface SpawnResult {
	output: string;   // truncated subagent output
	exitCode: number;
	cost: number;     // total cost from this subagent run
	elapsed: number;  // milliseconds
}

// ── Agent Definition Parser ────────────────────────────────────────────

interface AgentDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
}

/**
 * Read and parse an agent definition from .pi/agents/<name>.md.
 * Expects YAML frontmatter delimited by --- lines, followed by body text.
 */
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

// ── Git Branch Helpers ─────────────────────────────────────────────────

function checkoutBranch(branch: string, cwd: string): void {
	try {
		// Try to checkout existing branch first
		execSync(`git checkout ${branch}`, { cwd, stdio: "ignore" });
	} catch {
		// Branch doesn't exist — create it
		execSync(`git checkout -b ${branch}`, { cwd, stdio: "ignore" });
	}
}

function checkoutPreviousBranch(cwd: string): void {
	try {
		execSync("git checkout -", { cwd, stdio: "ignore" });
	} catch {
		// Best-effort — if it fails, stay on current branch
	}
}

// ── Main Spawn Function ───────────────────────────────────────────────

export async function spawnSubagent(options: SpawnOptions): Promise<SpawnResult> {
	const {
		agent,
		task,
		model,
		branch,
		cwd,
		timeout,
		maxResultTokens,
		sessionDir,
		taskId,
		signal,
		onUpdate,
		onCostUpdate,
	} = options;

	// Load agent definition
	const agentDef = loadAgentDef(agent, cwd);
	if (!agentDef) {
		return {
			output: `Agent "${agent}" not found. No .pi/agents/${agent}.md definition.`,
			exitCode: 1,
			cost: 0,
			elapsed: 0,
		};
	}

	// Ensure session directory exists
	mkdirSync(sessionDir, { recursive: true });

	// Session file for JSONL logging
	const sessionFile = join(sessionDir, `${agent}-${taskId}.jsonl`);

	// Switch to target branch if specified
	if (branch) {
		try {
			checkoutBranch(branch, cwd);
		} catch (err: any) {
			return {
				output: `Failed to checkout branch "${branch}": ${err?.message || err}`,
				exitCode: 1,
				cost: 0,
				elapsed: 0,
			};
		}
	}

	// Build pi args
	const args: string[] = [
		"--mode", "json",
		"--no-session",
		"--system-prompt", agentDef.systemPrompt,
		"--tools", agentDef.tools,
		"--thinking", "off",
	];

	if (model) {
		args.push("--model", model);
	}

	// The task prompt is the initial user message (positional arg)
	args.push(task);

	const startTime = Date.now();
	let totalCost = 0;
	const textChunks: string[] = [];

	return new Promise<SpawnResult>((resolve) => {
		const proc = spawn("pi", args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
		});

		let buffer = "";
		let killed = false;

		// Timeout handling
		const timeoutTimer = setTimeout(() => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
				// Give it a moment, then SIGKILL
				setTimeout(() => {
					try { proc.kill("SIGKILL"); } catch { /* already dead */ }
				}, 2000);
			}
		}, timeout * 1000);

		// Abort signal handling
		const onAbort = () => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
			}
		};
		if (signal) {
			if (signal.aborted) {
				killed = true;
				proc.kill("SIGTERM");
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		function processLine(line: string): void {
			if (!line.trim()) return;

			// Append raw JSONL to session file
			try {
				appendFileSync(sessionFile, line + "\n");
			} catch { /* best-effort logging */ }

			try {
				const event = JSON.parse(line);

				if (event.type === "message_update") {
					const delta = event.assistantMessageEvent;
					if (delta?.type === "text_delta") {
						const text = delta.delta || "";
						textChunks.push(text);
						if (onUpdate) {
							onUpdate({ type: "text_delta", content: text });
						}
					}
				} else if (event.type === "message_end") {
					// Extract cost from message_end events
					const msg = event.message;
					if (msg?.usage?.cost != null) {
						totalCost += msg.usage.cost;
						if (onCostUpdate) {
							onCostUpdate(totalCost);
						}
					} else if (msg?.usage) {
						// Some providers report input/output tokens but not cost directly
						// Try to extract from the event's top-level cost field
						if (event.cost != null) {
							totalCost += event.cost;
							if (onCostUpdate) {
								onCostUpdate(totalCost);
							}
						}
					}
				} else if (event.type === "tool_execution_start") {
					if (onUpdate) {
						const toolName = event.toolName || event.name || "tool";
						onUpdate({ type: "tool_start", content: toolName });
					}
				} else if (event.type === "agent_end") {
					// Final event — may contain cost summary
					if (event.cost != null && event.cost > totalCost) {
						totalCost = event.cost;
						if (onCostUpdate) {
							onCostUpdate(totalCost);
						}
					}
				}
			} catch {
				// Non-JSON line or parse error — ignore
			}
		}

		proc.stdout!.setEncoding("utf-8");
		proc.stdout!.on("data", (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";
			for (const line of lines) {
				processLine(line);
			}
		});

		// Capture stderr but don't process it (just drain)
		proc.stderr!.setEncoding("utf-8");
		proc.stderr!.on("data", () => {});

		proc.on("close", (code) => {
			clearTimeout(timeoutTimer);
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}

			// Process remaining buffer
			if (buffer.trim()) {
				processLine(buffer);
			}

			// Switch back to previous branch if we checked one out
			if (branch) {
				checkoutPreviousBranch(cwd);
			}

			const elapsed = Date.now() - startTime;
			const fullOutput = textChunks.join("");

			// Truncate to maxResultTokens characters
			const output = fullOutput.length > maxResultTokens
				? fullOutput.slice(0, maxResultTokens) + "\n\n... [truncated]"
				: fullOutput;

			resolve({
				output,
				exitCode: killed && code !== 0 ? (code ?? 124) : (code ?? 1),
				cost: totalCost,
				elapsed,
			});
		});

		proc.on("error", (err) => {
			clearTimeout(timeoutTimer);
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}

			// Switch back if needed
			if (branch) {
				checkoutPreviousBranch(cwd);
			}

			resolve({
				output: `Error spawning pi subprocess: ${err.message}`,
				exitCode: 1,
				cost: totalCost,
				elapsed: Date.now() - startTime,
			});
		});
	});
}
