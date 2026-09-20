// ============================================================
// KAMNAA — Multi-Provider LLM Bridge
// Supports: Ollama (local), Claude, OpenAI/Codex, OpenRouter
// Direct API calls from background service worker.
// No proxy server required for cloud providers.
//
// API keys are encrypted with the device AES-GCM key (see
// core/memory/encrypted-store) and held in chrome.storage.LOCAL.
// Not storage.sync: that replicates through the user's Google account,
// which is the opposite of what an on-device privacy tool should do
// with a bearer credential.
// ============================================================

import { guardedFetch } from "../privacy/egress-guard";
import { encryptValue, decryptValue } from "../memory/encrypted-store";
import { maskPIIInText } from "../privacy/pii-detector";
import type { SanitizedContext, PlanResult } from "./server-bridge";
import type { PlannedAction } from "../../types";

// ── Provider Configuration Types ────────────────────────────

export type ProviderID = "ollama" | "claude" | "openai" | "openrouter";

export interface ProviderConfig {
  id: ProviderID;
  name: string;
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  defaultModel?: string;
  defaultBaseUrl?: string;
  requiresApiKey?: boolean;
  availableModels?: string[];
  maxTokens?: number;
  temperature?: number;
}

export interface ProviderStatus {
  id: ProviderID;
  name: string;
  available: boolean;
  model: string | null;
  latencyMs: number;
  error?: string;
}

// ── Default Configs ─────────────────────────────────────────

const DEFAULT_CONFIGS: Record<ProviderID, ProviderConfig> = {
  ollama: {
    id: "ollama",
    name: "Ollama (Local)",
    enabled: true,
    baseUrl: "http://localhost:11434",
    defaultBaseUrl: "http://localhost:11434",
    model: "qwen2.5:3b",
    defaultModel: "qwen2.5:3b",
    availableModels: [
      "qwen2.5:3b",
      "qwen2.5:1.5b",
      "qwen2.5:7b",
      "llama3.2:1b",
      "llama3.2:3b",
      "llama3.1:8b",
      "mistral:7b",
      "phi3.5:3.8b",
      "gemma2:2b",
      "gemma2:9b",
    ],
    temperature: 0.3,
    maxTokens: 2048,
  },
  claude: {
    id: "claude",
    name: "Claude (Anthropic)",
    enabled: false,
    baseUrl: "https://api.anthropic.com",
    model: "claude-3-5-haiku-20241022",
    temperature: 0.3,
    maxTokens: 2048,
  },
  openai: {
    id: "openai",
    name: "OpenAI (GPT)",
    enabled: false,
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    temperature: 0.3,
    maxTokens: 2048,
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    // Enabled automatically when WXT_OPENROUTER_API_KEY is present at
    // build time; otherwise the user turns it on in Provider Settings.
    enabled: false,
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    temperature: 0.3,
    maxTokens: 2048,
  },
};

// ── Build-Time Env Keys ─────────────────────────────────────
//
// WXT inlines `WXT_*` variables from .env at BUILD time. There is no
// runtime env in an MV3 extension, so whatever is set here is compiled
// into background.js as a literal string and is readable by anyone who
// loads the unpacked extension or unzips the build.
//
// That is fine for local development and a demo machine. It is NOT a
// place for a key you care about — for anything shared or published,
// enter the key in Provider Settings instead, which stores it encrypted
// with the device key and never writes it into the bundle.
//
// The env value is only a FALLBACK: a key saved through the UI always
// wins, so a developer's .env cannot silently override a real user's key.

