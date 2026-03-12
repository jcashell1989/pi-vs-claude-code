import { parse as yamlParse } from "yaml";
import * as fs from "fs";
import * as path from "path";

export interface ProfileConfig {
  op: string;
  agent_models?: Record<string, string>;
  agent_fallbacks?: Record<string, string>;
}

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
  agent_fallbacks: Record<string, string>;
  agent_timeouts: Record<string, number>;
  profiles: Record<string, ProfileConfig> & { default: string };
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
    model: "openrouter/inception/mercury-2",
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
    scout: "openrouter/deepseek/deepseek-v3.2",
    builder: "openrouter/deepseek/deepseek-v3.2",
    reviewer: "openrouter/xiaomi/mimo-v2-flash",
    "red-team": "openrouter/qwen/qwen3-235b-a22b-thinking-2507",
    answer: "openrouter/nvidia/nemotron-3-nano-30b-a3b:free",
  },
  agent_fallbacks: {
    scout: "openrouter/mistralai/mistral-nemo",
    builder: "openrouter/deepseek/deepseek-v3.2",
    reviewer: "openrouter/deepseek/deepseek-chat",
    "red-team": "openrouter/deepseek/deepseek-v3.2",
    answer: "openrouter/mistralai/mistral-nemo",
  },
  agent_timeouts: {
    scout: 300,
    builder: 900,
    reviewer: 600,
    answer: 120,
  },
  profiles: {
    work: {
      op: "op://Personal/murmur openrouter key/credential",
      agent_models: {
        builder: "openrouter/anthropic/claude-sonnet-4.6",
      },
      agent_fallbacks: {
        builder: "openrouter/deepseek/deepseek-v3.2",
      },
    },
    personal: {
      op: "op://Personal/murmur openrouter key/credential",
    },
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
 * Resolve effective agent_models for a given profile by merging
 * profile-specific overrides on top of shared defaults.
 */
export function resolveProfileModels(config: ShellConfig, profile: string): Record<string, string> {
  const profileConfig = (config.profiles as Record<string, any>)[profile];
  if (!profileConfig || typeof profileConfig === "string") {
    return { ...config.agent_models };
  }
  return { ...config.agent_models, ...(profileConfig.agent_models || {}) };
}

/**
 * Resolve effective agent_fallbacks for a given profile.
 */
export function resolveProfileFallbacks(config: ShellConfig, profile: string): Record<string, string> {
  const profileConfig = (config.profiles as Record<string, any>)[profile];
  if (!profileConfig || typeof profileConfig === "string") {
    return { ...config.agent_fallbacks };
  }
  return { ...config.agent_fallbacks, ...(profileConfig.agent_fallbacks || {}) };
}

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
