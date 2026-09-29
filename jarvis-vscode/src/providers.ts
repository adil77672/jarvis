// Provider presets and the HTTP calls to each kind of API.

export type ProviderKind = 'apifreellm' | 'openai';

export interface Preset {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  /** Requests per day; 0 = no known limit. */
  dailyLimit: number;
  needsKey: boolean;
  keyUrl?: string;
  /** Can it read images? 'model' = depends on the chosen model. */
  vision: 'yes' | 'no' | 'model';
  /** 'free' = has a free tier, 'local' = runs on your computer, 'paid' = needs credits. */
  tier: 'free' | 'local' | 'paid';
  /** One-line note shown in the free-keys guide. */
  note?: string;
}

export const PRESETS: Preset[] = [
  {
    id: 'apifreellm', label: 'ApiFreeLLM (free)', kind: 'apifreellm',
    baseUrl: 'https://apifreellm.com/api/v1', defaultModel: 'apifreellm', models: ['apifreellm'],
    dailyLimit: 50, needsKey: true, keyUrl: 'https://apifreellm.com/en/api-access', vision: 'no', tier: 'free', note: '50 requests/day, text only',
  },
  {
    id: 'openrouter', label: 'OpenRouter', kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openrouter/free',
    models: ['openrouter/free', 'openrouter/auto', 'nvidia/nemotron-3-super-120b-a12b:free', 'google/gemma-4-31b-it:free', 'qwen/qwen3.8-27b:free'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://openrouter.ai/keys', vision: 'model', tier: 'free', note: 'Many free models (names end in :free)',
  },
  {
    id: 'groq', label: 'Groq', kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'openai/gpt-oss-120b',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://console.groq.com/keys', vision: 'model', tier: 'free', note: 'Very fast Llama models, generous free tier',
  },
  {
    id: 'gemini', label: 'Google AI Studio (Gemini)', kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-3.8-flash',
    models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://aistudio.google.com/apikey', vision: 'yes', tier: 'free', note: 'Free tier, reads images, big context',
  },
  {
    id: 'openai', label: 'OpenAI', kind: 'openai',
    baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-6-luna', models: ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://platform.openai.com/api-keys', vision: 'yes', tier: 'paid',
  },
  {
    id: 'anthropic', label: 'Claude (Anthropic)', kind: 'openai',
    baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-5-5',
    models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://console.anthropic.com/settings/keys', vision: 'yes', tier: 'paid',
  },
  {
    id: 'nvidia', label: 'NVIDIA NIM', kind: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1', defaultModel: 'nvidia/nemotron-3-super-120b-a12b',
    models: ['nvidia/nemotron-3-super-120b-a12b', 'moonshotai/kimi-k3', 'deepseek-ai/deepseek-v4.1-flash', 'openai/gpt-oss-20b'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://build.nvidia.com', vision: 'model', tier: 'free', note: 'Free credits for many open models',
  },
  {
    id: 'deepseek', label: 'DeepSeek', kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://platform.deepseek.com/api_keys', vision: 'no', tier: 'paid',
  },
  {
    id: 'mistral', label: 'Mistral', kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1', defaultModel: 'mistral-small-latest', models: ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest', 'codestral-latest'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://console.mistral.ai/api-keys', vision: 'model', tier: 'free', note: 'Free experiment tier',
  },
  {
    id: 'xai', label: 'xAI (Grok)', kind: 'openai',
    baseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-4.3', models: ['grok-4.3', 'grok-4.7', 'grok-build-0.1'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://console.x.ai', vision: 'model', tier: 'paid',
  },
  {
    id: 'together', label: 'Together AI', kind: 'openai',
    baseUrl: 'https://api.together.xyz/v1', defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'openai/gpt-oss-120b', 'deepseek-ai/DeepSeek-V4.1-Flash', 'moonshotai/Kimi-K3'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://api.together.ai/settings/api-keys', vision: 'model', tier: 'paid',
  },
  {
    id: 'cerebras', label: 'Cerebras', kind: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1', defaultModel: 'gpt-oss-120b', models: ['gpt-oss-120b', 'qwen-3.8-27b'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://cloud.cerebras.ai', vision: 'no', tier: 'free', note: 'Very fast, free tier',
  },
  {
    id: 'lmstudio', label: 'Local LM Studio', kind: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1', defaultModel: '', models: [],
    dailyLimit: 0, needsKey: false, vision: 'model', tier: 'local',
  },
  {
    id: 'sambanova', label: 'SambaNova', kind: 'openai',
    baseUrl: 'https://api.sambanova.ai/v1', defaultModel: 'gpt-oss-120b', models: ['gpt-oss-120b', 'Meta-Llama-3.3-70B-Instruct', 'DeepSeek-V3.1', 'MiniMax-M2.7'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://cloud.sambanova.ai/apis', vision: 'model', tier: 'free', note: 'Fast open models, free tier',
  },
  {
    id: 'huggingface', label: 'Hugging Face', kind: 'openai',
    baseUrl: 'https://router.huggingface.co/v1', defaultModel: 'openai/gpt-oss-120b', models: ['openai/gpt-oss-120b', 'meta-llama/Llama-3.3-70B-Instruct', 'deepseek-ai/DeepSeek-V4-Flash', 'zai-org/GLM-5.3'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://huggingface.co/settings/tokens', vision: 'model', tier: 'free', note: 'Monthly free credits, thousands of models',
  },
  {
    id: 'cohere', label: 'Cohere', kind: 'openai',
    baseUrl: 'https://api.cohere.ai/compatibility/v1', defaultModel: 'command-a-plus-05-2026', models: ['command-a-plus-05-2026', 'command-a-03-2025', 'command-a-vision-07-2025'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://dashboard.cohere.com/api-keys', vision: 'no', tier: 'free', note: 'Free trial key',
  },
  {
    id: 'openjarvis', label: 'Local OpenJarvis', kind: 'openai',
    baseUrl: 'http://127.0.0.1:8000/v1', defaultModel: 'apifreellm', models: [],
    dailyLimit: 0, needsKey: false, vision: 'no', tier: 'local',
  },
  {
    id: 'ollama', label: 'Local Ollama', kind: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'llama3.2', models: [],
    dailyLimit: 0, needsKey: false, vision: 'model', tier: 'local',
  },
  {
    id: 'custom', label: 'Custom (OpenAI-compatible)', kind: 'openai',
    baseUrl: '', defaultModel: '', models: [], dailyLimit: 0, needsKey: false, vision: 'model', tier: 'local',
  },
];

/** Old built-in defaults that providers have retired (or that fail on free accounts). */
export const RETIRED_DEFAULTS: Record<string, string[]> = {
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
  cerebras: ['llama-3.3-70b'],
  cohere: ['command-r-plus', 'command-r'],
  xai: ['grok-3-mini', 'grok-3'],
};

/** Labels presets used to have, so auto-generated key names are recognised after renames. */
export const LEGACY_LABELS: Record<string, string[]> = {
  gemini: ['Google Gemini'],
  anthropic: ['Anthropic (Claude)'],
};

export function presetById(id: string): Preset {
  return PRESETS.find(p => p.id === id) ?? PRESETS[PRESETS.length - 1];
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export function textOf(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.map(p => (p.type === 'text' ? p.text : '[image]')).join('\n');
}

/** Providers that can't read images. */
export function supportsImages(kind: ProviderKind): boolean {
  return kind !== 'apifreellm';
}

export interface Endpoint {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
}

export type ErrorKind = 'quota' | 'rate' | 'auth' | 'model' | 'other';

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly kind: ErrorKind,
    public readonly status = 0,
    public readonly retryAfterMs = 0,
    /** For 'model' errors: a replacement model named by the provider, if any. */
    public readonly suggestedModel?: string,
  ) {
    super(message);
  }
}

const MODEL_GONE = /model[^\n]{0,100}?(not found|no longer available|does not exist|not exist|decommissioned|deprecated|retired|not supported|is not available|unavailable|invalid)|unknown model|invalid model|model_not_found|no such model|not a valid model/i;

/** Does this look like a model ID (not an English word)? */
export function looksLikeModelId(id: string): boolean {
  return id.length >= 3 && /[\d\-\/.:]/.test(id) && !/^\d+(\.\d+)?$/.test(id);
}

/** "Please update your code to use models/gemini-3.8-flash" → "gemini-3.8-flash". */
export function suggestedModelFrom(detail: string, failedModel?: string): string | undefined {
  const re = /\b(?:use|using|switch to|migrate to|replaced? (?:by|with)|instead,? use)\s+(?:the\s+)?(?:model\s+)?[`'"]?(?:models\/)?([A-Za-z0-9][\w.\-:\/]*[\w])[`'"]?/gi;
  for (let m; (m = re.exec(detail));) {
    const id = m[1];
    if (looksLikeModelId(id) && id !== failedModel && `models/${id}` !== failedModel) return id;
  }
  return undefined;
}

export interface LLMResult {
  text: string;
  /** Daily limit reported by the provider, if any. */
  reportedDailyLimit?: number;
}

const QUOTA_PATTERN = /daily|quota|limit reached|exceeded your|insufficient|credits|per day|billing/i;

function classify(status: number, body: string, retryAfterHeader: string | null): LLMError {
  let detail = body;
  let errType = '';
  try {
    let j = JSON.parse(body);
    if (Array.isArray(j)) j = j[0];               // Gemini wraps errors in a list
    errType = `${j?.error?.type ?? ''} ${j?.error?.code ?? ''} ${j?.error?.status ?? ''}`;
    detail = j?.error?.message ?? j?.error ?? j?.message ?? body;
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch { /* not JSON */ }
  detail = String(detail).slice(0, 300);

  if (status === 401 || status === 403) {
    return new LLMError(`Invalid or unauthorized key (${status}): ${detail}`, 'auth', status);
  }
  if (status === 402) {
    return new LLMError(`Out of credits (402): ${detail}`, 'quota', status);
  }
  if (status === 429) {
    if (QUOTA_PATTERN.test(detail)) {
      return new LLMError(`Quota reached: ${detail}`, 'quota', status);
    }
    // Retry-After header, or "please wait 20 seconds" in the message.
    let secs = Number(retryAfterHeader);
    if (!(Number.isFinite(secs) && secs > 0)) {
      secs = Number(detail.match(/(\d+)\s*(?:s\b|sec|second)/i)?.[1] ?? 30);
    }
    const wait = secs * 1000 + 500;
    return new LLMError(`Rate limited: ${detail}`, 'rate', status, wait);
  }
  const modelGone =
    MODEL_GONE.test(detail) ||
    (status === 404 && /^\s*model:\s*\S+\s*$/i.test(detail)) ||                          // Anthropic: "model: claude-…"
    (status === 404 && /\bmodel_not_found\b/i.test(errType)) ||
    (status === 404 && /\bno endpoints found for\s+(?!that\b)\S+/i.test(detail));          // OpenRouter removed model
  if ((status === 404 || status === 400 || status === 410 || status === 422) && modelGone) {
    return new LLMError(`Model unavailable (${status}): ${detail}`, 'model', status, 0, suggestedModelFrom(detail));
  }
  return new LLMError(`Request failed (${status}): ${detail}`, 'other', status);
}

/** Choose a replacement model: the provider's suggestion, else the closest match from its model list. */
export function pickReplacement(oldModel: string, available: string[], suggested?: string): string | undefined {
  const list = available.filter(m => m && m !== oldModel);
  if (suggested && (list.includes(suggested) || (!list.length && looksLikeModelId(suggested)))) return suggested;
  if (!list.length) return undefined;
  const skip = /embed|embedding|tts|whisper|audio|image|vision-preview|moderation|guard|rerank|transcri|speech|realtime|search|dall-e|imagen|veo|learnlm|aqa/i;
  const chat = list.filter(m => !skip.test(m));
  const pool = chat.length ? chat : list;
  const tokens = oldModel.toLowerCase().split(/[^a-z0-9]+/).filter(t => t && !/^\d+$/.test(t));
  const score = (m: string) => {
    const low = m.toLowerCase();
    let s = tokens.reduce((n, t) => n + (low.includes(t) ? 2 : 0), 0);
    if (/preview|exp|experimental|beta|-\d{4,}/.test(low)) s -= 1;     // prefer stable IDs
    const nums = (low.match(/\d+(\.\d+)?/g) ?? []).map(Number);
    s += Math.min(nums.length ? Math.max(...nums) : 0, 50) / 100;      // prefer newer versions
    return s;
  };
  return [...pool].sort((a, b) => score(b) - score(a))[0];
}

/** Flatten a conversation into one prompt for APIs that take a single message. */
export function flatten(messages: ChatMessage[]): string {
  if (messages.length === 1) return textOf(messages[0].content);
  const label = { system: 'System', user: 'User', assistant: 'Assistant' } as const;
  return messages.map(m => `${label[m.role]}: ${textOf(m.content)}`).join('\n\n') + '\n\nAssistant:';
}


/** Friendly error when a request can't reach the server. */
function unreachable(url: string, e: any): LLMError {
  const local = /\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)[:/]/.test(url);
  if (local) {
    const hint = url.includes(':8000') ? 'For Local OpenJarvis, run ./start-jarvis.sh in your jarvis folder first (it uses your ApiFreeLLM key, so it shares that daily limit).'
      : url.includes(':11434') ? 'For Ollama, start it with `ollama serve`.'
      : url.includes(':1234') ? 'Start LM Studio\'s local server first.'
      : 'Start the local server first.';
    return new LLMError(`Nothing is running at ${url.replace(/\/(chat\/completions|chat|models)$/, '')}. ${hint}`, 'other');
  }
  return new LLMError(`Could not reach ${url}: ${e?.message ?? e}`, 'other');
}

export async function complete(
  ep: Endpoint,
  apiKey: string | undefined,
  messages: ChatMessage[],
  signal: AbortSignal,
): Promise<LLMResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let url: string;
  let body: unknown;
  if (ep.kind === 'apifreellm') {
    url = `${ep.baseUrl.replace(/\/$/, '')}/chat`;
    body = { message: flatten(messages) };
  } else {
    url = `${ep.baseUrl.replace(/\/$/, '')}/chat/completions`;
    body = { model: ep.model, messages, stream: false };
    if (ep.baseUrl.includes('anthropic.com') && apiKey) {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }
  }

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    throw unreachable(url, e);
  }

  const text = await res.text();
  if (!res.ok) throw classify(res.status, text, res.headers.get('retry-after'));

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    throw new LLMError(`Unexpected response: ${text.slice(0, 200)}`, 'other', res.status);
  }

  if (ep.kind === 'apifreellm') {
    if (data.success === false) {
      const msg = String(data.error ?? data.message ?? JSON.stringify(data));
      throw new LLMError(msg, QUOTA_PATTERN.test(msg) ? 'quota' : 'other', res.status);
    }
    const limit = Number(data?.features?.dailyRequestLimit);
    return {
      text: String(data.response ?? ''),
      reportedDailyLimit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    };
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new LLMError(`No reply in response: ${text.slice(0, 200)}`, 'other', res.status);
  }
  return { text: content };
}

/**
 * Streaming chat completion (OpenAI-style SSE). Calls onDelta with the text so far.
 * Falls back to a normal request for providers that can't stream.
 */
export async function completeStream(
  ep: Endpoint,
  apiKey: string | undefined,
  messages: ChatMessage[],
  signal: AbortSignal,
  onDelta: (textSoFar: string) => void,
): Promise<LLMResult & { streamed: boolean }> {
  if (ep.kind === 'apifreellm') return { ...(await complete(ep, apiKey, messages, signal)), streamed: false };
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  if (ep.baseUrl.includes('anthropic.com') && apiKey) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }
  const url = `${ep.baseUrl.replace(/\/$/, '')}/chat/completions`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model: ep.model, messages, stream: true }), signal });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    throw unreachable(url, e);
  }
  if (!res.ok) throw classify(res.status, await res.text(), res.headers.get('retry-after'));

  // Some servers ignore stream:true and return plain JSON.
  if (!(res.headers.get('content-type') ?? '').includes('event-stream') || !res.body) {
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { throw new LLMError(`Unexpected response: ${text.slice(0, 200)}`, 'other', res.status); }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new LLMError(`No reply in response: ${text.slice(0, 200)}`, 'other', res.status);
    return { text: content, streamed: false };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let chunk: any;
      try { chunk = JSON.parse(payload); } catch { continue; }
      if (chunk.error) throw new LLMError(String(chunk.error.message ?? JSON.stringify(chunk.error)), 'other');
      const delta = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content;
      if (typeof delta === 'string' && delta) {
        full += delta;
        onDelta(full);
      }
    }
  }
  if (!full) throw new LLMError('The provider returned an empty reply.', 'other');
  return { text: full, streamed: true };
}

/** List models from an OpenAI-compatible /models endpoint. */
export async function listModels(ep: Endpoint, apiKey: string | undefined, signal?: AbortSignal): Promise<string[]> {
  if (ep.kind === 'apifreellm') return ['apifreellm'];
  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  if (ep.baseUrl.includes('anthropic.com') && apiKey) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }
  const res = await fetch(`${ep.baseUrl.replace(/\/$/, '')}/models`, {
    headers, signal: signal ?? timeoutSignal(15_000),
  });
  if (!res.ok) throw classify(res.status, await res.text(), null);
  const data: any = await res.json();
  const ids: string[] = (data?.data ?? data?.models ?? [])
    .map((m: any) => String(m.id ?? m.name ?? '').replace(/^models\//, ''))
    .filter(Boolean);
  return [...new Set(ids)].sort();
}

function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}
