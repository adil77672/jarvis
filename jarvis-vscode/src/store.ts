// Saved keys ("profiles"), their secrets, and per-day usage tracking.
import * as vscode from 'vscode';
import { Endpoint, LEGACY_LABELS, PRESETS, ProviderKind, RETIRED_DEFAULTS, presetById } from './providers';

export interface Profile {
  id: string;
  name: string;
  presetId: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  /** Requests per day before switching to the next key; 0 = unlimited. */
  dailyLimit: number;
  enabled: boolean;
}

interface Usage {
  day: string;
  count: number;
  total: number;
  exhaustedDay?: string;
  cooldownUntil?: number;
  invalid?: boolean;
  lastError?: string;
}

export type ProfileStatus = 'ready' | 'exhausted' | 'cooldown' | 'invalid' | 'disabled' | 'nokey';

export interface ProfileView extends Profile {
  hasKey: boolean;
  keyHint: string;
  used: number;
  total: number;
  status: ProfileStatus;
  cooldownSecs: number;
  lastError?: string;
}

const PROFILES = 'jarvis.profiles';
const ACTIVE = 'jarvis.activeProfile';
const USAGE = 'jarvis.usage';

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function endpointOf(p: Profile): Endpoint {
  return { kind: p.kind, baseUrl: p.baseUrl, model: p.model };
}

export class Store {
  private keyCache = new Map<string, string | undefined>();

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  profiles(): Profile[] {
    return this.ctx.globalState.get<Profile[]>(PROFILES, []);
  }

  async saveProfiles(list: Profile[]): Promise<void> {
    await this.ctx.globalState.update(PROFILES, list);
  }

  get(id: string): Profile | undefined {
    return this.profiles().find(p => p.id === id);
  }

  async upsert(p: Profile): Promise<void> {
    const list = this.profiles();
    const i = list.findIndex(x => x.id === p.id);
    if (i >= 0) list[i] = p; else list.push(p);
    await this.saveProfiles(list);
    if (!this.activeId()) await this.setActive(p.id);
  }

  async remove(id: string): Promise<void> {
    await this.saveProfiles(this.profiles().filter(p => p.id !== id));
    await this.ctx.secrets.delete(`jarvis.key.${id}`);
    this.keyCache.delete(id);
    const usage = this.allUsage();
    delete usage[id];
    await this.ctx.globalState.update(USAGE, usage);
    if (this.activeId() === id) await this.setActive(this.profiles()[0]?.id);
  }

  async move(id: string, dir: -1 | 1): Promise<void> {
    const list = this.profiles();
    const i = list.findIndex(p => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await this.saveProfiles(list);
  }

  /** One-time migration: retired default models, removed presets, renamed labels. Returns notes. */
  async migrateRetiredModels(): Promise<string[]> {
    const FLAG = 'jarvis.modelsMigrated';
    const VERSION = 1;
    if (this.ctx.globalState.get<number>(FLAG, 0) >= VERSION) return [];
    const notes: string[] = [];
    const list = this.profiles().map(p => {
      let q = p;
      if (!PRESETS.some(x => x.id === q.presetId)) {
        notes.push(`${q.name}: provider no longer available (edit or remove this key)`);
        q = { ...q, presetId: 'custom' };
      }
      const retired = RETIRED_DEFAULTS[q.presetId];
      if (retired?.includes(q.model)) {
        const next = presetById(q.presetId).defaultModel;
        notes.push(`${q.name}: ${q.model} → ${next}`);
        q = { ...q, model: next };
      }
      const legacy = LEGACY_LABELS[q.presetId] ?? [];
      const label = presetById(q.presetId).label;
      for (const old of legacy) {
        if (q.name === old || q.name.startsWith(old + ' #')) q = { ...q, name: label + q.name.slice(old.length) };
      }
      return q;
    });
    await this.saveProfiles(list);
    await this.ctx.globalState.update(FLAG, VERSION);
    return notes;
  }

  activeId(): string | undefined {
    const id = this.ctx.globalState.get<string>(ACTIVE);
    return id && this.get(id) ? id : this.profiles()[0]?.id;
  }

  async setActive(id: string | undefined): Promise<void> {
    await this.ctx.globalState.update(ACTIVE, id);
  }

  // --- keys (stored in the OS keychain via SecretStorage) ---

  async getKey(id: string): Promise<string | undefined> {
    if (!this.keyCache.has(id)) {
      this.keyCache.set(id, await this.ctx.secrets.get(`jarvis.key.${id}`));
    }
    return this.keyCache.get(id);
  }

  async setKey(id: string, key: string): Promise<void> {
    await this.ctx.secrets.store(`jarvis.key.${id}`, key);
    this.keyCache.set(id, key);
    await this.patchUsage(id, u => { u.invalid = false; u.lastError = undefined; });
  }

  // --- usage ---

  private allUsage(): Record<string, Usage> {
    return { ...this.ctx.globalState.get<Record<string, Usage>>(USAGE, {}) };
  }

  usage(id: string): Usage {
    const u = this.allUsage()[id] ?? { day: today(), count: 0, total: 0 };
    if (u.day !== today()) {
      u.day = today();
      u.count = 0;
    }
    return u;
  }

  private async patchUsage(id: string, fn: (u: Usage) => void): Promise<void> {
    const all = this.allUsage();
    const u = this.usage(id);
    fn(u);
    all[id] = u;
    await this.ctx.globalState.update(USAGE, all);
  }

  async recordSuccess(id: string): Promise<void> {
    await this.patchUsage(id, u => {
      u.count++;
      u.total++;
      u.cooldownUntil = undefined;
      u.lastError = undefined;
    });
  }

  async markExhausted(id: string, msg: string): Promise<void> {
    await this.patchUsage(id, u => { u.exhaustedDay = today(); u.lastError = msg; });
  }

  async markCooldown(id: string, ms: number, msg: string): Promise<void> {
    await this.patchUsage(id, u => { u.cooldownUntil = Date.now() + ms; u.lastError = msg; });
  }

  async markInvalid(id: string, msg: string): Promise<void> {
    await this.patchUsage(id, u => { u.invalid = true; u.lastError = msg; });
  }

  async markError(id: string, msg: string): Promise<void> {
    await this.patchUsage(id, u => { u.lastError = msg; });
  }

  async resetUsage(id: string): Promise<void> {
    await this.patchUsage(id, u => {
      u.count = 0;
      u.exhaustedDay = undefined;
      u.cooldownUntil = undefined;
      u.invalid = false;
      u.lastError = undefined;
    });
  }

  async status(p: Profile): Promise<ProfileStatus> {
    if (!p.enabled) return 'disabled';
    const u = this.usage(p.id);
    if (u.invalid) return 'invalid';
    if (presetById(p.presetId).needsKey && !(await this.getKey(p.id))) return 'nokey';
    if (u.exhaustedDay === today()) return 'exhausted';
    if (p.dailyLimit > 0 && u.count >= p.dailyLimit) return 'exhausted';
    if (u.cooldownUntil && u.cooldownUntil > Date.now()) return 'cooldown';
    return 'ready';
  }

  async views(): Promise<ProfileView[]> {
    const out: ProfileView[] = [];
    for (const p of this.profiles()) {
      const key = await this.getKey(p.id);
      const u = this.usage(p.id);
      out.push({
        ...p,
        hasKey: !!key,
        keyHint: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '',
        used: u.count,
        total: u.total,
        status: await this.status(p),
        cooldownSecs: u.cooldownUntil ? Math.max(0, Math.ceil((u.cooldownUntil - Date.now()) / 1000)) : 0,
        lastError: u.lastError,
      });
    }
    return out;
  }
}
