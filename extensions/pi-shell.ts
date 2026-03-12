/**
 * Pi-Shell — Agent-forward personal command prompt
 *
 * Transforms pi into a strict orchestrator that never touches the codebase
 * directly. All real work is dispatched to specialist subagents. Shell
 * commands pass through via pi's built-in `!`/`!!`. Every interaction is
 * tracked via TillDone with no exceptions.
 *
 * Usage: pi -e extensions/pi-shell.ts
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import { applyExtensionDefaults } from "./themeMap.ts";
import { loadConfig as loadShellConfig, type ShellConfig } from "./pi-shell/config.ts";
import { createTaskStore as createPersistentTaskStore, type TaskStore, type Task, type TaskStatus } from "./pi-shell/task-store.ts";

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
function registerTillDone(pi: ExtensionAPI, _taskStore: TaskStore): void {
	// Will implement: tilldone tool (new-list, add, toggle, remove, update, list, clear)
	// with blocking gate that whitelists utility tools (answer, git_status, switch_key, kill_agent)
	// Adapted from tilldone.ts but using persistent TaskStore instead of session reconstruction

	const GATE_WHITELIST = ["tilldone", "answer", "git_status", "switch_key", "kill_agent"];

	pi.registerTool({
		name: "tilldone",
		label: "TillDone",
		description:
			"Manage your task list. You MUST add tasks before using any other tools. " +
			"Actions: new-list (text=title), add (text), toggle (id), remove (id), update (id + text), list, clear.",
		parameters: Type.Object({
			action: StringEnum(["new-list", "add", "toggle", "remove", "update", "list", "clear"] as const),
			text: Type.Optional(Type.String({ description: "Task text (for add/update) or list title (for new-list)" })),
			id: Type.Optional(Type.Number({ description: "Task ID (for toggle/remove/update)" })),
		}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			// Stub: will implement all tilldone actions using _taskStore
			return {
				content: [{ type: "text" as const, text: "tilldone stub — not yet implemented" }],
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("tilldone ")) + theme.fg("muted", (args as any).action || ""),
				0, 0,
			);
		},
		renderResult(result, _options, _theme) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	// Blocking gate: prevent non-whitelisted tools when no task is active
	pi.on("tool_call", async (event, _ctx) => {
		if (GATE_WHITELIST.includes(event.toolName)) return { block: false };

		const tasks = _taskStore.getAll();
		const active = _taskStore.getActive();

		if (tasks.length === 0) {
			return { block: true, reason: "No tasks defined. Use `tilldone add` first." };
		}
		if (!active) {
			return { block: true, reason: "No task in progress. Use `tilldone toggle` to activate a task." };
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
	// Will implement: spawn pi subprocess with --mode json, parse JSONL events,
	// track agent status, extract costs from message_end events, truncate results
	// Agent definitions loaded from .pi/agents/*.md
	// Session persisted to .pi/tasks/sessions/<agent>-<task-id>.jsonl

	pi.registerTool({
		name: "dispatch_agent",
		label: "Dispatch Agent",
		description: "Dispatch a task to a specialist subagent. Specify agent name, task description, and target branch.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent name (e.g. scout, builder, reviewer)" }),
			task: Type.String({ description: "Clear, specific task description for the agent" }),
			branch: Type.Optional(Type.String({ description: "Target git branch for code changes" })),
		}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			// Stub: will spawn subagent process, stream JSONL, track via agentTracker
			return {
				content: [{ type: "text" as const, text: "dispatch_agent stub — not yet implemented" }],
			};
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
		renderResult(result, _options, _theme) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
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
	// Will implement: self-contained lifecycle that creates task, spawns read-only
	// subagent (scout profile), streams result, marks task done — all in one tool call
	// Bypasses TillDone gate (whitelisted)

	pi.registerTool({
		name: "answer",
		label: "Quick Answer",
		description: "Answer a quick question using a read-only subagent. Self-contained — handles its own task lifecycle.",
		parameters: Type.Object({
			question: Type.String({ description: "The question to answer" }),
		}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			// Stub: will create task, spawn scout subagent, stream answer, mark done
			return {
				content: [{ type: "text" as const, text: "answer stub — not yet implemented" }],
			};
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
	// Will implement: dynamically assemble orchestrator system prompt with
	// current agent catalog injected from .pi/agents/*.md definitions

	pi.on("before_agent_start", async (_event, _ctx) => {
		// Stub: will return { systemPrompt: "..." } with agent catalog
		return {};
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
