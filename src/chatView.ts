// Sidebar chat webview: conversation state, key rotation, and UI messaging.
import * as vscode from 'vscode';
import { ChatMessage, LLMError, PRESETS, complete, listModels, presetById } from './providers';
import { Profile, Store, endpointOf } from './store';

interface HistoryEntry extends ChatMessage {
  /** Which key/model produced an assistant reply. */
  via?: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'jarvis.chat';

  private view?: vscode.WebviewView;
  private history: HistoryEntry[] = [];
  private busy = false;
  private abort?: AbortController;
  private pendingScreen?: 'chat' | 'keys';

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly store: Store) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => this.post({ type: 'error', text: String(e?.message ?? e) })));
  }

  // --- public API used by commands ---

  async reveal(screen: 'chat' | 'keys' = 'chat'): Promise<void> {
    this.pendingScreen = screen;
    await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    if (this.view) {
      this.post({ type: 'screen', screen });
      this.pendingScreen = undefined;
    }
  }

  newChat(): void {
    this.abort?.abort();
    this.history = [];
    this.refresh();
  }

  async ask(prompt: string): Promise<void> {
    await this.reveal('chat');
    await this.send(prompt);
  }

  async refresh(): Promise<void> {
    if (!this.view) return;
    this.post({
      type: 'state',
      profiles: await this.store.views(),
      activeId: this.store.activeId(),
      history: this.history,
      busy: this.busy,
      presets: PRESETS,
    });
  }

  // --- messaging ---

  private post(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private async onMessage(m: any): Promise<void> {
    switch (m.type) {
      case 'ready':
        await this.refresh();
        if (this.pendingScreen) {
          this.post({ type: 'screen', screen: this.pendingScreen });
          this.pendingScreen = undefined;
        } else if (this.store.profiles().length === 0) {
          this.post({ type: 'screen', screen: 'keys' });
        }
        break;
      case 'send':
        await this.send(String(m.text ?? ''));
        break;
      case 'stop':
        this.abort?.abort();
        break;
      case 'newChat':
        this.newChat();
        break;
      case 'selectProfile':
        await this.store.setActive(m.id);
        await this.refresh();
        break;
      case 'setModel': {
        const p = this.store.get(m.id);
        if (p) await this.store.upsert({ ...p, model: String(m.model).trim() });
        await this.refresh();
        break;
      }
      case 'saveProfile':
        await this.saveProfile(m);
        break;
      case 'deleteProfile': {
        const p = this.store.get(m.id);
        const ok = await vscode.window.showWarningMessage(
          `Remove key "${p?.name ?? m.id}"?`, { modal: true }, 'Remove');
        if (ok === 'Remove') await this.store.remove(m.id);
        await this.refresh();
        break;
      }
      case 'moveProfile':
        await this.store.move(m.id, m.dir < 0 ? -1 : 1);
        await this.refresh();
        break;
      case 'toggleProfile': {
        const p = this.store.get(m.id);
        if (p) await this.store.upsert({ ...p, enabled: !p.enabled });
        await this.refresh();
        break;
      }
      case 'resetUsage':
        await this.store.resetUsage(m.id);
        await this.refresh();
        break;
      case 'fetchModels':
        await this.fetchModels(m);
        break;
      case 'openUrl':
        if (typeof m.url === 'string' && /^https?:\/\//.test(m.url)) {
          vscode.env.openExternal(vscode.Uri.parse(m.url));
        }
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(String(m.text ?? ''));
        vscode.window.setStatusBarMessage('Jarvis: copied', 2000);
        break;
      case 'insert': {
        const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
        if (!editor) {
          vscode.window.showInformationMessage('Open a file to insert code into.');
          break;
        }
        await editor.edit(b => b.replace(editor.selection, String(m.text ?? '')));
        break;
      }
    }
  }

  private async saveProfile(m: any): Promise<void> {
    const preset = presetById(m.presetId);
    const id: string = m.id || `${preset.id}-${Date.now().toString(36)}`;
    const existing = this.store.get(id);
    const baseUrl = String(m.baseUrl || preset.baseUrl).trim();
    if (preset.kind === 'openai' && !/^https?:\/\//.test(baseUrl)) {
      this.post({ type: 'error', text: 'Enter a base URL starting with http:// or https://' });
      return;
    }
    const key = String(m.key ?? '').trim();
    if (preset.needsKey && !key && !(existing && (await this.store.getKey(id)))) {
      this.post({ type: 'error', text: `${preset.label} needs an API key.` });
      return;
    }
    const count = this.store.profiles().filter(p => p.presetId === preset.id && p.id !== id).length;
    const profile: Profile = {
      id,
      name: String(m.name || '').trim() || (count ? `${preset.label} #${count + 1}` : preset.label),
      presetId: preset.id,
      kind: preset.kind,
      baseUrl,
      model: String(m.model || preset.defaultModel).trim(),
      dailyLimit: Math.max(0, Number(m.dailyLimit ?? preset.dailyLimit) || 0),
      enabled: existing?.enabled ?? true,
    };
    await this.store.upsert(profile);
    if (key) await this.store.setKey(id, key);
    if (!existing) await this.store.setActive(id);
    await this.refresh();
    this.post({ type: 'saved', id });
  }

  private async fetchModels(m: any): Promise<void> {
    const preset = presetById(m.presetId);
    const p = m.id ? this.store.get(m.id) : undefined;
    const key = String(m.key ?? '').trim() || (p ? await this.store.getKey(p.id) : undefined);
    const ep = { kind: preset.kind, baseUrl: String(m.baseUrl || p?.baseUrl || preset.baseUrl), model: '' };
    try {
      const models = await listModels(ep, key);
      this.post({ type: 'models', target: m.target, models });
    } catch (e: any) {
      this.post({ type: 'error', text: `Could not load models: ${e?.message ?? e}` });
    }
  }

  // --- sending with automatic key rotation ---

  /** Active key first, then the rest in list order. */
  private candidates(): Profile[] {
    const list = this.store.profiles();
    const active = this.store.activeId();
    return [...list.filter(p => p.id === active), ...list.filter(p => p.id !== active)];
  }

  private buildMessages(): ChatMessage[] {
    const cfg = vscode.workspace.getConfiguration('jarvis');
    const system = cfg.get<string>('systemPrompt', '');
    const budget = cfg.get<number>('maxContextChars', 24000);
    const msgs: ChatMessage[] = [];
    let used = system.length;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i];
      const room = budget - used;
      if (room <= 0) break;
      // Always keep the newest message, trimming it from the start if needed.
      const content = h.content.length > room && msgs.length === 0 ? h.content.slice(-room) : h.content;
      if (content.length > room) break;
      msgs.unshift({ role: h.role, content });
      used += content.length;
    }
    if (system) msgs.unshift({ role: 'system', content: system });
    return msgs;
  }

  private async send(text: string): Promise<void> {
    text = text.trim();
    if (!text || this.busy) return;
    if (this.store.profiles().length === 0) {
      this.post({ type: 'screen', screen: 'keys' });
      this.post({ type: 'error', text: 'Add an API key first.' });
      return;
    }

    this.history.push({ role: 'user', content: text });
    this.busy = true;
    this.abort = new AbortController();
    await this.refresh();

    const messages = this.buildMessages();
    const notes: string[] = [];
    const autoSwitch = vscode.workspace.getConfiguration('jarvis').get<boolean>('autoSwitchKeys', true);
    let answered = false;

    try {
      for (const p of this.candidates()) {
        const status = await this.store.status(p);
        if (status !== 'ready') {
          if (p.id === this.store.activeId()) notes.push(`${p.name}: ${describe(status)}`);
          if (!autoSwitch) break;
          continue;
        }
        const attempt = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; attempt.abort(); }, 120_000);
        const onStop = () => attempt.abort();
        this.abort.signal.addEventListener('abort', onStop);
        const signal = attempt.signal;
        try {
          const res = await complete(endpointOf(p), await this.store.getKey(p.id), messages, signal);
          await this.store.recordSuccess(p.id);
          if (res.reportedDailyLimit && p.presetId === 'apifreellm' && res.reportedDailyLimit !== p.dailyLimit) {
            await this.store.upsert({ ...p, dailyLimit: res.reportedDailyLimit });
          }
          if (p.id !== this.store.activeId()) {
            notes.push(`Switched to ${p.name}.`);
            await this.store.setActive(p.id);
          }
          this.history.push({ role: 'assistant', content: res.text, via: `${p.name} · ${p.model}` });
          answered = true;
          break;
        } catch (e: any) {
          if (this.abort.signal.aborted) throw e;
          if (timedOut) {
            await this.store.markError(p.id, 'Timed out after 120s');
            notes.push(`${p.name}: timed out`);
          } else if (e instanceof LLMError) {
            if (e.kind === 'quota') await this.store.markExhausted(p.id, e.message);
            else if (e.kind === 'rate') await this.store.markCooldown(p.id, e.retryAfterMs, e.message);
            else if (e.kind === 'auth') await this.store.markInvalid(p.id, e.message);
            else await this.store.markError(p.id, e.message);
            notes.push(`${p.name}: ${e.message}`);
          } else {
            await this.store.markError(p.id, String(e?.message ?? e));
            notes.push(`${p.name}: ${e?.message ?? e}`);
          }
          if (!autoSwitch) break;
        } finally {
          clearTimeout(timer);
          this.abort.signal.removeEventListener('abort', onStop);
        }
      }
      if (!answered) {
        this.history.pop();
        this.post({
          type: 'error',
          text: notes.length
            ? `No key could answer.\n${notes.join('\n')}\n\nAdd another key, wait for the limit to reset, or check the Keys tab.`
            : 'All keys are disabled or out of quota. Add another key in the Keys tab.',
          restore: text,
        });
      } else if (notes.length) {
        this.post({ type: 'notice', text: notes.join('\n') });
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') throw e;
      this.history.pop();
      this.post({ type: 'notice', text: 'Stopped.', restore: text });
    } finally {
      this.busy = false;
      this.abort = undefined;
      await this.refresh();
    }
  }

  // --- html ---

  private html(webview: vscode.Webview): string {
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f));
    const nonce = Array.from({ length: 24 }, () => Math.random().toString(36)[2]).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${media('chat.css')}" rel="stylesheet">
<title>Jarvis</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${media('chat.js')}"></script>
</body>
</html>`;
  }
}

function describe(status: string): string {
  switch (status) {
    case 'exhausted': return 'daily limit reached';
    case 'cooldown': return 'rate limited, cooling down';
    case 'invalid': return 'key rejected';
    case 'disabled': return 'disabled';
    case 'nokey': return 'no key saved';
    default: return status;
  }
}
