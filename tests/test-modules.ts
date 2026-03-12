/**
 * Unit tests for pi-shell config loader and TaskStore modules.
 *
 * Run with: bun run tests/test-modules.ts
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadConfig, type ShellConfig } from "../extensions/pi-shell/config";
import { createTaskStore, type TaskStore } from "../extensions/pi-shell/task-store";

// ── Test harness ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    const msg = err?.message ?? String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name} — ${msg}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertThrows(fn: () => void, label = "") {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`${label ? label + ": " : ""}expected function to throw`);
}

// ── Temp directory helpers ──────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-"));
}

function cleanup(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════
// Config tests
// ═══════════════════════════════════════════════════════════════════════

console.log("\n── Config tests ──────────────────────────────────────────");

test("loadConfig: returns defaults when no config file exists", () => {
  const tmp = makeTmpDir();
  try {
    const cfg = loadConfig(tmp);
    assertEqual(cfg.orchestrator.model, "openrouter/minimax/minimax-m2.5", "orchestrator.model");
    assertEqual(cfg.orchestrator.max_dispatch_result_tokens, 8000, "max_dispatch_result_tokens");
    assertEqual(cfg.orchestrator.compaction_summary, true, "compaction_summary");
    assertEqual(cfg.git.auto_branch, true, "git.auto_branch");
    assertEqual(cfg.git.branch_prefix, "task/", "git.branch_prefix");
    assert(cfg.interactive_commands.length > 0, "interactive_commands should have entries");
    assertEqual(cfg.api_keys.default, "work", "api_keys.default");
  } finally {
    cleanup(tmp);
  }
});

test("loadConfig: loads real .pi/shell-config.yaml", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const cfg = loadConfig(projectRoot);
  assertEqual(cfg.orchestrator.model, "openrouter/minimax/minimax-m2.5", "orchestrator.model");
  assertEqual(cfg.agent_models.builder, "openrouter/anthropic/claude-sonnet-4", "agent_models.builder");
  assertEqual(cfg.agent_timeouts.builder, 900, "agent_timeouts.builder");
  assertEqual(cfg.git.branch_prefix, "task/", "git.branch_prefix");
});

test("loadConfig: all required fields are present", () => {
  const tmp = makeTmpDir();
  try {
    const cfg = loadConfig(tmp);
    // Top-level keys
    assert(cfg.orchestrator !== undefined, "missing orchestrator");
    assert(cfg.agent_models !== undefined, "missing agent_models");
    assert(cfg.agent_timeouts !== undefined, "missing agent_timeouts");
    assert(cfg.api_keys !== undefined, "missing api_keys");
    assert(cfg.interactive_commands !== undefined, "missing interactive_commands");
    assert(cfg.git !== undefined, "missing git");
    // Nested required fields
    assert(typeof cfg.orchestrator.model === "string", "orchestrator.model should be string");
    assert(typeof cfg.orchestrator.max_dispatch_result_tokens === "number", "max_dispatch_result_tokens should be number");
    assert(typeof cfg.orchestrator.compaction_summary === "boolean", "compaction_summary should be boolean");
    assert(typeof cfg.git.auto_branch === "boolean", "git.auto_branch should be boolean");
    assert(typeof cfg.git.auto_pr === "boolean", "git.auto_pr should be boolean");
    assert(typeof cfg.git.branch_prefix === "string", "git.branch_prefix should be string");
    assert(typeof cfg.git.require_gh === "boolean", "git.require_gh should be boolean");
  } finally {
    cleanup(tmp);
  }
});

test("loadConfig: deep merge fills missing fields from defaults", () => {
  const tmp = makeTmpDir();
  try {
    const piDir = path.join(tmp, ".pi");
    fs.mkdirSync(piDir, { recursive: true });
    // Write partial YAML — only override orchestrator.model and git.branch_prefix
    fs.writeFileSync(
      path.join(piDir, "shell-config.yaml"),
      `orchestrator:\n  model: custom/model\ngit:\n  branch_prefix: "feat/"\n`,
      "utf-8"
    );
    const cfg = loadConfig(tmp);
    // Overridden values
    assertEqual(cfg.orchestrator.model, "custom/model", "overridden model");
    assertEqual(cfg.git.branch_prefix, "feat/", "overridden branch_prefix");
    // Defaults that should survive
    assertEqual(cfg.orchestrator.max_dispatch_result_tokens, 8000, "default max_dispatch_result_tokens");
    assertEqual(cfg.orchestrator.compaction_summary, true, "default compaction_summary");
    assertEqual(cfg.git.auto_branch, true, "default auto_branch");
    assertEqual(cfg.git.auto_pr, true, "default auto_pr");
    assertEqual(cfg.git.require_gh, false, "default require_gh");
    assert(cfg.interactive_commands.length > 0, "default interactive_commands");
    assertEqual(cfg.api_keys.default, "work", "default api_keys.default");
  } finally {
    cleanup(tmp);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// TaskStore tests
// ═══════════════════════════════════════════════════════════════════════

console.log("\n── TaskStore tests ───────────────────────────────────────");

test("createTaskStore: creates fresh state when no file exists", () => {
  const tmp = makeTmpDir();
  try {
    const store = createTaskStore(tmp);
    const data = store.getData();
    assertEqual(data.nextId, 1, "nextId");
    assertEqual(data.listTitle, "pi-shell session", "listTitle");
    assertEqual(data.tasks.length, 0, "tasks.length");
  } finally {
    cleanup(tmp);
  }
});

test("add: creates task with correct defaults", () => {
  const tmp = makeTmpDir();
  try {
    const store = createTaskStore(tmp);
    const task = store.add("write tests");
    assertEqual(task.id, 1, "id");
    assertEqual(task.text, "write tests", "text");
    assertEqual(task.status, "idle", "status");
    assertEqual(task.branch, null, "branch");
    assertEqual(task.pr, null, "pr");
    assertEqual(task.cost, 0, "cost");
    assertEqual(task.completed, null, "completed");
    assert(typeof task.created === "string", "created should be ISO string");
  } finally {
    cleanup(tmp);
  }
});

test("addBatch: creates multiple tasks", () => {
  const tmp = makeTmpDir();
  try {
    const store = createTaskStore(tmp);
    const tasks = store.addBatch(["task A", "task B", "task C"]);
    assertEqual(tasks.length, 3, "batch length");
    assertEqual(tasks[0].id, 1, "first id");
    assertEqual(tasks[1].id, 2, "second id");
    assertEqual(tasks[2].id, 3, "third id");
    assertEqual(tasks[0].text, "task A", "first text");
    assertEqual(tasks[2].text, "task C", "third text");
    assertEqual(store.getAll().length, 3, "total tasks");
  } finally {
    cleanup(tmp);
  }
});

test("toggle: cycles idle -> inprogress -> done -> idle", () => {
  const tmp = makeTmpDir();
  try {
    const store = createTaskStore(tmp);
    store.add("cycling task");
    let t = store.toggle(1);
    assertEqual(t.status, "inprogress", "after first toggle");
    t = store.toggle(1);
    assertEqual(t.status, "done", "after second toggle");
    t = store.toggle(1);
    assertEqual(t.status, "idle", "after third toggle");
  } finally {
    cleanup(tmp);
  }
});

test("toggle: demotes other in-progress tasks (single active invariant)", () => {
  const tmp = makeTmpDir();
  try {
    const store = createTaskStore(tmp);
    store.add("task A");
    store.add("task B");
    store.toggle(1); // A -> inprogress
    assertEqual(store.getActive()?.id, 1, "A is active");

    store.toggle(2); // B -> inprogress, should demote A
    assertEqual(store.getActive()?.id, 2, "B is now active");
    assertEqual(store.getById(1)?.status, "idle", "A demoted to idle");
  } finally {
    cleanup(tmp);
  }
});

test("toggle: sets completed timestamp when moving to done", () => {
  const tmp = makeTmpDir();
  try {
    const store = createTaskStore(tmp);
    store.add("complete me");
    store.toggle(1); // idle -> inprogress
    const t = store.toggle(1); // inprogress -> done
    assert(t.completed !== null, "completed should be set");
    assert(typeof t.completed === "string", "completed should be ISO string");
    // Verify it clears when toggling back to idle
    const t2 = store.toggle(1); // done -> idle
    assertEqual(t2.completed, null, "completed cleared on re-idle");
  } finally {
    cleanup(tmp);
  }
});

test("remove: removes a task, throws on missing ID", () => {
  const tmp = makeTmpDir();
  try {
    const store = createTaskStore(tmp);
    store.add("to be removed");
    store.add("to remain");
    store.remove(1);
    assertEqual(store.getAll().length, 1, "length after remove");
    assertEqual(store.getAll()[0].id, 2, "remaining task id");
    assertThrows(() => store.remove(99), "remove missing id");
  } finally {
    cleanup(tmp);
  }
});

test("update: changes task text", () => {
  const tmp = makeTmpDir();
  try {
    const store = createTaskStore(tmp);
    store.add("old text");
    store.update(1, "new text");
    assertEqual(store.getById(1)?.text, "new text", "updated text");
  } finally {
    cleanup(tmp);
  }
});

test("setBranch, setPr, addCost work correctly", () => {
  const tmp = makeTmpDir();
  try {
    const store = createTaskStore(tmp);
    store.add("git task");
    store.setBranch(1, "feat/test");
    assertEqual(store.getById(1)?.branch, "feat/test", "branch");
    store.setPr(1, "https://github.com/example/pr/1");
    assertEqual(store.getById(1)?.pr, "https://github.com/example/pr/1", "pr");
    store.addCost(1, 0.05);
    store.addCost(1, 0.10);
    assertEqual(store.getById(1)?.cost, 0.15, "accumulated cost");
  } finally {
    cleanup(tmp);
  }
});

test("getActive: returns the in-progress task", () => {
  const tmp = makeTmpDir();
  try {
    const store = createTaskStore(tmp);
    store.add("task A");
    store.add("task B");
    assertEqual(store.getActive(), undefined, "no active initially");
    store.toggle(2); // B -> inprogress
    assertEqual(store.getActive()?.id, 2, "B is active");
  } finally {
    cleanup(tmp);
  }
});

test("hasActiveTasks: returns true when non-done tasks exist", () => {
  const tmp = makeTmpDir();
  try {
    const store = createTaskStore(tmp);
    assert(!store.hasActiveTasks(), "no tasks => false");
    store.add("task");
    assert(store.hasActiveTasks(), "idle task => true");
    store.toggle(1); // inprogress
    store.toggle(1); // done
    assert(!store.hasActiveTasks(), "all done => false");
  } finally {
    cleanup(tmp);
  }
});

test("summary: returns a readable string", () => {
  const tmp = makeTmpDir();
  try {
    const store = createTaskStore(tmp);
    // Empty summary
    assert(store.summary().includes("no tasks"), "empty summary");

    store.add("alpha");
    store.add("beta");
    store.toggle(1); // alpha -> inprogress
    store.setBranch(1, "feat/alpha");
    const s = store.summary();
    assert(s.includes("pi-shell session"), "contains title");
    assert(s.includes("0/2 done"), "contains progress");
    assert(s.includes("1 active"), "contains active count");
    assert(s.includes("#1"), "contains task id");
    assert(s.includes("alpha"), "contains task text");
    assert(s.includes("feat/alpha"), "contains branch");
  } finally {
    cleanup(tmp);
  }
});

test("clear: resets everything", () => {
  const tmp = makeTmpDir();
  try {
    const store = createTaskStore(tmp);
    store.add("task 1");
    store.add("task 2");
    store.clear();
    assertEqual(store.getAll().length, 0, "tasks cleared");
    // nextId resets to 1
    const next = store.add("new task");
    assertEqual(next.id, 1, "nextId reset to 1");
  } finally {
    cleanup(tmp);
  }
});

test("newList: resets with a new title", () => {
  const tmp = makeTmpDir();
  try {
    const store = createTaskStore(tmp);
    store.add("old task");
    store.newList("sprint 2");
    assertEqual(store.getTitle(), "sprint 2", "new title");
    assertEqual(store.getAll().length, 0, "tasks cleared");
    const t = store.add("fresh task");
    assertEqual(t.id, 1, "nextId reset");
  } finally {
    cleanup(tmp);
  }
});

test("persistence: mutations are saved to disk", () => {
  const tmp = makeTmpDir();
  try {
    const store = createTaskStore(tmp);
    store.add("persistent task");
    store.toggle(1); // inprogress
    store.setBranch(1, "main");

    // Read the JSON file directly
    const filePath = path.join(tmp, ".pi", "tasks", "tasks.json");
    assert(fs.existsSync(filePath), "tasks.json should exist");
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    assertEqual(raw.tasks.length, 1, "persisted task count");
    assertEqual(raw.tasks[0].text, "persistent task", "persisted text");
    assertEqual(raw.tasks[0].status, "inprogress", "persisted status");
    assertEqual(raw.tasks[0].branch, "main", "persisted branch");

    // Create a second store from same directory — should load persisted data
    const store2 = createTaskStore(tmp);
    assertEqual(store2.getAll().length, 1, "reloaded task count");
    assertEqual(store2.getActive()?.id, 1, "reloaded active task");
  } finally {
    cleanup(tmp);
  }
});

// ── Summary ─────────────────────────────────────────────────────────────

console.log("\n══════════════════════════════════════════════════════════");
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
}
console.log("");

process.exit(failed > 0 ? 1 : 0);
