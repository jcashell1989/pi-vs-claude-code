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
	fallbackModel?: string;  // fallback model if primary fails (404/guardrail)
	branch?: string;         // git branch to work on (dispatch_agent passes this)
	cwd: string;             // working directory
	agentDefsDir?: string;   // fallback dir for agent defs (if not found in cwd/.pi/agents/)
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
	conflict: boolean;
	actualBranch?: string;
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
 * Checks cwd first, then falls back to agentDefsDir (pi-orchestrator root).
 * Expects YAML frontmatter delimited by --- lines, followed by body text.
 */
function loadAgentDef(agentName: string, cwd: string, agentDefsDir?: string): AgentDef | null {
	const candidates = [
		join(cwd, ".pi", "agents", `${agentName}.md`),
	];
	if (agentDefsDir) {
		candidates.push(join(agentDefsDir, ".pi", "agents", `${agentName}.md`));
	}

	for (const filePath of candidates) {
		try {
			const raw = readFileSync(filePath, "utf-8");
			const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
			if (!match) continue;

			const frontmatter = yamlParse(match[1]) as Record<string, string>;
			if (!frontmatter?.name) continue;

			return {
				name: frontmatter.name,
				description: frontmatter.description || "",
				tools: frontmatter.tools || "read,bash,grep",
				systemPrompt: match[2].trim(),
			};
		} catch {
			continue;
		}
	}
	return null;
}

// ── Git Branch Helpers ─────────────────────────────────────────────────

function checkoutBranch(branch: string, cwd: string): string {
	try {
		execSync(`git checkout ${branch}`, { cwd, stdio: "ignore" });
		return branch;
	} catch {
		try {
			execSync(`git checkout -b ${branch}`, { cwd, stdio: "ignore" });
			return branch;
		} catch {
			const fallback = `${branch}_${Date.now()}`;
			execSync(`git checkout -b ${fallback}`, { cwd, stdio: "ignore" });
			return fallback;
		}
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

/** Detect if a spawn result failed due to provider guardrails / 404 */
function isGuardrailFailure(result: SpawnResult): boolean {
	return result.exitCode !== 0 &&
		/No endpoints available|guardrail restrictions|data policy/i.test(result.output);
}

export async function spawnSubagent(options: SpawnOptions): Promise<SpawnResult> {
	const result = await spawnSubagentCore(options);

	// Fallback: if primary model hit a guardrail error and fallback is configured, retry
	if (isGuardrailFailure(result) && options.fallbackModel && options.fallbackModel !== options.model) {
		if (options.onUpdate) {
			options.onUpdate({
				type: "text_delta",
				content: `\n[Fallback] Primary model blocked, retrying with ${options.fallbackModel.split("/").pop()}...\n`,
			});
		}
		return spawnSubagentCore({ ...options, model: options.fallbackModel, fallbackModel: undefined });
	}

	return result;
}

async function spawnSubagentCore(options: SpawnOptions): Promise<SpawnResult> {
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

	// Load agent definition (cwd first, then fallback to pi-orchestrator root)
	const agentDef = loadAgentDef(agent, cwd, options.agentDefsDir);
	if (!agentDef) {
		return {
			output: `Agent "${agent}" not found. No .pi/agents/${agent}.md definition.`,
			exitCode: 1,
			cost: 0,
			elapsed: 0,
			conflict: false,
		};
	}

	// Ensure session directory exists
	mkdirSync(sessionDir, { recursive: true });

	// Session file for JSONL logging
	const sessionFile = join(sessionDir, `${agent}-${taskId}.jsonl`);

	// Switch to target branch if specified
	let actualBranch: string | undefined;
	if (branch) {
		try {
			actualBranch = checkoutBranch(branch, cwd);
		} catch (err: any) {
			return {
				output: `Failed to checkout branch "${branch}": ${err?.message || err}`,
				exitCode: 1,
				cost: 0,
				elapsed: 0,
				conflict: false,
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
	let conflictDetected = false;
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
						if (!conflictDetected && /conflict|merge conflict/i.test(text)) {
							conflictDetected = true;
						}
						if (onUpdate) {
							onUpdate({ type: "text_delta", content: text });
						}
					}
				} else if (event.type === "message_end") {
					const msg = event.message;
					// Surface error messages so they're not swallowed
					if (msg?.stopReason === "error" && msg?.errorMessage) {
						textChunks.push(`[Error] ${msg.errorMessage}`);
					}
					// Extract cost from message_end events
					// Pi reports usage.cost as {input, output, cacheRead, cacheWrite, total}
					const rawCost = msg?.usage?.cost;
					const msgCost = typeof rawCost === "number" ? rawCost
						: (typeof rawCost === "object" && rawCost !== null) ? (Number((rawCost as any).total) || 0)
						: 0;
					if (msgCost > 0) {
						totalCost += msgCost;
						if (onCostUpdate) {
							onCostUpdate(totalCost);
						}
					} else if (msg?.usage) {
						// Fallback: event-level cost field
						const evtCost = typeof event.cost === "number" ? event.cost
							: (typeof event.cost === "object" && event.cost !== null) ? (Number((event.cost as any).total) || 0)
							: 0;
						if (evtCost > 0) {
							totalCost += evtCost;
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
					const endCost = typeof event.cost === "number" ? event.cost
						: (typeof event.cost === "object" && event.cost !== null) ? (Number((event.cost as any).total) || 0)
						: 0;
					if (endCost > 0 && endCost > totalCost) {
						totalCost = endCost;
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
				conflict: conflictDetected,
				actualBranch,
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
				conflict: conflictDetected,
				actualBranch,
			});
		});
	});
}
