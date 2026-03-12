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
import { Text } from "@mariozechner/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import * as path from "path";
import { applyExtensionDefaults } from "./themeMap.ts";
import { loadConfig as loadShellConfig, type ShellConfig } from "./pi-shell/config.ts";
import { createTaskStore as createPersistentTaskStore, type TaskStore, type Task, type TaskStatus } from "./pi-shell/task-store.ts";
import { spawnSubagent } from "./pi-shell/spawn.ts";
import { readFileSync, readdirSync } from "fs";
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
}

interface AgentTracker {
	/** Get all tracked agents */
	getAll(): AgentState[];
	/** Get agent by name */
	get(name: string): AgentState | undefined;
	/** Start tracking an agent run */
	start(name: string, task: string, taskId: number, pid: number): AgentState;
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
	// Stub: will track spawned subagent processes and their states
	const agents = new Map<string, AgentState>();

	return {
		getAll: () => Array.from(agents.values()),
		get: (name) => agents.get(name.toLowerCase()),
		start: (name, task, taskId, pid) => {
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
			};
			agents.set(name.toLowerCase(), state);
			return state;
		},
		update: (name, fields) => {
			const state = agents.get(name.toLowerCase());
			if (state) Object.assign(state, fields);
		},
		finish: (name, status) => {
			const state = agents.get(name.toLowerCase());
			if (state) {
				state.status = status;
				if (state.timer) clearInterval(state.timer);
			}
		},
		remove: (name) => { agents.delete(name.toLowerCase()); },
		running: () => Array.from(agents.values()).filter((a) => a.status === "running"),
		totalCost: () => Array.from(agents.values()).reduce((sum, a) => sum + a.cost, 0),
	};
}

// ── Tool Registration Stubs ────────────────────────────────────────────

