# Pi Agent Setup Guide

## Prerequisites

All three are required:

| Tool  | Version | Install |
|-------|---------|---------|
| **Bun** | ≥1.3.2 | https://bun.sh |
| **Just** | Latest | `brew install just` |
| **Pi** | ≥0.57 | https://github.com/mariozechner/pi-coding-agent |

## Quick Setup (5 minutes)

### 1. Install Dependencies
```bash
bun install
```

### 2. Create Environment File
```bash
cp .env.sample .env
# Edit .env and add your API keys
```

**Supported Providers:**
- `OPENAI_API_KEY` — OpenAI (https://platform.openai.com/api-keys)
- `ANTHROPIC_API_KEY` — Anthropic (https://console.anthropic.com/settings/keys)
- `GEMINI_API_KEY` — Google Gemini (https://aistudio.google.com/app/apikey)
- `OPENROUTER_API_KEY` — OpenRouter (https://openrouter.ai/keys)

### 3. Verify Installation
```bash
just pi       # Launches default Pi agent
```

## Loading Your Environment

Pi does NOT auto-load `.env` — you must source it before launching Pi.

**Option A — Per-Session:**
```bash
source .env && pi -e extensions/minimal.ts
```

**Option B — Bash Alias (add to `~/.zshrc` or `~/.bashrc`):**
```bash
alias pi-dev='cd /path/to/repo && source .env && pi'
```

**Option C — Just Tasks (Recommended):**
```bash
just pi                  # .env loads automatically
just ext-minimal         # Works for all recipes
just open minimal theme-cycler
```

## Project Structure

```
pi-vs-cc/
├── .env                      # Your API keys (create from .env.sample)
├── .pi/
│   ├── agents/               # Agent definitions (.md + teams.yaml)
│   ├── skills/               # Skills (capabilities packages)
│   ├── themes/               # Custom color themes (.json)
│   ├── prompts/              # Reusable prompt templates (.md)
│   ├── settings.json         # Pi configuration
│   └── SETUP.md              # This file
├── extensions/               # 16 custom extensions (.ts)
├── justfile                  # Task runner recipes
├── package.json              # Node dependencies
└── README.md                 # Full documentation
```

## Extensions

All extensions are in `extensions/`:

| Extension | Command | Purpose |
|-----------|---------|---------|
| **minimal** | `just ext-minimal` | Compact footer with model + context meter |
| **pure-focus** | `just ext-pure-focus` | Remove all UI noise |
| **theme-cycler** | `just ext-theme-cycler` | Ctrl+X/Q to cycle themes |
| **tool-counter** | `just ext-tool-counter` | Rich metrics footer |
| **purpose-gate** | `just ext-purpose-gate` | Declare intent before working |
| **subagent-widget** | `just ext-subagent-widget` | `/sub` command for background agents |
| **agent-team** | `just ext-agent-team` | Multi-specialist orchestration |
| **agent-chain** | `just ext-agent-chain` | Sequential pipeline workflows |
| **damage-control** | `just ext-damage-control` | Safety auditing & path access rules |
| **system-select** | `just ext-system-select` | `/system` to switch agent personas |
| **cross-agent** | `just ext-cross-agent` | Load from .claude/, .gemini/, .codex/ |
| **tilldone** | `just ext-tilldone` | Task discipline before coding |
| **pi-pi** | `just ext-pi-pi` | Meta-agent that builds Pi agents |
| **session-replay** | `just ext-session-replay` | Timeline overlay of session history |
| **tool-counter-widget** | `just ext-tool-counter-widget` | Live tool counts in widget |

## Troubleshooting

### Pi command not found
```bash
# Install Pi from: https://github.com/mariozechner/pi-coding-agent
# Or verify it's in your PATH:
which pi
```

### API keys not loading
```bash
# Check your .env file exists
test -f .env && echo "✅ .env exists" || echo "❌ Missing .env"

# Verify keys are set in current shell
echo $OPENAI_API_KEY
```

### Extensions not loading
```bash
# Try with verbose output
pi -e extensions/minimal.ts --verbose

# Check for TypeScript syntax errors
bun check extensions/minimal.ts
```

### Theme not applying
```bash
# Verify theme file exists
ls .pi/themes/

# Theme is set in .pi/settings.json
cat .pi/settings.json
```

## Next Steps

1. **Read README.md** — Full feature overview
2. **Run `just ext-pi-pi`** — Meta-agent that builds Pi agents
3. **Explore extensions/** — Study the TypeScript source code
4. **Customize themes** — Edit `.pi/themes/` JSON files
5. **Create agents** — Add `.pi/agents/*.md` personas

## Support

- **Pi Docs:** https://github.com/mariozechner/pi-coding-agent
- **Issues:** Create an issue on this repo's GitHub
