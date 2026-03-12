/**
 * Pi-Shell — Agent Orchestration Extension
 *
 * Transforms Pi into an orchestrator agent that dispatches work to specialist subagents
 * rather than directly manipulating code. Acts as a personal command prompt with
 * task-driven workflow management and comprehensive agent lifecycle tracking.
 *
 * Core Behavior:
 * • Never directly manipulates code — all work is delegated to subagents
 * • Operates as a strict orchestrator with task-first workflow
 * • Shell commands pass through via Pi's built-in `!`/`!!` syntax
 * • Every interaction is tracked via TillDone task management (no exceptions)
 *
 * Key Features:
 * • TillDone task management: persistent task lists with idle→inprogress→done lifecycle
 * • Dispatch Agent tool: spawn specialist subagents (scout, builder, reviewer, etc.)
 * • Quick Answer tool: self-contained Q&A via read-only subagents
 * • Git tools: lightweight repository state checks and branch management
 * • Agent lifecycle management: real-time tracking of spawned subagent status
 * • Dashboard UI: live agent cards showing progress, cost, and current work
 *
 * State Management:
 * • Persistent TaskStore: tracks tasks, costs, branches, and completion status
 * • In-memory AgentTracker: monitors spawned subagent processes and lifecycle
 * • Session continuity: state survives compaction and session restarts
 *
 * Usage: pi -e extensions/pi-shell.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Container, Text, truncateToWidth, visibleWidth, matchesKey, Key } from "@mariozechner/pi-tui";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import * as path from "path";
import * as os from "os";
import { applyExtensionDefaults } from "./themeMap.ts";
import { loadConfig as loadShellConfig, resolveProfileModels, resolveProfileFallbacks, resolveOrchestratorModel, type ShellConfig } from "./pi-shell/config.ts";
import { createTaskStore as createPersistentTaskStore, type TaskStore, type Task, type TaskStatus } from "./pi-shell/task-store.ts";
import { spawnSubagent } from "./pi-shell/spawn.ts";
import { TASK_STATUS_ICON, AGENT_STATUS_ICON, AGENT_FOOTER_ICON, TILLDONE_TOOLS, ORCHESTRATOR_TOOLS } from "./pi-shell/constants.ts";
import {
	logDispatch, generateDispatchId, markFollowUps,
	findSimilarDispatches, formatInjectionContext,
	formatAnalysisReport, formatModelScorecard, readLog,
	OPERATION_TYPES, type OperationType,
} from "./pi-shell/dispatch-log.ts";
import { FAN_OUT_WHITELIST, executeFanOut, formatFanOutResults, estimateFanOutCost, type FanOutDispatch } from "./pi-shell/fan-out.ts";
import { executeParallelDispatch, formatParallelResults, type ParallelDispatchLeg } from "./pi-shell/parallel-dispatch.ts";
import { readFileSync, readdirSync, existsSync } from "fs";
import { execSync } from "child_process";
import { parse as yamlParse } from "yaml";

// ── Type Definitions ───────────────────────────────────────────────────

interface AgentState {
	name: string;
	status: "idle" | "running" | "done" | "error";
	task: string;
	taskId: number | null;
	elapsed: number;
	lastWork: string;
	contextPct: number;
	cost: number;
	pid: number | null;
	timer?: ReturnType<typeof setInterval>;
	groupId?: string;
	groupType?: "fan_out" | "parallel_dispatch";
	_key?: string;
}

interface AgentTracker {
	/** Get all tracked agents */
	getAll(): AgentState[];
	/** Get agent by name */
	get(name: string): AgentState | undefined;
	/** Start tracking an agent run */
	start(name: string, task: string, taskId: number, pid: number, opts?: { groupId?: string; groupType?: AgentState["groupType"] }): AgentState;
	/** Update an agent's state fields */
	update(name: string, fields: Partial<AgentState>): void;
	/** Mark an agent as finished (done or error) */
	finish(name: string, status: "done" | "error"): void;
	/** Remove an agent from tracking (after kill) */
	remove(name: string): void;
	/** Get all currently running agents */
	running(): AgentState[];
	/** Get total accumulated cost across all agents */
	totalCost(): number;
}

// ShellConfig, TaskStore, Task, TaskStatus imported from ./pi-shell/ modules

// ── AgentTracker Module ────────────────────────────────────────────────

/** Create an in-memory tracker for subagent lifecycle and status */
function createAgentTracker(): AgentTracker {
	const agents = new Map<string, AgentState>();
	let _seq = 0;

	/** Find agent by exact key first, then by name field (returns most recent match) */
	const findByName = (name: string): AgentState | undefined => {
		const lower = name.toLowerCase();
		// Exact key match
		const exact = agents.get(lower);
		if (exact) return exact;
		// Search by name field — return the most recent (last) match
		let found: AgentState | undefined;
		for (const a of agents.values()) {
			if (a.name.toLowerCase() === lower || a._key === lower) found = a;
		}
		return found;
	};

	const findKeyByName = (name: string): string | undefined => {
		const lower = name.toLowerCase();
		if (agents.has(lower)) return lower;
		let foundKey: string | undefined;
		for (const [k, a] of agents.entries()) {
			if (a.name.toLowerCase() === lower) foundKey = k;
		}
		return foundKey;
	};

	return {
		getAll: () => Array.from(agents.values()),
		get: (name) => findByName(name),
		start: (name, task, taskId, pid, opts?: { groupId?: string; groupType?: AgentState["groupType"] }) => {
			// Unique internal key — prevents clobbering when the same agent type
			// is dispatched multiple times (e.g. two sequential scout calls)
			const key = `${name.toLowerCase()}-${++_seq}`;
			const state: AgentState = {
				name,
				status: "running",
				task,
				taskId,
				elapsed: 0,
				lastWork: "",
				contextPct: 0,
				cost: 0,
				pid,
				groupId: opts?.groupId,
				groupType: opts?.groupType,
				_key: key,
			};
			agents.set(key, state);
			return state;
		},
		update: (name, fields) => {
			const state = findByName(name);
			if (state) Object.assign(state, fields);
		},
		finish: (name, status) => {
			const state = findByName(name);
			if (state) {
				state.status = status;
				if (state.timer) clearInterval(state.timer);
			}
		},
		remove: (name) => {
			const key = findKeyByName(name);
			if (key) agents.delete(key);
		},
		running: () => Array.from(agents.values()).filter((a) => a.status === "running"),
		totalCost: () => Array.from(agents.values()).reduce((sum, a) => sum + a.cost, 0),
	};
}

// ── Tool Registration Stubs ────────────────────────────────────────────

/** Register the tilldone tool with persistent TaskStore and blocking gate */
function registerTillDone(pi: ExtensionAPI, taskStore: TaskStore): void {

	pi.registerTool({
		name: "tilldone",
		label: "TillDone",
		description:
			"Manage your task list. dispatch_agent and fan_out auto-create tasks, so you only need this for multi-step planning. " +
			"Actions: new-list (text=title), add (text or texts[] for batch), toggle (id) — cycles idle→inprogress→done, " +
			"remove (id), update (id + text), list, clear.",
		parameters: Type.Object({
			action: StringEnum(["new-list", "add", "toggle", "remove", "update", "list", "clear"] as const),
			text: Type.Optional(Type.String({ description: "Task text (for add/update) or list title (for new-list)" })),
			texts: Type.Optional(Type.Array(Type.String(), { description: "Multiple task texts (for add). Use this to batch-add several tasks at once." })),
			id: Type.Optional(Type.Number({ description: "Task ID (for toggle/remove/update)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.action) {
				case "new-list": {
					if (!params.text) {
						return {
							content: [{ type: "text" as const, text: "Error: text (title) required for new-list" }],
						};
					}
					taskStore.newList(params.text);
					return {
						content: [{ type: "text" as const, text: `New list created: "${params.text}"` }],
					};
				}

				case "add": {
					// Support batch via texts param, or single via text param
					const items = params.texts?.length ? params.texts : params.text ? [params.text] : [];
					if (items.length === 0) {
						return {
							content: [{ type: "text" as const, text: "Error: text or texts required for add" }],
						};
					}

					if (items.length === 1) {
						const task = taskStore.add(items[0]);
						return {
							content: [{ type: "text" as const, text: `Added task #${task.id} (${task.status}): ${task.text}` }],
						};
					}

					const added = taskStore.addBatch(items);
					const ids = added.map((t) => `#${t.id}`).join(", ");
					return {
						content: [{ type: "text" as const, text: `Added ${added.length} tasks: ${ids}` }],
					};
				}

				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for toggle" }],
						};
					}
					try {
						const task = taskStore.toggle(params.id);
						return {
							content: [{ type: "text" as const, text: `Task #${task.id}: now ${task.status} — ${task.text}` }],
						};
					} catch (err: any) {
						return {
							content: [{ type: "text" as const, text: `Error: ${err.message}` }],
						};
					}
				}

				case "remove": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for remove" }],
						};
					}
					try {
						const task = taskStore.getById(params.id);
						taskStore.remove(params.id);
						return {
							content: [{ type: "text" as const, text: `Removed task #${params.id}${task ? `: ${task.text}` : ""}` }],
						};
					} catch (err: any) {
						return {
							content: [{ type: "text" as const, text: `Error: ${err.message}` }],
						};
					}
				}

				case "update": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text" as const, text: "Error: id required for update" }],
						};
					}
					if (!params.text) {
						return {
							content: [{ type: "text" as const, text: "Error: text required for update" }],
						};
					}
					try {
						const oldTask = taskStore.getById(params.id);
						const oldText = oldTask?.text ?? "?";
						taskStore.update(params.id, params.text);
						return {
							content: [{ type: "text" as const, text: `Updated #${params.id}: "${oldText}" → "${params.text}"` }],
						};
					} catch (err: any) {
						return {
							content: [{ type: "text" as const, text: `Error: ${err.message}` }],
						};
					}
				}

				case "list": {
					const tasks = taskStore.getAll();
					const title = taskStore.getTitle();
					if (tasks.length === 0) {
						return {
							content: [{ type: "text" as const, text: "No tasks defined yet." }],
						};
					}
					const header = title ? `${title}:` : "Tasks:";
					const lines = tasks.map((t) =>
						`[${TASK_STATUS_ICON[t.status]}] #${t.id} (${t.status}): ${t.text}`
					);
					return {
						content: [{ type: "text" as const, text: `${header}\n${lines.join("\n")}` }],
					};
				}

				case "clear": {
					const count = taskStore.getAll().length;
					taskStore.clear();
					return {
						content: [{ type: "text" as const, text: `Cleared ${count} task(s)` }],
					};
				}

				default:
					return {
						content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }],
					};
			}
		},

		renderCall(args, theme) {
			const a = args as any;
			let text = theme.fg("toolTitle", theme.bold("tilldone ")) + theme.fg("muted", a.action || "");
			if (a.texts?.length) text += ` ${theme.fg("dim", `${a.texts.length} tasks`)}`;
			else if (a.text) text += ` ${theme.fg("dim", `"${a.text}"`)}`;
			if (a.id !== undefined) text += ` ${theme.fg("accent", `#${a.id}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, _theme) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	// Blocking gate: prevent non-whitelisted tools when no task is active.
	// dispatch_agent and fan_out auto-create a task if none exists (reduces friction).
	const AUTO_TASK_TOOLS = ["dispatch_agent", "fan_out", "parallel_dispatch"];
	pi.on("tool_call", async (event, _ctx) => {
		if (TILLDONE_TOOLS.includes(event.toolName as any)) return { block: false };

		const active = taskStore.getActive();
		if (active) return { block: false };

		// Auto-create and activate a task for dispatch/fan_out calls
		if (AUTO_TASK_TOOLS.includes(event.toolName)) {
			const taskDesc = (event.parameters as any)?.task
				?? (event.parameters as any)?.dispatches?.[0]?.task
				?? "dispatched work";
			const slug = taskDesc.slice(0, 80).replace(/\n/g, " ");
			const newTask = taskStore.add(slug);
			taskStore.toggle(newTask.id); // activate it
			return { block: false };
		}

		const tasks = taskStore.getAll();
		if (tasks.length === 0) {
			return { block: true, reason: "No tasks defined. Use `tilldone add` first, or just call dispatch_agent/fan_out directly (they auto-create tasks)." };
		}
		return { block: true, reason: "No task in progress. Use `tilldone toggle <id>` to activate a task." };
	});
}