/** Reads a build-time env var without exploding where import.meta.env is absent. */
function buildTimeEnv(name: string): string | undefined {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const value = env?.[name];
    return value && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Per-provider build-time key fallbacks. */
const ENV_KEY_VARS: Partial<Record<ProviderID, string>> = {
  openrouter: "WXT_OPENROUTER_API_KEY",
  claude: "WXT_ANTHROPIC_API_KEY",
  openai: "WXT_OPENAI_API_KEY",
};

/**
 * Apply build-time keys to any provider that has no stored key.
 * A provider that gains a key this way is enabled, so a fresh install
 * with a populated .env works without visiting the settings tab.
 */
function applyEnvKeyFallbacks(
  configs: Record<ProviderID, ProviderConfig>
): Record<ProviderID, ProviderConfig> {
  for (const id of Object.keys(ENV_KEY_VARS) as ProviderID[]) {
    if (configs[id]?.apiKey) continue; // Stored key wins.
    const envKey = buildTimeEnv(ENV_KEY_VARS[id]!);
    if (!envKey) continue;
    configs[id] = { ...configs[id], apiKey: envKey, enabled: true };
  }
  return configs;
}

// ── Config Storage ──────────────────────────────────────────

const STORAGE_KEY = "kamnaa_provider_configs";
/** Legacy plaintext location, migrated and cleared on first load. */
const LEGACY_SYNC_KEY = "kamnaa_provider_configs";

/** On-disk shape: the key is a ciphertext blob, never the raw secret. */
type StoredProviderConfig = Omit<Partial<ProviderConfig>, "apiKey"> & {
  apiKeyCipher?: string;
};

export async function loadProviderConfigs(): Promise<
  Record<ProviderID, ProviderConfig>
> {
  const result: Record<ProviderID, ProviderConfig> = {} as any;
  for (const id of Object.keys(DEFAULT_CONFIGS) as ProviderID[]) {
    result[id] = { ...DEFAULT_CONFIGS[id] };
  }

  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    let saved = stored[STORAGE_KEY] as Record<ProviderID, StoredProviderConfig> | undefined;

    if (!saved) {
      saved = (await migrateFromLegacySync()) ?? undefined;
    }
    if (!saved) return applyEnvKeyFallbacks(result);

    for (const id of Object.keys(DEFAULT_CONFIGS) as ProviderID[]) {
      const entry = saved[id];
      if (!entry) continue;
      const { apiKeyCipher, ...rest } = entry;
      result[id] = { ...result[id], ...rest };

      // FIX 8: Ensure Ollama defaults to enabled unless explicitly set to false
      if (id === "ollama") {
        if (entry.enabled === undefined || entry.enabled === null) {
          result[id].enabled = true;
        }
        if (!entry.model) {
          result[id].model = DEFAULT_CONFIGS.ollama.model;
        }
      }

      if (apiKeyCipher) {
        try {
          result[id].apiKey = await decryptValue<string>(apiKeyCipher);
        } catch {
          // Key material is unreadable (device key rotated or storage
          // tampered with). Drop it rather than sending a garbage bearer
          // token to a provider.
          console.warn(`[KAMNAA] Could not decrypt stored API key for ${id} — cleared.`);
          delete result[id].apiKey;
        }
      }
    }
    return applyEnvKeyFallbacks(result);
  } catch {
    return applyEnvKeyFallbacks(result);
  }
}

/**
 * One-time move of plaintext keys out of chrome.storage.sync.
 * Returns the migrated record, or null if there was nothing to migrate.
 */
async function migrateFromLegacySync(): Promise<Record<ProviderID, StoredProviderConfig> | null> {
  try {
    const legacy = await chrome.storage.sync.get(LEGACY_SYNC_KEY);
    const configs = legacy[LEGACY_SYNC_KEY] as Record<ProviderID, ProviderConfig> | undefined;
    if (!configs) return null;

    console.warn("[KAMNAA] Migrating provider config out of storage.sync into encrypted local storage.");
    const merged: Record<ProviderID, ProviderConfig> = {} as any;
    for (const id of Object.keys(DEFAULT_CONFIGS) as ProviderID[]) {
      merged[id] = { ...DEFAULT_CONFIGS[id], ...(configs[id] || {}) };
    }
    await saveProviderConfigs(merged);
    // Remove the plaintext copy so it stops replicating to Google.
    await chrome.storage.sync.remove(LEGACY_SYNC_KEY);

    const reread = await chrome.storage.local.get(STORAGE_KEY);
    return (reread[STORAGE_KEY] as Record<ProviderID, StoredProviderConfig>) || null;
  } catch {
    return null;
  }
}

export async function saveProviderConfigs(
  configs: Record<ProviderID, ProviderConfig>
): Promise<void> {
  const toStore: Record<string, StoredProviderConfig> = {};
  for (const id of Object.keys(configs) as ProviderID[]) {
    const { apiKey, ...rest } = configs[id];
    const entry: StoredProviderConfig = { ...rest };
    if (apiKey) {
      entry.apiKeyCipher = await encryptValue(apiKey);
    }
    toStore[id] = entry;
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: toStore });
}

export async function saveProviderConfig(
  id: ProviderID,
  config: Partial<ProviderConfig>
): Promise<void> {
  const all = await loadProviderConfigs();
  all[id] = { ...all[id], ...config };
  await saveProviderConfigs(all);
}

// ── LLM Prompt ─────────────────────────────────────────────

