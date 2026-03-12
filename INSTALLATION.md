# Installation & Setup Guide

Complete setup instructions for the Pi Agent playground.

## Prerequisites Checklist

Before proceeding, ensure you have:

- [ ] **Bun** ≥ 1.3.2 (runtime & package manager)
- [ ] **Just** (task runner)
- [ ] **Pi Coding Agent** ≥ 0.57.1 (CLI)
- [ ] One or more API keys from supported providers

### Installing Prerequisites

#### Bun
```bash
curl -fsSL https://bun.sh/install | bash
```
Verify: `bun --version`

#### Just
```bash
brew install just
```
Verify: `just --version`

#### Pi Coding Agent
```bash
# Follow official installation from:
# https://github.com/mariozechner/pi-coding-agent

# Verify installation:
pi --version
```

## Installation Steps

### Step 1: Clone This Repository
```bash
git clone https://github.com/your-org/pi-vs-cc.git
cd pi-vs-cc
```

### Step 2: Install Node Dependencies
```bash
bun install
```

This installs:
- `yaml` — for parsing YAML configuration files

### Step 3: Create Environment File
```bash
cp .env.sample .env
```

Then edit `.env` and add your API keys. See [API Keys](#api-keys) below.

### Step 4: Verify Setup
```bash
./setup-verify.sh
```

This checks:
- ✅ All prerequisites installed
- ✅ All configuration files present
- ✅ All directories created
- ✅ All themes and extensions available

You should see: **✅ All checks passed! You're ready to go.**

## API Keys

Pi requires at least ONE provider API key to function.

### Supported Providers

| Provider | Key Name | Get Your Key |
|----------|----------|--------------|
| **OpenAI** | `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **Anthropic** | `ANTHROPIC_API_KEY` | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |
| **Google Gemini** | `GEMINI_API_KEY` | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey) |
| **OpenRouter** | `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) |

See [Pi documentation](https://github.com/mariozechner/pi-coding-agent/blob/main/packages/coding-agent/docs/providers.md) for additional providers.

### Adding Keys to .env

Edit `.env` and replace placeholders:

```bash
# OpenAI
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxx

# Anthropic
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxx

# Google Gemini
GEMINI_API_KEY=AIzaxxxxxxxxxxxxxxxxxxxxx

# OpenRouter
OPENROUTER_API_KEY=sk-or-xxxxxxxxxxxxxxxxxxxxx
```

### Loading API Keys

Pi does **not** auto-load `.env` files. You must source them before launching Pi.

#### Option A: Per-Session (Quick)
```bash
source .env && pi
source .env && pi -e extensions/minimal.ts
```

#### Option B: Shell Alias (Permanent)
Add to `~/.zshrc` or `~/.bashrc`:
```bash
alias pi-dev='cd /path/to/pi-vs-cc && source .env && pi'
```

Then: `pi-dev` (loads .env automatically)

#### Option C: Just Tasks (Recommended)
```bash
# .env is automatically loaded by justfile via 'set dotenv-load := true'
just pi                    # Default agent
just ext-minimal           # Minimal UI
just ext-pi-pi            # Meta-agent that builds Pi agents
just open minimal theme-cycler    # Opens in new terminal window
```

## Quick Start

### Default Pi Agent
```bash
just pi
# or: source .env && pi
```

### Minimal UI
```bash
just ext-minimal
```

### Theme Cycler
```bash
just ext-theme-cycler
# Use Ctrl+X (forward) and Ctrl+Q (backward) to cycle themes
```

### Meta-Agent (Pi Pi)
```bash
just ext-pi-pi
# Build custom Pi agents with /experts command
```

### View All Available Commands
```bash
just --list
```

## Project Structure

```
pi-vs-cc/
├── .env                          # Your API keys (DO NOT COMMIT)
├── .env.sample                   # Template (commit this)
├── .pi/
│   ├── agents/                   # Agent personas (.md)
│   ├── agents/teams.yaml         # Team orchestration
│   ├── skills/                   # Capability packages
│   ├── themes/                   # Color themes (.json)
│   ├── prompts/                  # Prompt templates (.md)
│   ├── settings.json             # Pi configuration
│   ├── damage-control-rules.yaml # Safety audit rules
│   └── SETUP.md                  # Setup reference
├── extensions/                   # 16 custom extensions (.ts)
├── justfile                      # Task runner (just --list)
├── package.json                  # Node dependencies
├── setup-verify.sh               # Verification script
├── README.md                     # Feature overview
├── INSTALLATION.md               # This file
├── COMPARISON.md                 # Pi vs Claude Code
└── specs/                        # Design documents
```

## Troubleshooting

### Issue: "pi command not found"
```bash
# Verify Pi is installed
which pi

# If not found, install from:
# https://github.com/mariozechner/pi-coding-agent
```

### Issue: "API key not found" or "401 Unauthorized"
```bash
# Verify .env exists and is sourced
echo $OPENAI_API_KEY

# If empty, try:
source .env
echo $OPENAI_API_KEY

# If still empty, edit .env with your real key
nano .env
```

### Issue: "Extension not found"
```bash
# Verify extension file exists
ls extensions/minimal.ts

# Try with full path
pi -e ./extensions/minimal.ts

# Check for TypeScript errors
bun check extensions/minimal.ts
```

### Issue: "Theme not applying"
```bash
# Verify theme file exists
ls .pi/themes/synthwave.json

# Check settings.json
cat .pi/settings.json

# Manually set theme (in Pi):
/theme <theme_name>
```

### Issue: "Module not found" or import errors
```bash
# Reinstall dependencies
bun install

# Clear cache
rm -rf node_modules
bun install
```

## Verification

Run the comprehensive setup verification script:
```bash
./setup-verify.sh
```

Expected output:
```
✅ Checking Bun... ✅ 1.3.10
✅ Checking Just... ✅ just 1.46.0
✅ Checking Pi CLI... ✅ 0.57.1
✅ Checking dependencies... ✅ Installed
✅ Checking .env... ✅ Configured with API keys
✅ Checking .pi structure... ✅ All directories present
✅ Checking .pi/prompts... ✅ Exists
✅ Checking settings.json... ✅ Valid JSON
✅ Checking themes... ✅ 11 themes
✅ Checking extensions... ✅ 16 extensions

✅ All checks passed! You're ready to go.
```

## Next Steps

1. **Read README.md** — Feature overview and architecture
2. **Explore extensions/** — Study the TypeScript source code
3. **Try an extension** — `just ext-pi-pi` to build agents
4. **Customize themes** — Edit `.pi/themes/` JSON files
5. **Create agents** — Add `.pi/agents/your-agent.md`
6. **Review specs/** — Design documents and architecture

## Support & Links

- **Pi Coding Agent** — https://github.com/mariozechner/pi-coding-agent
- **This Repository** — https://github.com/your-org/pi-vs-cc
- **Bun** — https://bun.sh
- **Just** — https://github.com/casey/just

## Common Commands

```bash
# Start Pi with extensions
just pi                              # Default
just ext-minimal                     # Minimal UI
just ext-pure-focus                  # No UI noise
just ext-pi-pi                       # Meta-agent
just ext-agent-team                  # Multi-agent
just ext-damage-control              # Safety auditing

# Open in new terminal windows
just open minimal theme-cycler

# List all available tasks
just --list

# Verify setup
./setup-verify.sh
```

---

**Last Updated:** March 2024
**Pi Version:** ≥ 0.57.1
**Bun Version:** ≥ 1.3.2