/** Register the tilldone tool with persistent TaskStore and blocking gate */
function registerTillDone(pi: ExtensionAPI, taskStore: TaskStore): void {
	const STATUS_ICON: Record<TaskStatus, string> = { idle: "○", inprogress: "●", done: "✓" };
	const GATE_WHITELIST = ["tilldone", "answer", "git_status", "switch_key", "kill_agent"];

	pi.registerTool({
		name: "tilldone",
		label: "TillDone",
		description:
			"Manage your task list. You MUST add tasks before using any other tools. " +
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
						`[${STATUS_ICON[t.status]}] #${t.id} (${t.status}): ${t.text}`
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

	// Blocking gate: prevent non-whitelisted tools when no task is active
	pi.on("tool_call", async (event, _ctx) => {
		if (GATE_WHITELIST.includes(event.toolName)) return { block: false };

		const tasks = taskStore.getAll();
		const active = taskStore.getActive();

		if (tasks.length === 0) {
			return { block: true, reason: "No tasks defined. Use `tilldone add` first." };
		}
		if (!active) {
			return { block: true, reason: "No task in progress. Use `tilldone toggle <id>` to activate a task." };
		}
		return { block: false };
	});
}

/** Register the dispatch_agent tool for spawning subagents */
function registerDispatch(
	pi: ExtensionAPI,
	_config: ShellConfig,
	_taskStore: TaskStore,
	_agentTracker: AgentTracker,
): void {
	const cwd = process.cwd();
	const sessionDir = path.join(cwd, ".pi", "tasks", "sessions");

	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description: "Dispatch a task to a specialist subagent. Specify agent name, task description, and target branch.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (e.g. scout, builder, reviewer)" }),
			task: Type.String({ description: "Clear, specific task description for the agent" }),
			branch: Type.Optional(Type.String({ description: "Target git branch for code changes" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			const { agent, task, branch } = params as { agent: string; task: string; branch?: string };

			// Resolve the active task to attach cost to
			const activeTask = _taskStore.getActive();
			const taskId = activeTask?.id ?? 0;

			// Resolve model from config
			const model = _config.agent_models[agent.toLowerCase()];

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

			// Send initial streaming update
			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Dispatching ${agent}...` }],
					details: { agent, task, status: "dispatching" },
				});
			}

			try {
				const result = await spawnSubagent({
					agent,
					task,
					model,
					branch: targetBranch,
					cwd,
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

				const status = result.exitCode === 0 ? "done" : "error";
				_agentTracker.update(agent, { elapsed: result.elapsed, cost: result.cost });
				_agentTracker.finish(agent, status);

				const summary = `[${agent}] ${status} in ${Math.round(result.elapsed / 1000)}s` +
					(result.cost > 0 ? ` ($${result.cost.toFixed(3)})` : "");

				return {
					content: [{ type: "text" as const, text: `${summary}\n\n${result.output}` }],
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

			const model = _config.agent_models.answer || _config.agent_models.scout;
			const timeout = _config.agent_timeouts.answer ?? 120;
			const maxResultTokens = _config.orchestrator.max_dispatch_result_tokens;

			try {
				// 2. Spawn read-only scout subagent
				const result = await spawnSubagent({
					agent: "scout",
					task: `Answer the following question about the codebase: ${question}`,
					model,
					cwd,
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
			// Stub: will run git commands and aggregate repo metadata
			return {
				content: [{ type: "text" as const, text: "git_status stub — not yet implemented" }],
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

/** Register the switch_key tool for OpenRouter API key profile switching */
function registerSwitchKey(pi: ExtensionAPI, _config: ShellConfig): void {
	// Will implement: swap OPENROUTER_API_KEY in process.env from named profiles
	// in shell-config.yaml. Propagates to future subagent spawns.
	// Bypasses TillDone gate (whitelisted)

	pi.registerTool({
		name: "switch_key",
		label: "Switch API Key",
		description: "Switch the active OpenRouter API key profile.",
		parameters: Type.Object({
			profile: Type.String({ description: "API key profile name from shell-config.yaml" }),
		}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			// Stub: will swap env var and update active profile display
			return {
				content: [{ type: "text" as const, text: "switch_key stub — not yet implemented" }],
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("switch_key ")) +
				theme.fg("accent", (args as any).profile || "?"),
				0, 0,
			);
		},
		renderResult(result, _options, _theme) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
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
			// Stub: will kill process, clean up tracker state
			return {
				content: [{ type: "text" as const, text: "kill_agent stub — not yet implemented" }],
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

// ── UI Registration Stubs ──────────────────────────────────────────────

/** Register the unified footer showing cwd, branch, tasks, agents, cost, key profile */
function registerFooter(
	pi: ExtensionAPI,
	_taskStore: TaskStore,
	_agentTracker: AgentTracker,
	_config: ShellConfig,
): void {
	// Will implement: composed footer renderer with all status components
	// Components: cwd, git branch, task progress, active agents, session cost, api key profile
	// Stub: registers a minimal placeholder footer on session_start via the pi event system
	// (actual footer set in setupSessionStart for proper ctx access)
}

/** Register the subagent dashboard widget showing agent cards */
function registerDashboard(pi: ExtensionAPI, _agentTracker: AgentTracker): void {
	// Will implement: card grid with DynamicBorder, real-time updates via timer
	// Cards show: agent name, elapsed time, current work summary, context usage bar
	// Cards appear/disappear as agents start/finish
}

/** Register the /status command for cross-session task overview */
function registerStatusCommand(pi: ExtensionAPI, _taskStore: TaskStore): void {
	// Will implement: interactive overlay showing full task history with details

	pi.registerCommand("status", {
		description: "Show pi-shell task overview",
		handler: async (_args, _ctx) => {
			// Stub: will render task list overlay
			_ctx.ui.notify("status command — not yet implemented", "info");
		},
	});
}

/** Register the /kill command for interactive agent cancellation */
function registerKillCommand(pi: ExtensionAPI, _agentTracker: AgentTracker): void {
	// Will implement: select dialog listing running agents, kill selected one

	pi.registerCommand("kill", {
		description: "Kill a running subagent",
		handler: async (_args, _ctx) => {
			// Stub: will show select dialog of running agents
			_ctx.ui.notify("kill command — not yet implemented", "info");
		},
	});
}

/** Register the /help command for pi-shell onboarding */
function registerHelpCommand(pi: ExtensionAPI): void {
	// Will implement: display usage guide, available commands, workflow tips

	pi.registerCommand("help", {
		description: "Show pi-shell help and usage guide",
		handler: async (_args, _ctx) => {
			// Stub: will render help overlay
			_ctx.ui.notify("help command — not yet implemented", "info");
		},
	});
}

// ── Event Setup Stubs ──────────────────────────────────────────────────

/** Set up session_start: lock down tools, set model, load config */
function setupSessionStart(
	pi: ExtensionAPI,
	_config: ShellConfig,
	_taskStore: TaskStore,
	_agentTracker: AgentTracker,
): void {
	// Will implement: setActiveTools (tilldone, dispatch_agent, answer, git_status,
	// switch_key, kill_agent — NO codebase tools), set orchestrator model,
	// load TaskStore from disk, initialize footer and dashboard

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);

		// Lock to orchestrator-only tools (no codebase access)
		pi.setActiveTools(["tilldone", "dispatch_agent", "answer", "git_status", "switch_key", "kill_agent"]);

		// TaskStore loads from disk on creation — no explicit load needed

		// Stub: will set up footer and dashboard rendering
	});
}

/** Set up before_agent_start: inject system prompt with dynamic agent catalog */
function setupBeforeAgentStart(pi: ExtensionAPI, _config: ShellConfig): void {
	let cachedPrompt: string | null = null;

	pi.on("before_agent_start", async (_event, _ctx) => {
		if (cachedPrompt) return { systemPrompt: cachedPrompt };

		const cwd = process.cwd();
		const agentsDir = path.join(cwd, ".pi", "agents");
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
	// Will implement: check for incomplete tasks on agent_end, send nudge
	// message to trigger new turn if work remains

	pi.on("agent_end", async (_event, _ctx) => {
		// Stub: will check _taskStore for incomplete tasks and nudge
	});
}

/** Set up user_bash event: cd tracking, tmux routing for interactive commands */
function setupShellPassthrough(pi: ExtensionAPI, _config: ShellConfig): void {
	// Will implement: intercept cd commands to update cwd state,
	// detect interactive commands and route to tmux,
	// truncate long command output

	pi.on("user_bash", async (_event, _ctx) => {
		// Stub: will handle cd tracking, tmux routing, output truncation
		return { action: "continue" as const };
	});
}

/** Set up session_before_compact: inject task summary into post-compaction context */
function setupCompaction(pi: ExtensionAPI, _taskStore: TaskStore): void {
	// Will implement: on compaction, inject summary message with current
	// task list and active dispatches so orchestrator retains awareness

	pi.on("session_before_compact", async (_event, _ctx) => {
		// Stub: will inject task state summary for post-compaction context
		return {};
	});
}

// ── Extension Entry Point ──────────────────────────────────────────────

export default function piShell(pi: ExtensionAPI) {
	// --- Config ---
	const config = loadShellConfig();

	// --- State ---
	const taskStore = createPersistentTaskStore();
	const agentTracker = createAgentTracker();

	// --- Tools ---
	registerTillDone(pi, taskStore);
	registerDispatch(pi, config, taskStore, agentTracker);
	registerAnswer(pi, config, taskStore, agentTracker);
	registerGitStatus(pi);
	registerSwitchKey(pi, config);
	registerKillAgent(pi, agentTracker);

	// --- UI ---
	registerFooter(pi, taskStore, agentTracker, config);
	registerDashboard(pi, agentTracker);
	registerStatusCommand(pi, taskStore);
	registerKillCommand(pi, agentTracker);
	registerHelpCommand(pi);

	// --- Events ---
	setupSessionStart(pi, config, taskStore, agentTracker);
	setupBeforeAgentStart(pi, config);
	setupAgentEnd(pi, taskStore);
	setupShellPassthrough(pi, config);
	setupCompaction(pi, taskStore);
}