function buildPlanningPrompt(
  taskDescription: string,
  context: SanitizedContext,
  dataContext?: Record<string, string>,
  recentTasks?: string[]
): { system: string; user: string } {
  const ps = context.pageStructure;

  // The task description is typed by the user and has never been through the
  // sanitizer. Someone typing "fill aadhaar 2341 2341 2346" would otherwise
  // send that straight to the provider, past every other protection.
  const safeTask = maskPIIInText(taskDescription);
  const history = (recentTasks ?? [])
    .slice(-3)
    .map((t) => `- ${maskPIIInText(t)}`)
    .join("\n");

  // Principled element budget: score by relevance to task, then restore DOM index order
  const taskLower = safeTask.toLowerCase();
  const scoredElements = ps.elements.map((e, index) => {
    let score = 0;
    const text = (e.label || "").toLowerCase();
    
    // Exact or strong partial matches
    if (text && text.length > 2) {
      if (taskLower.includes(text)) score += 100;
      else if (text.includes(taskLower)) score += 50;
      else if (taskLower.split(/\s+/).some(w => w.length > 3 && text.includes(w))) score += 20;
    }
    
    // Visibility priority
    const visState = (e as any).visibilityState || (e.isVisible ? "visible" : "hidden");
    if (visState === "visible") score += 5;
    else if (visState === "offscreen") score += 2;
    
    return { e, index, score, visState };
  });

  const topElements = scoredElements
    .sort((a, b) => b.score - a.score)
    .slice(0, 60)
    .sort((a, b) => a.index - b.index);

  const elements = topElements
    .map(({ e, index, visState }) => {
      return `[${index}] <${e.tag}> role="${e.role}" label="${e.label}" type="${e.type}" visibility="${visState}" ${
        e.isDisabled ? "DISABLED" : ""
      }`;
    })
    .join("\n");

  const forms = ps.forms
    .map((f) => {
      const fields = f.fields
        .map((ff) => {
          const val = ff.hasValue ? "FILLED" : "EMPTY";
          const req = ff.isRequired ? "REQUIRED" : "";
          const pii = ff.piiCategory ? `[PII:${ff.piiCategory}]` : "";
          return `  - ${ff.label}: ${ff.type} ${val} ${req} ${pii}`;
        })
        .join("\n");
      return `Form ${f.id}:\n${fields}`;
    })
    .join("\n\n");

  // PRIVACY: Never send dataContext values to the LLM.
  // The LLM only sees that PII fields exist (marked [PII:category]).
  // Actual values are filled locally by the client after the plan is returned.
  const piiFieldCount = dataContext ? Object.keys(dataContext).length : 0;
  const dataStr = piiFieldCount > 0
    ? `\nNote: ${piiFieldCount} fields require user data (filled client-side, not in prompt).\nFields marked [PII:category] have values available locally — use their index for type actions.`
    : "";

  const system = `You are KAMNAA, a browser automation agent. You analyze web pages and produce action plans.

## Your Task
Analyze the page state and produce a sequence of browser actions to accomplish the user's goal.

## Output Format
Respond with ONLY valid JSON. No markdown, no code fences, no explanation outside the JSON.

{"reasoning":"<step-by-step thought process>","steps":[{"action":{"type":"<action_type>","target":"[<index>]","targetDescription":"<semantic description of the element>","value":"<optional>"},"reasoning":"<why this step>","confidence":<0.0-1.0>,"risk":"<low|medium|high>"}]}

## Action Types
- **click**: Click an element. target="[0]" (element index)
- **type**: Type text into a field. target="[1]", value="text"
- **select**: Select dropdown option. target="[2]", value="option text"
- **scroll**: Scroll the page. value="up" or "down"
- **wait**: Wait for page to load. value="<ms>"
- **press_key**: Press keyboard key. value="Enter" or "Tab"
- **navigate**: Go to URL. value="https://..."

## Rules
- one user-intended action = one plan step
- do not add exploratory actions
- do not duplicate actions
- do not type into buttons
- do not invent actions
- do not output explanations as actions
- do not output more actions than necessary
- Use [0], [1], [2] etc. as targets — these are element indices from the page state
- For form filling: click the field first to focus it, then type the value
- Fields marked [PII:category] are sensitive — the client fills these locally, reference by index only
- Max 20 steps. Be efficient.
- Mark destructive actions (submit, delete, navigate away) as risk high
- Think step by step: what needs to happen first? What depends on what?

## Few-Shot Examples

Example 1 — Fill a login form:
{"reasoning":"I see a login form with email [0] and password [1] fields, and a submit button [2]. First click email, type value, then click password, type value, then click submit.","steps":[{"action":{"type":"click","target":"[0]","targetDescription":"Email input field"},"reasoning":"Focus email field","confidence":0.95,"risk":"low"},{"action":{"type":"type","target":"[0]","targetDescription":"Email input field","value":"user@example.com"},"reasoning":"Type email address","confidence":0.95,"risk":"low"},{"action":{"type":"click","target":"[1]","targetDescription":"Password input field"},"reasoning":"Focus password field","confidence":0.95,"risk":"low"},{"action":{"type":"type","target":"[1]","targetDescription":"Password input field","value":"password123"},"reasoning":"Type password","confidence":0.95,"risk":"low"},{"action":{"type":"click","target":"[2]","targetDescription":"Submit login button"},"reasoning":"Click submit button","confidence":0.9,"risk":"high"}]}

Example 2 — Search on YouTube:
{"reasoning":"I see a search box [3] and the page is YouTube. I need to click the search box, type the query, and press Enter.","steps":[{"action":{"type":"click","target":"[3]","targetDescription":"YouTube search box"},"reasoning":"Focus search box","confidence":0.95,"risk":"low"},{"action":{"type":"type","target":"[3]","targetDescription":"YouTube search box","value":"harkirat singh"},"reasoning":"Type search query","confidence":0.95,"risk":"low"},{"action":{"type":"press_key","value":"Enter"},"reasoning":"Submit search","confidence":0.95,"risk":"low"}]}

Example 3 — Scroll and read:
{"reasoning":"User wants to see more content. I'll scroll down to reveal additional information.","steps":[{"action":{"type":"scroll","value":"down"},"reasoning":"Scroll down to see more content","confidence":0.95,"risk":"low"}]}`;

  const user = `TASK: "${safeTask}"
${history ? `\nRECENT TASKS IN THIS SESSION (most recent last):\n${history}\nTreat the current task as a follow-up to these. "submit" after a fill means press the submit button, NOT re-enter the fields.\n` : ""}
PAGE STATE:
Domain: ${ps.metadata.domain}
Title: ${ps.metadata.title}
Total elements: ${ps.metadata.elementCount}

ELEMENTS:
${elements}

${forms ? `FORMS:\n${forms}` : "No forms detected."}
${dataStr}

${ps.metadata.hasCAPTCHA ? "WARNING: CAPTCHA detected — may need user intervention." : ""}
${ps.metadata.hasPaymentForm ? "WARNING: Payment form — handle with extreme caution." : ""}

Privacy: ${context.redactionProof.totalPIIDetected} PII regions detected and redacted.
Sensitive fields are marked [PII:category] — the client has these values locally.

Generate the action plan as JSON.`;

  return { system, user };
}

