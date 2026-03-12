/**
 * Parallel Dispatch — Run multiple agents (including write agents) in parallel
 *
 * Unlike fan_out (read-only, summary-only), parallel_dispatch supports any agent type
 * and returns full output. Uses git worktrees for branch isolation when dispatches
 * need separate branches.
 */

import { execSync } from "child_process";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { spawnSubagent, type SpawnResult } from "./spawn.ts";
import { logDispatch, generateDispatchId, type OperationType } from "./dispatch-log.ts";

// ── Types ──────────────────────────────────────────────────────────────

export interface ParallelDispatchLeg {
	agent: string;
	task: string;
	branch?: string;
	operationType?: OperationType;
}

export interface ParallelDispatchOptions {
	dispatches: ParallelDispatchLeg[];
	cwd: string;
	agentDefsDir?: string;
	models: Record<string, string>;       // agent -> model
	fallbacks: Record<string, string>;     // agent -> fallback model
	timeouts: Record<string, number>;      // agent -> timeout (seconds)
	maxResultTokens: number;
	sessionDir: string;
	taskId: number;
	signal?: AbortSignal;
	onLegUpdate?: (index: number, agent: string, data: { type: string; content: string }) => void;
	onCostUpdate?: (totalCost: number) => void;
}

export interface ParallelDispatchLegResult {
	agent: string;
	task: string;
	branch?: string;
	operationType: OperationType;
	output: string;
	exitCode: number;
	cost: number;
	elapsed: number;
	conflict: boolean;
	worktreePath?: string;
}

export interface ParallelDispatchResult {
	legs: ParallelDispatchLegResult[];
	totalCost: number;
	totalElapsed: number;
	groupId: string;
}

// ── Git Worktree Helpers ───────────────────────────────────────────────

/** Create a git worktree for isolated parallel work */
function createWorktree(cwd: string, branch: string): string {
	const worktreeBase = join(cwd, ".pi", "worktrees");
	mkdirSync(worktreeBase, { recursive: true });

	const worktreeDir = join(worktreeBase, `${branch.replace(/\//g, "-")}-${Date.now()}`);

	try {
		// Try creating worktree with new branch
		execSync(`git worktree add "${worktreeDir}" -b "${branch}"`, { cwd, stdio: "ignore" });
	} catch {
		try {
			// Branch might already exist — checkout existing
			execSync(`git worktree add "${worktreeDir}" "${branch}"`, { cwd, stdio: "ignore" });
		} catch {
			// Last resort — use a unique branch name
			const uniqueBranch = `${branch}-${Date.now()}`;
			execSync(`git worktree add "${worktreeDir}" -b "${uniqueBranch}"`, { cwd, stdio: "ignore" });
		}
	}

	return worktreeDir;
}

/** Remove a git worktree */
function removeWorktree(cwd: string, worktreeDir: string): void {
	try {
		execSync(`git worktree remove "${worktreeDir}" --force`, { cwd, stdio: "ignore" });
	} catch {
		// Fallback: prune stale worktrees
		try {
			rmSync(worktreeDir, { recursive: true, force: true });
			execSync("git worktree prune", { cwd, stdio: "ignore" });
		} catch { /* best-effort cleanup */ }
	}
}

// ── Core Parallel Dispatch ─────────────────────────────────────────────