/** Register the dispatch_agent tool for spawning subagents */
function registerDispatch(
	pi: ExtensionAPI,
	_config: ShellConfig,
	_taskStore: TaskStore,
	_agentTracker: AgentTracker,
	_shellState: { agentModels: Record<string, string>; agentFallbacks: Record<string, string> },
): void {
	const cwd = process.cwd();
	const sessionDir = path.join(cwd, ".pi", "tasks", "sessions");

	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description: "Dispatch a task to a specialist subagent. Specify agent name and task description. Operation type and branch are optional.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name: scout, builder, reviewer, red-team, plan-reviewer, documenter" }),
			task: Type.String({ description: "Clear, specific task description for the agent" }),
			branch: Type.Optional(Type.String({ description: "Target git branch for code changes (e.g. task/3-fix-auth)" })),
			operationType: Type.Optional(StringEnum(OPERATION_TYPES, { description: "Type of operation: refactor, fix, add, investigate, review, audit, document, test. Defaults to 'investigate' if omitted." })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const { agent, task, branch } = params as { agent: string; task: string; branch?: string; operationType?: OperationType };
			const operationType: OperationType = (params as any).operationType ?? "investigate";

			// Resolve the active task to attach cost to
			const activeTask = _taskStore.getActive();
			const taskId = activeTask?.id ?? 0;

			// Resolve model from active profile
			const model = _shellState.agentModels[agent.toLowerCase()];

			// Resolve timeout from config (default 600s)
			const timeout = _config.agent_timeouts[agent.toLowerCase()] ?? 600;

			const maxResultTokens = _config.orchestrator.max_dispatch_result_tokens;

			// Determine branch: use explicit branch param, or auto-generate if git.auto_branch is enabled
			let targetBranch = branch;
			if (!targetBranch && _config.git.auto_branch && activeTask) {
				const slug = activeTask.text
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-|-$/g, "")
					.slice(0, 40);
				targetBranch = `${_config.git.branch_prefix}${activeTask.id}-${slug}`;
				_taskStore.setBranch(activeTask.id, targetBranch);
			}

			// Track agent start — use pid 0 as placeholder (updated below isn't possible
			// since spawnSubagent encapsulates the process, but we track lifecycle)
			const agentState = _agentTracker.start(agent, task, taskId, 0);

			// Set up elapsed timer
			const startTime = Date.now();
			const elapsedTimer = setInterval(() => {
				_agentTracker.update(agent, { elapsed: Date.now() - startTime });
			}, 1000);

			// Context injection: surface relevant past outcomes
			let injectionPrefix = "";
			if (_config.context_injection.enabled) {
				const similar = findSimilarDispatches(cwd, agent, operationType, _config.context_injection.max_matches);
				const ctx = formatInjectionContext(similar);
				if (ctx) {
					injectionPrefix = ctx + "\n\n---\n\n";
				}
			}

			// Send initial streaming update (include injection context if available)
			if (onUpdate) {
				const dispatchMsg = injectionPrefix
					? `${injectionPrefix}Dispatching ${agent}...`
					: `Dispatching ${agent}...`;
				onUpdate({
					content: [{ type: "text", text: dispatchMsg }],
					details: { agent, task, status: "dispatching" },
				});
			}

			// Generate dispatch ID and mark follow-ups for same parentTaskId
			const dispatchId = generateDispatchId();
			if (taskId > 0) {
				markFollowUps(cwd, taskId, dispatchId);
			}

			// Resolve fallback model from active profile
			const fallbackModel = _shellState.agentFallbacks?.[agent.toLowerCase()];

			try {
				const result = await spawnSubagent({
					agent,
					task,
					model,
					fallbackModel,
					branch: targetBranch,
					cwd,
					agentDefsDir: PI_SHELL_ROOT,
					timeout,
					maxResultTokens,
					sessionDir,
					taskId,
					signal,
					onUpdate: (data) => {
						// Update agent tracker with latest work
						if (data.type === "text_delta") {
							_agentTracker.update(agent, { lastWork: data.content });
						}
						// Stream progress to orchestrator
						if (onUpdate) {
							onUpdate({
								content: [{ type: "text", text: data.content }],
								details: { agent, task, status: "running", type: data.type },
							});
						}
					},
					onCostUpdate: (cost) => {
						_agentTracker.update(agent, { cost });
						// Add cost to the active task
						if (activeTask) {
							_taskStore.addCost(activeTask.id, cost - (agentState.cost || 0));
						}
					},
				});

				clearInterval(elapsedTimer);

				// Surface conflict info from dispatch result
				const conflictWarning = result.conflict ? "⚠️ MERGE CONFLICT DETECTED — manual resolution needed\n" : "";

				// Track actual branch if it differs from target
				if (result.actualBranch && result.actualBranch !== targetBranch) {
					if (activeTask) _taskStore.setBranch(activeTask.id, result.actualBranch);
					targetBranch = result.actualBranch;
				}

				const status = result.exitCode === 0 ? "done" : "error";
				_agentTracker.update(agent, { elapsed: result.elapsed, cost: result.cost });
				_agentTracker.finish(agent, status);

				// Log dispatch to persistent dispatch log
				logDispatch(cwd, {
					id: dispatchId,
					timestamp: new Date().toISOString(),
					agent,
					operation: operationType,
					taskPrompt: task,
					taskSummary: task.slice(0, 120),
					outcome: result.exitCode === 0 ? "success" : "failure",
					exitCode: result.exitCode,
					cost: result.cost,
					elapsed: result.elapsed,
					branch: targetBranch || null,
					model: model || null,
					parentTaskId: taskId,
					followUpNeeded: false,
					fanOutGroupId: null,
					failureReason: result.failureReason || null,
					fellBack: result.fellBack || false,
				});

				const summary = `[${agent}] ${status} in ${Math.round(result.elapsed / 1000)}s` +
					(result.cost > 0 ? ` ($${result.cost.toFixed(3)})` : "");

				return {
					content: [{ type: "text" as const, text: `${conflictWarning}${summary}\n\n${result.output}` }],
					details: {
						agent,
						task,
						status,
						elapsed: result.elapsed,
						exitCode: result.exitCode,
						cost: result.cost,
						branch: targetBranch,
					},
				};
			} catch (err: any) {
				clearInterval(elapsedTimer);
				_agentTracker.finish(agent, "error");

				return {
					content: [{ type: "text" as const, text: `Error dispatching to ${agent}: ${err?.message || err}` }],
					details: { agent, task, status: "error", elapsed: 0, exitCode: 1, cost: 0 },
				};
			}
		},
		renderCall(args, theme) {
			const a = args as any;
			return new Text(
				theme.fg("toolTitle", theme.bold("dispatch_agent ")) +
				theme.fg("accent", a.agent || "?") +
				theme.fg("dim", " — ") +
				theme.fg("muted", (a.task || "").slice(0, 60)),
				0, 0,
			);
		},
		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			// Streaming/partial result while agent is still running
			if (options.isPartial || details.status === "dispatching") {
				return new Text(
					theme.fg("accent", `● ${details.agent || "?"}`) +
					theme.fg("dim", " working..."),
					0, 0,
				);
			}

			const icon = details.status === "done" ? "✓" : "✗";
			const color = details.status === "done" ? "success" : "error";
			const elapsed = typeof details.elapsed === "number" ? Math.round(details.elapsed / 1000) : 0;
			const costStr = details.cost > 0 ? ` $${details.cost.toFixed(3)}` : "";
			const header = theme.fg(color, `${icon} ${details.agent}`) +
				theme.fg("dim", ` ${elapsed}s${costStr}`);

			if (options.expanded && result.content[0]?.type === "text") {
				const output = result.content[0].text;
				const truncated = output.length > 4000
					? output.slice(0, 4000) + "\n... [truncated in view]"
					: output;
				return new Text(header + "\n" + theme.fg("muted", truncated), 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});
}

