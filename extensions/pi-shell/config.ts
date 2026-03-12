import { parse as yamlParse } from "yaml";
import * as fs from "fs";
import * as path from "path";

export interface ShellConfig {
  orchestrator: {
    model: string;
    max_dispatch_result_tokens: number;
    compaction_summary: boolean;
  };
  fan_out: {
    cost_ceiling: number;
    max_agents: number;
  };
  context_injection: {
    enabled: boolean;
    max_matches: number;
  };
  agent_models: Record<string, string>;
  agent_timeouts: Record<string, number>;
  api_keys: Record<string, { env: string }> & { default: string };
  interactive_commands: string[];
  git: {
    auto_branch: boolean;
    auto_pr: boolean;
    branch_prefix: string;
    require_gh: boolean;
  };
}

const DEFAULT_CONFIG: ShellConfig = {
  orchestrator: {
    model: "openrouter/minimax/minimax-m2.5",
    max_dispatch_result_tokens: 8000,
    compaction_summary: true,
  },
  fan_out: {
    cost_ceiling: 0.50,
    max_agents: 5,
  },
  context_injection: {
    enabled: true,
    max_matches: 3,
  },
  agent_models: {
    scout: "openrouter/google/gemini-2.5-flash",
    planner: "openrouter/google/gemini-2.5-flash",
    builder: "openrouter/anthropic/claude-sonnet-4",
    reviewer: "openrouter/anthropic/claude-sonnet-4",
    "red-team": "openrouter/anthropic/claude-sonnet-4",
    answer: "openrouter/google/gemini-2.5-flash",
  },
  agent_timeouts: {
    scout: 300,
    planner: 300,
    builder: 900,
    reviewer: 600,
    answer: 120,
  },
  api_keys: {
    work: { env: "OPENROUTER_WORK_KEY" },
    personal: { env: "OPENROUTER_PERSONAL_KEY" },
    default: "work",
  },
  interactive_commands: [
    "vim", "nvim", "nano", "htop", "top",
    "less", "more", "ssh", "python", "node", "irb",
  ],
  git: {
    auto_branch: true,
    auto_pr: true,
    branch_prefix: "task/",
    require_gh: false,
  },
};

/**
 * Deep merge source into target, returning a new object.
 * Arrays are replaced, not merged. Only plain objects are recursed.
 */
function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target } as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    const srcVal = (source as Record<string, unknown>)[key];
    const tgtVal = result[key];
    if (
      srcVal !== null &&
      srcVal !== undefined &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      typeof tgtVal === "object" &&
      tgtVal !== null &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else if (srcVal !== undefined) {
      result[key] = srcVal;
    }
  }
  return result as T;
}

/**
 * Load shell config from `.pi/shell-config.yaml` relative to the given
 * working directory. Falls back to built-in defaults for any missing fields.
 */
export function loadConfig(cwd?: string): ShellConfig {
  const base = cwd ?? process.cwd();
  const configPath = path.join(base, ".pi", "shell-config.yaml");

  if (!fs.existsSync(configPath)) {
    return structuredClone(DEFAULT_CONFIG);
  }

  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = yamlParse(raw) as Partial<ShellConfig> | null;

    if (!parsed || typeof parsed !== "object") {
      return structuredClone(DEFAULT_CONFIG);
    }

    return deepMerge(DEFAULT_CONFIG, parsed);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}
