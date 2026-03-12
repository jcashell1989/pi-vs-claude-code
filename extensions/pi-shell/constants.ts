/**
 * Pi-Shell Constants Module
 *
 * Centralized definitions for status icons and tool names to eliminate magic strings
 * throughout the pi-shell extension codebase.
 */

import type { TaskStatus } from "./task-store.ts";

// Re-export TaskStatus for external use
export type { TaskStatus };

// ── Status Icons ───────────────────────────────────────────────────────

/** Status icons for task lifecycle states */
export const TASK_STATUS_ICON: Record<TaskStatus, string> = {
	idle: "○",
	inprogress: "●",
	done: "✓",
} as const;

/** Status icons for agent lifecycle states */
export const AGENT_STATUS_ICON = {
	idle: "◻",
	running: "●",
	done: "✓",
	error: "✗",
} as const;

/** Status icons for footer/dashboard display (using different symbols for better visibility) */
export const AGENT_FOOTER_ICON = {
	idle: "◻",
	running: "⟳",
	done: "✓",
	error: "✗",
} as const;

// ── Tool Names ─────────────────────────────────────────────────────────

/** Tools that bypass TillDone gate (always allowed even without active task) */
export const TILLDONE_TOOLS = [
	"tilldone",
	"answer",
	"git_status",
	"kill_agent"
] as const;

/** All pi-shell orchestrator tools */
export const ORCHESTRATOR_TOOLS = [
	"tilldone",
	"dispatch_agent",
	"fan_out",
	"answer",
	"git_status",
	"kill_agent"
] as const;