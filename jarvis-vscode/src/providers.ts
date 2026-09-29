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
}

export const PRESETS: Preset[] = [
  {
    id: 'apifreellm', label: 'ApiFreeLLM (free)', kind: 'apifreellm',
    baseUrl: 'https://apifreellm.com/api/v1', defaultModel: 'apifreellm', models: ['apifreellm'],
    dailyLimit: 50, needsKey: true, keyUrl: 'https://apifreellm.com/en/api-access',
  },
  {
    id: 'openrouter', label: 'OpenRouter', kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openrouter/auto',
    models: ['openrouter/auto', 'meta-llama/llama-3.3-70b-instruct:free', 'deepseek/deepseek-r1:free'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'groq', label: 'Groq', kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'gemini', label: 'Google Gemini', kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'openai', label: 'OpenAI', kind: 'openai',
    baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', models: ['gpt-4o-mini', 'gpt-4o'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic', label: 'Anthropic (Claude)', kind: 'openai',
    baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-5',
    models: ['claude-sonnet-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'nvidia', label: 'NVIDIA NIM', kind: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1', defaultModel: 'meta/llama-3.3-70b-instruct',
    models: ['meta/llama-3.3-70b-instruct'],
    dailyLimit: 0, needsKey: true, keyUrl: 'https://build.nvidia.com',
  },
  {
    id: 'openjarvis', label: 'Local OpenJarvis', kind: 'openai',
    baseUrl: 'http://127.0.0.1:8000/v1', defaultModel: 'apifreellm', models: [],
    dailyLimit: 0, needsKey: false,
  },
  {
    id: 'ollama', label: 'Local Ollama', kind: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'llama3.2', models: [],
    dailyLimit: 0, needsKey: false,
  },
  {
    id: 'custom', label: 'Custom (OpenAI-compatible)', kind: 'openai',
    baseUrl: '', defaultModel: '', models: [], dailyLimit: 0, needsKey: false,
  },
];

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

export type ErrorKind = 'quota' | 'rate' | 'auth' | 'other';

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly kind: ErrorKind,
    public readonly status = 0,
    public readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}

export interface LLMResult {
  text: string;
  /** Daily limit reported by the provider, if any. */
  reportedDailyLimit?: number;
}

const QUOTA_PATTERN = /daily|quota|limit reached|exceeded your|insufficient|credits|per day|billing/i;

function classify(status: number, body: string, retryAfterHeader: string | null): LLMError {
  let detail = body;
  try {
    const j = JSON.parse(body);
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
  return new LLMError(`Request failed (${status}): ${detail}`, 'other', status);
}

/** Flatten a conversation into one prompt for APIs that take a single message. */
export function flatten(messages: ChatMessage[]): string {
  if (messages.length === 1) return textOf(messages[0].content);
  const label = { system: 'System', user: 'User', assistant: 'Assistant' } as const;
  return messages.map(m => `${label[m.role]}: ${textOf(m.content)}`).join('\n\n') + '\n\nAssistant:';
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
    throw new LLMError(`Could not reach ${url}: ${e?.message ?? e}`, 'other');
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

/** List models from an OpenAI-compatible /models endpoint. */
export async function listModels(ep: Endpoint, apiKey: string | undefined): Promise<string[]> {
  if (ep.kind === 'apifreellm') return ['apifreellm'];
  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  if (ep.baseUrl.includes('anthropic.com') && apiKey) {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }
  const res = await fetch(`${ep.baseUrl.replace(/\/$/, '')}/models`, {
    headers, signal: timeoutSignal(15_000),
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
