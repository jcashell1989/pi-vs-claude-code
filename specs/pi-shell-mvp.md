# Pi-Shell MVP — Final Plan

## Vision

Pi-Shell is a single pi extension (`extensions/pi-shell.ts`) that transforms pi into an agent-forward personal command prompt. The main session is a strict orchestrator — it never touches the codebase directly. All real work is dispatched to specialist subagents. Shell commands pass through via pi's built-in `!`/`!!`. Every interaction is tracked via TillDone with no exceptions.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Pi-Shell (orchestrator session)                 │
│  Cheap high-perf model (MiniMax/Kimi/GLM-5)     │
│  Tools: tilldone, dispatch_agent, answer, git_   │
│         status, switch_key, kill_agent           │
│  NO codebase tools (no read/write/edit/bash)     │
├──────────────────────────────────────────────────┤
│  ! / !! → fish passthrough (built-in pi)         │
│  Natural language → orchestrator LLM             │
│    → creates task (TillDone, always)             │
│    → dispatches subagent(s) OR answers directly  │
│    → tracks completion in footer                 │
│    → git branch + PR on done                     │
└──────┬──────┬──────┬────────────────────────────┘
       │      │      │
    ┌──▼──┐┌──▼──┐┌──▼──┐
    │scout││build││review│  ← subagents (pi CLIs)
    │     ││     ││      │  ← own branches
    │cheap││exp. ││mid   │  ← model per role
    └─────┘└─────┘└─────┘