/** Execute multiple agent dispatches in parallel */
export async function executeParallelDispatch(options: ParallelDispatchOptions): Promise<ParallelDispatchResult> {
	const {
		dispatches,
		cwd,
		models,
		fallbacks,
		timeouts,
		maxResultTokens,
		sessionDir,
		taskId,
		signal,
		onLegUpdate,
		onCostUpdate,
	} = options;

	const groupId = `pd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	let runningCost = 0;
	// Track per-leg cost so we can compute deltas (spawnSubagent reports running totals)
	const legCosts = new Array(dispatches.length).fill(0);

	// Track worktrees for cleanup
	const worktrees: { index: number; dir: string }[] = [];

	const promises = dispatches.map(async (leg, index) => {
		const operationType: OperationType = leg.operationType ?? "investigate";
		const model = models[leg.agent.toLowerCase()];
		const fallbackModel = fallbacks[leg.agent.toLowerCase()];
		const timeout = timeouts[leg.agent.toLowerCase()] ?? 600;

		// If this leg has a branch, create a worktree for isolation
		let legCwd = cwd;
		let worktreeDir: string | undefined;
		if (leg.branch) {
			try {
				worktreeDir = createWorktree(cwd, leg.branch);
				legCwd = worktreeDir;
				worktrees.push({ index, dir: worktreeDir });
			} catch (err: any) {
				return {
					agent: leg.agent,
					task: leg.task,
					branch: leg.branch,
					operationType,
					output: `Failed to create worktree for branch "${leg.branch}": ${err?.message || err}`,
					exitCode: 1,
					cost: 0,
					elapsed: 0,
					conflict: false,
				} as ParallelDispatchLegResult;
			}
		}

		const result = await spawnSubagent({
			agent: leg.agent,
			task: leg.task,
			model,
			fallbackModel,
			// Don't pass branch to spawn — we handle isolation via worktree
			cwd: legCwd,
			agentDefsDir: options.agentDefsDir,
			timeout,
			maxResultTokens,
			sessionDir,
			taskId,
			signal,
			onUpdate: (data) => {
				if (onLegUpdate) onLegUpdate(index, leg.agent, data);
			},
			onCostUpdate: (legTotal) => {
				const delta = legTotal - legCosts[index];
				legCosts[index] = legTotal;
				runningCost += delta;
				if (onCostUpdate) onCostUpdate(runningCost);
			},
		});

		// Log each leg to dispatch log
		const dispatchId = generateDispatchId();
		logDispatch(cwd, {
			id: dispatchId,
			timestamp: new Date().toISOString(),
			agent: leg.agent,
			operation: operationType,
			taskPrompt: leg.task,
			taskSummary: `[parallel: ${leg.agent}] ${leg.task.slice(0, 80)}`,
			outcome: result.exitCode === 0 ? "success" : "failure",
			exitCode: result.exitCode,
			cost: result.cost,
			elapsed: result.elapsed,
			branch: leg.branch || null,
			model: model || null,
			parentTaskId: taskId,
			followUpNeeded: false,
			fanOutGroupId: groupId,
			failureReason: result.failureReason || null,
			fellBack: result.fellBack || false,
		});

		return {
			agent: leg.agent,
			task: leg.task,
			branch: leg.branch,
			operationType,
			output: result.output,
			exitCode: result.exitCode,
			cost: result.cost,
			elapsed: result.elapsed,
			conflict: result.conflict,
			worktreePath: worktreeDir,
		} as ParallelDispatchLegResult;
	});

	const settled = await Promise.allSettled(promises);

	const results: ParallelDispatchLegResult[] = settled.map((s, i) => {
		if (s.status === "fulfilled") return s.value;
		return {
			agent: dispatches[i].agent,
			task: dispatches[i].task,
			branch: dispatches[i].branch,
			operationType: dispatches[i].operationType ?? "investigate",
			output: `Error: ${s.reason?.message || s.reason}`,
			exitCode: 1,
			cost: 0,
			elapsed: 0,
			conflict: false,
		} as ParallelDispatchLegResult;
	});

	// Clean up worktrees (only for failed legs — successful ones may have commits to preserve)
	for (const wt of worktrees) {
		const legResult = results[wt.index];
		// Always remove worktree dir — the branch and its commits persist in git
		removeWorktree(cwd, wt.dir);
	}

	const totalCost = results.reduce((s, r) => s + r.cost, 0);
	const totalElapsed = Math.max(...results.map(r => r.elapsed), 0);

	return { legs: results, totalCost, totalElapsed, groupId };
}

/** Format parallel dispatch results for the orchestrator */
export function formatParallelResults(result: ParallelDispatchResult): string {
	const lines: string[] = [];

	for (const leg of result.legs) {
		const status = leg.exitCode === 0 ? "done" : "error";
		const elapsed = Math.round(leg.elapsed / 1000);
		const costStr = `$${(Number(leg.cost) || 0).toFixed(3)}`;
		const branchStr = leg.branch ? ` [${leg.branch}]` : "";
		const conflictStr = leg.conflict ? " ⚠️ CONFLICT" : "";
		lines.push(`--- ${leg.agent}${branchStr} (${status}, ${elapsed}s, ${costStr})${conflictStr} ---`);
		lines.push(leg.output);
		lines.push("");
	}

	const totalCostStr = `$${(Number(result.totalCost) || 0).toFixed(3)}`;
	const totalElapsedStr = `${Math.round(result.totalElapsed / 1000)}s`;
	lines.push(`Parallel dispatch complete: ${result.legs.length} agents, ${totalElapsedStr} wall time, ${totalCostStr} total`);

	return lines.join("\n");
}
