# Pish Architecture & Model Requirements

## What Pish Is

Pish is a coding agent shell built as an extension to [Pi](https://github.com/mariozechner/pi-coding-agent). It transforms Pi from a single-model coding assistant into a **multi-agent orchestrator** — a command-line interface where one model (the orchestrator) coordinates specialist models (subagents) to accomplish software engineering tasks.

The user never talks to subagents directly. They talk to the orchestrator, which decides what work to delegate, to whom, and with what instructions.

## How It Works

```
User <---> Orchestrator (Pi process)
                |
                |--- dispatch_agent ---> Scout (Pi subprocess)
                |--- dispatch_agent ---> Builder (Pi subprocess)
                |--- dispatch_agent ---> Reviewer (Pi subprocess)
                |--- fan_out ----------> [Scout x3 in parallel]
                |--- answer -----------> Answer (Pi subprocess)
```

### The Orchestrator

The orchestrator is Pi itself, running with a custom system prompt and a set of **tools** (not file/bash tools — meta-tools for managing work):

- `tilldone` — task lifecycle management (add, toggle, list tasks)
- `dispatch_agent` — spawn a specialist subagent with a task prompt
- `fan_out` — spawn multiple read-only agents in parallel
- `answer` — quick Q&A via a lightweight subagent
- `git_status` — check repo state
- `kill_agent` — cancel a running subagent

The orchestrator **cannot read, write, or edit files**. It cannot run shell commands. Its only capability is understanding the user's intent and delegating to specialists via well-crafted prompts.

**Model requirements for orchestrator:**
- **Tool use (function calling)** — mandatory. Pi sends the tool schemas to the model, which must return structured tool_call responses. Without this, the orchestrator literally cannot use any of its tools.
- **Strong instruction following** — must understand complex system prompts, choose the right tool, and write detailed dispatch prompts.
- **Good judgment** — decides which agent to use, when to fan out vs. single dispatch, when to ask clarifying questions.
- **Moderate context window** — holds the conversation with the user, task state, and dispatch results (truncated to 8K tokens each).
- **NOT needed: coding ability** — the orchestrator never writes code.

### Subagents

Each subagent is spawned as an independent `pi` child process:

```bash
pi --mode json --no-session --system-prompt <prompt> --tools <toolset> --model <model> "<task>"
```

The subagent gets:
- A system prompt from `.pi/agents/<name>.md`
- A tool whitelist (e.g., `read,bash,grep` for read-only agents)
- A model override from `shell-config.yaml`
- A single user message: the task prompt written by the orchestrator

The subagent has **zero context** beyond this. It doesn't see the user's conversation, prior dispatches, or task history. The orchestrator's dispatch prompt is the only thing it knows.

Results stream back via JSONL on stdout. The extension captures text output, cost data, and error messages, then returns a truncated summary to the orchestrator.

### Learning Loop

Every dispatch is logged to `.pi/dispatch-log.jsonl`. Before the next dispatch, the system searches the log for similar past work (matching on agent + operation type) and injects raw outcomes into the orchestrator's context. Over time, the orchestrator sees what worked and what didn't, and can write better prompts.

`/improve-agents` analyzes the log and proposes edits to agent definition files based on accumulated evidence.

---

## The Agent Roster

### Read-Only Agents (tools: `read,bash,grep`)

These agents can explore the codebase but cannot modify it. They're safe for parallel execution (fan_out) since they can't create conflicts.

#### Scout
**Job:** Fast reconnaissance. Find files, trace code paths, identify structure, answer "where is X?" and "how does Y work?" questions.

**When used:** First step in most workflows. Before the orchestrator can write a good dispatch prompt for a builder, it often needs to know what exists. Scout answers that.

**What matters in a model:**
- Speed (TTFT and tokens/sec) — scout runs frequently, often as a precursor to real work
- Codebase navigation — needs to read files, grep patterns, follow imports
- Concise summarization — should report findings, not dump file contents
- Does NOT need deep reasoning or creativity

**Typical cost per run:** Low. Short prompts, short outputs. Usually under 2K output tokens.

#### Planner
**Job:** Given a feature request or bug report, produce a numbered implementation plan: which files to change, in what order, with what approach, and what risks exist.

**When used:** Before complex builder dispatches. The orchestrator sends the planner first, reviews the plan, then dispatches builder(s) following it.

**What matters in a model:**
- Architectural reasoning — understand how components interact
- Risk identification — spot breaking changes, missing migrations, dependency issues
- Structured output — numbered plans with clear steps
- Codebase comprehension — must read and understand existing patterns
- Does NOT need to write code, but must understand code deeply

**Typical cost per run:** Medium. Reads many files, produces 1-3K tokens of structured output.

#### Reviewer
**Job:** Post-implementation code review. Check for bugs, style issues, missing tests, security problems. Verify the builder's work matches the original request.

**When used:** After builder completes. The orchestrator dispatches reviewer to audit what was built.

**What matters in a model:**
- Bug detection — catch logical errors, off-by-ones, race conditions
- Security awareness — spot injection, auth bypass, exposed secrets
- Attention to detail — compare implementation against acceptance criteria
- Constructive feedback — actionable bullet points, not vague concerns

**Typical cost per run:** Medium. Reads diffs and surrounding code, produces structured critique.

#### Red-Team
**Job:** Adversarial analysis. Find edge cases, security vulnerabilities, failure modes, and ways the implementation could break under stress.

**When used:** For security-sensitive changes or when the user asks for thorough vetting. More aggressive and paranoid than reviewer.

**What matters in a model:**
- **Adversarial thinking** — this is the key differentiator. The model must actively try to break things, not just verify they work.
- Creative attack vectors — think about what inputs could cause problems
- Security domain knowledge — OWASP top 10, common vulnerability patterns
- A thinking/reasoning model is ideal here — step-by-step analysis of attack surfaces

**Typical cost per run:** Medium-high. Deep analysis produces longer output with reasoning chains.

#### Plan-Reviewer
**Job:** Critique implementation plans before they're executed. Challenge assumptions, find missing steps, flag scope creep.

**When used:** After planner, before builder. Quality gate for plans.

**What matters in a model:**
- Critical thinking — must disagree with the plan where appropriate
- Practical feasibility sense — "can this actually be done?"
- Awareness of common planning failures — missing migrations, forgotten tests, dependency ordering

**Typical cost per run:** Low-medium. Reviews a plan document, produces structured critique.

#### Answer (special)
**Job:** Self-contained Q&A. User asks a question, answer agent does a quick lookup and responds. Manages its own task lifecycle.

**When used:** For simple questions that don't need a full dispatch workflow. "What's on port 8080?" "How does the auth middleware work?"

**What matters in a model:**
- Speed — this should feel instant
- Cheap — runs frequently for small questions
- Basic comprehension — read a file, understand it, summarize
- Does NOT need deep reasoning

**Typical cost per run:** Very low. Shortest prompts, shortest outputs.

### Write Agents (tools: `read,write,edit,bash,grep`)

These agents can modify the codebase. They run on branches and commit their work.

#### Builder
**Job:** The workhorse. Implement features, fix bugs, refactor code, write tests. The only agent that regularly creates/modifies files.

**When used:** For all code changes. The orchestrator writes a detailed prompt with objective, scope, acceptance criteria, and constraints. Builder executes.

**What matters in a model:**
- **Code generation quality** — this is the primary differentiator. The model must write correct, clean, idiomatic code.
- **SWE-bench / LiveCodeBench scores** — direct predictors of real-world coding performance
- Tool use within pi — the builder uses read, write, edit, bash, grep tools via pi's tool system
- Multi-file editing — many tasks require coordinated changes across files
- Test awareness — should run existing tests, write new ones when asked
- Self-correction — if a test fails, should diagnose and fix

**Typical cost per run:** Highest. Long context (reads many files), long output (writes code), multiple tool calls. Can run for several minutes.

#### Documenter
**Job:** Write documentation, update READMEs, add comments. Has write access.

**When used:** Rarely dispatched directly. More often documentation is part of a builder task.

**What matters in a model:**
- Clear technical writing
- Ability to match existing doc style
- Understanding of what needs documenting vs. what's self-evident

**Typical cost per run:** Low-medium.

#### Bowser (special)
**Job:** Headless browser automation via Playwright. Screenshots, web scraping, UI testing.

**When used:** Specialized tasks requiring browser interaction. Not part of the standard coding workflow.

**Model:** Hardcoded to Opus (needs strong reasoning for browser automation).

---

## Model Niche Summary

| Niche | What Matters Most | What Doesn't Matter | Volume | Cost Sensitivity |
|-------|------------------|--------------------|---------|-----------------|
| **Orchestrator** | Tool use, judgment, instruction following | Coding ability | Every interaction | Medium — always running |
| **Scout** | Speed, navigation, conciseness | Deep reasoning | High — runs first in most workflows | High — frequent |
| **Planner** | Architectural reasoning, risk ID | Code generation | Medium | Medium |
| **Builder** | Code quality (SWE-bench), multi-file editing | Speed | Medium but expensive per run | Low — quality > cost |
| **Reviewer** | Bug detection, attention to detail | Creativity | Medium — runs after builder | Medium |
| **Red-Team** | Adversarial thinking, security knowledge | Speed | Low — only for security-sensitive work | Low — quality > cost |
| **Plan-Reviewer** | Critical thinking, feasibility sense | Code generation | Low | High — brief runs |
| **Answer** | Speed, cheapness | Deep reasoning | High | Very high — should be near-free |

## Current Model Assignment & Known Issues

| Role | Current Model | Cost (in/out) | Status |
|------|--------------|---------------|--------|
| Orchestrator | hermes-4-70b | $0.13/$0.40 | **BROKEN** — no tool use support on OpenRouter |
| Scout | hermes-4-70b | $0.13/$0.40 | Works (no tool use needed) |
| Planner | hermes-4-70b | $0.13/$0.40 | Works |
| Builder | deepseek-v3.2 | $0.26/$0.38 | Works |
| Reviewer | hermes-4-70b | $0.13/$0.40 | Works |
| Red-Team | qwen3-235b-thinking | $0.11/$0.60 | Works |
| Answer | mistral-nemo | $0.02/$0.04 | Works |

### Open Questions

1. **Orchestrator model** — Needs tool use. DeepSeek V3.2 ($0.26/$0.38) is proven but same model as builder. Qwen3.5 Flash ($0.10/$0.40) has 1M context and ZDR. Others?

2. **Is hermes-4-70b the right choice for read-only agents?** — It's cheap and capable, but lacks tool use (fine for subagents since they use pi's tool system, not OpenRouter's). Quality-wise, is it strong enough for reviewer and planner roles?

3. **Red-team model** — Qwen3-235b-thinking is a reasoning model, which suits adversarial analysis. But at $0.11/$0.60 it's cheap on input, expensive on output — and red-team produces long output. Is there a better fit?

4. **Where does Mercury 2 fit?** — $0.25/$0.75, strong general capability, tool use supported. Could upgrade scout, planner, or reviewer quality. But nearly 2x the cost of hermes for read-only roles.

5. **Builder alternatives** — DeepSeek V3.2 is the best cost/performance ratio on the market (67.8% SWE-bench at $0.26/$0.38). Is it good enough, or do we need tiered builders (cheap for simple tasks, premium for complex ones)?

6. **Fan-out cost** — Parallel scouts multiply cost by N. With hermes at $0.13 input, a 3-way fan-out costs ~$0.39 input alone. With a more expensive model, this adds up.
