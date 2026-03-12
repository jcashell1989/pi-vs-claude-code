/**
 * Fan-Out — Parallel read-only dispatch for pi-shell
 *
 * Dispatches multiple read-only agents in parallel with structured summary
 * enforcement, cost ceiling checks, and dispatch log integration.
 */

import { spawnSubagent, type SpawnResult } from "./spawn.ts";
import { logDispatch, generateDispatchId, type OperationType } from "./dispatch-log.ts";

// ── Constants ──────────────────────────────────────────────────────────

/** Agents allowed in fan_out (read-only only) */
export const FAN_OUT_WHITELIST = ["scout", "reviewer", "red-team", "plan-reviewer"] as const;

/** Summary instruction appended to every fan-out dispatch prompt */
const SUMMARY_INSTRUCTION = "\n\nConclude your response with a SUMMARY section (max 500 tokens) that captures your key findings in a structured format.";

// ── Types ──────────────────────────────────────────────────────────────

export interface FanOutDispatch {
  task: string;
  scope: string;
}

export interface FanOutOptions {
  agent: string;
  dispatches: FanOutDispatch[];
  cwd: string;
  agentDefsDir?: string;
  model?: string;
  fallbackModel?: string;
  timeout: number;
  maxResultTokens: number;
  sessionDir: string;
  taskId: number;
  parentTaskId: number;
  costCeiling: number;
  signal?: AbortSignal;
  onUpdate?: (scope: string, data: { type: string; content: string }) => void;
  onCostUpdate?: (totalCost: number) => void;
}

export interface FanOutLegResult {
  scope: string;
  output: string;
  exitCode: number;
  cost: number;
  elapsed: number;
  summary: string;
}

export interface FanOutResult {
  legs: FanOutLegResult[];
  totalCost: number;
  totalElapsed: number;
  fanOutGroupId: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Extract SUMMARY section from agent output */
function extractSummary(output: string): string {
  const summaryMatch = output.match(/(?:^|\n)#+?\s*SUMMARY[:\s]*\n([\s\S]*?)$/i)
    || output.match(/(?:^|\n)SUMMARY[:\s]*\n([\s\S]*?)$/i);

  if (summaryMatch) {
    return summaryMatch[1].trim().slice(0, 2000);
  }
  // Fallback: last 500 chars
  return output.slice(-500).trim();
}

/** Estimate cost for a fan-out operation */
export function estimateFanOutCost(numDispatches: number, avgCostPerDispatch: number = 0.03): number {
  return numDispatches * avgCostPerDispatch;
}

// ── Core Fan-Out ───────────────────────────────────────────────────────

/** Execute parallel fan-out dispatches */
export async function executeFanOut(options: FanOutOptions): Promise<FanOutResult> {
  const {
    agent,
    dispatches,
    cwd,
    model,
    timeout,
    maxResultTokens,
    sessionDir,
    taskId,
    parentTaskId,
    costCeiling,
    signal,
    onUpdate,
    onCostUpdate,
  } = options;

  const fanOutGroupId = `fo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let runningCost = 0;

  // Per-agent timeout (individual, not cumulative)
  const perAgentTimeout = timeout;

  // Launch all dispatches in parallel
  // Track per-leg cost so we can compute deltas (spawnSubagent reports running totals)
  const legCosts = new Array(dispatches.length).fill(0);

  const promises = dispatches.map(async (dispatch, index) => {
    const compositeKey = `${agent}-${index}`;
    const augmentedTask = dispatch.task + SUMMARY_INSTRUCTION;

    const result = await spawnSubagent({
      agent,
      task: augmentedTask,
      model,
      fallbackModel: options.fallbackModel,
      cwd,
      agentDefsDir: options.agentDefsDir,
      timeout: perAgentTimeout,
      maxResultTokens,
      sessionDir,
      taskId,
      signal,
      onUpdate: (data) => {
        if (onUpdate) onUpdate(dispatch.scope, data);
      },
      onCostUpdate: (legTotal) => {
        // legTotal is the running total for this single agent
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
      agent,
      operation: "investigate" as OperationType,
      taskPrompt: dispatch.task,
      taskSummary: `[fan-out: ${dispatch.scope}] ${dispatch.task.slice(0, 80)}`,
      outcome: result.exitCode === 0 ? "success" : "failure",
      exitCode: result.exitCode,
      cost: result.cost,
      elapsed: result.elapsed,
      branch: null,
      model: model || null,
      parentTaskId,
      followUpNeeded: false,
      fanOutGroupId,
    });

    const summary = extractSummary(result.output);

    return {
      scope: dispatch.scope,
      output: result.output,
      exitCode: result.exitCode,
      cost: result.cost,
      elapsed: result.elapsed,
      summary,
    } as FanOutLegResult;
  });

  const legs = await Promise.allSettled(promises);

  const results: FanOutLegResult[] = legs.map((leg, i) => {
    if (leg.status === "fulfilled") return leg.value;
    return {
      scope: dispatches[i].scope,
      output: `Error: ${leg.reason?.message || leg.reason}`,
      exitCode: 1,
      cost: 0,
      elapsed: 0,
      summary: `Error in ${dispatches[i].scope}: ${leg.reason?.message || "unknown error"}`,
    };
  });

  const totalCost = results.reduce((s, r) => s + r.cost, 0);
  const totalElapsed = Math.max(...results.map(r => r.elapsed), 0);

  return {
    legs: results,
    totalCost,
    totalElapsed,
    fanOutGroupId,
  };
}

/** Format fan-out results for the orchestrator */
export function formatFanOutResults(result: FanOutResult, agent: string): string {
  const lines: string[] = [];

  for (const leg of result.legs) {
    const status = leg.exitCode === 0 ? "done" : "error";
    const elapsed = Math.round(leg.elapsed / 1000);
    const costStr = `$${(Number(leg.cost) || 0).toFixed(3)}`;
    lines.push(`--- ${agent} [${leg.scope}] (${status}, ${elapsed}s, ${costStr}) ---`);
    lines.push(leg.summary);
    lines.push("");
  }

  const totalCostStr = `$${(Number(result.totalCost) || 0).toFixed(3)}`;
  const totalElapsedStr = `${Math.round(result.totalElapsed / 1000)}s`;
  lines.push(`Fan-out complete: ${result.legs.length} dispatches, ${totalElapsedStr}, ${totalCostStr} total`);

  return lines.join("\n");
}
