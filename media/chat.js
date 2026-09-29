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
  let statusText = '';     // e.g. "Generating image…"
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
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false || c === true || c === 0 || c === '') continue;
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

  /** Code fence info string: "ts path=src/a.ts", "ts:src/a.ts", "ts src/a.ts". */
  function parseInfo(info) {
    const toks = info.trim().split(/\s+/).filter(Boolean);
    let lang = toks[0] || '', path = '';
    for (const t of toks) {
      const m = t.match(/^(?:path|file|filename)=(.+)$/i);
      if (m) path = m[1].replace(/^["'`]|["'`]$/g, '');
    }
    if (!path && /^[\w+#-]+:[^\s]+\.\w+$/.test(toks[0] || '')) {
      const i = toks[0].indexOf(':');
      path = toks[0].slice(i + 1); lang = toks[0].slice(0, i);
    }
    if (!path && toks[1] && /^[\w./-]+\.\w+$/.test(toks[1])) path = toks[1];
    if (lang.includes('=')) lang = '';
    return { lang, path };
  }

  /** Minimal Markdown: fenced code blocks, headings, lists, paragraphs. */
  function renderMarkdown(text) {
    const frag = document.createDocumentFragment();
    const parts = text.split(/```/);
    parts.forEach((part, i) => {
      if (i % 2 === 1) {
        const nl = part.indexOf('\n');
        const { lang, path } = parseInfo(nl >= 0 ? part.slice(0, nl) : '');
        const code = (nl >= 0 ? part.slice(nl + 1) : part).replace(/\n$/, '');
        frag.append(el('div', { class: 'code' },
          el('div', { class: 'code-bar' },
            path
              ? el('span', { class: 'code-path', title: path }, icon('file', 12), path.split('/').pop())
              : el('span', {}, lang || 'code'),
            el('span', { class: 'code-actions' },
              path ? el('button', {
                class: 'apply', title: `Review the diff and write ${path}`,
                onclick: () => send('applyCode', { path, code }),
              }, 'Apply') : null,
              el('button', { class: 'link', title: 'Copy code', onclick: () => send('copy', { text: code }) }, 'Copy'),
              el('button', { class: 'link', title: 'Insert at cursor in the editor', onclick: () => send('insert', { text: code }) }, 'Insert'))),
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

  // ---------- icons (inline SVG, inherit currentColor) ----------

  const ICONS = {
    clip: 'M16.5 6.5l-7.8 7.8a2 2 0 002.8 2.8l7.8-7.8a4 4 0 00-5.7-5.7l-7.8 7.8a6 6 0 008.5 8.5l6.4-6.4',
    file: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5M12 12v6M9 15h6',
    send: 'M5 12h13M13 6l6 6-6 6',
    stop: 'M7 7h10v10H7z',
    chevron: 'M6 9l6 6 6-6',
    gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
    copy: 'M9 9h10v10H9zM5 15V5h10',
    check: 'M5 12l5 5L20 7',
    back: 'M15 18l-6-6 6-6',
    x: 'M6 6l12 12M18 6L6 18',
    alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
    info: 'M12 16v-4M12 8h.01M12 22a10 10 0 100-20 10 10 0 000 20z',
    spark: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z',
  };

  function icon(name, size = 16) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  // ---------- chat screen ----------

  let menuOpen = false;
  let copiedIdx = -1;

  const SUGGESTIONS = [
    { label: 'Explain the current file', prompt: 'Explain what this file does and how it works.', file: true },
    { label: 'Find bugs in the current file', prompt: 'Review this file for bugs and problems. Show fixes.', file: true },
    { label: 'Write tests for the current file', prompt: 'Write unit tests for this file.', file: true },
    { label: 'Generate an image', prompt: '/image ', file: false },
  ];

  function renderHeader(p) {
    const dot = st => el('span', { class: `dot ${st}` });
    const trigger = el('button', {
      class: 'switcher', title: 'Switch key or model',
      onclick: e => { e.stopPropagation(); menuOpen = !menuOpen; render(); },
    },
      p ? dot(p.status) : null,
      el('span', { class: 'switcher-text' },
        el('span', { class: 'switcher-name' }, p ? p.name : 'No key'),
        p && el('span', { class: 'switcher-model' }, p.model)),
      icon('chevron', 14));

    const usage = p && el('span', {
      class: `usage ${p.status}`,
      title: `${usageText(p)}${p.lastError ? `\nLast error: ${p.lastError}` : ''}`,
    }, p.dailyLimit > 0 ? `${p.used}/${p.dailyLimit}` : `${p.used}`,
      el('span', { class: 'usage-label' }, ' today'));

    const menu = menuOpen && el('div', { class: 'menu', onclick: e => e.stopPropagation() },
      el('div', { class: 'menu-title' }, 'Keys'),
      state.profiles.map(x => el('button', {
        class: `menu-item ${x.id === state.activeId ? 'selected' : ''}`,
        onclick: () => { menuOpen = false; send('selectProfile', { id: x.id }); },
      },
        dot(x.status),
        el('span', { class: 'grow menu-item-text' },
          el('span', {}, x.name),
          el('span', { class: 'muted small' }, `${x.model} · ${STATUS_LABEL[x.status]}`)),
        el('span', { class: 'muted small' }, x.dailyLimit > 0 ? `${x.used}/${x.dailyLimit}` : `${x.used}`),
        x.id === state.activeId ? icon('check', 14) : null)),
      p && p.kind !== 'apifreellm' && el('div', { class: 'menu-model' },
        el('div', { class: 'menu-title' }, 'Model'),
        el('div', { class: 'row' },
          el('input', {
            class: 'grow', value: p.model, list: 'model-list', 'aria-label': 'Model',
            onchange: e => send('setModel', { id: p.id, model: e.target.value }),
          }),
          el('button', {
            class: 'ghost small', title: 'Load the model list from the provider',
            onclick: () => send('fetchModels', { id: p.id, presetId: p.presetId, target: 'chat' }),
          }, 'Load'),
          el('datalist', { id: 'model-list' },
            (modelCache.chat || presetModels(p.presetId)).map(m => el('option', { value: m }))))),
      el('div', { class: 'menu-sep' }),
      el('button', { class: 'menu-item', onclick: () => { menuOpen = false; go('keys'); } },
        icon('gear', 14), el('span', { class: 'grow' }, 'Manage keys & usage…')));

    return el('div', { class: 'header' }, el('div', { class: 'switcher-wrap' }, trigger, menu), usage);
  }

  function renderMessage(m, idx) {
    if (m.role === 'user') {
      return el('div', { class: 'msg user' },
        el('div', { class: 'bubble' },
          m.attachments && m.attachments.length > 0 ? attachmentList(m.attachments, false) : null,
          m.content ? el('div', { class: 'user-text' }, m.content) : null));
    }
    const copied = copiedIdx === idx;
    return el('div', { class: 'msg assistant' },
      el('div', { class: 'msg-head' },
        el('span', { class: 'avatar' }, 'J'),
        el('span', { class: 'who' }, 'Jarvis'),
        m.via ? el('span', { class: 'via' }, m.via) : null,
        el('span', { class: 'grow' }),
        el('button', {
          class: 'icon-btn msg-action', title: copied ? 'Copied' : 'Copy reply',
          onclick: () => {
            send('copy', { text: m.content });
            copiedIdx = idx; render();
            setTimeout(() => { copiedIdx = -1; render(); }, 1500);
          },
        }, icon(copied ? 'check' : 'copy', 14))),
      el('div', { class: 'md' },
        renderMarkdown(m.content),
        (m.attachments || []).filter(a => a.kind === 'image').map(a =>
          el('div', { class: 'gen-image' },
            el('img', { src: a.dataUrl, alt: a.name }),
            m.savedPath ? el('div', { class: 'row' },
              el('button', { class: 'ghost small', onclick: () => send('openFile', { path: m.savedPath }) }, 'Open file'),
              el('button', { class: 'ghost small', onclick: () => send('copy', { text: m.savedPath }) }, 'Copy path')) : null))));
  }

  function renderEmpty() {
    return el('div', { class: 'empty' },
      el('div', { class: 'logo' }, 'J'),
      el('h2', {}, 'How can I help?'),
      el('p', { class: 'muted' }, 'Ask anything, attach files or images, or select code and press ⌘⇧J.'),
      el('div', { class: 'suggestions' }, SUGGESTIONS.map(sg => el('button', {
        class: 'suggestion',
        onclick: () => sg.file ? send('askWithFile', { prompt: sg.prompt }) : (draft = sg.prompt, saveDraft(), render(), focusInput()),
      }, icon(sg.file ? 'file' : 'spark', 14), sg.label))));
  }

  let inputEl = null;
  function getInput() {
    if (inputEl) return inputEl;
    inputEl = el('textarea', {
      id: 'input', rows: 1, placeholder: 'Ask anything · /image to generate a picture',
      onpaste: onPaste,
      oninput: e => { draft = e.target.value; saveDraft(); autoGrow(); updateSendState(); },
      onkeydown: e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
      },
    });
    return inputEl;
  }

  function autoGrow() {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + 'px';
  }

  function updateSendState() {
    const b = document.getElementById('send');
    if (b && !state.busy) b.disabled = !draft.trim() && pending.length === 0;
  }

  function focusInput() {
    if (inputEl) { inputEl.focus(); inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length); }
  }

  function renderChat() {
    const p = active();

    const log = el('div', { class: 'log', id: 'log' });
    if (!state.history.length && !state.busy) log.append(renderEmpty());
    state.history.forEach((m, i) => log.append(renderMessage(m, i)));
    if (state.busy) {
      const waiting = waitingUntil > Date.now();
      log.append(el('div', { class: 'msg assistant' },
        el('div', { class: 'msg-head' }, el('span', { class: 'avatar' }, 'J'), el('span', { class: 'who' }, 'Jarvis')),
        el('div', { class: 'typing', id: 'typing' },
          waiting ? null : el('span', { class: 'dots' }, el('i'), el('i'), el('i')),
          el('span', { id: 'typing-text', class: 'muted' }, typingText()))));
    }

    const input = getInput();
    if (input.value !== draft) input.value = draft;

    const imgWarn = p && p.kind === 'apifreellm' && pending.some(a => a.kind === 'image')
      ? el('div', { class: 'composer-note' }, icon('alert', 12),
          ` ${p.name} can't read images. Jarvis will use a key that can, if you have one.`)
      : null;

    const composer = el('div', { class: 'composer' },
      pending.length > 0 ? attachmentList(pending, true) : null,
      imgWarn,
      input,
      el('div', { class: 'composer-bar' },
        el('button', { class: 'icon-btn', title: 'Attach files or images', onclick: () => send('pickFiles') }, icon('clip')),
        el('button', { class: 'icon-btn', title: 'Attach the file open in the editor', onclick: () => send('attachActive') }, icon('file')),
        el('span', { class: 'grow hint' }, 'Enter to send · Shift+Enter for new line'),
        state.busy
          ? el('button', { class: 'send stop', id: 'send', title: 'Stop', onclick: () => send('stop') }, icon('stop', 14))
          : el('button', {
              class: 'send', id: 'send', title: 'Send',
              disabled: !draft.trim() && pending.length === 0, onclick: submit,
            }, icon('send', 16))));

    return [renderHeader(p), bannerEl(), log, composer];
  }

  function submit() {
    const text = draft.trim();
    if ((!text && !pending.length) || state.busy) return;
    banner = null;
    const attachments = pending;
    pending = [];
    draft = ''; saveDraft();
    if (inputEl) { inputEl.value = ''; autoGrow(); }
    send('send', { text, attachments });
  }

  function typingText() {
    const secs = Math.ceil((waitingUntil - Date.now()) / 1000);
    if (secs > 0) return `Rate limited, retrying in ${secs}s… (press ■ to cancel)`;
    return statusText || 'Thinking…';
  }
  setInterval(() => {
    const t = document.getElementById('typing-text');
    if (t && waitingUntil) t.textContent = typingText();
  }, 1000);

  document.addEventListener('click', () => {
    if (menuOpen) { menuOpen = false; render(); }
  });

  // ---------- attachments ----------

  function fmtSize(n) {
    return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
  }

  function attachmentList(list, removable) {
    return el('div', { class: 'attachments' }, list.map(a => el('div', { class: 'chip', title: a.name },
      a.kind === 'image' ? el('img', { src: a.dataUrl, alt: a.name }) : el('span', { class: 'file-icon' }, icon('file', 14)),
      el('span', { class: 'chip-name' }, a.name.split('/').pop()),
      el('span', { class: 'chip-size' }, fmtSize(a.size)),
      removable ? el('button', { class: 'icon-btn chip-x', title: 'Remove', onclick: () => { pending = pending.filter(x => x.id !== a.id); render(); updateSendState(); } }, icon('x', 12)) : null)));
  }

  function addPending(list) {
    for (const a of list) if (!pending.some(x => x.name === a.name && x.size === a.size)) pending.push(a);
    render();
    focusInput();
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
      el('button', { class: 'icon-btn', title: 'Back to chat', onclick: () => go('chat'), disabled: !state.profiles.length }, icon('back')),
      el('span', { class: 'grow title' }, 'API keys & usage'),
      !editing && el('button', { class: 'primary small', onclick: () => { editing = blankForm(); render(); } }, '+ Add key'));

    const intro = !state.profiles.length && !editing && el('div', { class: 'empty' },
      el('h3', {}, 'Welcome to Jarvis'),
      el('p', {}, 'Paste an API key to start. Add several keys and Jarvis rotates to the next one when one runs out.'));

    const list = el('div', { class: 'cards' }, state.profiles.map((p, i) => {
      const pct = p.dailyLimit > 0 ? Math.min(100, Math.round(p.used / p.dailyLimit * 100)) : 0;
      return el('div', { class: `card ${p.id === state.activeId ? 'active' : ''}` },
        el('div', { class: 'toolbar' },
          el('span', { class: `dot ${p.status}` }),
          el('strong', { class: 'grow' }, p.name, p.id === state.activeId ? el('span', { class: 'in-use' }, 'in use') : null),
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
        el('button', { class: 'primary', onclick: () => send('saveProfile', { ...f }) }, isNew ? 'Save key' : 'Save'),
        el('button', { class: 'secondary', onclick: () => { editing = null; modelCache.form = null; render(); } }, 'Cancel')));
  }

  // ---------- shared ----------

  function bannerEl() {
    if (!banner) return null;
    return el('div', { class: `banner ${banner.kind}` },
      icon(banner.kind === 'error' ? 'alert' : 'info', 14),
      el('span', { class: 'grow pre' }, banner.text),
      el('button', { class: 'icon-btn', title: 'Dismiss', onclick: () => { banner = null; render(); } }, icon('x', 12)));
  }

  function go(s) {
    screen = s;
    banner = null;
    if (s === 'keys' && !state.profiles.length && !editing) editing = blankForm();
    render();
  }

  function render() {
    const inputFocused = inputEl && document.activeElement === inputEl;
    const sel = inputFocused ? [inputEl.selectionStart, inputEl.selectionEnd] : null;
    const log = document.getElementById('log');
    const nearBottom = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const prevScroll = log ? log.scrollTop : 0;
    app.className = `screen-${screen}`;
    app.replaceChildren(...(screen === 'keys' ? renderKeys() : renderChat()).filter(Boolean));
    const newLog = document.getElementById('log');
    if (newLog) newLog.scrollTop = nearBottom ? newLog.scrollHeight : prevScroll;
    if (screen === 'chat') autoGrow();
    if (inputFocused && inputEl) {
      inputEl.focus();
      inputEl.setSelectionRange(sel[0], sel[1]);
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
      case 'status':
        statusText = m.text || '';
        break;
      case 'toPng': {
        const img = new Image();
        img.onload = () => {
          try {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            c.getContext('2d').drawImage(img, 0, 0);
            send('pngResult', { reqId: m.reqId, dataUrl: c.toDataURL('image/png') });
          } catch { send('pngResult', { reqId: m.reqId }); }
        };
        img.onerror = () => send('pngResult', { reqId: m.reqId });
        img.src = m.dataUrl;
        return;
      }
      case 'waiting':
        waitingUntil = m.seconds ? Date.now() + m.seconds * 1000 : 0;
        break;
    }
    render();
  });

  render();
  send('ready');
})();
