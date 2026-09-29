// Saved conversations (chat history), kept in the extension's global storage.
import * as vscode from 'vscode';
import { Attachment } from './attachments';

export interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
  /** Which key/model produced an assistant reply. */
  via?: string;
  /** Workspace-relative path of a generated image. */
  savedPath?: string;
  /** Results of agent actions (sent to the model as a user turn, shown as an action log). */
  tool?: boolean;
  actions?: { kind: 'write' | 'run' | 'git' | 'read'; label: string; ok: boolean; output?: string; code?: number }[];
}

export interface Conversation {
  id: string;
  title: string;
  created: number;
  updated: number;
  messages: HistoryEntry[];
  /** Current task plan (checklist) for agent work in this chat. */
  plan?: { text: string; done: boolean }[];
}

export interface ChatSummary {
  id: string;
  title: string;
  updated: number;
  count: number;
}

const KEY = 'jarvis.chats';
const MAX_CHATS = 100;
/** Images larger than this are not persisted (only their name), to keep storage small. */
const MAX_STORED_IMAGE = 400_000;

export function newConversation(): Conversation {
  const now = Date.now();
  return { id: `c${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: 'New chat', created: now, updated: now, messages: [] };
}

export function titleFor(messages: HistoryEntry[]): string {
  const first = messages.find(m => m.role === 'user' && !m.tool);
  if (!first) return 'New chat';
  const text = (first.content || first.attachments?.map(a => a.name).join(', ') || 'New chat')
    .replace(/\s+/g, ' ').trim();
  return text.length > 60 ? text.slice(0, 57) + '…' : text;
}

function slim(m: HistoryEntry): HistoryEntry {
  if (!m.attachments?.length) return m;
  return {
    ...m,
    attachments: m.attachments.map(a =>
      a.kind === 'image' && (a.dataUrl?.length ?? 0) > MAX_STORED_IMAGE ? { ...a, dataUrl: undefined } : a),
  };
}

export class ChatStore {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  all(): Conversation[] {
    return this.ctx.globalState.get<Conversation[]>(KEY, []);
  }

  get(id: string): Conversation | undefined {
    return this.all().find(c => c.id === id);
  }

  summaries(): ChatSummary[] {
    return this.all()
      .filter(c => c.messages.length)
      .sort((a, b) => b.updated - a.updated)
      .map(c => ({ id: c.id, title: c.title, updated: c.updated, count: c.messages.length }));
  }

  async save(c: Conversation): Promise<void> {
    if (!c.messages.length) return;
    const stored: Conversation = { ...c, title: titleFor(c.messages), updated: Date.now(), messages: c.messages.map(slim) };
    const list = this.all().filter(x => x.id !== c.id);
    list.push(stored);
    list.sort((a, b) => b.updated - a.updated);
    await this.ctx.globalState.update(KEY, list.slice(0, MAX_CHATS));
  }

  async delete(id: string): Promise<void> {
    await this.ctx.globalState.update(KEY, this.all().filter(c => c.id !== id));
  }

  async clear(): Promise<void> {
    await this.ctx.globalState.update(KEY, []);
  }
}