/** Register the answer tool for quick self-contained question handling */
function registerAnswer(
	pi: ExtensionAPI,
	_config: ShellConfig,
	_taskStore: TaskStore,
	_agentTracker: AgentTracker,
	_shellState: { agentModels: Record<string, string>; agentFallbacks: Record<string, string> },
): void {
	const cwd = process.cwd();
	const sessionDir = path.join(cwd, ".pi", "tasks", "sessions");

	pi.registerTool({
		name: "answer",
		label: "Quick Answer",
		description: "Answer a quick question using a read-only subagent. Self-contained — handles its own task lifecycle.",
		parameters: Type.Object({
			question: Type.String({ description: "The question to answer" }),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const { question } = params as { question: string };

			// 1. Create task and toggle to in-progress
			const task = _taskStore.add(question);
			_taskStore.toggle(task.id); // idle -> inprogress

			const model = _shellState.agentModels.answer || _shellState.agentModels.scout;
			const timeout = _config.agent_timeouts.answer ?? 120;
			const maxResultTokens = _config.orchestrator.max_dispatch_result_tokens;

			const answerFallback = _shellState.agentFallbacks?.answer;

			try {
				// 2. Spawn read-only scout subagent
				const result = await spawnSubagent({
					agent: "scout",
					task: `Answer the following question about the codebase: ${question}`,
					model,
					fallbackModel: answerFallback,
					cwd,
					agentDefsDir: PI_SHELL_ROOT,
					timeout,
					maxResultTokens,
					sessionDir,
					taskId: task.id,
					signal,
					onUpdate: (data) => {
						if (onUpdate) {
							onUpdate({
								content: [{ type: "text" as const, text: data.content }],
							});
						}
					},
					onCostUpdate: (cost) => {
						_agentTracker.update("scout", { cost });
					},
				});

				// 3. Mark task done and record cost
				_taskStore.toggle(task.id); // inprogress -> done
				if (result.cost > 0) {
					_taskStore.addCost(task.id, result.cost);
				}

				// Log answer dispatch
				logDispatch(cwd, {
					id: generateDispatchId(),
					timestamp: new Date().toISOString(),
					agent: "scout",
					operation: "investigate",
					taskPrompt: question,
					taskSummary: `[answer] ${question.slice(0, 100)}`,
					outcome: result.exitCode === 0 ? "success" : "failure",
					exitCode: result.exitCode,
					cost: result.cost,
					elapsed: result.elapsed,
					branch: null,
					model: model || null,
					parentTaskId: task.id,
					followUpNeeded: false,
					fanOutGroupId: null,
					failureReason: result.failureReason || null,
					fellBack: result.fellBack || false,
				});

				return {
					content: [{ type: "text" as const, text: result.output || "(no answer returned)" }],
				};
			} catch (err: unknown) {
				// On failure, still mark task as done so it doesn't block
				try {
					_taskStore.toggle(task.id); // inprogress -> done
				} catch {
					// Task may already be in unexpected state — ignore
				}

				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Error answering question: ${message}` }],
				};
			}
		},
		renderCall(args, theme) {
			const q = (args as any).question || "?";
			return new Text(
				theme.fg("toolTitle", theme.bold("answer ")) +
				theme.fg("muted", q.slice(0, 70)),
				0, 0,
			);
		},
		renderResult(result, _options, _theme) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});
}

/** Register the git_status tool for lightweight repo state checks */
function registerGitStatus(pi: ExtensionAPI): void {
	// Will implement: current branch, uncommitted changes, recent commits,
	// active task branches and PR status. No file reading — metadata only.
	// Bypasses TillDone gate (whitelisted)

	pi.registerTool({
		name: "git_status",
		label: "Git Status",
		description: "Check repository state: current branch, uncommitted changes, recent commits, task branches and PR status.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const opts = { encoding: "utf-8" as const, cwd: process.cwd() };
			const lines: string[] = [];

			// 1. Current branch
			try {
				const branch = execSync("git branch --show-current", opts).trim();
				lines.push(`Branch: ${branch || "(detached HEAD)"}`);
			} catch {
				lines.push("Branch: (unable to determine)");
			}

			// 2. Uncommitted changes
			try {
				const porcelain = execSync("git status --porcelain", opts).trim();
				if (!porcelain) {
					lines.push("Changes: clean working tree");
				} else {
					const entries = porcelain.split("\n");
					let modified = 0;
					let added = 0;
					let deleted = 0;
					let untracked = 0;
					let other = 0;
					for (const entry of entries) {
						const code = entry.substring(0, 2);
						if (code === "??") untracked++;
						else if (code.includes("M")) modified++;
						else if (code.includes("A")) added++;
						else if (code.includes("D")) deleted++;
						else other++;
					}
					const parts: string[] = [];
					if (modified) parts.push(`${modified} modified`);
					if (added) parts.push(`${added} added`);
					if (deleted) parts.push(`${deleted} deleted`);
					if (untracked) parts.push(`${untracked} untracked`);
					if (other) parts.push(`${other} other`);
					lines.push(`Changes: ${entries.length} uncommitted (${parts.join(", ")})`);
				}
			} catch {
				lines.push("Changes: (unable to determine)");
			}

			// 3. Recent commits
			try {
				const log = execSync("git log --oneline -5", opts).trim();
				if (log) {
					lines.push("Recent commits:");
					for (const commit of log.split("\n")) {
						lines.push(`  ${commit}`);
					}
				} else {
					lines.push("Recent commits: (none)");
				}
			} catch {
				lines.push("Recent commits: (unable to retrieve)");
			}

			// 4. Task branches
			try {
				const branches = execSync('git branch --list "task/*"', opts).trim();
				if (branches) {
					lines.push("Task branches:");
					for (const b of branches.split("\n")) {
						lines.push(`  ${b.trim()}`);
					}
				} else {
					lines.push("Task branches: (none)");
				}
			} catch {
				lines.push("Task branches: (unable to retrieve)");
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("git_status")), 0, 0);
		},
		renderResult(result, _options, _theme) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});
}

/** Register the /switch-key command for OpenRouter API key profile switching.
 *  Key flows: op read → auth.json via shell pipeline. Never touches JS memory. */
function registerSwitchKeyCommand(
	pi: ExtensionAPI,
	_config: ShellConfig,
	_shellState: {
		activeProfile: string;
		agentModels: Record<string, string>;
		agentFallbacks: Record<string, string>;
	},
): void {
	const { execSync } = require("child_process") as typeof import("child_process");
	const authJsonPath = path.join(os.homedir(), ".pi", "agent", "auth.json");

	pi.registerCommand("switch-key", {
		description: "Switch OpenRouter API key profile (usage: /switch-key <profile>)",
		handler: async (_args, _ctx) => {
			const profile = _args?.trim();
			if (!profile) {
				const available = Object.keys(_config.profiles).filter((k) => k !== "default");
				_ctx.ui.notify(`Usage: /switch-key <profile>\nAvailable: ${available.join(", ")}`, "info");
				return;
			}

			const profileConfig = (_config.profiles as Record<string, any>)[profile];
			if (!profileConfig || typeof profileConfig === "string") {
				const available = Object.keys(_config.profiles).filter((k) => k !== "default");
				_ctx.ui.notify(`Unknown profile '${profile}'. Available: ${available.join(", ")}`, "error");
				return;
			}

			const opRef = profileConfig.op as string;
			if (!opRef) {
				_ctx.ui.notify(`Profile '${profile}' has no 'op' reference configured.`, "error");
				return;
			}

			// Step 1: Check op is available
			try {
				execSync("command -v op", { stdio: "ignore" });
			} catch {
				_ctx.ui.notify("1Password CLI (op) not found. Install it first.", "error");
				return;
			}

			// Step 2: Pipe key from op directly into auth.json — key never enters JS
			try {
				const shellCmd = `op read "${opRef}" | python3 -c "import sys,json; k=sys.stdin.read().strip(); print(json.dumps({'openrouter':{'type':'api_key','key':k}}, indent=2))" > "${authJsonPath}"`;
				execSync(shellCmd, { stdio: "pipe", timeout: 15000 });
			} catch (e: any) {
				_ctx.ui.notify(`Failed to fetch key from 1Password:\n${e.message || e}`, "error");
				return;
			}

			// Step 3: Verify auth.json was written and test the key
			try {
				const testCmd = `KEY=$(python3 -c "import json; print(json.load(open('${authJsonPath}'))['openrouter']['key'])") && curl -sf -o /dev/null -w "%{http_code}" "https://openrouter.ai/api/v1/auth/key" -H "Authorization: Bearer $KEY"`;
				const httpCode = execSync(testCmd, { stdio: "pipe", timeout: 10000 }).toString().trim();
				if (httpCode !== "200") {
					_ctx.ui.notify(`Key verification failed (HTTP ${httpCode}). auth.json may be invalid.`, "error");
					return;
				}
			} catch (e: any) {
				_ctx.ui.notify(`Key verification failed:\n${e.message || e}`, "error");
				return;
			}

			// Step 4: Check if orchestrator model would change
			const prevOrch = resolveOrchestratorModel(_config, _shellState.activeProfile);
			const newOrch = resolveOrchestratorModel(_config, profile);
			const orchNote = newOrch !== prevOrch
				? `\n⚠ Orchestrator model differs for '${profile}' (${newOrch.split("/").pop()}) — restart pish to apply.`
				: "";

			// Step 5: Switch active profile — update key, models, and fallbacks
			_shellState.activeProfile = profile;
			_shellState.agentModels = resolveProfileModels(_config, profile);
			_shellState.agentFallbacks = resolveProfileFallbacks(_config, profile);

			// Step 6: Confirm with model summary
			const modelLines = Object.entries(_shellState.agentModels)
				.map(([role, model]) => `  ${role}: ${(model as string).split("/").pop()}`)
				.join("\n");
			_ctx.ui.notify(
				`Switched to '${profile}' ✓\nAgent models:\n${modelLines}${orchNote}`,
				"info",
			);
		},
	});
}

/** Register the kill_agent tool for subagent cancellation */
function registerKillAgent(pi: ExtensionAPI, _agentTracker: AgentTracker): void {
	// Will implement: kill running subagent by name, clean up session file,
	// update AgentTracker, report cancellation
	// Bypasses TillDone gate (whitelisted)

	pi.registerTool({
		name: "kill_agent",
		label: "Kill Agent",
		description: "Cancel a running subagent by name.",
		parameters: Type.Object({
			agent: Type.String({ description: "Name of the agent to kill" }),
		}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const { agent } = _params as { agent: string };
			const state = _agentTracker.get(agent);

			if (!state) {
				const running = _agentTracker.running();
				const names = running.map((a) => a.name).join(", ") || "none";
				return {
					content: [{ type: "text" as const, text: `Agent '${agent}' not found. Running agents: ${names}` }],
				};
			}

			if (state.status !== "running") {
				return {
					content: [{ type: "text" as const, text: `Agent '${agent}' is already ${state.status}` }],
				};
			}

			if (state.pid) {
				try {
					process.kill(state.pid, "SIGTERM");
				} catch (err: any) {
					// Process may have already exited
				}
			}

			_agentTracker.finish(agent, "error");

			const pidInfo = state.pid ? ` (pid: ${state.pid})` : "";
			return {
				content: [{ type: "text" as const, text: `Killed agent '${agent}'${pidInfo}` }],
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("kill_agent ")) +
				theme.fg("error", (args as any).agent || "?"),
				0, 0,
			);
		},
		renderResult(result, _options, _theme) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});
}

/** Register the fan_out tool for parallel read-only dispatch */
function registerFanOut(
	pi: ExtensionAPI,
	_config: ShellConfig,
	_taskStore: TaskStore,
	_agentTracker: AgentTracker,
	_shellState: { agentModels: Record<string, string>; agentFallbacks: Record<string, string> },
): void {
	const cwd = process.cwd();
	const sessionDir = path.join(cwd, ".pi", "tasks", "sessions");

	pi.registerTool({
		name: "fan_out",
		label: "Fan Out",
		description:
			"Dispatch multiple read-only agents in parallel across explicitly specified areas. " +
			"Read-only agents only (scout, reviewer, red-team, plan-reviewer). " +
			"You must know the areas before calling — scout first if you don't.",
		parameters: Type.Object({
			agent: Type.String({ description: "Read-only agent name (scout, reviewer, red-team, plan-reviewer)" }),
			dispatches: Type.Array(
				Type.Object({
					task: Type.String({ description: "Focused task for this area — must request structured summary" }),
					scope: Type.String({ description: "Area label (e.g. 'src/auth', 'API layer')" }),
				}),
				{ minItems: 2, maxItems: 5, description: "2-5 parallel dispatches with explicit scopes" },
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const { agent, dispatches } = params as { agent: string; dispatches: FanOutDispatch[] };

			// Enforce read-only whitelist
			if (!FAN_OUT_WHITELIST.includes(agent as any)) {
				return {
					content: [{ type: "text" as const, text: `Error: fan_out only supports read-only agents: ${FAN_OUT_WHITELIST.join(", ")}. Got: ${agent}` }],
				};
			}

			const activeTask = _taskStore.getActive();
			const taskId = activeTask?.id ?? 0;
			const model = _shellState.agentModels[agent.toLowerCase()];
			const fallbackModel = _shellState.agentFallbacks?.[agent.toLowerCase()];
			const timeout = _config.agent_timeouts[agent.toLowerCase()] ?? 300;
			const maxResultTokens = _config.orchestrator.max_dispatch_result_tokens;
			const costCeiling = _config.fan_out.cost_ceiling;

			// Cost estimate
			const estimated = estimateFanOutCost(dispatches.length);
			if (estimated > costCeiling) {
				return {
					content: [{ type: "text" as const, text: `Estimated cost $${estimated.toFixed(2)} exceeds ceiling $${costCeiling.toFixed(2)}. Reduce dispatches or raise fan_out.cost_ceiling.` }],
				};
			}

			// Send initial update
			if (onUpdate) {
				const scopes = dispatches.map(d => d.scope).join(", ");
				onUpdate({
					content: [{ type: "text", text: `Fan-out: ${dispatches.length}x ${agent} → [${scopes}] (est. $${estimated.toFixed(2)})` }],
					details: { agent, dispatches: dispatches.length, status: "dispatching" },
				});
			}

			// Track each leg in AgentTracker
			const foGroupId = `fo-${Date.now()}`;
			for (let i = 0; i < dispatches.length; i++) {
				const key = `${agent}-${i}`;
				_agentTracker.start(key, dispatches[i].task, taskId, 0, { groupId: foGroupId, groupType: "fan_out" });
			}

			try {
				let lastKnownFanOutCost = 0;
				const result = await executeFanOut({
					agent,
					dispatches,
					cwd,
					agentDefsDir: PI_SHELL_ROOT,
					model,
					fallbackModel,
					timeout,
					maxResultTokens,
					sessionDir,
					taskId,
					parentTaskId: taskId,
					costCeiling,
					signal,
					onUpdate: (scope, data) => {
						if (onUpdate) {
							onUpdate({
								content: [{ type: "text", text: data.content }],
								details: { agent, scope, status: "running", type: data.type },
							});
						}
					},
					onCostUpdate: (totalCost) => {
						if (activeTask) {
							const delta = totalCost - lastKnownFanOutCost;
							lastKnownFanOutCost = totalCost;
							if (delta > 0) _taskStore.addCost(activeTask.id, delta);
						}
					},
				});

				// Clean up tracker entries
				for (let i = 0; i < dispatches.length; i++) {
					const key = `${agent}-${i}`;
					const legResult = result.legs[i];
					_agentTracker.finish(key, legResult.exitCode === 0 ? "done" : "error");
				}

				const formatted = formatFanOutResults(result, agent);

				const costWarning = result.totalCost > costCeiling
					? `\n\nWarning: Total cost $${result.totalCost.toFixed(3)} exceeded ceiling $${costCeiling.toFixed(2)}\n`
					: "";

				return {
					content: [{ type: "text" as const, text: `${costWarning}${formatted}` }],
					details: {
						agent,
						dispatches: dispatches.length,
						status: "done",
						totalCost: result.totalCost,
						totalElapsed: result.totalElapsed,
						fanOutGroupId: result.fanOutGroupId,
					},
				};
			} catch (err: any) {
				// Clean up tracker
				for (let i = 0; i < dispatches.length; i++) {
					_agentTracker.finish(`${agent}-${i}`, "error");
				}

				return {
					content: [{ type: "text" as const, text: `Error in fan_out: ${err?.message || err}` }],
					details: { agent, dispatches: dispatches.length, status: "error" },
				};
			}
		},
		renderCall(args, theme) {
			const a = args as any;
			const count = a.dispatches?.length ?? "?";
			return new Text(
				theme.fg("toolTitle", theme.bold("fan_out ")) +
				theme.fg("accent", `${count}x ${a.agent || "?"}`) +
				theme.fg("dim", ` → ${(a.dispatches || []).map((d: any) => d.scope).join(", ")}`),
				0, 0,
			);
		},
		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (options.isPartial || details.status === "dispatching") {
				return new Text(
					theme.fg("accent", `● fan_out ${details.dispatches || "?"}x ${details.agent || "?"}`) +
					theme.fg("dim", " working..."),
					0, 0,
				);
			}

			const icon = details.status === "done" ? "✓" : "✗";
			const color = details.status === "done" ? "success" : "error";
			const elapsed = typeof details.totalElapsed === "number" ? Math.round(details.totalElapsed / 1000) : 0;
			const costStr = details.totalCost > 0 ? ` $${details.totalCost.toFixed(3)}` : "";
			const header = theme.fg(color, `${icon} fan_out ${details.dispatches}x ${details.agent}`) +
				theme.fg("dim", ` ${elapsed}s${costStr}`);

			if (options.expanded && result.content[0]?.type === "text") {
				const output = result.content[0].text;
				const truncated = output.length > 4000
					? output.slice(0, 4000) + "\n... [truncated in view]"
					: output;
				return new Text(header + "\n" + theme.fg("muted", truncated), 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});
}

/** Register the parallel_dispatch tool for running multiple agents concurrently */
function registerParallelDispatch(
	pi: ExtensionAPI,
	_config: ShellConfig,
	_taskStore: TaskStore,
	_agentTracker: AgentTracker,
	_shellState: { agentModels: Record<string, string>; agentFallbacks: Record<string, string> },
): void {
	const cwd = process.cwd();
	const sessionDir = path.join(cwd, ".pi", "tasks", "sessions");

	pi.registerTool({
		name: "parallel_dispatch",
		label: "Parallel Dispatch",
		description:
			"Dispatch 2-5 agents in parallel. Supports ALL agent types including builder. " +
			"Each dispatch can have its own branch (uses git worktrees for isolation). " +
			"Use this when tasks are independent and can run concurrently.",
		parameters: Type.Object({
			dispatches: Type.Array(
				Type.Object({
					agent: Type.String({ description: "Agent name: scout, builder, reviewer, red-team, plan-reviewer, documenter" }),
					task: Type.String({ description: "Clear, specific task description" }),
					branch: Type.Optional(Type.String({ description: "Git branch for this dispatch (e.g. task/3-fix-auth). Uses worktree for isolation." })),
					operationType: Type.Optional(StringEnum(OPERATION_TYPES, { description: "Operation type. Defaults to 'investigate'." })),
				}),
				{ minItems: 2, maxItems: 5, description: "2-5 parallel agent dispatches" },
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const { dispatches } = params as { dispatches: ParallelDispatchLeg[] };

			const activeTask = _taskStore.getActive();
			const taskId = activeTask?.id ?? 0;

			// Send initial update
			if (onUpdate) {
				const agents = dispatches.map(d => d.agent).join(", ");
				onUpdate({
					content: [{ type: "text", text: `Parallel dispatch: ${dispatches.length} agents → [${agents}]` }],
					details: { dispatches: dispatches.length, status: "dispatching" },
				});
			}

			// Track each leg in AgentTracker with composite keys
			const pdGroupId = `pd-${Date.now()}`;
			for (let i = 0; i < dispatches.length; i++) {
				const key = `${dispatches[i].agent}-p${i}`;
				_agentTracker.start(key, dispatches[i].task, taskId, 0, { groupId: pdGroupId, groupType: "parallel_dispatch" });
			}

			// Set up elapsed timers for each leg
			const startTime = Date.now();
			const elapsedTimer = setInterval(() => {
				for (let i = 0; i < dispatches.length; i++) {
					const key = `${dispatches[i].agent}-p${i}`;
					_agentTracker.update(key, { elapsed: Date.now() - startTime });
				}
			}, 1000);

			try {
				let lastKnownPdCost = 0;
				const result = await executeParallelDispatch({
					dispatches,
					cwd,
					agentDefsDir: PI_SHELL_ROOT,
					models: _shellState.agentModels,
					fallbacks: _shellState.agentFallbacks,
					timeouts: _config.agent_timeouts,
					maxResultTokens: _config.orchestrator.max_dispatch_result_tokens,
					sessionDir,
					taskId,
					signal,
					onLegUpdate: (index, agent, data) => {
						const key = `${agent}-p${index}`;
						if (data.type === "text_delta") {
							_agentTracker.update(key, { lastWork: data.content });
						}
						if (onUpdate) {
							onUpdate({
								content: [{ type: "text", text: data.content }],
								details: { agent, index, status: "running", type: data.type },
							});
						}
					},
					onCostUpdate: (totalCost) => {
						if (activeTask) {
							const delta = totalCost - lastKnownPdCost;
							lastKnownPdCost = totalCost;
							if (delta > 0) _taskStore.addCost(activeTask.id, delta);
						}
					},
				});

				clearInterval(elapsedTimer);

				// Finish tracker entries
				for (let i = 0; i < dispatches.length; i++) {
					const key = `${dispatches[i].agent}-p${i}`;
					const legResult = result.legs[i];
					_agentTracker.update(key, { elapsed: legResult.elapsed, cost: legResult.cost });
					_agentTracker.finish(key, legResult.exitCode === 0 ? "done" : "error");
				}

				const formatted = formatParallelResults(result);

				return {
					content: [{ type: "text" as const, text: formatted }],
					details: {
						dispatches: dispatches.length,
						status: "done",
						totalCost: result.totalCost,
						totalElapsed: result.totalElapsed,
						groupId: result.groupId,
					},
				};
			} catch (err: any) {
				clearInterval(elapsedTimer);
				for (let i = 0; i < dispatches.length; i++) {
					_agentTracker.finish(`${dispatches[i].agent}-p${i}`, "error");
				}
				return {
					content: [{ type: "text" as const, text: `Error in parallel_dispatch: ${err?.message || err}` }],
					details: { dispatches: dispatches.length, status: "error" },
				};
			}
		},
		renderCall(args, theme) {
			const a = args as any;
			const legs = a.dispatches || [];
			const agents = legs.map((d: any) => d.agent || "?").join(", ");
			return new Text(
				theme.fg("toolTitle", theme.bold("parallel_dispatch ")) +
				theme.fg("accent", `${legs.length}x`) +
				theme.fg("dim", ` → [${agents}]`),
				0, 0,
			);
		},
		renderResult(result, options, theme) {
			const details = result.details as any;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (options.isPartial || details.status === "dispatching") {
				return new Text(
					theme.fg("accent", `● parallel_dispatch ${details.dispatches || "?"}x`) +
					theme.fg("dim", " working..."),
					0, 0,
				);
			}

			const icon = details.status === "done" ? "✓" : "✗";
			const color = details.status === "done" ? "success" : "error";
			const elapsed = typeof details.totalElapsed === "number" ? Math.round(details.totalElapsed / 1000) : 0;
			const costStr = details.totalCost > 0 ? ` $${details.totalCost.toFixed(3)}` : "";
			const header = theme.fg(color, `${icon} parallel_dispatch ${details.dispatches}x`) +
				theme.fg("dim", ` ${elapsed}s${costStr}`);

			if (options.expanded && result.content[0]?.type === "text") {
				const output = result.content[0].text;
				const truncated = output.length > 4000
					? output.slice(0, 4000) + "\n... [truncated in view]"
					: output;
				return new Text(header + "\n" + theme.fg("muted", truncated), 0, 0);
			}

			return new Text(header, 0, 0);
		},
	});
}

/** Register the /improve-agents command for human-in-the-loop agent evolution */
function registerImproveAgentsCommand(
	pi: ExtensionAPI,
	_config: ShellConfig,
	_taskStore: TaskStore,
	_agentTracker: AgentTracker,
	_shellState: { agentModels: Record<string, string>; agentFallbacks: Record<string, string> },
): void {
	const cwd = process.cwd();
	const sessionDir = path.join(cwd, ".pi", "tasks", "sessions");

	pi.registerCommand("improve-agents", {
		description: "Analyze dispatch log and propose agent definition improvements",
		handler: async (_args, _ctx) => {
			const entries = readLog(cwd);
			if (entries.length < 5) {
				_ctx.ui.notify(
					`Only ${entries.length} dispatch log entries. Accumulate more data (10+ dispatches) for meaningful analysis.`,
					"info",
				);
				return;
			}

			// Generate analysis report
			const report = formatAnalysisReport(cwd);

			// Read current agent definitions (cwd first, fallback to pi-orchestrator root)
			const cwdAgents = path.join(cwd, ".pi", "agents");
			const agentsDir = existsSync(cwdAgents) ? cwdAgents : path.join(PI_SHELL_ROOT, ".pi", "agents");
			const agentDefs: string[] = [];
			try {
				const files = readdirSync(agentsDir).filter(f => f.endsWith(".md") && f !== "orchestrator.md");
				for (const file of files) {
					try {
						const content = readFileSync(path.join(agentsDir, file), "utf-8");
						agentDefs.push(`--- ${file} ---\n${content}`);
					} catch { /* skip unreadable */ }
				}
			} catch { /* agents dir unreadable */ }

			const agentDefsText = agentDefs.length > 0
				? agentDefs.join("\n\n")
				: "(No agent definitions found)";

			// Dispatch analysis to a capable model
			const analysisPrompt = [
				"You are an expert at improving AI agent configurations. Analyze the following dispatch log data and current agent definitions, then propose specific improvements.",
				"",
				"## Dispatch Log Analysis",
				report,
				"",
				"## Current Agent Definitions",
				agentDefsText,
				"",
				"## Your Task",
				"Based on the dispatch data, propose specific, concrete edits to the agent .md files. For each proposal:",
				"1. State what you're changing and why (cite evidence from the log)",
				"2. Show the exact edit (what to add/change/remove in which file)",
				"3. Explain the expected improvement",
				"",
				"Focus on:",
				"- System prompt improvements (add instructions that would prevent observed failures)",
				"- Tool adjustments (add/remove tools based on what agents actually need)",
				"- Model recommendations (if an agent's tasks are simple, suggest cheaper models)",
				"- Agents with high follow-up rates (their prompts may need more specificity)",
				"",
				"Be specific — not 'improve the prompt' but 'add this sentence to the system prompt'.",
			].join("\n");

			_ctx.ui.notify("Analyzing dispatch log and generating improvement proposals...", "info");

			try {
				const model = _shellState.agentModels.reviewer || "openrouter/deepseek/deepseek-v3.2";
				const timeout = _config.agent_timeouts.reviewer ?? 600;
				const maxResultTokens = _config.orchestrator.max_dispatch_result_tokens;

				const result = await spawnSubagent({
					agent: "scout",
					task: analysisPrompt,
					model,
					cwd,
					agentDefsDir: PI_SHELL_ROOT,
					timeout,
					maxResultTokens,
					sessionDir,
					taskId: 0,
					onUpdate: (data) => {
						if (data.type === "text_delta") {
							// Stream progress silently
						}
					},
				});

				if (result.output) {
					_ctx.ui.notify(
						`Agent Improvement Proposals\n\n${result.output}\n\n` +
						`Cost: $${result.cost.toFixed(3)} | Review these proposals and apply manually to .pi/agents/*.md`,
						"info",
					);
				} else {
					_ctx.ui.notify("Analysis completed but no proposals generated. Try again with more log data.", "info");
				}
			} catch (err: any) {
				_ctx.ui.notify(`Error analyzing dispatch log: ${err?.message || err}`, "info");
			}
		},
	});
}

// ── UI Registration Stubs ──────────────────────────────────────────────

/** Build a footer setup closure. Call the returned function with ctx inside session_start. */
function registerFooter(
	_pi: ExtensionAPI,
	_taskStore: TaskStore,
	_agentTracker: AgentTracker,
	_config: ShellConfig,
	_shellState: { ghAvailable: boolean; activeProfile: string; activeModel: string },
): (ctx: ExtensionContext) => void {
	let cachedBranch = "";
	let branchLastRefresh = 0;
	const BRANCH_CACHE_MS = 5000;

	function getGitBranch(): string {
		const now = Date.now();
		if (cachedBranch && now - branchLastRefresh < BRANCH_CACHE_MS) return cachedBranch;
		try {
			cachedBranch = execSync("git branch --show-current", {
				encoding: "utf-8",
				cwd: process.cwd(),
				timeout: 2000,
			}).trim();
		} catch {
			cachedBranch = "";
		}
		branchLastRefresh = now;
		return cachedBranch;
	}

	function shortenCwd(): string {
		const cwd = process.cwd();
		const home = process.env.HOME || process.env.USERPROFILE || "";
		if (home && cwd.startsWith(home)) {
			return "~" + cwd.slice(home.length);
		}
		return cwd;
	}

	return (ctx: ExtensionContext) => {
		ctx.ui.setFooter((_tui, theme, _footerData) => ({
			dispose: () => {},
			invalidate() {},
			render(width: number): string[] {
				const sep = theme.fg("dim", "  ");

				// cwd
				const cwdStr = theme.fg("muted", ` ${shortenCwd()}`);

				// git branch
				const branch = getGitBranch();
				const branchStr = branch
					? sep + theme.fg("muted", ` ${branch}`)
					: "";

				// task progress: done/total checkmark
				const tasks = _taskStore.getAll();
				const doneCount = tasks.filter((t) => t.status === "done").length;
				const taskStr = tasks.length > 0
					? sep + theme.fg("dim", "tasks: ") +
					  theme.fg("success", `${doneCount}`) +
					  theme.fg("dim", `/${tasks.length} ✓`)
					: "";

				// active agents with status icons — group parallel agents by base name
				const allAgents = _agentTracker.getAll();
				const activeAgents = allAgents.filter(a => a.status === "running" || a.status === "idle");
				const groups = new Map<string, { count: number; status: string }>();
				for (const a of activeAgents) {
					const base = a.name.replace(/-(p?\d+)$/, "");
					const existing = groups.get(base);
					if (existing) {
						existing.count++;
						if (a.status === "running") existing.status = "running";
					} else {
						groups.set(base, { count: 1, status: a.status });
					}
				}
				const agentParts = Array.from(groups.entries()).map(([name, { count, status }]) => {
					const icon = AGENT_FOOTER_ICON[status as keyof typeof AGENT_FOOTER_ICON] || "◻";
					const countStr = count > 1 ? `×${count}` : "";
					return theme.fg("accent", `${name}${icon}${countStr}`);
				});
				const agentStr = agentParts.length > 0
					? sep + agentParts.join(" ")
					: "";

				// session cost
				const totalCost = _agentTracker.totalCost();
				const costStr = totalCost > 0
					? sep + theme.fg("dim", `$${totalCost.toFixed(2)}`)
					: "";

				// api key profile (live from shellState)
				const profileStr = _shellState.activeProfile
					? sep + theme.fg("muted", _shellState.activeProfile)
					: "";

				const ghStr = !_shellState.ghAvailable && _config.git.auto_pr
					? sep + theme.fg("dim", "no-gh")
					: "";

				// orchestrator model (live from shellState, fallback to config)
				const fullModel = _shellState.activeModel || _config.orchestrator.model || "";
				const shortModel = fullModel.split("/").pop() || "";
				const modelStr = shortModel
					? sep + theme.fg("dim", shortModel)
					: "";

				const left = cwdStr + branchStr + taskStr + agentStr;
				const right = modelStr + costStr + profileStr + ghStr + " ";
				const pad = " ".repeat(
					Math.max(1, width - visibleWidth(left) - visibleWidth(right)),
				);
				return [truncateToWidth(left + pad + right, width)];
			},
		}));
	};
}

/** Build a dashboard widget setup closure. Call the returned function with ctx inside session_start. */
function registerDashboard(_pi: ExtensionAPI, _agentTracker: AgentTracker): (ctx: ExtensionContext) => void {
	return (ctx: ExtensionContext) => {
		ctx.ui.setWidget("pi-shell-dashboard", (_tui, theme) => {
			const container = new Container();
			const borderFn = (s: string) => theme.fg("dim", s);

			container.addChild(new Text("", 0, 0)); // top margin
			container.addChild(new DynamicBorder(borderFn));
			const content = new Text("", 1, 0);
			container.addChild(content);
			container.addChild(new DynamicBorder(borderFn));

			return {
				render(width: number): string[] {
					const running = _agentTracker.running();
					if (running.length === 0) {
						// Hide widget when no agents are running
						content.setText("");
						return [];
					}



					const lines: string[] = [];
					lines.push(
						theme.fg("accent", ` Agents`) +
						theme.fg("dim", ` (${running.length} running)`),
					);

					// Group agents by groupId for display
					const ungrouped: AgentState[] = [];
					const groupMap = new Map<string, { type: string; agents: AgentState[] }>();
					for (const agent of running) {
						if (agent.groupId) {
							const existing = groupMap.get(agent.groupId);
							if (existing) {
								existing.agents.push(agent);
							} else {
								groupMap.set(agent.groupId, {
									type: agent.groupType === "fan_out" ? "fan_out" : "parallel",
									agents: [agent],
								});
							}
						} else {
							ungrouped.push(agent);
						}
					}

					// Render grouped agents with headers
					for (const [, group] of groupMap) {
						const baseName = group.agents[0].name.replace(/-(p?\d+)$/, "");
						const label = group.type === "fan_out"
							? `${group.type}: ${group.agents.length}× ${baseName}`
							: `parallel: ${group.agents.length} agents`;
						lines.push(theme.fg("dim", `  ── ${label} ──`));

						for (const agent of group.agents) {
							const icon = AGENT_STATUS_ICON[agent.status as keyof typeof AGENT_STATUS_ICON] || "◻";
							const statusColor = agent.status === "running" ? "accent"
								: agent.status === "done" ? "success" : "error";
							const elapsed = Math.round(agent.elapsed / 1000);
							const costStr = agent.cost > 0 ? ` $${agent.cost.toFixed(3)}` : "";

							// Better display name: scout[0] instead of scout-0
							const displayName = agent.name.replace(/-(p?)(\d+)$/, (_, p, n) => `[${p}${n}]`);

							// Shorter task preview — first sentence or 60 chars max
							const firstSentence = agent.task.split(/\.\s/)[0];
							const maxTaskLen = Math.min(60, Math.max(20, width - 30));
							const taskPreview = firstSentence.length > maxTaskLen
								? firstSentence.slice(0, maxTaskLen - 3) + "..."
								: firstSentence;

							lines.push(
								theme.fg(statusColor, `  ${icon} ${displayName}`) +
								theme.fg("dim", ` ${elapsed}s${costStr}`) +
								theme.fg("muted", `  ${taskPreview}`),
							);
						}
					}

					// Render ungrouped agents normally
					for (const agent of ungrouped) {
						const icon = AGENT_STATUS_ICON[agent.status as keyof typeof AGENT_STATUS_ICON] || "◻";
						const statusColor = agent.status === "running" ? "accent"
							: agent.status === "done" ? "success" : "error";
						const elapsed = Math.round(agent.elapsed / 1000);
						const costStr = agent.cost > 0 ? ` $${agent.cost.toFixed(3)}` : "";

						// Shorter task preview — first sentence or 60 chars max
						const firstSentence = agent.task.split(/\.\s/)[0];
						const maxTaskLen = Math.min(60, Math.max(20, width - 30));
						const taskPreview = firstSentence.length > maxTaskLen
							? firstSentence.slice(0, maxTaskLen - 3) + "..."
							: firstSentence;

						lines.push(
							theme.fg(statusColor, `  ${icon} ${agent.name}`) +
							theme.fg("dim", ` ${elapsed}s${costStr}`) +
							theme.fg("muted", `  ${taskPreview}`),
						);

						// Last work line if available
						if (agent.lastWork) {
							const maxWorkLen = Math.max(20, width - 6);
							const workPreview = agent.lastWork.length > maxWorkLen
								? agent.lastWork.slice(0, maxWorkLen - 3) + "..."
								: agent.lastWork;
							lines.push(theme.fg("dim", `    ${workPreview}`));
						}
					}

					content.setText(lines.join("\n"));
					return container.render(width);
				},
				dispose() {},
				invalidate() {
					container.invalidate();
				},
			};
		});
	};
}

/** Register the /status command for cross-session task overview */
function registerStatusCommand(pi: ExtensionAPI, _taskStore: TaskStore): void {
	// Will implement: interactive overlay showing full task history with details

	pi.registerCommand("status", {
		description: "Show pi-shell task overview",
		handler: async (_args, _ctx) => {
			const tasks = _taskStore.getAll();
			if (tasks.length === 0) {
				_ctx.ui.notify("No tasks yet", "info");
				return;
			}

			const lines: string[] = [_taskStore.getTitle(), ""];
			for (const t of tasks) {
				let line = `${TASK_STATUS_ICON[t.status]} #${t.id} ${t.text}`;
				if (t.branch) line += ` [${t.branch}]`;
				if (t.cost && t.cost > 0) line += ` $${t.cost.toFixed(3)}`;
				lines.push(line);
			}
			const done = tasks.filter((t) => t.status === "done").length;
			const total = tasks.length;
			const totalCost = tasks.reduce((s, t) => s + (t.cost || 0), 0);
			lines.push("", `${done}/${total} done, $${totalCost.toFixed(3)} total cost`);
			_ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

/** Register the /kill command for interactive agent cancellation */
function registerKillCommand(pi: ExtensionAPI, _agentTracker: AgentTracker): void {
	// Will implement: select dialog listing running agents, kill selected one

	pi.registerCommand("kill", {
		description: "Kill a running subagent",
		handler: async (_args, _ctx) => {
			const name = _args?.trim();
			if (name) {
				const state = _agentTracker.get(name);
				if (!state) {
					_ctx.ui.notify(`No agent named "${name}"`, "info");
					return;
				}
				if (state.status !== "running" || !state.pid) {
					_ctx.ui.notify(`Agent "${name}" is not running`, "info");
					return;
				}
				try {
					process.kill(state.pid, "SIGTERM");
				} catch {
					// process may already be gone
				}
				_agentTracker.finish(name, "error");
				_ctx.ui.notify(`Killed agent "${name}" (pid ${state.pid})`, "info");
				return;
			}
			const running = _agentTracker.running();
			if (running.length === 0) {
				_ctx.ui.notify("No agents currently running", "info");
				return;
			}
			const list = running.map((a) => `${a.name} (pid ${a.pid})`).join(", ");
			_ctx.ui.notify(`Running agents: ${list}. Use /kill <name>`, "info");
		},
	});
}

/** Register the /help command for pi-shell onboarding */
function registerHelpCommand(pi: ExtensionAPI): void {
	// Will implement: display usage guide, available commands, workflow tips

	pi.registerCommand("help", {
		description: "Show pi-shell help and usage guide",
		handler: async (_args, _ctx) => {
			const help = [
				"Pi-Shell — Agent-Forward Orchestrator",
				"",
				"You talk to the orchestrator. It creates tasks, dispatches",
				"specialist agents, and tracks everything automatically.",
				"",
				"Workflow:",
				"  1. Describe what you want (natural language)",
				"  2. Orchestrator creates a task and picks the right agent",
				"  3. Agent does the work, results stream back",
				"  4. Task marked done when complete",
				"",
				"Commands:",
				"  /status       Task overview with costs",
				"  /kill [name]  Cancel a running agent",
				"  /models       Model performance scorecard",
				"  /help         This guide",
				"",
				"Shortcuts:",
				"  F2            Agent dashboard overlay",
				"  F3            Kill agent (picker if multiple)",
				"  F4            Quick-kill most recent agent",
				"",
				"Shell:",
				"  !<cmd>        Run a shell command (e.g. !ls, !git log)",
				"  !!            Repeat last shell command",
				"",
				"Agents:",
				"  scout         Fast read-only codebase recon",
				"  builder       Code implementation (read/write/edit)",
				"  reviewer      Code review and quality checks",
				"  plan-reviewer Plan critic — reviews and challenges plans",
				"  red-team      Security and adversarial testing",
				"  documenter    Documentation generation",
				"",
				"Tips:",
				"  - Ask questions directly — orchestrator uses 'answer' tool",
				"  - For code changes, be specific about files and behavior",
				"  - Use /status to check progress and costs across sessions",
				"  - Tasks persist to .pi/tasks/tasks.json (survives restarts)",
			].join("\n");
			_ctx.ui.notify(help, "info");
		},
	});
}

/** Register the /models command for model performance scorecard */
function registerModelsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("models", {
		description: "Show model performance scorecard",
		handler: async (_args, _ctx) => {
			const cwd = process.cwd();
			const scorecard = formatModelScorecard(cwd);
			_ctx.ui.notify(scorecard, "info");
		},
	});
}

// ── Event Setup Stubs ──────────────────────────────────────────────────

/** Set up session_start: lock down tools, set model, load config, wire up footer and dashboard */
function setupSessionStart(
	pi: ExtensionAPI,
	_config: ShellConfig,
	_taskStore: TaskStore,
	_agentTracker: AgentTracker,
	shellState: { ghAvailable: boolean },
	setupFooter: (ctx: ExtensionContext) => void,
	setupDashboard: (ctx: ExtensionContext) => void,
): void {
	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);

		// Detect gh CLI
		try {
			execSync("which gh", { stdio: "ignore", timeout: 3000 });
			shellState.ghAvailable = true;
		} catch {
			shellState.ghAvailable = false;
			if (_config.git.auto_pr) {
				ctx.ui.notify("gh CLI not found — auto-PR disabled. Install GitHub CLI for PR creation.", "info");
			}
		}

		// Capture actual model from pi runtime
		shellState.activeModel = ctx.model?.id || _config.orchestrator.model || "";

		// Lock to orchestrator-only tools (no codebase access)
		pi.setActiveTools([...ORCHESTRATOR_TOOLS]);

		// TaskStore loads from disk on creation — no explicit load needed

		// Wire up footer and dashboard now that ctx is available
		setupFooter(ctx);
		setupDashboard(ctx);
	});
}

/** Set up before_agent_start: inject system prompt with dynamic agent catalog */
function setupBeforeAgentStart(pi: ExtensionAPI, _config: ShellConfig): void {
	let cachedPrompt: string | null = null;

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (cachedPrompt) return { systemPrompt: cachedPrompt };

		const cwd = process.cwd();
		// Look for agent defs in cwd first, then fall back to pi-orchestrator root
		const cwdAgentsDir = path.join(cwd, ".pi", "agents");
		const fallbackAgentsDir = path.join(PI_SHELL_ROOT, ".pi", "agents");
		const agentsDir = existsSync(path.join(cwdAgentsDir, "orchestrator.md")) ? cwdAgentsDir : fallbackAgentsDir;
		const orchestratorPath = path.join(agentsDir, "orchestrator.md");

		// Parse orchestrator.md — extract body from YAML frontmatter
		let orchestratorBody: string;
		try {
			const raw = readFileSync(orchestratorPath, "utf-8");
			const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
			if (match) {
				orchestratorBody = match[2].trim();
			} else {
				orchestratorBody = raw.trim();
			}
		} catch {
			// Fallback if orchestrator.md is missing
			cachedPrompt =
				"You are Pi-Shell, a strict orchestrator agent. " +
				"You coordinate work by dispatching specialist subagents via the dispatch_agent tool. " +
				"You NEVER touch the codebase directly. " +
				"Always use tilldone to track tasks before dispatching work.";
			return { systemPrompt: cachedPrompt };
		}

		// Build agent catalog from all .pi/agents/*.md except orchestrator.md
		const catalogLines: string[] = [];
		try {
			const files = readdirSync(agentsDir).filter(
				(f) => f.endsWith(".md") && f !== "orchestrator.md"
			);
			files.sort();

			for (const file of files) {
				try {
					const raw = readFileSync(path.join(agentsDir, file), "utf-8");
					const match = raw.match(/^---\n([\s\S]*?)\n---/);
					if (!match) continue;

					const frontmatter = yamlParse(match[1]) as Record<string, string>;
					if (!frontmatter?.name) continue;

					const name = frontmatter.name;
					const description = frontmatter.description || "";
					catalogLines.push(`- **${name}** — ${description}`);
				} catch {
					// Skip files that can't be parsed
				}
			}
		} catch {
			// agentsDir unreadable — catalog stays empty
		}

		const catalog = catalogLines.length > 0
			? catalogLines.join("\n")
			: "(No specialist agents found)";

		cachedPrompt = orchestratorBody.replace("{{AGENT_CATALOG}}", catalog);
		return { systemPrompt: cachedPrompt };
	});
}

/** Set up agent_end: nudge orchestrator if tasks remain incomplete */
function setupAgentEnd(pi: ExtensionAPI, _taskStore: TaskStore): void {
	let nudgedThisCycle = false;

	pi.on("agent_end", async (_event, _ctx) => {
		const incomplete = _taskStore.getAll().filter((t) => t.status !== "done");
		if (incomplete.length === 0 || nudgedThisCycle) return;
		nudgedThisCycle = true;
		const taskList = incomplete
			.map((t) => `  ${TASK_STATUS_ICON[t.status] ?? "?"} #${t.id} [${t.status}]: ${t.text}`)
			.join("\n");
		pi.sendMessage(
			{
				customType: "tilldone-nudge",
				content: `⚠️ You still have ${incomplete.length} incomplete task(s):\n\n${taskList}\n\nEither continue working on them or mark them done. Don't stop until it's done!`,
				display: true,
			},
			{ triggerTurn: true },
		);
	});
}

/** Set up user_bash event: cd tracking, tmux routing for interactive commands */
function setupShellPassthrough(pi: ExtensionAPI, _config: ShellConfig): void {
	pi.on("user_bash", async (_event, _ctx) => {
		const event = _event as any;
		const command = (event.command || event.input || "").trim();

		// 1. cd tracking — detect cd commands and update process.cwd()
		//    Pi handles cd natively; the footer cwd updates via process.cwd().
		//    Nothing extra needed for Phase 1.

		// 2. Interactive command detection — warn if not in tmux
		const baseCmd = command.split(/\s+/)[0];
		if (baseCmd && _config.interactive_commands.includes(baseCmd)) {
			if (!process.env.TMUX) {
				_ctx.ui.notify(
					`"${baseCmd}" is interactive and may garble the TUI. Run pi-shell inside tmux, or use a separate terminal.`,
					"info",
				);
			}
			// In tmux: future phases may route to a new tmux pane.
		}

		// 3. Output truncation is handled by pi's built-in passthrough for Phase 1.

		return { action: "continue" as const };
	});
}

/** Set up session_before_compact: inject task summary into post-compaction context */
function setupCompaction(pi: ExtensionAPI, _taskStore: TaskStore): void {
	pi.on("session_before_compact", async (_event, _ctx) => {
		const tasks = _taskStore.getAll();
		if (tasks.length === 0) return {};

		const lines: string[] = [
			"## Pi-Shell Task State (preserved across compaction)",
			"",
			_taskStore.summary(),
		];

		const active = _taskStore.getActive();
		if (active) {
			lines.push("");
			lines.push(`Active task: #${active.id} — ${active.text}`);
		}

		return { summary: lines.join("\n") };
	});
}

// ── Keyboard Shortcuts ─────────────────────────────────────────────────

/** Register hotkeys for agent control */
function registerShortcuts(
	pi: ExtensionAPI,
	_agentTracker: AgentTracker,
	_taskStore: TaskStore,
): void {
	// F2 — Toggle agent dashboard overlay
	pi.registerShortcut("f2", {
		description: "Toggle agent dashboard",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			const running = _agentTracker.running();
			const all = _agentTracker.getAll();
			if (all.length === 0) {
				ctx.ui.notify("No agents tracked yet", "info");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _kb, done) => {
				return {
					render(width: number): string[] {
						const agents = _agentTracker.getAll();
						const lines: string[] = [];

						const runCount = agents.filter(a => a.status === "running").length;
						const doneCount = agents.filter(a => a.status === "done").length;
						const errCount = agents.filter(a => a.status === "error").length;
						lines.push(
							theme.fg("accent", theme.bold(" AGENTS")) +
							theme.fg("dim", " │ ") +
							theme.fg("accent", `${runCount} running`) +
							(doneCount ? theme.fg("dim", "  ") + theme.fg("success", `${doneCount} done`) : "") +
							(errCount ? theme.fg("dim", "  ") + theme.fg("error", `${errCount} error`) : ""),
						);
						lines.push("");

						// Group by groupId
						const ungrouped: AgentState[] = [];
						const groupMap = new Map<string, { type: string; agents: AgentState[] }>();
						for (const agent of agents) {
							if (agent.groupId) {
								const existing = groupMap.get(agent.groupId);
								if (existing) {
									existing.agents.push(agent);
								} else {
									groupMap.set(agent.groupId, {
										type: agent.groupType === "fan_out" ? "fan_out" : "parallel",
										agents: [agent],
									});
								}
							} else {
								ungrouped.push(agent);
							}
						}

						for (const [, group] of groupMap) {
							const baseName = group.agents[0].name.replace(/-(p?\d+)$/, "");
							const label = group.type === "fan_out"
								? `fan_out: ${group.agents.length}× ${baseName}`
								: `parallel: ${group.agents.length} agents`;
							lines.push(theme.fg("dim", `  ── ${label} ──`));

							for (const agent of group.agents) {
								const icon = AGENT_STATUS_ICON[agent.status as keyof typeof AGENT_STATUS_ICON] || "◻";
								const statusColor = agent.status === "running" ? "accent"
									: agent.status === "done" ? "success" : "error";
								const elapsed = Math.round(agent.elapsed / 1000);
								const costStr = agent.cost > 0 ? ` $${agent.cost.toFixed(3)}` : "";
								const displayName = agent.name.replace(/-(p?)(\d+)$/, (_, p, n) => `[${p}${n}]`);

								const firstSentence = agent.task.split(/\.\s/)[0];
								const maxLen = Math.min(60, Math.max(20, width - 35));
								const taskPreview = firstSentence.length > maxLen
									? firstSentence.slice(0, maxLen - 3) + "..."
									: firstSentence;

								lines.push(
									theme.fg(statusColor, `  ${icon} ${displayName}`) +
									theme.fg("dim", ` ${elapsed}s${costStr}`) +
									theme.fg("muted", `  ${taskPreview}`),
								);
							}
							lines.push("");
						}

						for (const agent of ungrouped) {
							const icon = AGENT_STATUS_ICON[agent.status as keyof typeof AGENT_STATUS_ICON] || "◻";
							const statusColor = agent.status === "running" ? "accent"
								: agent.status === "done" ? "success" : "error";
							const elapsed = Math.round(agent.elapsed / 1000);
							const costStr = agent.cost > 0 ? ` $${agent.cost.toFixed(3)}` : "";

							const firstSentence = agent.task.split(/\.\s/)[0];
							const maxLen = Math.min(60, Math.max(20, width - 35));
							const taskPreview = firstSentence.length > maxLen
								? firstSentence.slice(0, maxLen - 3) + "..."
								: firstSentence;

							lines.push(
								theme.fg(statusColor, `  ${icon} ${agent.name}`) +
								theme.fg("dim", ` ${elapsed}s${costStr}`) +
								theme.fg("muted", `  ${taskPreview}`),
							);
						}

						lines.push("");
						const totalCost = _agentTracker.totalCost();
						if (totalCost > 0) {
							lines.push(theme.fg("dim", `  Total session cost: $${totalCost.toFixed(3)}`));
						}
						lines.push(theme.fg("dim", "  Press ESC to close"));

						return lines;
					},
					handleInput(data: string): void {
						if (matchesKey(data, Key.escape) || matchesKey(data, "f2")) {
							done();
						}
					},
					invalidate() {},
				};
			}, {
				overlay: true,
				overlayOptions: { width: "80%", anchor: "center" },
			});
		},
	});

	// F3 — Kill agent (select from list if multiple)
	pi.registerShortcut("f3", {
		description: "Kill a running agent",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			const running = _agentTracker.running();
			if (running.length === 0) {
				ctx.ui.notify("No agents running", "info");
				return;
			}

			// Single agent — kill immediately
			if (running.length === 1) {
				const agent = running[0];
				if (agent.pid) {
					try { process.kill(agent.pid, "SIGTERM"); } catch {}
				}
				_agentTracker.finish(agent.name, "error");
				ctx.ui.notify(`Killed ${agent.name}`, "info");
				return;
			}

			// Multiple — show picker
			let selectedIndex = 0;
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				return {
					render(width: number): string[] {
						const agents = _agentTracker.running();
						const lines: string[] = [];
						lines.push(theme.fg("accent", theme.bold(" KILL AGENT")) + theme.fg("dim", " — ↑↓ select, Enter kill, ESC cancel"));
						lines.push("");

						agents.forEach((agent, i) => {
							const cursor = i === selectedIndex ? "▸ " : "  ";
							const elapsed = Math.round(agent.elapsed / 1000);
							const costStr = agent.cost > 0 ? ` $${agent.cost.toFixed(3)}` : "";
							const highlight = i === selectedIndex ? "accent" : "muted";

							lines.push(
								theme.fg(highlight, `${cursor}${agent.name}`) +
								theme.fg("dim", ` ${elapsed}s${costStr}`),
							);
						});
						return lines;
					},
					handleInput(data: string): void {
						const agents = _agentTracker.running();
						if (matchesKey(data, Key.up)) {
							selectedIndex = Math.max(0, selectedIndex - 1);
							tui.requestRender();
						} else if (matchesKey(data, Key.down)) {
							selectedIndex = Math.min(agents.length - 1, selectedIndex + 1);
							tui.requestRender();
						} else if (matchesKey(data, Key.enter)) {
							done(agents[selectedIndex]?.name ?? null);
						} else if (matchesKey(data, Key.escape) || matchesKey(data, "f3")) {
							done(null);
						}
					},
					invalidate() {},
				};
			}, {
				overlay: true,
				overlayOptions: { width: "60%", anchor: "center" },
			});

			if (result) {
				const agent = _agentTracker.get(result);
				if (agent?.pid) {
					try { process.kill(agent.pid, "SIGTERM"); } catch {}
				}
				if (agent) _agentTracker.finish(result, "error");
				ctx.ui.notify(`Killed ${result}`, "info");
			}
		},
	});

	// F4 — Quick-kill: abort most recently started agent
	pi.registerShortcut("f4", {
		description: "Quick-kill most recent agent",
		handler: async (ctx) => {
			if (!ctx.hasUI) return;
			const running = _agentTracker.running();
			if (running.length === 0) {
				ctx.ui.notify("No agents running", "info");
				return;
			}

			// Kill the last one (most recently added)
			const agent = running[running.length - 1];
			if (agent.pid) {
				try { process.kill(agent.pid, "SIGTERM"); } catch {}
			}
			_agentTracker.finish(agent.name, "error");
			ctx.ui.notify(`Killed ${agent.name} (F4)`, "info");
		},
	});
}

