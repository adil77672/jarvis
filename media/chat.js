// Jarvis chat webview UI. Plain DOM, no framework.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  let state = { profiles: [], activeId: undefined, history: [], busy: false, presets: [] };
  let screen = 'chat';
  let editing = null;      // profile form data when the add/edit form is open
  let banner = null;       // { kind: 'error' | 'notice', text }
  let draft = (vscode.getState() || {}).draft || '';
  let pending = [];        // attachments waiting to be sent
  let waitingUntil = 0;    // rate-limit countdown end (ms)
  const MAX_IMAGE = 5 * 1024 * 1024, MAX_TEXT = 200000;
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

  const send = (type, data = {}) => vscode.postMessage({ type, ...data });
  const saveDraft = () => vscode.setState({ draft });

  // ---------- helpers ----------

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else if (k === 'value') e.value = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function inline(s) {
    return escapeHtml(s)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  }

  /** Minimal Markdown: fenced code blocks, headings, lists, paragraphs. */
  function renderMarkdown(text) {
    const frag = document.createDocumentFragment();
    const parts = text.split(/```/);
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf('\n');
        const lang = nl >= 0 ? part.slice(0, nl).trim() : '';
        const code = (nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, '');
        frag.append(el('div', { class: 'code' },
          el('div', { class: 'code-bar' },
            el('span', {}, lang || 'code'),
            el('span', {},
              el('button', { class: 'link', onclick: () => send('copy', { text: code }) }, 'Copy'),
              el('button', { class: 'link', onclick: () => send('insert', { text: code }) }, 'Insert'))),
          el('pre', {}, el('code', {}, code))));
        return;
      }
      let list = null;
      for (const raw of part.split('\n')) {
        const line = raw.trimEnd();
        const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
        if (li) {
          if (!list) { list = el(/^\s*\d/.test(line) ? 'ol' : 'ul'); frag.append(list); }
          const item = el('li'); item.innerHTML = inline(li[1]); list.append(item);
          continue;
        }
        list = null;
        if (!line.trim()) continue;
        const h = line.match(/^(#{1,4})\s+(.*)$/);
        const node = el(h ? 'h4' : 'p');
        node.innerHTML = inline(h ? h[2] : line);
        frag.append(node);
      }
    });
    return frag;
  }

  const STATUS_LABEL = {
    ready: 'ready', exhausted: 'limit reached', cooldown: 'cooling down',
    invalid: 'key rejected', disabled: 'off', nokey: 'no key',
  };

  function usageText(p) {
    return p.dailyLimit > 0 ? `${p.used}/${p.dailyLimit} today` : `${p.used} today`;
  }

  function active() {
    return state.profiles.find(p => p.id === state.activeId);
  }

  // ---------- chat screen ----------

  function renderChat() {
    const p = active();
    const header = el('div', { class: 'toolbar' },
      el('select', {
        class: 'grow', title: 'Which key to use',
        onchange: e => send('selectProfile', { id: e.target.value }),
      }, state.profiles.map(x => el('option', { value: x.id, selected: x.id === state.activeId },
        `${x.name} (${STATUS_LABEL[x.status]})`))),
      p && el('span', { class: `badge ${p.status}`, title: p.lastError || 'Requests sent with this key today' }, usageText(p)),
      el('button', { class: 'icon', title: 'Keys & usage', onclick: () => go('keys') }, '⚙'));

    const modelRow = p && el('div', { class: 'toolbar' },
      el('label', { class: 'muted' }, 'Model'),
      el('input', {
        class: 'grow', value: p.model, list: 'model-list', disabled: p.kind === 'apifreellm',
        onchange: e => send('setModel', { id: p.id, model: e.target.value }),
      }),
      p.kind !== 'apifreellm' && el('button', {
        class: 'link', title: 'Load the model list from the provider',
        onclick: () => send('fetchModels', { id: p.id, presetId: p.presetId, target: 'chat' }),
      }, 'Load'),
      el('datalist', { id: 'model-list' },
        (modelCache.chat || presetModels(p.presetId)).map(m => el('option', { value: m }))));

    const log = el('div', { class: 'log', id: 'log' });
    if (!state.history.length) {
      log.append(el('div', { class: 'empty' },
        el('h3', {}, 'Jarvis'),
        el('p', {}, 'Ask anything, or select code and right-click → "Ask Jarvis About Selection" (⌘⇧J).'),
        el('p', { class: 'muted' }, 'When a key reaches its daily limit, Jarvis switches to your next key automatically.')));
    }
    for (const m of state.history) {
      const body = el('div', { class: 'body' });
      if (m.role === 'assistant') body.append(renderMarkdown(m.content));
      else {
        if (m.attachments && m.attachments.length) body.append(attachmentList(m.attachments, false));
        if (m.content) body.append(el('div', {}, m.content));
      }
      log.append(el('div', { class: `msg ${m.role}` },
        el('div', { class: 'who' }, m.role === 'user' ? 'You' : 'Jarvis', m.via && el('span', { class: 'muted' }, ` · ${m.via}`)),
        body));
    }
    if (state.busy) log.append(el('div', { class: 'msg assistant' }, el('div', { class: 'typing', id: 'typing' }, typingText())));

    const input = el('textarea', {
      id: 'input', rows: 3, placeholder: 'Ask Jarvis…  (Enter to send · paste or drop images/files)',
      onpaste: onPaste,
      oninput: e => { draft = e.target.value; saveDraft(); },
      onkeydown: e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
      },
    });
    input.value = draft;

    const imgWarn = p && p.kind === 'apifreellm' && pending.some(a => a.kind === 'image') &&
      el('div', { class: 'muted small' }, `⚠ ${p.name} can't read images; Jarvis will use another key that can, if you have one.`);
    const footer = el('div', { class: 'composer' },
      pending.length && attachmentList(pending, true),
      imgWarn,
      input,
      el('div', { class: 'toolbar' },
        el('button', { class: 'icon', title: 'Attach files or images', onclick: () => send('pickFiles') }, '📎'),
        el('button', { class: 'link', title: 'Attach the file open in the editor', onclick: () => send('attachActive') }, '+ Current file'),
        el('button', { class: 'link', onclick: () => send('newChat') }, 'New chat'),
        el('span', { class: 'grow' }),
        state.busy
          ? el('button', { class: 'secondary', onclick: () => send('stop') }, 'Stop')
          : el('button', { onclick: submit }, 'Send')));

    return [header, modelRow, bannerEl(), log, footer];
  }

  function submit() {
    const text = draft.trim();
    if ((!text && !pending.length) || state.busy) return;
    banner = null;
    const attachments = pending;
    pending = [];
    draft = ''; saveDraft();
    send('send', { text, attachments });
  }

  function typingText() {
    const secs = Math.ceil((waitingUntil - Date.now()) / 1000);
    return secs > 0 ? `Rate limited, retrying in ${secs}s… (Stop to cancel)` : 'Thinking…';
  }
  setInterval(() => {
    const t = document.getElementById('typing');
    if (t && waitingUntil) t.textContent = typingText();
  }, 1000);

  // ---------- attachments ----------

  function fmtSize(n) {
    return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
  }

  function attachmentList(list, removable) {
    return el('div', { class: 'attachments' }, list.map(a => el('div', { class: 'chip', title: a.name },
      a.kind === 'image' ? el('img', { src: a.dataUrl, alt: a.name }) : el('span', { class: 'file-icon' }, '📄'),
      el('span', { class: 'chip-name' }, a.name),
      el('span', { class: 'muted small' }, fmtSize(a.size)),
      removable && el('button', { class: 'link', title: 'Remove', onclick: () => { pending = pending.filter(x => x.id !== a.id); render(); } }, '✕'))));
  }

  function addPending(list) {
    for (const a of list) if (!pending.some(x => x.name === a.name && x.size === a.size)) pending.push(a);
    render();
    const input = document.getElementById('input');
    if (input) input.focus();
  }

  const uid = () => Math.random().toString(36).slice(2, 10);

  function readBrowserFile(file) {
    return new Promise((resolve, reject) => {
      const name = file.name || `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`;
      const isImage = (file.type || '').startsWith('image/') || IMAGE_EXT.test(name);
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Could not read ${name}`));
      if (isImage) {
        if (file.size > MAX_IMAGE) return reject(new Error(`${name} is larger than 5 MB.`));
        reader.onload = () => resolve({ id: uid(), kind: 'image', name, size: file.size, dataUrl: reader.result });
        reader.readAsDataURL(file);
      } else {
        reader.onload = () => {
          const bytes = new Uint8Array(reader.result);
          if (bytes.subarray(0, 8000).includes(0)) {
            return reject(new Error(`${name} looks like a binary file (PDF, zip, etc.). Only text/code files and images are supported.`));
          }
          let text = new TextDecoder().decode(bytes);
          if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '\n… [truncated]';
          resolve({ id: uid(), kind: 'text', name, size: file.size, text });
        };
        reader.readAsArrayBuffer(file);
      }
    });
  }

  async function addBrowserFiles(files) {
    const ok = [], errors = [];
    for (const f of files) {
      try { ok.push(await readBrowserFile(f)); } catch (e) { errors.push(e.message); }
    }
    if (errors.length) banner = { kind: 'error', text: errors.join('\n') };
    if (ok.length) addPending(ok); else render();
  }

  function onPaste(e) {
    const files = Array.from(e.clipboardData ? e.clipboardData.files : []);
    if (files.length) {
      e.preventDefault();
      addBrowserFiles(files);
    }
  }

  document.addEventListener('dragover', e => {
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', e => {
    if (!e.relatedTarget) document.body.classList.remove('dragging');
  });
  document.addEventListener('drop', e => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    if (screen !== 'chat') go('chat');
    const dt = e.dataTransfer;
    if (!dt) return;
    const files = Array.from(dt.files || []);
    if (files.length) return addBrowserFiles(files);
    // Dragged from the VS Code explorer or an editor tab: we get URIs.
    const uriList = dt.getData('application/vnd.code.uri-list') || dt.getData('text/uri-list') ||
      dt.getData('resourceurls') || dt.getData('text/plain');
    let uris = [];
    try { uris = JSON.parse(uriList); } catch { uris = (uriList || '').split(/\r?\n/); }
    uris = uris.filter(Boolean);
    if (uris.length) send('dropUris', { uris });
  });

  // ---------- keys screen ----------

  const modelCache = {};

  function presetModels(presetId) {
    return (state.presets.find(p => p.id === presetId) || {}).models || [];
  }

  function blankForm(presetId = 'apifreellm') {
    const pr = state.presets.find(p => p.id === presetId) || state.presets[0];
    return { id: '', presetId: pr.id, name: '', key: '', model: pr.defaultModel, baseUrl: pr.baseUrl, dailyLimit: pr.dailyLimit };
  }

  function renderKeys() {
    const top = el('div', { class: 'toolbar' },
      el('button', { class: 'link', onclick: () => go('chat'), disabled: !state.profiles.length }, '← Chat'),
      el('span', { class: 'grow title' }, 'API keys & usage'),
      !editing && el('button', { onclick: () => { editing = blankForm(); render(); } }, '+ Add key'));

    const intro = !state.profiles.length && !editing && el('div', { class: 'empty' },
      el('h3', {}, 'Welcome to Jarvis'),
      el('p', {}, 'Paste an API key to start. Add several keys and Jarvis rotates to the next one when one runs out.'));

    const list = el('div', { class: 'cards' }, state.profiles.map((p, i) => {
      const pct = p.dailyLimit > 0 ? Math.min(100, Math.round(p.used / p.dailyLimit * 100)) : 0;
      return el('div', { class: `card ${p.id === state.activeId ? 'active' : ''}` },
        el('div', { class: 'toolbar' },
          el('strong', { class: 'grow' }, p.name, p.id === state.activeId && el('span', { class: 'muted' }, '  · in use')),
          el('span', { class: `badge ${p.status}` }, STATUS_LABEL[p.status])),
        el('div', { class: 'muted small' }, `${p.model || '(no model)'} · ${p.hasKey ? p.keyHint : 'no key'}`),
        el('div', { class: 'meter', title: usageText(p) },
          el('div', { class: `fill ${p.status}`, style: `width:${p.dailyLimit > 0 ? pct : 0}%` })),
        el('div', { class: 'small' },
          usageText(p), p.dailyLimit > 0 ? '' : ' · no limit set',
          ` · ${p.total} total`, p.cooldownSecs ? ` · retry in ${p.cooldownSecs}s` : ''),
        p.lastError && el('div', { class: 'small error-text' }, p.lastError),
        el('div', { class: 'toolbar actions' },
          p.id !== state.activeId && el('button', { class: 'link', onclick: () => send('selectProfile', { id: p.id }) }, 'Use'),
          el('button', { class: 'link', onclick: () => { editing = { ...p, key: '' }; render(); } }, 'Edit'),
          el('button', { class: 'link', onclick: () => send('toggleProfile', { id: p.id }) }, p.enabled ? 'Disable' : 'Enable'),
          el('button', { class: 'link', onclick: () => send('resetUsage', { id: p.id }) }, 'Reset'),
          el('button', { class: 'link', disabled: i === 0, title: 'Higher priority', onclick: () => send('moveProfile', { id: p.id, dir: -1 }) }, '↑'),
          el('button', { class: 'link', disabled: i === state.profiles.length - 1, title: 'Lower priority', onclick: () => send('moveProfile', { id: p.id, dir: 1 }) }, '↓'),
          el('span', { class: 'grow' }),
          el('button', { class: 'link danger', onclick: () => send('deleteProfile', { id: p.id }) }, 'Remove')));
    }));

    const note = state.profiles.length > 1 && el('p', { class: 'muted small' },
      'Order = fallback priority. The key in use is tried first, then the others from top to bottom.');

    return [top, bannerEl(), intro, editing && renderForm(), list, note];
  }

  function renderForm() {
    const f = editing;
    const pr = state.presets.find(p => p.id === f.presetId) || state.presets[0];
    const isNew = !f.id;
    const field = (label, node, hint) => el('label', { class: 'field' }, el('span', {}, label), node, hint && el('span', { class: 'muted small' }, hint));
    const bind = k => e => { f[k] = e.target.value; };

    return el('div', { class: 'card form' },
      el('strong', {}, isNew ? 'Add a key' : `Edit ${f.name}`),
      field('Provider', el('select', {
        disabled: !isNew,
        onchange: e => { editing = { ...blankForm(e.target.value), key: f.key }; render(); },
      }, state.presets.map(p => el('option', { value: p.id, selected: p.id === f.presetId }, p.label)))),
      pr.keyUrl && el('button', { class: 'link small', onclick: () => send('openUrl', { url: pr.keyUrl }) }, `Get a ${pr.label} key ↗`),
      field('API key', el('input', {
        type: 'password', value: f.key, oninput: bind('key'), autocomplete: 'off',
        placeholder: isNew ? (pr.needsKey ? 'Paste your key' : 'Optional') : 'Leave empty to keep the saved key',
      })),
      pr.kind !== 'apifreellm' && field('Model', el('span', { class: 'toolbar' },
        el('input', { class: 'grow', value: f.model, list: 'form-models', oninput: bind('model') }),
        el('button', {
          class: 'link',
          onclick: () => send('fetchModels', { id: f.id, presetId: f.presetId, baseUrl: f.baseUrl, key: f.key, target: 'form' }),
        }, 'Load list'),
        el('datalist', { id: 'form-models' }, (modelCache.form || pr.models).map(m => el('option', { value: m }))))),
      pr.kind !== 'apifreellm' && field('Base URL', el('input', { value: f.baseUrl, oninput: bind('baseUrl'), placeholder: 'https://…/v1' })),
      field('Daily request limit', el('input', { type: 'number', min: 0, value: f.dailyLimit, oninput: bind('dailyLimit') }),
        'Jarvis switches to your next key after this many requests per day. 0 = no limit (still switches on quota errors).'),
      field('Name (optional)', el('input', { value: f.name, oninput: bind('name'), placeholder: pr.label })),
      el('div', { class: 'toolbar' },
        el('button', { onclick: () => send('saveProfile', { ...f }) }, isNew ? 'Save key' : 'Save'),
        el('button', { class: 'secondary', onclick: () => { editing = null; modelCache.form = null; render(); } }, 'Cancel')));
  }

  // ---------- shared ----------

  function bannerEl() {
    if (!banner) return null;
    return el('div', { class: `banner ${banner.kind}` },
      el('span', { class: 'grow pre' }, banner.text),
      el('button', { class: 'link', onclick: () => { banner = null; render(); } }, '✕'));
  }

  function go(s) {
    screen = s;
    banner = null;
    if (s === 'keys' && !state.profiles.length && !editing) editing = blankForm();
    render();
  }

  function render() {
    const focused = document.activeElement && document.activeElement.id;
    const log = document.getElementById('log');
    const nearBottom = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    app.replaceChildren(...(screen === 'keys' ? renderKeys() : renderChat()).filter(Boolean));
    const newLog = document.getElementById('log');
    if (newLog && nearBottom) newLog.scrollTop = newLog.scrollHeight;
    if (focused === 'input' || (screen === 'chat' && !state.busy)) {
      const input = document.getElementById('input');
      if (input && focused === 'input') input.focus();
    }
  }

  window.addEventListener('message', ({ data: m }) => {
    switch (m.type) {
      case 'state':
        state = m;
        if (screen === 'chat' && !state.profiles.length) screen = 'keys';
        break;
      case 'screen':
        go(m.screen);
        return;
      case 'saved':
        editing = null;
        modelCache.form = null;
        banner = { kind: 'notice', text: 'Key saved.' };
        break;
      case 'models':
        modelCache[m.target] = m.models;
        banner = { kind: 'notice', text: `Loaded ${m.models.length} models. Click the model box to pick one.` };
        break;
      case 'error':
      case 'notice':
        banner = { kind: m.type, text: m.text };
        if (m.restore && !draft) { draft = m.restore; saveDraft(); }
        if (m.attachments && m.attachments.length && !pending.length) pending = m.attachments;
        break;
      case 'attachments':
        if (screen !== 'chat') screen = 'chat';
        addPending(m.attachments);
        return;
      case 'waiting':
        waitingUntil = m.seconds ? Date.now() + m.seconds * 1000 : 0;
        break;
    }
    render();
  });

  render();
  send('ready');
})();
