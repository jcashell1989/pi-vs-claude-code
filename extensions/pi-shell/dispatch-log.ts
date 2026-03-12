import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// ── Types ──────────────────────────────────────────────────────────────

export const OPERATION_TYPES = [
  "refactor", "fix", "add", "investigate", "review", "audit", "document", "test"
] as const;
export type OperationType = typeof OPERATION_TYPES[number];

export const FAILURE_REASONS = [
  "timeout", "guardrail", "repetition", "not_found", "checkout_failed", "conflict", "error"
] as const;
export type FailureReason = typeof FAILURE_REASONS[number];

export interface DispatchLogEntry {
  id: string;
  timestamp: string;
  agent: string;
  operation: OperationType;
  taskPrompt: string;
  taskSummary: string;
  outcome: "success" | "failure";
  exitCode: number;
  cost: number;
  elapsed: number;
  branch: string | null;
  model: string | null;
  parentTaskId: number;
  followUpNeeded: boolean;
  fanOutGroupId: string | null;
  failureReason?: FailureReason | null;
  fellBack?: boolean;  // true if fallback model was used after primary failed
}

// ── Dispatch Log ───────────────────────────────────────────────────────

const MAX_ENTRIES = 1000;

function getLogPath(cwd: string): string {
  return join(cwd, ".pi", "dispatch-log.jsonl");
}

/** Read all entries from the dispatch log */
export function readLog(cwd: string): DispatchLogEntry[] {
  const logPath = getLogPath(cwd);
  if (!existsSync(logPath)) return [];
  try {
    const raw = readFileSync(logPath, "utf-8");
    return raw.trim().split("\n").filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean) as DispatchLogEntry[];
  } catch {
    return [];
  }
}