// ── Response Parsing ────────────────────────────────────────

/** Robustly extract and parse a JSON object or array from raw LLM text. */
function extractJsonObject(str: string): any | null {
  if (!str) return null;

  // Clean up common LLM JSON syntax errors (trailing commas)
  const cleanStr = str.replace(/,\s*([\}\]])/g, "$1");

  // 1. Try markdown code block with { or [
  // This matches anything inside ```json ... ``` or ``` ... ```
  const fenceMatches = [...cleanStr.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
  for (const match of fenceMatches) {
    const content = match[1].trim();
    if (content.startsWith("{") || content.startsWith("[")) {
      try { return JSON.parse(content); } catch {}
    }
  }

  // 2. Track balanced curly braces or brackets for EVERY possible start index
  for (let startIdx = 0; startIdx < cleanStr.length; startIdx++) {
    const char = cleanStr[startIdx];
    if (char === "{" || char === "[") {
      const isArray = char === "[";
      const openChar = isArray ? "[" : "{";
      const closeChar = isArray ? "]" : "}";
      let depth = 0;
      let inString = false;
      let escape = false;

      for (let i = startIdx; i < cleanStr.length; i++) {
        const c = cleanStr[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (c === "\\") {
          escape = true;
          continue;
        }
        if (c === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (c === openChar) depth++;
          else if (c === closeChar) {
            depth--;
            if (depth === 0) {
              const candidate = cleanStr.substring(startIdx, i + 1);
              try { return JSON.parse(candidate); } catch {}
            }
          }
        }
      }
    }
  }

  // 3. Fallback to direct parse
  try { return JSON.parse(cleanStr.trim()); } catch {}
  return null;
}

function parsePlanResponse(response: string): {
  steps: PlannedAction[];
  reasoning: string;
} {
  const parsed = extractJsonObject(response);
  console.log(`[KAMNAA DEBUG] planner-parse\njsonFound=${!!parsed}\njsonType=${parsed ? (Array.isArray(parsed) ? 'array' : 'object') : 'none'}`);
  
  if (!parsed) {
    console.warn("[KAMNAA] Could not parse JSON from LLM response:", response.slice(0, 300));
    console.log(`[KAMNAA DEBUG] planner-validation\nsuccess=false\nsteps=0\nreason=json_parse_failed`);
    return { steps: [], reasoning: "Failed to parse JSON from LLM response" };
  }

  try {
    const rawSteps = Array.isArray(parsed)
      ? parsed
      : (parsed.steps || parsed.actions || (parsed.action || parsed.type ? [parsed] : []));
    const steps: PlannedAction[] = rawSteps.map(
      (step: Record<string, unknown>, i: number) => {
        const actionObj = (typeof step.action === "object" && step.action !== null
          ? step.action
          : step) as Record<string, unknown>;
        let target = (actionObj.target || actionObj.element || step.element || step.target || "") as string | Record<string, unknown>;
        if (typeof target === "object" && target !== null) {
          target = ((target as any).label || (target as any).id || (target as any).name || (target as any).selector || (target as any).text || "") as string;
        }
        let targetDescription = (actionObj.targetDescription || step.targetDescription || actionObj.description || step.description) as string | undefined;
        const bracketMatch = typeof target === "string" ? target.match(/\[(\d+)\]/) : null;
        if (bracketMatch) {
          target = "[" + bracketMatch[1] + "]";
        }
        let actionType = (typeof actionObj.type === "string"
          ? actionObj.type
          : typeof step.action === "string"
          ? step.action
          : "click") as string;
        if (actionType === "fill" || actionType === "input") actionType = "type";

        // TEST 5: Fallback safety if targetDescription is missing
        if (!targetDescription && actionType === "click" && target && target.startsWith("[")) {
          // It's unsafe to blindly click a numeric index without semantic intent.
          // Try to recover intent from reasoning, else use a placeholder that will force semantic mismatch if expecting a critical button
          targetDescription = step.reasoning ? `Element for: ${step.reasoning}` : "Unknown element";
        }

        return {
          index: i,
          action: {
            id: `llm-action-${i}`,
            type: actionType,
            target: typeof target === "string" ? target : "",
            targetDescription,
            value: (actionObj.value || step.value) as string | undefined,
            retries: 0,
            maxRetries: 3,
          },
          reasoning: (step.reasoning as string) || (parsed.reasoning as string) || "LLM-planned step",
          confidence: (step.confidence as number) || 0.8,
          verification: "Check page state after action",
        };
      }
    );
    console.log(`[KAMNAA DEBUG] planner-validation\nsuccess=true\nsteps=${steps.length}\nreason=parsed_successfully`);
    return {
      steps,
      reasoning: parsed.reasoning || `Generated ${steps.length} steps`,
    };
  } catch (err: any) {
    console.log(`[KAMNAA DEBUG] planner-validation\nsuccess=false\nsteps=0\nreason=exception_during_mapping`);
    return { steps: [], reasoning: "Failed to process LLM action steps" };
  }
}

// ── Individual Providers ────────────────────────────────────

async function callOllama(
  config: ProviderConfig,
  system: string,
  user: string
): Promise<string> {
  const baseUrl = config.baseUrl || "http://localhost:11434";
  const modelName = config.model || "qwen2.5:3b";
  console.log(`[KAMNAA DEBUG] ollama-request\nmodel=${modelName}\nurl=${baseUrl}/api/chat`);
  console.log(`[KAMNAA][OLLAMA] call start model=${modelName} baseUrl=${baseUrl}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  const bodyObj = {
    model: modelName,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: false,
    options: {
      temperature: config.temperature ?? 0.3,
      num_predict: config.maxTokens ?? 2048,
      top_p: 0.9,
    },
  };
  const bodyStr = JSON.stringify(bodyObj);
  console.log(`[KAMNAA][OLLAMA] request prepared bodyLength=${bodyStr.length}`);

  let response: Response;
  const reqStart = performance.now();
  try {
    console.log(`[KAMNAA][OLLAMA] guardedFetch start`);
    response = await guardedFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyStr,
      signal: controller.signal,
    });
    const elapsedMs = performance.now() - reqStart;
    console.log(`[KAMNAA DEBUG] ollama-response\nstatus=${response.status}\nok=${response.ok}\ncontentType=${response.headers.get("content-type") || "none"}\nelapsedMs=${elapsedMs.toFixed(0)}`);
    console.log(`[KAMNAA][OLLAMA] guardedFetch complete status=${response.status}`);
  } catch (err: any) {
    if (err?.name === "EgressBlockedError" || err?.message?.includes("egress guard")) {
      const categories = err?.categories ? err.categories.join(", ") : "sensitive data";
      console.error(`[KAMNAA][OLLAMA] ERROR phase=guardedFetch blocked by egress guard: ${categories}`);
      throw new Error(`EgressBlocked: Outbound payload contained ${categories}`);
    }
    const netErr = err instanceof Error ? err.message : String(err);
    console.log(`[KAMNAA DEBUG] ollama-error\nname=${err?.name || "Error"}\nmessage=${netErr}`);
    console.error(`[KAMNAA][OLLAMA] ERROR phase=guardedFetch message=${netErr}`);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    console.error(`[KAMNAA][OLLAMA] ERROR phase=response status=${response.status}`);
    throw new Error(`Ollama HTTP ${response.status}`);
  }
  const data = await response.json();
  const content = data.message?.content || "";
  console.log(`[KAMNAA DEBUG] ollama-body\nlength=${content.length}`);
  console.log(`[KAMNAA][OLLAMA] response received contentLength=${content.length}`);
  return content;
}

async function callClaude(
  config: ProviderConfig,
  system: string,
  user: string
): Promise<string> {
  if (!config.apiKey) throw new Error("Claude API key not configured");
  const baseUrl = config.baseUrl || "https://api.anthropic.com";

  const response = await guardedFetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: config.model || "claude-3-5-haiku-20241022",
      max_tokens: config.maxTokens || 2048,
      temperature: config.temperature ?? 0.3,
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.content?.[0]?.text || "";
}

async function callOpenAI(
  config: ProviderConfig,
  system: string,
  user: string
): Promise<string> {
  if (!config.apiKey) throw new Error("OpenAI API key not configured");
  const baseUrl = config.baseUrl || "https://api.openai.com/v1";

  const response = await guardedFetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || "gpt-4o-mini",
      max_tokens: config.maxTokens || 2048,
      temperature: config.temperature ?? 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

async function callOpenRouter(
  config: ProviderConfig,
  system: string,
  user: string
): Promise<string> {
  if (!config.apiKey) throw new Error("OpenRouter API key not configured");
  const baseUrl = config.baseUrl || "https://openrouter.ai/api/v1";

  const response = await guardedFetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "HTTP-Referer": "https://github.com/kkunac/kamnaa",
      "X-Title": "KAMNAA Browser Agent",
    },
    body: JSON.stringify({
      model: config.model || "openai/gpt-4o-mini",
      max_tokens: config.maxTokens || 2048,
      temperature: config.temperature ?? 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

// ── Provider Call Router ────────────────────────────────────

const CALLERS: Record<
  ProviderID,
  (config: ProviderConfig, system: string, user: string) => Promise<string>
> = {
  ollama: callOllama,
  claude: callClaude,
  openai: callOpenAI,
  openrouter: callOpenRouter,
};

// ── Main API ────────────────────────────────────────────────

/**
 * Check which providers are available.
 */
export async function checkProviders(): Promise<ProviderStatus[]> {
  const configs = await loadProviderConfigs();
  const statuses: ProviderStatus[] = [];

  for (const [id, config] of Object.entries(configs) as [
    ProviderID,
    ProviderConfig,
  ][]) {
    if (!config.enabled) {
      statuses.push({
        id,
        name: config.name,
        available: false,
        model: null,
        latencyMs: 0,
        error: "Disabled",
      });
      continue;
    }

    const t0 = performance.now();
    try {
      if (id === "ollama") {
        // Ollama: check if server is running and model exists
        let probeOk = false;
        let detectedModel: string | null = null;
        let probeError: string | undefined;

        try {
          const resp = await fetch(`${config.baseUrl}/api/tags`, {
            signal: AbortSignal.timeout(10000),
          });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.json();
          const models = (data.models || []).map((m: { name: string }) => m.name);
          const wanted = (config.model || "qwen").toLowerCase();

          // 1. Exact or prefix match (e.g., "qwen2.5:1.5b" matches "qwen2.5:1.5b")
          let model = models.find((n: string) => n.toLowerCase() === wanted || n.toLowerCase().startsWith(wanted));
          // 2. Substring match
          if (!model) {
            model = models.find((n: string) => n.toLowerCase().includes(wanted));
          }
          // 3. Family match (e.g., "qwen", "llama", "mistral", "gemma", "phi")
          if (!model) {
            const family = wanted.split(":")[0].split("-")[0];
            model = models.find((n: string) => n.toLowerCase().includes(family));
          }
          // 4. Any Qwen variant match
          if (!model && wanted.includes("qwen")) {
            model = models.find((n: string) => n.toLowerCase().includes("qwen"));
          }
          // 5. Fallback: if Ollama is running and has ANY model installed, use the first available model!
          if (!model && models.length > 0) {
            model = models[0];
          }

          if (model) {
            probeOk = true;
            detectedModel = model;
          } else {
            probeError = `Model "${config.model}" not found in [${models.join(", ")}]. Run: ollama pull ${config.model}`;
          }
        } catch (probeErr: any) {
          probeError = probeErr instanceof Error ? probeErr.message : "Not running or unreachable";
        }

        console.log(
          `[KAMNAA] Ollama probe:\navailable=${probeOk}\nmodel=${detectedModel || "none"}\nerror=${probeError || "none"}`
        );

        if (probeOk && detectedModel) {
          statuses.push({
            id,
            name: config.name,
            available: true,
            model: detectedModel,
            latencyMs: performance.now() - t0,
          });
        } else {
          statuses.push({
            id,
            name: config.name,
            available: false,
            model: null,
            latencyMs: performance.now() - t0,
            error: probeError || "Probe failed",
          });
        }
      } else {
        // Cloud providers: check if API key is set
        if (!config.apiKey) {
          statuses.push({
            id,
            name: config.name,
            available: false,
            model: null,
            latencyMs: 0,
            error: "API key not configured",
          });
        } else {
          // Try a minimal request to validate the key
          statuses.push({
            id,
            name: config.name,
            available: true,
            model: config.model || null,
            latencyMs: 0,
          });
        }
      }
    } catch (err) {
      const errStr = err instanceof Error ? err.message : "Check failed";
      if (id === "ollama") {
        console.warn(
          `[KAMNAA] Ollama probe:\navailable=false\nmodel=none\nerror=${errStr}`
        );
      }
      statuses.push({
        id,
        name: config.name,
        available: false,
        model: null,
        latencyMs: performance.now() - t0,
        error: errStr,
      });
    }
  }

  return statuses;
}

/**
 * Provider order for planning.
 *
 * Default is local-first: Ollama runs on-device, so with no cloud key
 * configured nothing ever leaves the machine (unchanged behaviour). But the
 * moment the user adds a cloud key — which auto-enables that provider — they
 * have explicitly opted into egress, and a hosted model is both far faster and
 * far smarter than a small local one. So a configured, reachable cloud
 * provider takes precedence and Ollama drops to being the offline fallback.
 *
 * This fixes the latency trap where a running-but-slow Ollama (30s timeout)
 * was always tried first even when a cloud key was present.
 */
function planningPriority(
  configs: Record<ProviderID, ProviderConfig>,
  statuses: ProviderStatus[]
): ProviderID[] {
  const cloud: ProviderID[] = ["claude", "openai", "openrouter"];
  const ready = (id: ProviderID) =>
    !!statuses.find((s) => s.id === id)?.available && !!configs[id]?.enabled;

  const readyCloud = cloud.filter(ready);
  if (readyCloud.length === 0) {
    // No cloud provider configured — stay fully local, Ollama first.
    return ["ollama", "claude", "openai", "openrouter"];
  }
  // Cloud opted-in: preferred cloud first (Claude leads), Ollama as fallback.
  return [...readyCloud, "ollama", ...cloud.filter((c) => !readyCloud.includes(c))];
}

/**
 * Generate a plan using the best available provider.
 * Order is decided by planningPriority(): cloud-first once a key is set,
 * otherwise local-first (Ollama).
 */
export async function generatePlanWithBestProvider(
  taskDescription: string,
  sanitizedContext: SanitizedContext,
  dataContext?: Record<string, string>,
  recentTasks?: string[]
): Promise<PlanResult> {
  console.log(`[KAMNAA DEBUG] planner-start\nprovider=best-available`);
  console.log(`[KAMNAA][PLANNER] generatePlanWithBestProvider start`);
  const configs = await loadProviderConfigs();
  const statuses = await checkProviders();

  // Log all provider statuses for debugging
  for (const s of statuses) {
    console.log(`[KAMNAA][PLANNER] provider status: id=${s.id} available=${s.available} model=${s.model || "none"} error=${s.error || "none"}`);
  }

  // Read explicitly chosen active provider from local storage
  let activeId: ProviderID = "ollama";
  try {
    const stored = await chrome.storage.local.get("kamnaa_active_provider");
    if (stored.kamnaa_active_provider && configs[stored.kamnaa_active_provider as ProviderID]) {
      activeId = stored.kamnaa_active_provider as ProviderID;
    }
  } catch {
    // fallback
  }
  console.log(`[KAMNAA][PLANNER] activeProvider=${activeId}`);

  const defaultPriority = planningPriority(configs, statuses);
  // Put active provider at the front of priority list
  const priority: ProviderID[] = [
    activeId,
    ...defaultPriority.filter((id) => id !== activeId),
  ];
  console.log(`[KAMNAA][PLANNER] priority=[${priority.join(", ")}]`);

  for (const id of priority) {
    const status = statuses.find((s) => s.id === id);
    const config = configs[id];

    if (!config?.enabled) {
      console.log(`[KAMNAA][PLANNER] ${id}: SKIP (disabled in config)`);
      continue;
    }
    if (!status?.available) {
      console.warn(`[KAMNAA][PLANNER] ${id}: SKIP (unavailable: ${status?.error || "probe failed"})`);
      continue;
    }

    // Resolve the effective model: prefer detected Ollama model (e.g. qwen2.5:3b)
    // over stale/missing configuration
    const effectiveModel =
      id === "ollama" && status.model
        ? status.model
        : config.model || status.model || (id === "ollama" ? "qwen2.5:3b" : config.model);

    const effectiveConfig: ProviderConfig = {
      ...config,
      model: effectiveModel,
    };

    console.log(`[KAMNAA][PLANNER] ${id}: ATTEMPTING model=${effectiveConfig.model}`);
    const startTime = performance.now();
    try {
      const { system, user } = buildPlanningPrompt(
        taskDescription,
        sanitizedContext,
        dataContext,
        recentTasks
      );
      console.log(`[KAMNAA][PLANNER] ${id}: prompt built, calling CALLERS[${id}]...`);
      const response = await CALLERS[id](effectiveConfig, system, user);
      console.log(`[KAMNAA][PLANNER] ${id}: raw response length=${response.length}`);

      const parsed = parsePlanResponse(response);
      console.log(`[KAMNAA][PLANNER] ${id}: parsed steps=${parsed.steps.length} reasoning="${(parsed.reasoning || "").slice(0, 80)}"`);

      if (!parsed.steps || parsed.steps.length === 0) {
        console.warn(
          `[KAMNAA][PLANNER] ${id}: 0 steps parsed — continuing to next provider`
        );
        continue;
      }

      const elapsed = (performance.now() - startTime).toFixed(0);
      console.log(`[KAMNAA DEBUG] planner-final\nprovider=${id}\nsuccess=true\nsteps=${parsed.steps.length}`);
      console.log(`[KAMNAA][PLANNER] SUCCESS provider=${id} steps=${parsed.steps.length} elapsed=${elapsed}ms`);

      return {
        success: true,
        steps: parsed.steps,
        reasoning: parsed.reasoning,
        provider: id,
        latencyMs: performance.now() - startTime,
      };
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[KAMNAA][PLANNER] ${id}: FAILED error="${errMsg}"`);
      // Continue to next provider
    }
  }

  return {
    success: false,
    steps: [],
    reasoning: "No provider available",
    provider: "none",
    latencyMs: 0,
    error: "No LLM provider available. Configure one in Settings.",
  };
}

