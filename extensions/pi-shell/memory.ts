/**
 * Agent Memory — Persistent knowledge store for pi-shell agents
 *
 * Provides a file-based memory system at .pi/memory/ that agents can
 * read (recall) and write (remember) across sessions. The orchestrator
 * auto-injects memory context into scout dispatches.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

// ── Constants ──────────────────────────────────────────────────────────

const MEMORY_DIR = ".pi/memory";
const MEMORY_INDEX = "MEMORY.md";

// ── Types ──────────────────────────────────────────────────────────────

export interface MemoryEntry {
  topic: string;
  updated: string;
  agent: string;
  content: string;
}

// ── Core Functions ─────────────────────────────────────────────────────

/** Get the memory directory path */
export function getMemoryDir(cwd: string): string {
  return join(cwd, MEMORY_DIR);
}

/** Read the memory index file. Returns empty string if not found. */
export function readMemoryIndex(cwd: string): string {
  const indexPath = join(cwd, MEMORY_DIR, MEMORY_INDEX);
  if (!existsSync(indexPath)) return "";
  try {
    return readFileSync(indexPath, "utf-8");
  } catch {
    return "";
  }
}

/** Check if any memory entries exist beyond the empty index */
export function hasMemory(cwd: string): boolean {
  const index = readMemoryIndex(cwd);
  // Check if index has any topic entries (lines containing .md links)
  return /\[.*\.md\]/.test(index);
}

/**
 * Build a compact memory context prefix for injection into agent dispatch prompts.
 * Returns null if no memory exists.
 */
export function buildMemoryContext(cwd: string): string | null {
  const index = readMemoryIndex(cwd);
  if (!index || !hasMemory(cwd)) return null;

  return [
    "## Known Context (from .pi/memory/)",
    "",
    index.trim(),
    "",
    "Use `cat .pi/memory/<topic>.md` to load details for relevant topics before scanning.",
    "",
  ].join("\n");
}

/**
 * Build memory injection prefix for scout dispatch prompts.
 * Prepends known context so the scout can skip re-scanning known areas.
 */
export function buildScoutMemoryPrefix(cwd: string): string {
  const ctx = buildMemoryContext(cwd);
  if (!ctx) return "";
  return ctx + "\n---\n\n";
}
