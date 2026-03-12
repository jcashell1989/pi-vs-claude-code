/**
 * Agent Memory — Persistent knowledge store for pi-shell agents
 *
 * Provides a file-based memory system at .pi/memory/ that agents can
 * read (recall) and write (remember) across sessions. The orchestrator
 * auto-injects memory context into scout dispatches.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
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

/**
 * Write or update a memory entry. Creates the topic file and updates the index.
 * Returns a status message.
 */
export function writeMemory(cwd: string, topic: string, content: string): string {
  const memDir = join(cwd, MEMORY_DIR);
  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });

  // Sanitize topic to kebab-case filename
  const safeTopic = topic.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!safeTopic) return "Error: invalid topic name";

  const filename = `${safeTopic}.md`;
  const filePath = join(memDir, filename);
  const isUpdate = existsSync(filePath);
  const date = new Date().toISOString().split("T")[0];

  // Write topic file with frontmatter
  const fileContent = [
    "---",
    `topic: ${safeTopic}`,
    `updated: ${date}`,
    "agent: orchestrator",
    "---",
    "",
    content.trim(),
    "",
  ].join("\n");

  writeFileSync(filePath, fileContent);

  // Update index if this is a new topic
  if (!isUpdate) {
    const indexPath = join(memDir, MEMORY_INDEX);
    let index = existsSync(indexPath) ? readFileSync(indexPath, "utf-8") : "# Agent Memory Index\n";

    // Check if already listed (shouldn't be if !isUpdate, but be safe)
    if (!index.includes(`[${filename}]`)) {
      // Extract a one-line description from content (first non-empty line)
      const firstLine = content.trim().split("\n")[0].slice(0, 80);
      index = index.trimEnd() + `\n- [${filename}](${filename}) — ${firstLine}\n`;
      writeFileSync(indexPath, index);
    }
  }

  return isUpdate
    ? `Updated memory: ${safeTopic} (${filePath})`
    : `Saved new memory: ${safeTopic} (${filePath})`;
}