/**
 * Get the first available provider for quick checks.
 */
export async function getBestAvailableProvider(): Promise<{
  id: ProviderID;
  config: ProviderConfig;
} | null> {
  const configs = await loadProviderConfigs();
  const statuses = await checkProviders();
  const priority = planningPriority(configs, statuses);

  for (const id of priority) {
    const status = statuses.find((s) => s.id === id);
    if (status?.available) {
      const effectiveModel =
        id === "ollama" && status.model
          ? status.model
          : configs[id].model || status.model || (id === "ollama" ? "qwen2.5:3b" : configs[id].model);

      return { id, config: { ...configs[id], model: effectiveModel } };
    }
  }
  return null;
}

/**
 * Explain a page using the best available provider.
 */
export async function explainPage(
  context: SanitizedContext
): Promise<string> {
  const best = await getBestAvailableProvider();
  if (!best) return "No LLM provider available.";

  const system =
    "You are a browser assistant. Describe the webpage briefly in 2-3 sentences. Focus on what the user can do on this page.";
  const user = `Domain: ${context.pageStructure.metadata.domain}
Title: ${context.pageStructure.metadata.title}
Elements: ${context.pageStructure.metadata.elementCount}
Forms: ${context.pageStructure.forms.length}
${context.pageStructure.metadata.hasCAPTCHA ? "Has CAPTCHA." : ""}
${context.pageStructure.metadata.hasPaymentForm ? "Has payment form." : ""}`;

  try {
    const response = await CALLERS[best.id](best.config, system, user);
    return response;
  } catch {
    return "Could not explain page.";
  }
}
