import * as vscode from 'vscode';
import { ProposalProvider } from './apply';
import { ChatViewProvider } from './chatView';
import { PRESETS } from './providers';
import { initSettings, schemaIsStale } from './settings';
import { Store } from './store';
import { checkForUpdates } from './updater';

export function activate(ctx: vscode.ExtensionContext): void {
  initSettings(ctx);
  if (schemaIsStale()) {
    // Extension code was updated but the editor still has the old settings list.
    vscode.window.showWarningMessage('Jarvis AI Chat & Code Assistant was updated. Reload the window to finish the update.', 'Reload now')
      .then(r => { if (r) vscode.commands.executeCommand('workbench.action.reloadWindow'); });
  }
  const store = new Store(ctx);
  const proposals = new ProposalProvider();
  const chat = new ChatViewProvider(ctx, store, proposals);

  setTimeout(() => { checkForUpdates(ctx, true).catch(() => {}); }, 15_000);

  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ProposalProvider.scheme, proposals),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand('jarvis.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('jarvis.checkForUpdates', () => checkForUpdates(ctx, false)),
    vscode.commands.registerCommand('jarvis.manageKeys', () => chat.reveal('keys')),
    vscode.commands.registerCommand('jarvis.attachActiveFile', () => chat.attachActiveFile(false)),
    vscode.commands.registerCommand('jarvis.attachFromExplorer', async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const list = uris?.length ? uris : uri ? [uri] : [];
      if (!list.length) return chat.attachActiveFile(false);
      await chat.reveal('chat');
      await chat.attachFiles(list);
    }),

    // Command-palette flow for adding a key without opening the sidebar form.
    vscode.commands.registerCommand('jarvis.setApiKey', async () => {
      const pick = await vscode.window.showQuickPick(
        PRESETS.map(p => ({ label: p.label, description: p.baseUrl, preset: p })),
        { title: 'Jarvis: which provider is this key for?' },
      );
      if (!pick) return;
      const p = pick.preset;
      let baseUrl = p.baseUrl;
      if (p.id === 'custom') {
        baseUrl = (await vscode.window.showInputBox({
          title: 'Base URL', placeHolder: 'https://example.com/v1', ignoreFocusOut: true,
        })) ?? '';
        if (!baseUrl) return;
      }
      const key = await vscode.window.showInputBox({
        title: `${p.label} API key`, password: true, ignoreFocusOut: true,
        placeHolder: p.needsKey ? 'Paste your key' : 'Optional; leave empty if not needed',
      });
      if (key === undefined || (p.needsKey && !key.trim())) return;
      const model = p.kind === 'apifreellm' ? p.defaultModel : await vscode.window.showInputBox({
        title: 'Model', value: p.defaultModel, ignoreFocusOut: true,
      });
      if (model === undefined) return;

      const id = `${p.id}-${Date.now().toString(36)}`;
      const n = store.profiles().filter(x => x.presetId === p.id).length;
      await store.upsert({
        id, name: n ? `${p.label} #${n + 1}` : p.label, presetId: p.id, kind: p.kind,
        baseUrl, model: model.trim() || p.defaultModel, dailyLimit: p.dailyLimit, enabled: true,
      });
      if (key.trim()) await store.setKey(id, key.trim());
      await store.setActive(id);
      await chat.refresh();
      await chat.reveal('chat');
      vscode.window.showInformationMessage(`Jarvis: ${p.label} key saved. Start chatting!`);
    }),

    vscode.commands.registerCommand('jarvis.clearApiKey', async () => {
      const list = store.profiles();
      if (!list.length) return vscode.window.showInformationMessage('No keys saved.');
      const pick = await vscode.window.showQuickPick(
        list.map(p => ({ label: p.name, description: p.model, id: p.id })),
        { title: 'Remove which key?' },
      );
      if (pick) {
        await store.remove(pick.id);
        await chat.refresh();
      }
    }),

    vscode.commands.registerCommand('jarvis.askSelection', async () => {
      const ctxText = selectionContext();
      if (!ctxText) return;
      const q = await vscode.window.showInputBox({
        title: 'Ask Jarvis about the selected code', placeHolder: 'e.g. How can I make this faster?',
      });
      if (q) await chat.ask(`${q}\n\n${ctxText}`);
    }),
    vscode.commands.registerCommand('jarvis.explainSelection', async () => {
      const ctxText = selectionContext();
      if (ctxText) await chat.ask(`Explain what this code does, step by step:\n\n${ctxText}`);
    }),
    vscode.commands.registerCommand('jarvis.fixSelection', async () => {
      const ctxText = selectionContext();
      if (ctxText) await chat.ask(`Find bugs or problems in this code and show a fixed version:\n\n${ctxText}`);
    }),
  );
}

function selectionContext(): string | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.selection.isEmpty) {
    vscode.window.showInformationMessage('Select some code first.');
    return;
  }
  const code = ed.document.getText(ed.selection);
  const file = vscode.workspace.asRelativePath(ed.document.uri);
  return `File: ${file} (${ed.document.languageId})\n\`\`\`${ed.document.languageId}\n${code}\n\`\`\``;
}

export function deactivate(): void {}