/** Append a dispatch entry to the log. Auto-rotates if over MAX_ENTRIES. */
export function logDispatch(cwd: string, entry: DispatchLogEntry): void {
  const logPath = getLogPath(cwd);
  const dir = dirname(logPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  appendFileSync(logPath, JSON.stringify(entry) + "\n");

  // Rotate: keep only last MAX_ENTRIES
  const entries = readLog(cwd);
  if (entries.length > MAX_ENTRIES) {
    const trimmed = entries.slice(-MAX_ENTRIES);
    writeFileSync(logPath, trimmed.map(e => JSON.stringify(e)).join("\n") + "\n");
  }
}

/** Mark previous dispatches to the same parentTaskId as followUpNeeded = true */
export function markFollowUps(cwd: string, parentTaskId: number, currentId: string): void {
  const logPath = getLogPath(cwd);
  const entries = readLog(cwd);
  let changed = false;

  for (const entry of entries) {
    if (entry.parentTaskId === parentTaskId && entry.id !== currentId && !entry.followUpNeeded) {
      entry.followUpNeeded = true;
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(logPath, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  }
}

/** Generate a unique dispatch ID */
export function generateDispatchId(): string {
  return `d-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Context Injection (Layer 2) ────────────────────────────────────────

/** Find similar past dispatches by agent + operationType match */
export function findSimilarDispatches(
  cwd: string,
  agent: string,
  operation: OperationType,
  limit: number = 3,
): DispatchLogEntry[] {
  const entries = readLog(cwd);

  // Match on agent + operation type (structured field matching)
  const matches = entries
    .filter(e => e.agent === agent && e.operation === operation)
    .slice(-limit); // most recent matches

  return matches;
}

/** Format similar dispatches as injection context for the orchestrator */
export function formatInjectionContext(matches: DispatchLogEntry[]): string | null {
  if (matches.length === 0) return null;

  const agent = matches[0].agent;
  const operation = matches[0].operation;

  const lines: string[] = [
    `The following are records of past similar work (${agent} + ${operation}).`,
    `Use them to inform your dispatch prompt. They are NOT part of the current task.`,
    "",
  ];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const outcomeStr = m.followUpNeeded
      ? `${m.outcome} → follow-up needed`
      : m.outcome;
    const costStr = `$${(Number(m.cost) || 0).toFixed(3)}`;
    const elapsedStr = `${Math.round(m.elapsed / 1000)}s`;

    lines.push(
      `${i + 1}. [${outcomeStr}, ${costStr}, ${elapsedStr}] ${m.taskSummary}`
    );
  }

  return lines.join("\n");
}

// ── Stats for /improve-agents (Layer 3) ────────────────────────────────

export interface AgentStats {
  agent: string;
  total: number;
  successes: number;
  failures: number;
  followUpRate: number;
  avgCost: number;
  avgElapsed: number;
  operationBreakdown: Record<string, { total: number; failures: number }>;
}

/** Compute per-agent statistics from the dispatch log */
export function getAgentStats(cwd: string): AgentStats[] {
  const entries = readLog(cwd);
  if (entries.length === 0) return [];

  const byAgent = new Map<string, DispatchLogEntry[]>();
  for (const e of entries) {
    const list = byAgent.get(e.agent) || [];
    list.push(e);
    byAgent.set(e.agent, list);
  }

  const stats: AgentStats[] = [];
  for (const [agent, agentEntries] of byAgent) {
    const total = agentEntries.length;
    const successes = agentEntries.filter(e => e.outcome === "success").length;
    const failures = total - successes;
    const followUps = agentEntries.filter(e => e.followUpNeeded).length;
    const totalCost = agentEntries.reduce((s, e) => s + e.cost, 0);
    const totalElapsed = agentEntries.reduce((s, e) => s + e.elapsed, 0);

    // Operation breakdown
    const opBreakdown: Record<string, { total: number; failures: number }> = {};
    for (const e of agentEntries) {
      if (!opBreakdown[e.operation]) opBreakdown[e.operation] = { total: 0, failures: 0 };
      opBreakdown[e.operation].total++;
      if (e.outcome === "failure") opBreakdown[e.operation].failures++;
    }

    stats.push({
      agent,
      total,
      successes,
      failures,
      followUpRate: total > 0 ? followUps / total : 0,
      avgCost: total > 0 ? totalCost / total : 0,
      avgElapsed: total > 0 ? totalElapsed / total : 0,
      operationBreakdown: opBreakdown,
    });
  }

  return stats.sort((a, b) => b.total - a.total);
}

// ── Model Scorecard ─────────────────────────────────────────────────────

export interface ModelScore {
  model: string;
  total: number;
  successes: number;
  failures: number;
  successRate: number;
  avgCost: number;
  avgElapsed: number;
  failureBreakdown: Partial<Record<FailureReason, number>>;
  agents: string[];  // which agent roles used this model
  fellBackCount: number;  // times this model caused a fallback
}

/** Compute per-model statistics from the dispatch log */
export function getModelStats(cwd: string): ModelScore[] {
  const entries = readLog(cwd);
  if (entries.length === 0) return [];

  const byModel = new Map<string, DispatchLogEntry[]>();
  for (const e of entries) {
    const model = e.model || "unknown";
    const list = byModel.get(model) || [];
    list.push(e);
    byModel.set(model, list);
  }

  const scores: ModelScore[] = [];
  for (const [model, modelEntries] of byModel) {
    const total = modelEntries.length;
    const successes = modelEntries.filter(e => e.outcome === "success").length;
    const failures = total - successes;
    const totalCost = modelEntries.reduce((s, e) => s + e.cost, 0);
    const totalElapsed = modelEntries.reduce((s, e) => s + e.elapsed, 0);
    const agents = [...new Set(modelEntries.map(e => e.agent))];
    const fellBackCount = modelEntries.filter(e => e.fellBack).length;

    const failureBreakdown: Partial<Record<FailureReason, number>> = {};
    for (const e of modelEntries) {
      if (e.failureReason) {
        failureBreakdown[e.failureReason] = (failureBreakdown[e.failureReason] || 0) + 1;
      }
    }

    scores.push({
      model,
      total,
      successes,
      failures,
      successRate: total > 0 ? successes / total : 0,
      avgCost: total > 0 ? totalCost / total : 0,
      avgElapsed: total > 0 ? totalElapsed / total : 0,
      failureBreakdown,
      agents,
      fellBackCount,
    });
  }

  return scores.sort((a, b) => b.total - a.total);
}

/** Format model scorecard for /models command */
export function formatModelScorecard(cwd: string): string {
  const scores = getModelStats(cwd);
  if (scores.length === 0) return "No dispatch data yet. Run some agents to build model scores.";

  const lines: string[] = ["Model Scorecard", ""];

  for (const s of scores) {
    const shortModel = s.model.split("/").pop() || s.model;
    const rateStr = `${(s.successRate * 100).toFixed(0)}%`;
    const rateIcon = s.successRate >= 0.9 ? "●" : s.successRate >= 0.7 ? "◐" : "○";
    lines.push(`${rateIcon} ${shortModel}  ${rateStr} success  (${s.total} dispatches)`);
    lines.push(`  agents: ${s.agents.join(", ")}  avg: $${s.avgCost.toFixed(3)} / ${Math.round(s.avgElapsed / 1000)}s`);

    if (Object.keys(s.failureBreakdown).length > 0) {
      const reasons = Object.entries(s.failureBreakdown)
        .map(([r, n]) => `${r}:${n}`)
        .join("  ");
      lines.push(`  failures: ${reasons}`);
    }
    if (s.fellBackCount > 0) {
      lines.push(`  fell back ${s.fellBackCount}× (primary model failed, used fallback)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Format a full analysis report for /improve-agents */
export function formatAnalysisReport(cwd: string): string {
  const stats = getAgentStats(cwd);
  const entries = readLog(cwd);

  if (entries.length === 0) return "No dispatch log entries found. Use pi-shell to accumulate data first.";

  const lines: string[] = [
    `Dispatch Log Analysis (${entries.length} entries)`,
    "",
  ];

  for (const s of stats) {
    lines.push(`## ${s.agent}`);
    lines.push(`  Dispatches: ${s.total} (${s.successes} success, ${s.failures} failure)`);
    lines.push(`  Follow-up rate: ${(s.followUpRate * 100).toFixed(0)}%`);
    lines.push(`  Avg cost: $${s.avgCost.toFixed(3)}, Avg time: ${Math.round(s.avgElapsed / 1000)}s`);

    const ops = Object.entries(s.operationBreakdown);
    if (ops.length > 0) {
      lines.push(`  Operations:`);
      for (const [op, data] of ops) {
        const failStr = data.failures > 0 ? ` (${data.failures} failed)` : "";
        lines.push(`    ${op}: ${data.total}${failStr}`);
      }
    }
    lines.push("");
  }

  // Identify patterns
  const failedEntries = entries.filter(e => e.outcome === "failure");
  if (failedEntries.length > 0) {
    lines.push("## Failure Patterns");
    for (const e of failedEntries.slice(-5)) {
      lines.push(`  - [${e.agent}/${e.operation}] ${e.taskSummary}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