// ── Extension Entry Point ──────────────────────────────────────────────

// Resolve the project root from the extension file location
// so config is found regardless of cwd
const PI_SHELL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

export default function piShell(pi: ExtensionAPI) {
	// --- Config ---
	// Try project root first (where the extension lives), then cwd
	const config = loadShellConfig(PI_SHELL_ROOT);

	// --- State ---
	const taskStore = createPersistentTaskStore();
	const agentTracker = createAgentTracker();
	const defaultProfile = (typeof config.profiles?.default === "string" ? config.profiles.default : "work");
	const shellState = {
		ghAvailable: false,
		activeProfile: defaultProfile,
		activeModel: "",
		agentModels: resolveProfileModels(config, defaultProfile),
		agentFallbacks: resolveProfileFallbacks(config, defaultProfile),
	};

	// --- Tools ---
	registerTillDone(pi, taskStore);
	registerDispatch(pi, config, taskStore, agentTracker, shellState);
	registerFanOut(pi, config, taskStore, agentTracker, shellState);
	registerParallelDispatch(pi, config, taskStore, agentTracker, shellState);
	registerAnswer(pi, config, taskStore, agentTracker, shellState);
	registerGitStatus(pi);
	registerSwitchKeyCommand(pi, config, shellState);
	registerKillAgent(pi, agentTracker);

	// --- UI ---
	const setupFooter = registerFooter(pi, taskStore, agentTracker, config, shellState);
	const setupDashboard = registerDashboard(pi, agentTracker);
	registerStatusCommand(pi, taskStore);
	registerKillCommand(pi, agentTracker);
	registerHelpCommand(pi);
	registerModelsCommand(pi);
	registerImproveAgentsCommand(pi, config, taskStore, agentTracker, shellState);

	// --- Shortcuts ---
	registerShortcuts(pi, agentTracker, taskStore);

	// --- Events ---
	setupSessionStart(pi, config, taskStore, agentTracker, shellState, setupFooter, setupDashboard);
	setupBeforeAgentStart(pi, config);
	setupAgentEnd(pi, taskStore);
	setupShellPassthrough(pi, config);
	setupCompaction(pi, taskStore);
}
