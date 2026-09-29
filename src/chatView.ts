// Sidebar chat webview: conversation state, key rotation, and UI messaging.
import * as vscode from 'vscode';
import { Attachment, fromEditor, fromUri, textBlock } from './attachments';
import { ChatMessage, LLMError, PRESETS, complete, listModels, presetById, supportsImages } from './providers';
import { Profile, Store, endpointOf } from './store';

interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
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
        await this.send(String(m.text ?? ''), Array.isArray(m.attachments) ? m.attachments : []);
        break;
      case 'pickFiles': {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: true, openLabel: 'Attach',
          defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
        });
        if (uris?.length) await this.attachUris(uris);
        break;
      }
      case 'attachActive':
        await this.attachActiveFile(!!m.selectionOnly);
        break;
      case 'dropUris': {
        const uris = (m.uris as string[] ?? [])
          .map(u => u.trim()).filter(u => u && !u.startsWith('#'))
          .map(u => (/^[a-z][\w+.-]*:/i.test(u) ? vscode.Uri.parse(u) : vscode.Uri.file(u)));
        if (uris.length) await this.attachUris(uris);
        break;
      }
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

  /** Conversation for one provider, newest messages kept within the size budget. */
  private buildMessages(allowImages: boolean): ChatMessage[] {
    const cfg = vscode.workspace.getConfiguration('jarvis');
    const system = cfg.get<string>('systemPrompt', '');
    const budget = cfg.get<number>('maxContextChars', 24000);
    const IMAGE_COST = 1000;
    const msgs: ChatMessage[] = [];
    let used = system.length;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i];
      const files = (h.attachments ?? []).filter(a => a.kind === 'text').map(textBlock);
      let text = [...files, h.content].filter(Boolean).join('\n\n');
      const images = allowImages ? (h.attachments ?? []).filter(a => a.kind === 'image') : [];
      const room = budget - used - images.length * IMAGE_COST;
      if (room <= 0 && msgs.length) break;
      // Always keep the newest message, trimming from the start so the question survives.
      if (text.length > room) {
        if (msgs.length) break;
        text = text.slice(-Math.max(room, 2000));
      }
      used += text.length + images.length * IMAGE_COST;
      msgs.unshift(images.length
        ? { role: h.role, content: [
            ...images.map(a => ({ type: 'image_url' as const, image_url: { url: a.dataUrl! } })),
            { type: 'text' as const, text: text || 'Describe this image.' },
          ] }
        : { role: h.role, content: text });
    }
    if (system) msgs.unshift({ role: 'system', content: system });
    return msgs;
  }

  /** Try each usable key once. */
  private async tryKeys(hasImages: boolean, notes: string[]): Promise<boolean> {
    const autoSwitch = vscode.workspace.getConfiguration('jarvis').get<boolean>('autoSwitchKeys', true);
    for (const p of this.candidates()) {
      const status = await this.store.status(p);
      if (status !== 'ready') {
        if (p.id === this.store.activeId()) notes.push(`${p.name}: ${describe(status)}`);
        if (!autoSwitch) break;
        continue;
      }
      if (hasImages && !supportsImages(p.kind)) {
        notes.push(`${p.name}: can't read images (text only)`);
        if (!autoSwitch) break;
        continue;
      }
      const attempt = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; attempt.abort(); }, 120_000);
      const onStop = () => attempt.abort();
      this.abort!.signal.addEventListener('abort', onStop);
      try {
        const messages = this.buildMessages(supportsImages(p.kind));
        const res = await complete(endpointOf(p), await this.store.getKey(p.id), messages, attempt.signal);
        await this.store.recordSuccess(p.id);
        if (res.reportedDailyLimit && p.presetId === 'apifreellm' && res.reportedDailyLimit !== p.dailyLimit) {
          await this.store.upsert({ ...p, dailyLimit: res.reportedDailyLimit });
        }
        if (p.id !== this.store.activeId()) {
          notes.push(`Switched to ${p.name}.`);
          await this.store.setActive(p.id);
        }
        this.history.push({ role: 'assistant', content: res.text, via: `${p.name} · ${p.model}` });
        return true;
      } catch (e: any) {
        if (this.abort!.signal.aborted) throw e;
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
        this.abort!.signal.removeEventListener('abort', onStop);
      }
    }
    return false;
  }

  /** Shortest wait until a rate-limited (not exhausted) key is usable again, in ms. */
  private async soonestCooldown(hasImages: boolean): Promise<number | undefined> {
    let best: number | undefined;
    for (const v of await this.store.views()) {
      if (v.status !== 'cooldown' || (hasImages && !supportsImages(v.kind))) continue;
      const ms = v.cooldownSecs * 1000;
      if (best === undefined || ms < best) best = ms;
    }
    return best;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      this.abort!.signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(Object.assign(new Error('Stopped'), { name: 'AbortError' }));
      }, { once: true });
    });
  }

  private async send(text: string, attachments: Attachment[] = []): Promise<void> {
    text = text.trim();
    if ((!text && !attachments.length) || this.busy) return;
    if (this.store.profiles().length === 0) {
      this.post({ type: 'screen', screen: 'keys' });
      this.post({ type: 'error', text: 'Add an API key first.' });
      return;
    }

    const hasImages = attachments.some(a => a.kind === 'image');
    this.history.push({ role: 'user', content: text, attachments });
    this.busy = true;
    this.abort = new AbortController();
    await this.refresh();

    const notes: string[] = [];
    const MAX_WAIT_MS = 65_000;
    let answered = false;
    try {
      for (let round = 0; round < 3 && !answered; round++) {
        answered = await this.tryKeys(hasImages, notes);
        if (answered) break;
        // Only rate-limited keys left: wait it out instead of failing.
        const wait = await this.soonestCooldown(hasImages);
        if (wait === undefined || wait > MAX_WAIT_MS) break;
        const secs = Math.ceil(wait / 1000);
        this.post({ type: 'waiting', seconds: secs, text: `Rate limited. Retrying in ${secs}s…` });
        await this.sleep(wait);
        this.post({ type: 'waiting', seconds: 0 });
        notes.length = 0;
      }
      if (!answered) {
        this.history.pop();
        const imgHint = hasImages && notes.some(n => n.includes("can't read images"))
          ? '\n\nTo send images, add a key for a vision model: Gemini, OpenAI, Claude or OpenRouter.'
          : '\n\nAdd another key, wait for the limit to reset, or check the Keys tab.';
        this.post({
          type: 'error',
          text: notes.length
            ? `No key could answer.\n${notes.join('\n')}${imgHint}`
            : 'All keys are disabled or out of quota. Add another key in the Keys tab.',
          restore: text,
          attachments,
        });
      } else if (notes.length) {
        this.post({ type: 'notice', text: notes.join('\n') });
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') throw e;
      this.history.pop();
      this.post({ type: 'notice', text: 'Stopped.', restore: text, attachments });
    } finally {
      this.busy = false;
      this.abort = undefined;
      this.post({ type: 'waiting', seconds: 0 });
      await this.refresh();
    }
  }

  // --- attachments ---

  private async attachUris(uris: vscode.Uri[]): Promise<void> {
    const ok: Attachment[] = [];
    const errors: string[] = [];
    for (const uri of uris) {
      try { ok.push(await fromUri(uri)); } catch (e: any) { errors.push(e?.message ?? String(e)); }
    }
    if (ok.length) this.post({ type: 'attachments', attachments: ok });
    if (errors.length) this.post({ type: 'error', text: errors.join('\n') });
  }

  async attachFiles(uris: vscode.Uri[]): Promise<void> {
    await this.attachUris(uris);
  }

  async attachActiveFile(selectionOnly = false): Promise<void> {
    const ed = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
    if (!ed) {
      this.post({ type: 'error', text: 'Open a file in the editor first.' });
      return;
    }
    await this.reveal('chat');
    this.post({ type: 'attachments', attachments: [fromEditor(ed, selectionOnly)] });
  }

  // --- html ---

  private html(webview: vscode.Webview): string {
    const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f));
    const nonce = Array.from({ length: 24 }, () => Math.random().toString(36)[2]).join('');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
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
