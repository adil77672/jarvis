// Sidebar chat webview: conversation state, key rotation, and UI messaging.
import * as vscode from 'vscode';
import { AGENT_PROMPT, isDangerous, parseActions, runCommand, runFile, runInTerminal, workspaceRoot } from './agent';
import { ProposalProvider, applyCode, resolveWorkspacePath, showDiff, writeWorkspaceFile } from './apply';
import { Attachment, composeUserText, fromEditor, fromFolder, fromUri, fromZipBytes, walk } from './attachments';
import { ChatStore, Conversation, HistoryEntry, newConversation } from './chats';
import { fetchImage, parseImageRequest, saveImage, slugify } from './images';
import { Speaker } from './speech';
import { DICTATION_HINT, Recorder, transcribe } from './voice';
import { ChatMessage, LLMError, PRESETS, completeStream, listModels, presetById, supportsImages } from './providers';
import { Profile, Store, endpointOf } from './store';


export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'jarvis.chat';

  private view?: vscode.WebviewView;
  private chat: Conversation = newConversation();
  private get history(): HistoryEntry[] { return this.chat.messages; }
  private set history(v: HistoryEntry[]) { this.chat.messages = v; }
  private readonly chats: ChatStore;
  private busy = false;
  private abort?: AbortController;
  private pendingScreen?: 'chat' | 'keys';
  private pngWaiters = new Map<string, (dataUrl: string | undefined) => void>();
  private fileCache?: { at: number; files: string[] };
  private perms = new Map<string, (d: Decision) => void>();
  private pendingPermission?: PermissionRequest & { id: string };
  private allow = { write: false, run: false, read: false, files: new Set<string>() };
  private recorder = new Recorder();
  private speaker = new Speaker();
  private speaking?: Promise<void>;
  private live = false;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly store: Store,
    private readonly proposals: ProposalProvider,
  ) {
    this.chats = new ChatStore(ctx);
  }

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
    this.chat = newConversation();
    this.allow = { write: false, run: false, read: false, files: new Set<string>() };
    this.refresh();
    this.post({ type: 'screen', screen: 'chat' });
  }

  private async persist(): Promise<void> {
    await this.chats.save(this.chat);
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
      chatId: this.chat.id,
      permission: this.pendingPermission,
      agent: this.agentMode(),
      speak: this.speakMode(),
      settings: (() => {
        const c = vscode.workspace.getConfiguration('jarvis');
        return {
          autoApproveReads: c.get<boolean>('autoApproveReads', true),
          autoApproveEdits: c.get<boolean>('autoApproveEdits', false),
          autoApproveCommands: c.get<boolean>('autoApproveCommands', false),
          runInTerminal: c.get<boolean>('runInTerminal', true),
          autoUpdate: c.get<boolean>('autoUpdate', true),
        };
      })(),
      live: this.live,
      chats: this.chats.summaries(),
      account: {
        name: this.ctx.globalState.get<string>('jarvis.userName', ''),
        version: String(this.ctx.extension?.packageJSON?.version ?? ''),
        imageFolder: vscode.workspace.getConfiguration('jarvis').get<string>('imageFolder', '') || '(project root)',
        workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? '',
      },
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
      case 'applyCode':
        try {
          const rel = await applyCode(this.proposals, String(m.path ?? ''), String(m.code ?? ''));
          if (rel) this.post({ type: 'notice', text: `Applied changes to ${rel}.` });
        } catch (e: any) {
          this.post({ type: 'error', text: e?.message ?? String(e) });
        }
        break;
      case 'openFile': {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (ws && typeof m.path === 'string') {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(ws.uri, m.path));
        }
        break;
      }
      case 'pngResult': {
        const done = this.pngWaiters.get(m.reqId);
        this.pngWaiters.delete(m.reqId);
        done?.(typeof m.dataUrl === 'string' ? m.dataUrl : undefined);
        break;
      }
      case 'permissionReply': {
        const done = this.perms.get(m.id);
        if (done) done(['allow', 'always', 'file'].includes(m.decision) ? m.decision : 'deny');
        break;
      }
      case 'viewDiff':
        if (this.pendingPermission?.path && this.pendingPermission.code !== undefined) {
          try { await showDiff(this.proposals, this.pendingPermission.path, this.pendingPermission.code); } catch (e: any) { this.post({ type: 'error', text: e?.message ?? String(e) }); }
        }
        break;
      case 'setSetting': {
        const allowed = ['autoApproveReads', 'autoApproveEdits', 'autoApproveCommands', 'runInTerminal', 'autoUpdate', 'agentMode', 'speakReplies'];
        if (allowed.includes(m.key)) {
          await vscode.workspace.getConfiguration('jarvis').update(m.key, !!m.value, vscode.ConfigurationTarget.Global);
          await this.refresh();
        }
        break;
      }
      case 'openAttachment': {
        // Open the real workspace file if it exists; otherwise show the attached text in a new tab.
        const ws = vscode.workspace.workspaceFolders?.[0];
        const name = String(m.name ?? '').split(':')[0];
        if (ws && name && !name.endsWith('/') && !/^pasted-/.test(name)) {
          const uri = vscode.Uri.joinPath(ws.uri, name);
          try { await vscode.workspace.fs.stat(uri); await vscode.commands.executeCommand('vscode.open', uri); break; } catch { /* not in workspace */ }
        }
        const ext = name.split('.').pop() ?? '';
        const langs: Record<string, string> = { ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', py: 'python', json: 'json', md: 'markdown', sh: 'shellscript', css: 'css', html: 'html', go: 'go', rs: 'rust', java: 'java', yml: 'yaml', yaml: 'yaml', sql: 'sql' };
        const doc = await vscode.workspace.openTextDocument({ content: String(m.text ?? ''), language: langs[ext] ?? (name.endsWith('/') ? 'markdown' : 'plaintext') });
        await vscode.window.showTextDocument(doc, { preview: true });
        break;
      }
      case 'checkUpdates':
        await vscode.commands.executeCommand('jarvis.checkForUpdates');
        break;
      case 'toggleAgent':
        await vscode.workspace.getConfiguration('jarvis').update('agentMode', !this.agentMode(), vscode.ConfigurationTarget.Global);
        await this.refresh();
        break;
      case 'pickFolder': {
        const uris = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true, openLabel: 'Attach folder', defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri });
        if (uris?.length) await this.attachUris(uris);
        break;
      }
      case 'attachProject': {
        const root = workspaceRoot();
        if (!root) { this.post({ type: 'error', text: 'Open a project folder first.' }); break; }
        this.post({ type: 'status', text: 'Reading project…' });
        this.post({ type: 'attachments', attachments: [await fromFolder(root, vscode.workspace.workspaceFolders![0].name)] });
        this.post({ type: 'status', text: '' });
        break;
      }
      case 'attachZipBytes':
        try {
          this.post({ type: 'attachments', attachments: [await fromZipBytes(String(m.name), String(m.data))] });
        } catch (e: any) { this.post({ type: 'error', text: e?.message ?? String(e) }); }
        break;
      case 'attachBrowserFolder':
        this.post({ type: 'attachments', attachments: [m.attachment] });
        break;
      case 'toggleSpeak': {
        const on = !this.speakMode();
        await vscode.workspace.getConfiguration('jarvis').update('speakReplies', on, vscode.ConfigurationTarget.Global);
        if (!on) this.speaker.stop();
        await this.refresh();
        break;
      }
      case 'stopSpeaking':
        this.speaker.stop();
        break;
      case 'liveStart':
        void this.liveLoop();
        break;
      case 'liveStop':
        this.live = false;
        this.recorder.cancel();
        this.speaker.stop();
        this.abort?.abort();
        this.post({ type: 'voice', state: 'idle' });
        await this.refresh();
        break;
      case 'voiceStart':
        await this.voiceStart();
        break;
      case 'voiceStop':
        await this.voiceStop();
        break;
      case 'voiceCancel':
        this.recorder.cancel();
        this.post({ type: 'voice', state: 'idle' });
        break;
      case 'listFiles':
        this.post({ type: 'files', query: m.query, files: this.matchFiles(await this.workspaceFiles(), String(m.query ?? '')) });
        break;
      case 'attachPath': {
        const ws = vscode.workspace.workspaceFolders?.[0];
        if (ws && typeof m.path === 'string') await this.attachUris([vscode.Uri.joinPath(ws.uri, m.path)]);
        break;
      }
      case 'askWithFile': {
        const ed = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
        if (!ed) {
          this.post({ type: 'error', text: 'Open a file in the editor first, then try again.' });
          break;
        }
        await this.send(String(m.prompt ?? ''), [fromEditor(ed, false)]);
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
      case 'openChat': {
        const c = this.chats.get(m.id);
        if (c && !this.busy) {
          this.chat = { ...c, messages: [...c.messages] };
          this.allow = { write: false, run: false, read: false, files: new Set<string>() };
          await this.refresh();
          this.post({ type: 'screen', screen: 'chat' });
        }
        break;
      }
      case 'deleteChat':
        await this.chats.delete(m.id);
        if (m.id === this.chat.id) this.chat = newConversation();
        await this.refresh();
        break;
      case 'clearChats': {
        const ok = await vscode.window.showWarningMessage('Delete all saved chats?', { modal: true }, 'Delete all');
        if (ok === 'Delete all') {
          await this.chats.clear();
          this.chat = newConversation();
          await this.refresh();
        }
        break;
      }
      case 'setName':
        await this.ctx.globalState.update('jarvis.userName', String(m.name ?? '').trim().slice(0, 40));
        await this.refresh();
        break;
      case 'retry': {
        if (this.busy) break;
        if (this.history.at(-1)?.role === 'assistant') this.history.pop();
        const last = this.history.at(-1);
        if (last?.role !== 'user') break;
        this.history.pop();
        await this.send(last.content, last.attachments ?? []);
        break;
      }
      case 'saveImage': {
        if (typeof m.dataUrl !== 'string' || !m.dataUrl.startsWith('data:image/')) break;
        const ext = (m.dataUrl.match(/^data:image\/(\w+)/)?.[1] ?? 'png').replace('jpeg', 'jpg');
        const base = String(m.name || 'image').split('/').pop()!.replace(/\.\w+$/, '');
        const saved = await saveImage(`${slugify(base)}.${ext}`, Buffer.from(m.dataUrl.split(',')[1], 'base64'));
        if (saved) {
          const rel = vscode.workspace.asRelativePath(saved, false);
          this.post({ type: 'notice', text: `Saved ${rel}` });
        }
        break;
      }
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:adilmustafa.jarvis-ai-chat');
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
    const ws = vscode.workspace.workspaceFolders?.[0]?.name;
    const system = [cfg.get<string>('systemPrompt', ''), ws ? `The user's project folder is "${ws}".` : '', this.agentMode() ? AGENT_PROMPT : '']
      .filter(Boolean).join('\n\n');
    const budget = cfg.get<number>('maxContextChars', 24000);
    const IMAGE_COST = 1000;
    const msgs: ChatMessage[] = [];
    let used = system.length;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i];
      let text = h.role === 'user' ? composeUserText(h.content, h.attachments) : h.content;
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
            { type: 'text' as const, text },
          ] }
        : { role: h.role, content: text });
    }
    if (system) msgs.unshift({ role: 'system', content: system });
    return msgs;
  }

  /** Try each usable key once. */
  private async tryKeys(hasImages: boolean, notes: string[], override?: ChatMessage[]): Promise<{ text: string; via: string } | undefined> {
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
        const messages = override ?? this.buildMessages(supportsImages(p.kind));
        const stream = !override;
        if (stream) this.postStream('');
        const res = await completeStream(endpointOf(p), await this.store.getKey(p.id), messages, attempt.signal,
          text => { if (stream) this.postStream(text); });
        // Providers without streaming get a short typing animation so replies don't appear all at once.
        if (stream && !res.streamed) await this.typeOut(res.text);
        clearTimeout(this.streamTimer);
        this.streamTimer = undefined;
        await this.store.recordSuccess(p.id);
        if (res.reportedDailyLimit && p.presetId === 'apifreellm' && res.reportedDailyLimit !== p.dailyLimit) {
          await this.store.upsert({ ...p, dailyLimit: res.reportedDailyLimit });
        }
        if (p.id !== this.store.activeId()) {
          notes.push(`Switched to ${p.name}.`);
          await this.store.setActive(p.id);
        }
        return { text: res.text, via: `${p.name} · ${p.model}` };
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
    return undefined;
  }

  private streamTimer?: NodeJS.Timeout;
  private streamLatest = '';

  /** Throttled stream updates to the webview (~25 fps). */
  private postStream(text: string): void {
    this.streamLatest = text;
    if (!text) { clearTimeout(this.streamTimer); this.streamTimer = undefined; this.post({ type: 'stream', text: '' }); return; }
    if (this.streamTimer) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = undefined;
      this.post({ type: 'stream', text: this.streamLatest });
    }, 40);
  }

  private async typeOut(text: string): Promise<void> {
    const steps = Math.min(45, Math.max(4, Math.ceil(text.length / 30)));
    for (let i = 1; i <= steps; i++) {
      if (this.abort?.signal.aborted) return;
      let cut = Math.round((text.length * i) / steps);
      const space = text.indexOf(' ', cut);
      if (i < steps && space > 0 && space - cut < 12) cut = space;
      this.post({ type: 'stream', text: text.slice(0, cut) });
      await new Promise(r => setTimeout(r, 18));
    }
  }

  /** tryKeys with automatic waiting when only rate-limited keys remain. */
  private async askModel(hasImages: boolean, notes: string[], override?: ChatMessage[]): Promise<{ text: string; via: string } | undefined> {
    const MAX_WAIT_MS = 65_000;
    for (let round = 0; round < 3; round++) {
      const res = await this.tryKeys(hasImages, notes, override);
      if (res) return res;
      const wait = await this.soonestCooldown(hasImages);
      if (wait === undefined || wait > MAX_WAIT_MS) return undefined;
      const secs = Math.ceil(wait / 1000);
      this.post({ type: 'waiting', seconds: secs });
      await this.sleep(wait);
      this.post({ type: 'waiting', seconds: 0 });
      notes.length = 0;
    }
    return undefined;
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

    if (!attachments.length && text.startsWith('/') && (await this.slashCommand(text))) return;

    // Image requests go to the image generator (no API key needed).
    const imagePrompt = attachments.length ? undefined : parseImageRequest(text);
    if (imagePrompt !== undefined) {
      await this.generateImage(text, imagePrompt);
      return;
    }

    if (this.store.profiles().length === 0) {
      this.post({ type: 'screen', screen: 'keys' });
      this.post({ type: 'error', text: 'Add an API key first.' });
      return;
    }

    attachments = await this.withMentionedFiles(text, attachments);
    const hasImages = attachments.some(a => a.kind === 'image');
    this.history.push({ role: 'user', content: text, attachments });
    this.busy = true;
    this.abort = new AbortController();
    await this.refresh();

    const notes: string[] = [];
    let answered = false;
    try {
      let res = await this.askModel(hasImages, notes);
      if (!res && hasImages && notes.some(n => n.includes("can't read images"))) {
        // No vision key available: answer from the text and say the image was skipped.
        const skipped = [...notes];
        notes.length = 0;
        res = await this.askModel(false, notes);
        if (res) notes.push("None of your keys can see images, so the image was skipped and I answered from your text. Add a Gemini (free), OpenAI, Claude or OpenRouter key to include images.");
        else notes.unshift(...skipped);
      }
      if (res) {
        answered = true;
        this.history.push({ role: 'assistant', content: res.text, via: res.via });
        if (notes.length) this.post({ type: 'notice', text: notes.join('\n') });
        notes.length = 0;
        if (this.speakMode() || this.live) this.speaking = this.speaker.speak(res.text);
        if (this.agentMode()) await this.agentLoop(hasImages, notes);
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
      if (!answered) {
        this.history.pop();
        this.post({ type: 'notice', text: 'Stopped.', restore: text, attachments });
      } else {
        this.post({ type: 'notice', text: 'Stopped.' });
      }
    } finally {
      this.clearPermission();
      this.busy = false;
      this.abort = undefined;
      this.post({ type: 'waiting', seconds: 0 });
      await this.persist();
      await this.refresh();
    }
  }

  // --- agent mode ---

  private agentMode(): boolean {
    return vscode.workspace.getConfiguration('jarvis').get<boolean>('agentMode', true);
  }

  /** Ask the user in the chat panel; resolves when they click a button (or Stop). */
  private askPermission(req: PermissionRequest): Promise<Decision> {
    const id = Math.random().toString(36).slice(2);
    const code = req.code && req.code.length > 6000 ? req.code.slice(0, 6000) + '\n…' : req.code;
    this.pendingPermission = { ...req, id };
    this.post({ type: 'permission', permission: { ...req, code, id } });
    return new Promise(resolve => {
      const finish = (d: Decision) => {
        this.perms.delete(id);
        this.abort?.signal.removeEventListener('abort', onAbort);
        this.clearPermission();
        resolve(d);
      };
      const onAbort = () => finish('deny');
      this.abort?.signal.addEventListener('abort', onAbort, { once: true });
      this.perms.set(id, finish);
    });
  }

  private clearPermission(): void {
    if (!this.pendingPermission) return;
    this.pendingPermission = undefined;
    this.post({ type: 'permission', permission: undefined });
  }

  /** Execute file writes / commands from the last reply, feeding command output back to the model. */
  private async agentLoop(hasImages: boolean, notes: string[]): Promise<void> {
    const root = workspaceRoot();
    for (let step = 0; step < 4; step++) {
      const last = this.history.at(-1);
      if (!last || last.role !== 'assistant') return;
      const actions = parseActions(last.content);
      if (!actions.length) return;
      if (!root) {
        this.post({ type: 'notice', text: 'Open a project folder so Jarvis can write files and run commands.' });
        return;
      }
      const lines: string[] = [];
      const log: NonNullable<HistoryEntry['actions']> = [];
      let needsReply = false;
      const cfg = vscode.workspace.getConfiguration('jarvis');
      for (const a of actions) {
        if (a.kind === 'read' || a.kind === 'list') {
          const label = a.kind === 'read' ? a.paths.join(', ') : a.path;
          let d: Decision = this.allow.read || cfg.get<boolean>('autoApproveReads', true) ? 'allow' : await this.askPermission({
            kind: 'read', title: a.kind === 'read' ? `Let Jarvis read ${a.paths.length === 1 ? a.paths[0] : `${a.paths.length} files`}?` : `Let Jarvis list ${a.path}?`,
            command: a.kind === 'read' ? a.paths.join('\n') : a.path,
          });
          if (d === 'always' || d === 'file') { this.allow.read = true; d = 'allow'; }
          if (d === 'deny') {
            lines.push(`User declined access to ${label}.`);
            log.push({ kind: 'read', label, ok: false, output: 'Declined' });
            continue;
          }
          needsReply = true;
          if (a.kind === 'list') {
            try {
              const isRoot = ['', '.', './', '/'].includes(a.path.trim());
              const dir = isRoot ? root : resolveWorkspacePath(a.path).uri.fsPath;
              const files = await walk(dir, '', [], 400);
              lines.push(`Files in ${isRoot ? 'the project root' : a.path}:\n${files.join('\n') || '(empty)'}`);
              log.push({ kind: 'read', label: `list ${a.path}`, ok: true, output: `${files.length} files` });
            } catch (e: any) {
              lines.push(`Could not list ${a.path}: ${e?.message ?? e}`);
              log.push({ kind: 'read', label: `list ${a.path}`, ok: false, output: String(e?.message ?? e) });
            }
            continue;
          }
          let budget = 40_000;
          for (const rp of a.paths) {
            try {
              const { uri, rel } = resolveWorkspacePath(rp);
              const att = await fromUri(uri);
              let text = att.text ?? '';
              if (att.kind === 'image') text = '(image file; cannot be shown as text)';
              if (text.length > Math.min(20_000, budget)) text = text.slice(0, Math.min(20_000, budget)) + '\n… [truncated]';
              budget -= text.length;
              lines.push(`--- ${rel} ---\n${text}`);
              log.push({ kind: 'read', label: rel, ok: true, output: 'Read' });
            } catch (e: any) {
              lines.push(`Could not read ${rp}: ${e?.message ?? 'not found'}`);
              log.push({ kind: 'read', label: rp, ok: false, output: 'Not found' });
            }
          }
        } else if (a.kind === 'write') {
          let exists = true;
          try { await vscode.workspace.fs.stat(vscode.Uri.file(require('path').join(root, a.path))); } catch { exists = false; }
          const approved = this.allow.write || this.allow.files.has(a.path) || cfg.get<boolean>('autoApproveEdits', false);
          let d: Decision = approved ? 'allow' : await this.askPermission({
            kind: 'write', title: `${exists ? 'Edit' : 'Create'} ${a.path}?`, path: a.path, code: a.code, exists,
          });
          if (d === 'always') { this.allow.write = true; d = 'allow'; }
          if (d === 'file') { this.allow.files.add(a.path); d = 'allow'; }
          if (d === 'deny') {
            lines.push(`User declined writing ${a.path}.`);
            log.push({ kind: 'write', label: a.path, ok: false, output: 'Declined' });
            continue;
          }
          try {
            const r = await writeWorkspaceFile(a.path, a.code);
            lines.push(`${r.created ? 'Created' : 'Updated'} ${r.rel} (${a.code.split('\n').length} lines).`);
            log.push({ kind: 'write', label: r.rel, ok: true, output: r.created ? 'Created' : 'Updated' });
          } catch (e: any) {
            lines.push(`Failed to write ${a.path}: ${e?.message ?? e}`);
            log.push({ kind: 'write', label: a.path, ok: false, output: String(e?.message ?? e) });
          }
        } else {
          const danger = isDangerous(a.command);
          const approved = !danger && (this.allow.run || cfg.get<boolean>('autoApproveCommands', false));
          let d: Decision = approved ? 'allow' : await this.askPermission({
            kind: 'run', title: danger ? 'Run this potentially destructive command?' : 'Run this command?', command: a.command, danger,
          });
          if (d === 'always' || d === 'file') { this.allow.run = true; d = 'allow'; }
          if (d === 'deny') {
            lines.push(`User declined running: ${a.command}`);
            log.push({ kind: 'run', label: a.command, ok: false, output: 'Declined' });
            continue;
          }
          const r = await this.execute(a.command, root);
          needsReply = true;
          const out = r.output || '(no output)';
          lines.push(`$ ${a.command}\nexit code ${r.code}${r.timedOut ? ' (timed out)' : ''}\n${out}`);
          log.push({ kind: 'run', label: a.command, ok: r.code === 0, output: out, code: r.code });
        }
      }
      this.history.push({ role: 'user', tool: true, actions: log, content: `Results of the actions you requested:\n\n${lines.join('\n\n')}` });
      await this.refresh();
      if (!needsReply) return;
      // Let the model react to file contents / command output.
      const res = await this.askModel(hasImages, notes);
      if (!res) {
        this.post({ type: 'error', text: `Couldn't continue: ${notes.join('\n') || 'no key available'}` });
        return;
      }
      this.history.push({ role: 'assistant', content: res.text, via: res.via });
      await this.refresh();
    }
  }

  /** Run a command in the visible Jarvis terminal when possible, else in the background. */
  private async execute(command: string, root: string) {
    this.post({ type: 'status', text: `Running ${command.split('\n')[0].slice(0, 60)}…` });
    try {
      if (vscode.workspace.getConfiguration('jarvis').get<boolean>('runInTerminal', true)) {
        const r = await runInTerminal(command, root, this.abort?.signal);
        if (r) return r;
      }
      return await runCommand(command, root, this.abort?.signal);
    } finally {
      this.post({ type: 'status', text: '' });
    }
  }

  // --- slash commands ---

  /** Returns true if the text was a command that has been handled. */
  private async slashCommand(text: string): Promise<boolean> {
    const m = text.match(/^\/(\w+)\b\s*([\s\S]*)$/);
    if (!m) return false;
    const cmd = m[1].toLowerCase();
    const arg = m[2].trim();
    const say = async (content: string) => {
      this.history.push({ role: 'user', content: text });
      this.history.push({ role: 'assistant', content, via: 'Jarvis' });
      await this.persist();
      await this.refresh();
    };
    const editorFile = (): Attachment | undefined => {
      const ed = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors[0];
      if (!ed) { this.post({ type: 'error', text: 'Open a file in the editor first.' }); return undefined; }
      return fromEditor(ed, true);
    };
    const fileTasks: Record<string, string> = {
      explain: 'Explain what this code does and how it works, step by step.',
      fix: this.agentMode()
        ? 'Find the bugs in this file and fix them. Output the complete fixed file with path= so it can be written.'
        : 'Find bugs or problems in this code and show a fixed version.',
      tests: this.agentMode()
        ? 'Write unit tests for this file using the project\'s test setup. Create the test file with path= and give the command to run them in a `bash run` block.'
        : 'Write unit tests for this code.',
      review: 'Review this code: correctness, edge cases, readability, performance. Be specific.',
      doc: this.agentMode()
        ? 'Add clear documentation comments to this file. Output the complete updated file with path=.'
        : 'Write documentation comments for this code.',
    };

    switch (cmd) {
      case 'help': await say(HELP); return true;
      case 'new': case 'clear': this.newChat(); return true;
      case 'keys': this.post({ type: 'screen', screen: 'keys' }); return true;
      case 'account': this.post({ type: 'screen', screen: 'account' }); return true;
      case 'chats': case 'history': this.post({ type: 'screen', screen: 'chats' }); return true;
      case 'agent': {
        const on = arg ? /^(on|yes|true|1)$/i.test(arg) : !this.agentMode();
        await vscode.workspace.getConfiguration('jarvis').update('agentMode', on, vscode.ConfigurationTarget.Global);
        await say(on
          ? 'Agent mode is **on**. I can create and edit files and run commands in your project. I\'ll ask your permission each time.'
          : 'Agent mode is **off**. I\'ll only suggest changes; use **Apply** on code blocks to write them.');
        return true;
      }
      case 'explain': case 'fix': case 'tests': case 'test': case 'review': case 'doc': case 'docs': {
        const key = cmd === 'test' ? 'tests' : cmd === 'docs' ? 'doc' : cmd;
        const file = editorFile();
        if (file) await this.send(arg ? `${fileTasks[key]}\n\n${arg}` : fileTasks[key], [file]);
        return true;
      }
      case 'project': {
        const root = workspaceRoot();
        if (!root) { this.post({ type: 'error', text: 'Open a project folder first.' }); return true; }
        this.post({ type: 'status', text: 'Reading project…' });
        const att = await fromFolder(root, vscode.workspace.workspaceFolders![0].name);
        await this.send(arg || 'Give me an overview of this project: what it does, how it is structured, and how to run it.', [att]);
        return true;
      }
      case 'diff': {
        const git = await this.gitChanges();
        if (!git) return true;
        await this.send(arg || 'Review these uncommitted changes. Point out bugs, risky parts and anything missing.', [
          { id: 'diff', kind: 'text', name: 'git-diff.patch', size: git.length, text: git },
        ]);
        return true;
      }
      case 'commit': await this.gitCommit(text, arg); return true;
      case 'push': await this.gitPush(text); return true;
      case 'run': case 'sh': case 'terminal': {
        if (!arg) { await say('Usage: `/run <command>`, e.g. `/run npm test`'); return true; }
        await this.runUserCommand(text, arg);
        return true;
      }
      default:
        return false; // /image and unknown commands continue as normal messages
    }
  }

  private async runUserCommand(text: string, command: string): Promise<void> {
    const root = workspaceRoot();
    if (!root) { this.post({ type: 'error', text: 'Open a project folder first.' }); return; }
    this.history.push({ role: 'user', content: text });
    this.busy = true;
    this.abort = new AbortController();
    await this.refresh();
    try {
      const danger = isDangerous(command);
      const d = await this.askPermission({ kind: 'run', title: danger ? 'Run this potentially destructive command?' : 'Run this command?', command, danger });
      if (d === 'deny') {
        this.history.push({ role: 'user', tool: true, content: `User declined running: ${command}`, actions: [{ kind: 'run', label: command, ok: false, output: 'Declined' }] });
        return;
      }
      this.post({ type: 'status', text: `Running ${command.slice(0, 60)}…` });
      const r = await this.execute(command, root);
      const out = r.output || '(no output)';
      this.history.push({
        role: 'user', tool: true,
        content: `Output of \`${command}\` (exit code ${r.code}):\n${out}`,
        actions: [{ kind: 'run', label: command, ok: r.code === 0, output: out, code: r.code }],
      });
    } finally {
      this.busy = false;
      this.abort = undefined;
      this.post({ type: 'status', text: '' });
      this.clearPermission();
      await this.persist();
      await this.refresh();
    }
  }

  // --- git ---

  /** Status + diff of uncommitted changes, or undefined (with a message) if none. */
  private async gitChanges(): Promise<string | undefined> {
    const root = workspaceRoot();
    if (!root) { this.post({ type: 'error', text: 'Open a project folder first.' }); return undefined; }
    const status = await runFile('git', ['status', '--porcelain'], root);
    if (status.code !== 0) { this.post({ type: 'error', text: 'This folder is not a git repository.' }); return undefined; }
    if (!status.output.trim()) { this.post({ type: 'notice', text: 'No uncommitted changes.' }); return undefined; }
    const diff = await runFile('git', ['diff', 'HEAD', '--no-color'], root);
    const body = diff.code === 0 ? diff.output : (await runFile('git', ['diff', '--no-color'], root)).output;
    return `git status:\n${status.output}\n\ngit diff:\n${body.slice(0, 16000)}`;
  }

  private async gitCommit(text: string, hint: string): Promise<void> {
    const root = workspaceRoot();
    const changes = await this.gitChanges();
    if (!changes || !root) return;
    if (!this.store.profiles().length) { this.post({ type: 'error', text: 'Add an API key first.' }); return; }
    this.history.push({ role: 'user', content: text });
    this.busy = true;
    this.abort = new AbortController();
    await this.refresh();
    const notes: string[] = [];
    try {
      this.post({ type: 'status', text: 'Writing commit message…' });
      const res = await this.askModel(false, notes, [
        { role: 'system', content: 'You write clear git commit messages.' },
        { role: 'user', content: `Write a git commit message for these changes: an imperative subject line under 72 characters, then (only if useful) a blank line and a short bullet list.${hint ? ` Note from the user: ${hint}.` : ''} Reply with ONLY the commit message, no code fences.\n\n${changes}` },
      ]);
      this.post({ type: 'status', text: '' });
      if (!res) { this.post({ type: 'error', text: `Couldn't write a commit message: ${notes.join('\n')}` }); return; }
      const message = res.text.replace(/^```\w*\n?/, '').replace(/```\s*$/, '').replace(/^["']|["']$/g, '').trim();
      this.history.push({ role: 'assistant', content: `Proposed commit message:\n\n\`\`\`\n${message}\n\`\`\``, via: res.via });
      await this.refresh();
      const d = await this.askPermission({ kind: 'commit', title: 'Commit all changes with this message?', message, command: 'git add -A && git commit' });
      if (d === 'deny') {
        this.history.push({ role: 'user', tool: true, content: 'User cancelled the commit.', actions: [{ kind: 'git', label: 'commit', ok: false, output: 'Cancelled' }] });
        return;
      }
      await runFile('git', ['add', '-A'], root);
      const r = await runFile('git', ['commit', '-m', message], root);
      this.history.push({ role: 'user', tool: true, content: `git commit (exit ${r.code}):\n${r.output}`, actions: [{ kind: 'git', label: 'git commit', ok: r.code === 0, output: r.output, code: r.code }] });
    } finally {
      this.busy = false;
      this.abort = undefined;
      this.post({ type: 'status', text: '' });
      this.clearPermission();
      await this.persist();
      await this.refresh();
    }
  }

  private async gitPush(text: string): Promise<void> {
    const root = workspaceRoot();
    if (!root) { this.post({ type: 'error', text: 'Open a project folder first.' }); return; }
    this.history.push({ role: 'user', content: text });
    this.busy = true;
    this.abort = new AbortController();
    await this.refresh();
    try {
      const branch = (await runFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root)).output.trim();
      const d = await this.askPermission({ kind: 'push', title: `Push "${branch}" to the remote?`, command: 'git push' });
      if (d === 'deny') return;
      this.post({ type: 'status', text: 'Pushing…' });
      const r = await runFile('git', ['push'], root);
      this.history.push({ role: 'user', tool: true, content: `git push (exit ${r.code}):\n${r.output}`, actions: [{ kind: 'git', label: 'git push', ok: r.code === 0, output: r.output || 'Done', code: r.code }] });
    } finally {
      this.busy = false;
      this.abort = undefined;
      this.post({ type: 'status', text: '' });
      this.clearPermission();
      await this.persist();
      await this.refresh();
    }
  }

  // --- speak & live voice ---

  private speakMode(): boolean {
    return vscode.workspace.getConfiguration('jarvis').get<boolean>('speakReplies', false);
  }

  /** Hands-free conversation: listen → transcribe → answer → speak → listen again. */
  private async liveLoop(): Promise<void> {
    if (this.live) return;
    const vk = await this.voiceKey();
    if (!vk) {
      this.post({ type: 'error', text: `Live voice needs a Groq (free) or OpenAI key to understand speech. Add one in Keys (Groq: console.groq.com/keys).\n\n${DICTATION_HINT}` });
      return;
    }
    this.live = true;
    await this.refresh();
    let idleRounds = 0;
    try {
      while (this.live) {
        if (this.speaking) { await this.speaking; this.speaking = undefined; }
        if (!this.live) break;
        this.post({ type: 'voice', state: 'listening' });
        const file = await this.recorder.recordUntilSilence();
        if (!this.live) break;
        if (!file) {
          if (this.recorder.lastError) throw new Error(this.recorder.lastError);
          if (++idleRounds >= 3) { this.post({ type: 'notice', text: 'Live voice paused: nothing heard for a while.' }); break; }
          continue;
        }
        idleRounds = 0;
        this.post({ type: 'voice', state: 'transcribing' });
        const text = await transcribe(file, vk.provider, vk.key);
        if (!this.live) break;
        if (!text || /^(\W|you|thank you\.?)$/i.test(text)) continue;  // Whisper noise
        if (/^(stop|goodbye|bye|end (the )?(chat|conversation)|exit)[.!]?$/i.test(text)) break;
        this.post({ type: 'voice', state: 'thinking' });
        await this.send(text);
      }
    } catch (e: any) {
      this.post({ type: 'error', text: e?.message ?? String(e) });
    } finally {
      this.live = false;
      this.recorder.cancel();
      this.post({ type: 'voice', state: 'idle' });
      await this.refresh();
    }
  }

  // --- voice ---

  private async voiceKey(): Promise<{ provider: 'groq' | 'openai'; key: string } | undefined> {
    for (const p of this.store.profiles()) {
      if (!p.enabled || (p.presetId !== 'groq' && p.presetId !== 'openai')) continue;
      const key = await this.store.getKey(p.id);
      if (key) return { provider: p.presetId, key };
    }
    return undefined;
  }

  private async voiceStart(): Promise<void> {
    if (!(await this.voiceKey())) {
      this.post({ type: 'voice', state: 'idle' });
      this.post({ type: 'error', text: `Voice input needs a Groq (free) or OpenAI key to turn speech into text. Add one in Keys (Groq: console.groq.com/keys).\n\n${DICTATION_HINT}` });
      return;
    }
    try {
      await this.recorder.start();
      this.post({ type: 'voice', state: 'recording' });
    } catch (e: any) {
      this.post({ type: 'voice', state: 'idle' });
      this.post({ type: 'error', text: e?.message ?? String(e) });
    }
  }

  private async voiceStop(): Promise<void> {
    const vk = await this.voiceKey();
    try {
      this.post({ type: 'voice', state: 'transcribing' });
      const file = await this.recorder.stop();
      const text = await transcribe(file, vk!.provider, vk!.key);
      this.post({ type: 'voiceText', text });
    } catch (e: any) {
      this.post({ type: 'error', text: e?.message ?? String(e) });
    } finally {
      this.post({ type: 'voice', state: 'idle' });
    }
  }

  // --- image generation ---

  /** Ask the webview to re-encode an image as PNG (canvas). Falls back to undefined. */
  private toPng(dataUrl: string): Promise<string | undefined> {
    return new Promise(resolve => {
      const reqId = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { this.pngWaiters.delete(reqId); resolve(undefined); }, 15_000);
      this.pngWaiters.set(reqId, url => { clearTimeout(timer); resolve(url); });
      this.post({ type: 'toPng', reqId, dataUrl });
    });
  }

  private async generateImage(userText: string, prompt: string): Promise<void> {
    this.history.push({ role: 'user', content: userText });
    if (!prompt) {
      this.history.push({
        role: 'assistant', via: 'Image generator',
        content: 'What should the image show? For example:\n\n`/image a bird flying over mountains at sunset`',
      });
      await this.persist();
      await this.refresh();
      return;
    }
    this.busy = true;
    this.abort = new AbortController();
    await this.refresh();
    this.post({ type: 'status', text: 'Generating image… (10–30 seconds)' });
    try {
      const size = vscode.workspace.getConfiguration('jarvis').get<string>('imageSize', '1024x1024');
      const img = await fetchImage(prompt, size, this.abort.signal, (secs, n) => {
        this.post({ type: 'status', text: `Image service busy, retry ${n}/2…` });
        this.post({ type: 'waiting', seconds: secs });
      });
      this.post({ type: 'waiting', seconds: 0 });
      const original = `data:${img.mime};base64,${Buffer.from(img.bytes).toString('base64')}`;
      const png = img.mime === 'image/png' ? original : await this.toPng(original);
      const dataUrl = png ?? original;
      const bytes = png ? Buffer.from(png.split(',')[1], 'base64') : img.bytes;
      const ext = png ? 'png' : (img.mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const saved = await saveImage(`${slugify(prompt)}.${ext}`, bytes);
      const rel = saved ? vscode.workspace.asRelativePath(saved, false) : undefined;
      this.history.push({
        role: 'assistant', via: 'Image generator · pollinations.ai',
        content: rel ? `Here's your image. Saved as \`${rel}\`.` : "Here's your image (not saved).",
        attachments: [{ id: Math.random().toString(36).slice(2), kind: 'image', name: rel ?? 'image', size: bytes.length, dataUrl }],
        savedPath: rel,
      });
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        this.post({ type: 'notice', text: 'Stopped.' });
      } else {
        this.history.push({ role: 'assistant', via: 'Image generator', content: `Couldn't generate the image: ${e?.message ?? e}` });
      }
    } finally {
      this.busy = false;
      this.abort = undefined;
      this.post({ type: 'status', text: '' });
      await this.persist();
      await this.refresh();
    }
  }

  // --- @file mentions ---

  /** Workspace files (relative paths), cached briefly. */
  private async workspaceFiles(): Promise<string[]> {
    if (this.fileCache && Date.now() - this.fileCache.at < 30_000) return this.fileCache.files;
    const exclude = '{**/node_modules/**,**/.git/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/dist/**,**/out/**,**/target/**,**/build/**,**/.next/**,**/*.vsix}';
    const uris = await vscode.workspace.findFiles('**/*', exclude, 20000);
    const paths = uris.map(u => vscode.workspace.asRelativePath(u, false));
    const dirs = new Set<string>();
    for (const f of paths) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
    }
    const files = [...paths, ...dirs].sort((a, b) => a.length - b.length || a.localeCompare(b));
    this.fileCache = { at: Date.now(), files };
    return files;
  }

  /** Rank files for an @query: name prefix > name contains > path contains > fuzzy. */
  private matchFiles(files: string[], query: string): string[] {
    const q = query.toLowerCase();
    if (!q) return files.slice(0, 30);
    const scored: [number, string][] = [];
    for (const f of files) {
      const lower = f.toLowerCase();
      const name = lower.replace(/\/$/, '').split('/').pop()!;
      let score = -1;
      if (name === q) score = 0;
      else if (name.startsWith(q)) score = 1;
      else if (name.includes(q)) score = 2;
      else if (lower.includes(q)) score = 3;
      else {
        let i = 0;
        for (const ch of lower) if (ch === q[i]) i++;
        if (i === q.length) score = 4;
      }
      if (score >= 0) scored.push([score, f]);
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length).slice(0, 30).map(x => x[1]);
  }

  /** Attach files written as @path in the message that aren't attached yet. */
  private async withMentionedFiles(text: string, attachments: Attachment[]): Promise<Attachment[]> {
    const ws = vscode.workspace.workspaceFolders?.[0];
    const mentions = [...text.matchAll(/(?:^|\s)@([\w./-]+[\w/-])/g)].map(m => m[1]);
    if (!ws || !mentions.length) return attachments;
    const out = [...attachments];
    for (const rel of new Set(mentions)) {
      if (out.some(a => a.name === rel || a.name.split(':')[0] === rel)) continue;
      try { out.push(await fromUri(vscode.Uri.joinPath(ws.uri, rel))); } catch { /* not a file; leave as text */ }
    }
    return out;
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

type Decision = 'allow' | 'always' | 'file' | 'deny';

interface PermissionRequest {
  kind: 'write' | 'run' | 'read' | 'commit' | 'push';
  title: string;
  path?: string;
  code?: string;
  command?: string;
  message?: string;
  danger?: boolean;
  exists?: boolean;
}

const HELP = [
  '**Commands**',
  '- `/image <description>`: generate an image and save it in your project',
  '- `/explain`, `/fix`, `/tests`, `/review`, `/doc`: work on the open file (or selection)',
  '- `/project [question]`: include your whole project (tree + files) and ask',
  '- `/diff`: review your uncommitted git changes',
  '- `/commit`: write a commit message from your changes and commit (asks first)',
  '- `/push`: git push (asks first)',
  '- `/run <command>`: run a shell command in your project (asks first)',
  '- `/agent on` · `/agent off`: let Jarvis create/edit files and run commands (always asks permission)',
  '- `/new`, `/clear`, `/keys`, `/account`, `/chats`, `/help`',
  '',
  '**Tips**: type `@` to add a file or folder · attach zips, folders and images with 📎 · 🎤 for voice.',
].join('\n');
