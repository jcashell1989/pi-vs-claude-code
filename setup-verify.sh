#!/bin/bash
set -e

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║         Pi Agent Setup Verification (v0.57.1+)            ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

failed=0
warnings=0

# 1. Check Bun
echo -n "1️⃣  Checking Bun... "
if command -v bun &> /dev/null; then
    bun_version=$(bun --version 2>/dev/null || echo "unknown")
    echo -e "${GREEN}✅ $bun_version${NC}"
else
    echo -e "${RED}❌ NOT INSTALLED${NC}"
    echo "   Install from: https://bun.sh"
    ((failed++))
fi

# 2. Check Just
echo -n "2️⃣  Checking Just... "
if command -v just &> /dev/null; then
    just_version=$(just --version 2>/dev/null | head -1)
    echo -e "${GREEN}✅ $just_version${NC}"
else
    echo -e "${RED}❌ NOT INSTALLED${NC}"
    echo "   Install: brew install just"
    ((failed++))
fi

# 3. Check Pi CLI
echo -n "3️⃣  Checking Pi CLI... "
if command -v pi &> /dev/null; then
    pi_version=$(pi --version 2>/dev/null | head -1 || echo "✓")
    echo -e "${GREEN}✅ $pi_version${NC}"
else
    echo -e "${RED}❌ NOT INSTALLED${NC}"
    echo "   Install from: https://github.com/mariozechner/pi-coding-agent"
    ((failed++))
fi

# 4. Check node_modules
echo -n "4️⃣  Checking dependencies... "
if [ -d node_modules ] && [ -d node_modules/yaml ]; then
    echo -e "${GREEN}✅ Installed${NC}"
else
    echo -e "${YELLOW}⚠️  Missing${NC}"
    echo "   Run: bun install"
    ((warnings++))
fi

# 5. Check .env
echo -n "5️⃣  Checking .env... "
if [ -f .env ]; then
    # Check if it's just the template or has actual keys
    if grep -q "^OPENAI_API_KEY=sk-\|^ANTHROPIC_API_KEY=sk-ant-\|^GEMINI_API_KEY=AIza" .env; then
        echo -e "${GREEN}✅ Configured with API keys${NC}"
    else
        echo -e "${YELLOW}⚠️  Exists but may not have API keys${NC}"
        echo "   Edit .env and add your provider keys"
        ((warnings++))
    fi
else
    echo -e "${YELLOW}⚠️  Missing${NC}"
    echo "   Creating .env from template..."
    cp .env.sample .env 2>/dev/null || true
    if [ -f .env ]; then
        echo -e "   ${GREEN}✅ Created .env${NC}"
        echo "   Edit .env and add your provider keys"
        ((warnings++))
    else
        ((failed++))
    fi
fi

# 6. Check .pi directory
echo -n "6️⃣  Checking .pi structure... "
missing_dirs=""
for dir in agents skills themes; do
    if [ ! -d ".pi/$dir" ]; then
        missing_dirs="$missing_dirs $dir"
    fi
done

if [ -z "$missing_dirs" ]; then
    echo -e "${GREEN}✅ All directories present${NC}"
else
    echo -e "${RED}❌ Missing:$missing_dirs${NC}"
    ((failed++))
fi

# 7. Check .pi/prompts
echo -n "7️⃣  Checking .pi/prompts... "
if [ -d ".pi/prompts" ]; then
    echo -e "${GREEN}✅ Exists${NC}"
else
    echo -e "${YELLOW}⚠️  Missing${NC}"
    mkdir -p ".pi/prompts"
    echo -e "   ${GREEN}✅ Created${NC}"
fi

# 8. Check settings.json
echo -n "8️⃣  Checking settings.json... "
if [ -f ".pi/settings.json" ]; then
    if python3 -c "import json; json.load(open('.pi/settings.json'))" 2>/dev/null; then
        echo -e "${GREEN}✅ Valid JSON${NC}"
    else
        echo -e "${RED}❌ Invalid JSON${NC}"
        ((failed++))
    fi
else
    echo -e "${RED}❌ Missing${NC}"
    ((failed++))
fi

# 9. Check themes
echo -n "9️⃣  Checking themes... "
theme_count=$(ls .pi/themes/*.json 2>/dev/null | wc -l)
if [ "$theme_count" -gt 0 ]; then
    echo -e "${GREEN}✅ $theme_count themes${NC}"
else
    echo -e "${RED}❌ No themes found${NC}"
    ((failed++))
fi

# 10. Check extensions
echo -n "🔟 Checking extensions... "
ext_count=$(ls extensions/*.ts 2>/dev/null | wc -l)
if [ "$ext_count" -gt 0 ]; then
    echo -e "${GREEN}✅ $ext_count extensions${NC}"
else
    echo -e "${RED}❌ No extensions found${NC}"
    ((failed++))
fi

echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════════${NC}"
echo ""

if [ $failed -eq 0 ] && [ $warnings -eq 0 ]; then
    echo -e "${GREEN}✅ All checks passed! You're ready to go.${NC}"
    echo ""
    echo "Quick start:"
    echo "  source .env && pi                    # Default agent"
    echo "  just ext-minimal                     # Minimal UI"
    echo "  just ext-pi-pi                       # Meta-agent (builds Pi agents)"
    echo ""
    exit 0
elif [ $failed -eq 0 ]; then
    echo -e "${YELLOW}⚠️  $warnings warning(s) — setup is mostly ready${NC}"
    echo ""
    echo "You can still run Pi, but fix these warnings first:"
    echo "  • Add API keys to .env"
    echo "  • Run: bun install"
    echo ""
    exit 0
else
    echo -e "${RED}❌ $failed critical issue(s) prevent Pi from running${NC}"
    echo ""
    echo "Fix these before proceeding:"
    echo "  • Install Bun: https://bun.sh"
    echo "  • Install Just: brew install just"
    echo "  • Install Pi CLI: https://github.com/mariozechner/pi-coding-agent"
    echo "  • Run: bun install"
    echo ""
    exit 1
fi