```

## Tools Registered by pi-shell.ts

### 1. `tilldone` — Task Lifecycle Management
Carried over from existing `tilldone.ts` with modifications:
- **Persistent state**: reads/writes `.pi/tasks/tasks.json` instead of reconstructing from session
- **Always enforced**: blocks all other tools until a task exists and is in-progress
- **Gate whitelist**: `answer`, `git_status`, `switch_key`, and `kill_agent` bypass the blocking gate (utility tools that don't require a task context)
- **Actions**: `new-list`, `add`, `toggle`, `remove`, `update`, `list`, `clear`
- **Single active task**: toggling one task to in-progress demotes others
- **Auto-nudge on agent_end**: if tasks remain incomplete, triggers new turn

### 2. `dispatch_agent` — Subagent Spawning
Adapted from existing `agent-team.ts` pattern:
- Spawns `pi` subprocess with `--mode json` for JSONL event parsing
- Agent definitions loaded from `.pi/agents/*.md` (YAML frontmatter + system prompt)
- Team selection from `.pi/agents/teams.yaml`
- Each dispatch specifies: agent name, task description, target branch
- Subagent runs in background, status tracked in footer and dashboard widget
- Session persisted to `.pi/tasks/sessions/<agent>-<task-id>.jsonl` for resume
- Result truncated to configurable `max_dispatch_result_tokens` (default 8000) before returning to orchestrator context
- Model per agent role configured in `.pi/shell-config.yaml`
- Parses `message_end` events from subagent JSONL to extract and aggregate costs

### 3. `answer` — Self-Contained Question Tool
New tool for quick questions that don't need a full subagent dispatch:
- **Self-contained lifecycle**: internally manages TaskStore directly (not via `tilldone` tool calls)
- On `execute`:
  1. `taskStore.add(question)` — creates the task
  2. `taskStore.toggle(id)` — sets to in-progress
  3. Refreshes UI
  4. Spawns a read-only subagent (scout profile, answer-specific model from config)
  5. Uses `onUpdate()` for streaming progress during subagent run
  6. `taskStore.toggle(id)` — sets to done on completion
  7. Refreshes UI
  8. Returns result
- **Bypasses TillDone gate** (whitelisted) — single tool call from orchestrator's perspective
- For questions like "what's on port 8080?", "explain this error", "what does X do?"
- Task is fully tracked in persistent JSON — no loophole, just compressed lifecycle

### 4. `git_status` — Repository State
Lightweight tool the orchestrator can use to check repo state:
- Current branch, uncommitted changes, recent commits
- Active task branches and their PR status (via `gh` if available)
- No file reading — just metadata
- **Bypasses TillDone gate** (utility tool)

### 5. `switch_key` — OpenRouter API Key Switching
- Named profiles in `.pi/shell-config.yaml` under `api_keys`
- Swaps `OPENROUTER_API_KEY` in process env
- Propagates to all future subagent spawns
- Active profile shown in footer
- **Bypasses TillDone gate** (utility tool)

### 6. `kill_agent` — Subagent Cancellation
- Kills a running subagent by name or ID
- Cleans up session file and updates AgentTracker
- Reports cancellation to orchestrator
- **Bypasses TillDone gate** (utility tool)

## Orchestrator System Prompt

The orchestrator system prompt is a Wave 1 deliverable. It must cover:

```markdown
You are Pi-Shell, a strict orchestrator. You NEVER touch the codebase directly.
You have NO file access tools. Your job is to understand what the user wants,
track it as a task, and dispatch the right specialist agent to do the work.

## Your Tools
- `tilldone`: manage your task list. You MUST create a task before dispatching work.
- `dispatch_agent`: send work to a specialist agent. Available agents: {dynamic catalog}
- `answer`: for quick questions that need a read-only lookup. Self-contained — handles
  its own task lifecycle. Use this instead of dispatch_agent for simple questions.
- `git_status`: check repository state (branch, changes, PRs). No task required.
- `switch_key`: switch OpenRouter API key profile. No task required.
- `kill_agent`: cancel a running agent. No task required.

## Workflow
1. User gives you a request
2. Create a task with `tilldone add`
3. Toggle it to in-progress with `tilldone toggle`
4. Dispatch the right agent(s) with `dispatch_agent` — or use `answer` for questions
5. When agent returns results, evaluate completeness
6. If done: toggle task to done. If git workflow created a branch: push + PR.
7. If not done: dispatch follow-up agent(s)

## Rules
- NEVER skip TillDone. Every interaction creates a task.
- Use `answer` for questions. Use `dispatch_agent` for code changes and multi-step work.
- When dispatching, write clear, specific prompts. The agent cannot see your conversation.
- Keep dispatch prompts focused. Include: what to do, which files, acceptance criteria.
- For code changes: specify the target branch in your dispatch.
- Summarize agent results concisely for the user. Do not dump raw output.
```

This prompt is dynamically assembled at `before_agent_start` with the current agent catalog injected.

## UI: Unified Footer

Single composed footer owned entirely by pi-shell.ts:

```
 ~/projects/myapp  main  tasks: 2/5 ✓  scout⟳ builder◻  $0.43  work
```

Components left to right:
- **cwd**: current working directory (abbreviated)
- **git branch**: current branch name
- **task progress**: `done/total ✓` with count
- **active agents**: name + status icon (✓ done, ⟳ running, ◻ queued, ✗ failed)
- **session cost**: running total from orchestrator + all subagent costs (parsed from JSONL `message_end` events)
- **api key profile**: which OpenRouter key is active

## UI: Subagent Dashboard Widget

Rendered above the editor when subagents are active:

```
┌─ scout ────────────────────── 12s ─┐
│ Investigating auth module structure │
│ Context: ██████░░░░ 58%            │
└────────────────────────────────────┘
┌─ builder ──────────────────── 0s ─┐
│ ◻ Queued: waiting for scout       │
└────────────────────────────────────┘
```

- Cards appear/disappear as agents start/finish
- Shows: agent name, elapsed time, current work summary, context usage bar
- Dismissed automatically when all agents for current task complete

## Persistent State

### `.pi/tasks/tasks.json`
```json
{
  "nextId": 4,
  "listTitle": "pi-shell session",
  "tasks": [
    {
      "id": 1,
      "text": "Refactor auth middleware",
      "status": "done",
      "branch": "task/1-refactor-auth",
      "pr": "https://github.com/user/repo/pull/42",
      "created": "2026-03-11T10:00:00Z",
      "completed": "2026-03-11T10:15:00Z",
      "cost": 0.35
    },
    {
      "id": 2,
      "text": "What does the cache layer do?",
      "status": "done",
      "branch": null,
      "pr": null,
      "created": "2026-03-11T10:16:00Z",
      "completed": "2026-03-11T10:16:30Z",
      "cost": 0.02
    }
  ]
}
```

### `.pi/tasks/sessions/`
Contains subagent session JSONL files for resume capability.
Named: `<agent>-<task-id>.jsonl` (e.g., `scout-1.jsonl`, `builder-1.jsonl`).

### `.pi/shell-config.yaml`
```yaml
orchestrator:
  model: openrouter/minimax/minimax-m2.5
  max_dispatch_result_tokens: 8000
  compaction_summary: true

agent_models:
  scout: openrouter/google/gemini-2.5-flash
  planner: openrouter/google/gemini-2.5-flash
  builder: openrouter/anthropic/claude-sonnet-4
  reviewer: openrouter/anthropic/claude-sonnet-4
  red-team: openrouter/anthropic/claude-sonnet-4
  answer: openrouter/google/gemini-2.5-flash

agent_timeouts:
  scout: 300
  planner: 300
  builder: 900
  reviewer: 600
  answer: 120

api_keys:
  work:
    env: OPENROUTER_WORK_KEY
  personal:
    env: OPENROUTER_PERSONAL_KEY
  default: work

interactive_commands:
  - vim
  - nvim
  - nano
  - htop
  - top
  - less
  - more
  - ssh
  - python
  - node
  - irb

git:
  auto_branch: true
  auto_pr: true
  branch_prefix: "task/"
  require_gh: false
```

## Git Workflow

**Phase 1 (this MVP): Branch-per-task, sequential dispatch.**

1. Orchestrator creates task in TillDone
2. If task requires code changes: `git checkout -b task/<id>-<slug>`
3. Dispatch subagent(s) sequentially on that branch
4. Each subagent commits before returning
5. On task completion: `git push -u origin task/<id>-<slug>` + `gh pr create` (if `gh` available and `require_gh` is not false)
6. PR link stored in task JSON
7. Return to previous branch

Questions (answer tool) skip git workflow — no branch, no PR.

## TMux Integration

For interactive commands detected via the `interactive_commands` config:

1. Check `process.env.TMUX` — are we in tmux?
2. If yes: `tmux new-window -n <cmd> "cd <cwd> && <full command>"`
3. If no: warn user that interactive commands require tmux, suggest running in separate terminal
4. Pi-shell footer remains visible in the original pane/window

## Shell Passthrough

Uses pi's built-in `!` and `!!` — no custom code needed for basic passthrough.

Custom handling in `user_bash` event:
- **cd tracking**: intercept `cd` commands, update internal cwd state, sync with `ctx.cwd`
- **Output truncation**: if `user_bash` output exceeds 500 lines, truncate with summary
- **Interactive detection**: if command matches `interactive_commands`, route to tmux

## Context Management

The orchestrator session is lean by design (no codebase tools), but will still accumulate dispatch results over time.

- **Compaction handler** (`session_before_compact`): injects a summary message containing the current task list and active dispatches into post-compaction context, so the orchestrator retains awareness of task state after compaction
- **Dispatch result truncation**: configurable via `max_dispatch_result_tokens` (default 8000)
- **TaskStore is the source of truth**: even if session context is compacted, persistent JSON has complete task history

## Error Handling (Phase 1 — Lightweight)

- **Subagent exit code != 0**: report failure to orchestrator, orchestrator decides retry or escalate to user
- **Subagent timeout**: configurable per role via `agent_timeouts` config, kill process and report on exceed
- **Subagent hang**: user can manually cancel via `kill_agent` tool or `/kill` command
- **OpenRouter API down**: surface error in footer, allow `!` commands to continue, block agent dispatch
- **`gh` not installed**: detect on session start, disable auto-PR, warn user, still create branches and commits
- **Git conflicts**: subagent reports conflict, orchestrator surfaces to user
- **Branch already exists**: append timestamp suffix, warn orchestrator

## Internal Module Structure

`pi-shell.ts` is organized internally as composable modules:

```typescript
// pi-shell.ts — single extension entry point

export default function piShell(pi: ExtensionAPI) {
  // --- Config ---
  const config = loadConfig();          // .pi/shell-config.yaml

  // --- State ---
  const taskStore = createTaskStore();  // .pi/tasks/tasks.json persistence
  const agentTracker = createAgentTracker(); // subagent status tracking

  // --- Tools ---
  registerTillDone(pi, taskStore);      // tilldone tool + blocking gate (whitelists utility tools)
  registerDispatch(pi, config, taskStore, agentTracker); // dispatch_agent tool
  registerAnswer(pi, config, taskStore, agentTracker);   // answer tool (self-contained lifecycle)
  registerGitStatus(pi);               // git_status tool
  registerSwitchKey(pi, config);       // switch_key tool
  registerKillAgent(pi, agentTracker); // kill_agent tool

  // --- UI ---
  registerFooter(pi, taskStore, agentTracker, config);   // unified footer
  registerDashboard(pi, agentTracker); // subagent widget
  registerStatusCommand(pi, taskStore); // /status command
  registerKillCommand(pi, agentTracker); // /kill command
  registerHelpCommand(pi);              // /help command

  // --- Events ---
  setupSessionStart(pi, config);       // setActiveTools, system prompt, model selection
  setupBeforeAgentStart(pi, config);   // inject system prompt with agent catalog
  setupAgentEnd(pi, taskStore);        // tilldone nudge on incomplete tasks
  setupShellPassthrough(pi, config);   // user_bash: cd tracking, tmux routing
  setupCompaction(pi, taskStore);      // session_before_compact: inject task summary
}
```

Each `create*` / `register*` / `setup*` function is a pure function taking explicit dependencies. No global state. No classes. Testable in isolation.

## Build Sequence

Built by dispatching subagents for each module. The orchestrator (Claude) will:
1. Coordinate the build, write integration glue, and review results
2. Dispatch subagents to implement each module in parallel where possible
3. Task L (session lifecycle / wiring) is integration work — built directly by orchestrator, not dispatched

### Wave 1: Foundation
- **Task A**: Extension skeleton — entry point, type definitions, module structure
- **Task B**: Config module — `.pi/shell-config.yaml` loader with defaults and validation
- **Task C**: TaskStore module — CRUD for `.pi/tasks/tasks.json`, persistence logic
- **Task D**: Orchestrator system prompt — the `.pi/agents/orchestrator.md` definition
- **Task E**: Agent definitions — create/update `.pi/agents/*.md` for pi-shell's team (scout, planner, builder, reviewer, red-team) and `.pi/agents/teams.yaml`
- **Task F** (orchestrator, not dispatched): `setActiveTools` + model selection in `session_start`, system prompt injection in `before_agent_start`

### Wave 2: Core Tools
- **Task G**: TillDone tool — adapted from `tilldone.ts`, using TaskStore, blocking gate with utility tool whitelist
- **Task H**: Dispatch tool — adapted from `agent-team.ts`, background spawning, JSONL parsing, cost extraction, AgentTracker updates. Includes shared `spawnSubagent` helper.
- **Task I**: Answer tool — uses `spawnSubagent` from Task H, self-contained TaskStore lifecycle

### Wave 3: Utility Tools + Git
- **Task J**: Git workflow — branch creation, commit, push, PR via `gh`, git_status tool
- **Task K**: API key switching — switch_key tool, env propagation, config profiles
- **Task L**: Kill agent — kill_agent tool, process cleanup, AgentTracker update

### Wave 4: UI
- **Task M**: Unified footer — composed renderer with all status components, real-time cost tracking
- **Task N**: Subagent dashboard widget — card grid with DynamicBorder, real-time updates via timer
- **Task O**: Commands — `/status` (cross-session task overview), `/kill` (interactive agent cancel), `/help` (onboarding)

### Wave 5: Events + Integration
- **Task P** (orchestrator, not dispatched): Wire all modules together — event handlers for `agent_end` (nudge), `user_bash` (cd tracking, tmux routing, interactive detection), `session_before_compact` (task summary injection)
- **Task Q**: Error handling — timeouts, fallbacks, graceful degradation, branch conflict resolution

### Wave 6: Validation
- **Task R**: Integration testing — end-to-end flows, edge cases, 20 manual test conversations with target orchestrator model

## De-risking Strategy

**Build and test Wave 1 + Task G (TillDone) + Task H (dispatch) first.** Then run 20 manual test conversations with the target cheap orchestrator model before investing in UI and git workflow. If the model can't reliably follow the TillDone protocol and make good dispatch decisions, we know immediately and can adjust the model choice or improve the system prompt.

## Deferred to Phase 2
- Worktrees for parallel subagent dispatch
- Chain workflows (`run_chain`)
- Blueprint learning (save successful patterns)
- Cost budget enforcement
- Smart context handoff suggestions
- Advanced compaction optimization
- Self-improving error recovery
