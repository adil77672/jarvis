// Jarvis chat webview UI. Plain DOM, no framework.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  let state = { profiles: [], activeId: undefined, history: [], busy: false, presets: [], chats: [], chatId: '', account: {} };
  let screen = 'chat';            // chat | keys | chats | account
  let editing = null;             // key form data when open
  let banner = null;              // { kind: 'error' | 'notice', text }
  let draft = (vscode.getState() || {}).draft || '';
  let pending = [];               // attachments waiting to be sent
  let waitingUntil = 0;           // rate-limit countdown end (ms)
  let statusText = '';            // e.g. "Generating image…"
  let menuOpen = false;           // key/model menu in the composer
  let copiedIdx = -1;
  let viewer = null;              // { src, name, savedPath, zoom }
  let chatFilter = '';
  let mention = null;             // { start, query, files, sel } while typing @file
  let slash = null;               // { query, items, sel } while typing a /command
  let attachOpen = false;         // 📎 menu
  let voiceState = 'idle';        // idle | recording | transcribing | listening | thinking
  let streamText = '';            // reply text arriving while Jarvis is answering
  let pasteCount = 0;
  let planOpen = true;            // plan card expanded
  const modelCache = {};
  const MAX_IMAGE = 5 * 1024 * 1024, MAX_TEXT = 200000;
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

  const send = (type, data = {}) => vscode.postMessage({ type, ...data });
  const saveDraft = () => vscode.setState({ draft });
  const uid = () => Math.random().toString(36).slice(2, 10);

  // ---------- DOM helpers ----------

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

  const ICONS = {
    clip: 'M16.5 6.5l-7.8 7.8a2 2 0 002.8 2.8l7.8-7.8a4 4 0 00-5.7-5.7l-7.8 7.8a6 6 0 008.5 8.5l6.4-6.4',
    file: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5M12 12v6M9 15h6',
    up: 'M12 19V5M5 12l7-7 7 7',
    stop: 'M7 7h10v10H7z',
    chevron: 'M6 9l6 6 6-6',
    copy: 'M9 9h10v10H9zM5 15V5h10',
    check: 'M5 12l5 5L20 7',
    back: 'M15 18l-6-6 6-6',
    x: 'M6 6l12 12M18 6L6 18',
    alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
    info: 'M12 16v-4M12 8h.01M12 22a10 10 0 100-20 10 10 0 000 20z',
    spark: 'M12 2l2.2 6.6L21 11l-6.8 2.4L12 20l-2.2-6.6L3 11l6.8-2.4z',
    retry: 'M3 12a9 9 0 0115.5-6.3L21 8M21 3v5h-5M21 12a9 9 0 01-15.5 6.3L3 16M3 21v-5h5',
    plus: 'M12 5v14M5 12h14',
    history: 'M3 12a9 9 0 109-9 9.7 9.7 0 00-6.7 2.8L3 8M3 3v5h5M12 7v5l3 2',
    key: 'M15 7a4 4 0 11-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0115 7z',
    gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z',
    trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
    zoom: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.3-4.3M11 8v6M8 11h6',
    download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
    open: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5',
    image: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9h.01',
    search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.3-4.3',
    mic: 'M12 3a3 3 0 00-3 3v6a3 3 0 006 0V6a3 3 0 00-3-3zM5 11a7 7 0 0014 0M12 18v3',
    wave: 'M3 12h2M7 8v8M11 5v14M15 8v8M19 11v2',
    speaker: 'M11 5L6 9H3v6h3l5 4zM15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13',
    mute: 'M11 5L6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6',
    folder: 'M3 6a1 1 0 011-1h5l2 2h9a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1z',
    bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
    terminal: 'M4 17l6-5-6-5M12 19h8',
    slash: 'M15 4L9 20',
    project: 'M3 7l9-4 9 4-9 4zM3 12l9 4 9-4M3 17l9 4 9-4',
    git: 'M6 3v12M18 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM18 9a9 9 0 01-9 9',
  };

  function icon(name, size = 16) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  const btn = (name, title, onclick, cls = 'icon-btn', size = 16) =>
    el('button', { class: cls, title, 'aria-label': title, onclick }, icon(name, size));

  // ---------- Markdown ----------

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function inline(s) {
    return escapeHtml(s)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="#" data-href="$2">$1</a>');
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

  function renderMarkdown(text) {
    const frag = document.createDocumentFragment();
    text.split(/```/).forEach((part, i) => {
      if (i % 2 === 1 && /^(plan|todo|tasks)\s*\n/i.test(part)) {
        const items = part.split('\n').slice(1).filter(l => /\[( |x|X)\]/.test(l));
        const d = items.filter(l => /\[(x|X)\]/.test(l)).length;
        frag.append(el('div', { class: 'plan-note' }, icon('check', 12), `Plan updated · ${d}/${items.length} done`));
        return;
      }
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
              path && el('button', { class: 'apply', title: `Review the diff and write ${path}`, onclick: () => send('applyCode', { path, code }) }, 'Apply'),
              el('button', { class: 'link', title: 'Copy code', onclick: () => send('copy', { text: code }) }, 'Copy'),
              el('button', { class: 'link', title: 'Insert at cursor in the editor', onclick: () => send('insert', { text: code }) }, 'Insert'))),
          el('pre', {}, el('code', {}, code))));
        return;
      }
      let list = null;
      for (const raw of part.split('\n')) {
        const line = raw.trimEnd();
        const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
        if (li) {
          if (!list) { list = el(/^\s*\d/.test(line) ? 'ol' : 'ul'); frag.append(list); }
          const item = el('li'); item.innerHTML = inline(li[1]); list.append(item);
          continue;
        }
        list = null;
        if (!line.trim()) continue;
        if (/^\s*(---|\*\*\*)\s*$/.test(line)) { frag.append(el('hr')); continue; }
        const h = line.match(/^(#{1,4})\s+(.*)$/);
        const q = line.match(/^>\s?(.*)$/);
        const node = el(h ? 'h4' : q ? 'blockquote' : 'p');
        node.innerHTML = inline(h ? h[2] : q ? q[1] : line);
        frag.append(node);
      }
    });
    return frag;
  }

  document.addEventListener('click', e => {
    const a = e.target.closest && e.target.closest('a[data-href]');
    if (a) { e.preventDefault(); send('openUrl', { url: a.getAttribute('data-href') }); }
  });

  // ---------- shared bits ----------

  const STATUS_LABEL = { ready: 'Ready', exhausted: 'Limit reached', cooldown: 'Cooling down', invalid: 'Key rejected', disabled: 'Off', nokey: 'No key' };
  const active = () => state.profiles.find(p => p.id === state.activeId);
  const usageText = p => (p.dailyLimit > 0 ? `${p.used}/${p.dailyLimit} today` : `${p.used} today`);
  const userName = () => (state.account && state.account.name) || '';
  const initial = () => (userName()[0] || 'Y').toUpperCase();

  function greeting() {
    const h = new Date().getHours();
    const part = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    return userName() ? `${part}, ${userName()}` : part;
  }

  function relTime(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
    return new Date(t).toLocaleDateString();
  }

  function bannerEl() {
    if (!banner) return null;
    return el('div', { class: `banner ${banner.kind}` },
      icon(banner.kind === 'error' ? 'alert' : 'info', 14),
      el('span', { class: 'grow pre' }, banner.text),
      btn('x', 'Dismiss', () => { banner = null; render(); }, 'icon-btn tiny', 12));
  }

  function topBar(title, extra) {
    return el('div', { class: 'topbar' },
      btn('back', 'Back to chat', () => go('chat')),
      el('span', { class: 'grow topbar-title' }, title),
      extra);
  }

  // ---------- chat screen ----------

  const COMMANDS = [
    { cmd: 'image', desc: 'Generate an image and save it', icon: 'image', arg: true },
    { cmd: 'plan', desc: 'Plan a task and let Jarvis build it', icon: 'check', arg: true },
    { cmd: 'explain', desc: 'Explain the open file or selection', icon: 'file' },
    { cmd: 'fix', desc: 'Find and fix bugs in the open file', icon: 'alert' },
    { cmd: 'tests', desc: 'Write tests for the open file', icon: 'check' },
    { cmd: 'review', desc: 'Review the open file', icon: 'search' },
    { cmd: 'doc', desc: 'Add documentation comments', icon: 'file' },
    { cmd: 'project', desc: 'Ask about the whole project', icon: 'project', arg: true },
    { cmd: 'diff', desc: 'Review uncommitted git changes', icon: 'git' },
    { cmd: 'commit', desc: 'Write a commit message and commit', icon: 'git' },
    { cmd: 'push', desc: 'git push (asks first)', icon: 'git' },
    { cmd: 'run', desc: 'Run a shell command (asks first)', icon: 'terminal', arg: true },
    { cmd: 'agent', desc: 'Turn agent mode on/off', icon: 'bolt', arg: true },
    { cmd: 'new', desc: 'Start a new chat', icon: 'plus' },
    { cmd: 'chats', desc: 'Open chat history', icon: 'history' },
    { cmd: 'keys', desc: 'Manage API keys', icon: 'key' },
    { cmd: 'help', desc: 'Show all commands', icon: 'info' },
  ];

  const TIPS = [
    { icon: 'folder', title: 'Drag files or folders in', text: 'Drag from Finder or the Explorer onto this panel. In VS Code, hold Shift while you drop.', demo: 'drag' },
    { icon: 'copy', title: 'Paste anything', text: '⌘V a screenshot to ask about it, or paste a whole file: it becomes a neat chip.', demo: 'paste' },
    { icon: 'file', title: 'Type @ to add a file', text: 'Pick any file or folder in your project, e.g. @src/app.ts', demo: '@' },
    { icon: 'slash', title: 'Type / for commands', text: '/plan, /fix, /tests, /commit, /run, /image…', demo: '/' },
    { icon: 'bolt', title: 'Let Jarvis build it', text: '"Create a to-do app in todo.html": Jarvis plans, writes the files and runs commands (asks first).', demo: 'build' },
  ];

  const SUGGESTIONS = [
    { label: 'Build a to-do app', prompt: '/plan Create a simple to-do app in todo.html (HTML, CSS and JavaScript in one file)', file: false, icon: 'bolt', send: true },
    { label: 'Explain this file', prompt: 'Explain what this file does and how it works.', file: true, icon: 'file' },
    { label: 'Find bugs', prompt: 'Review this file for bugs and problems. Show fixes.', file: true, icon: 'alert' },
    { label: 'Write tests', prompt: 'Write unit tests for this file.', file: true, icon: 'check' },
    { label: 'Create an image', prompt: '/image ', file: false, icon: 'image' },
  ];

  function firstUserText() {
    const m = state.history.find(h => h.role === 'user');
    return m ? (m.content || 'Attachment').slice(0, 60) : '';
  }

  function renderHeader() {
    const current = state.history.length ? ((state.chats.find(c => c.id === state.chatId) || {}).title || firstUserText()) : '';
    return el('div', { class: 'header' },
      el('span', { class: 'brand-mark' }, icon('spark', 14)),
      el('span', { class: 'grow header-title', title: current }, current || 'Jarvis'),
      el('button', {
        class: `icon-btn ${state.live ? 'live-on' : ''}`, title: state.live ? 'End live voice chat' : 'Live voice chat (hands-free)',
        'aria-label': 'Live voice chat', onclick: () => send(state.live ? 'liveStop' : 'liveStart'),
      }, icon('wave', 16)),
      btn(state.speak ? 'speaker' : 'mute', state.speak ? 'Speaking replies: on (click to turn off)' : 'Speak replies aloud', () => send('toggleSpeak'), `icon-btn ${state.speak ? 'on' : ''}`),
      btn('history', 'Chats', () => go('chats')),
      btn('plus', 'New chat', () => send('newChat')),
      el('button', { class: 'avatar-btn', title: 'Account', 'aria-label': 'Account', onclick: () => go('account') }, initial()));
  }

  function openViewer(a, savedPath) {
    viewer = { src: a.dataUrl, name: a.name, savedPath, zoom: false };
    render();
  }

  function imageEl(a, big, savedPath) {
    if (!a.dataUrl) return el('div', { class: 'img-missing' }, icon('image', 14), `${a.name} (not stored)`);
    return el('img', { src: a.dataUrl, alt: a.name, class: big ? 'img-big' : 'img-thumb', title: 'Click to view', onclick: () => openViewer(a, savedPath) });
  }

  function renderToolEntry(m) {
    const acts = m.actions || [];
    return el('div', { class: 'msg tool' },
      acts.length ? acts.map(a => el('details', { class: `action ${a.ok ? 'ok' : 'fail'}`, open: a.kind === 'run' && !a.ok ? true : undefined },
        el('summary', {},
          el('span', { class: 'action-icon' }, icon(a.kind === 'write' || a.kind === 'read' ? 'file' : a.kind === 'git' ? 'git' : 'terminal', 13)),
          el('span', { class: 'grow action-label' }, a.label),
          el('span', { class: `action-status ${a.ok ? 'ok' : 'fail'}` }, a.ok ? (a.output && (a.kind === 'write' || a.kind === 'read') ? a.output : 'Done') : (a.output === 'Declined' || a.output === 'Cancelled' ? a.output : `Failed${a.code !== undefined ? ` (${a.code})` : ''}`))),
        a.kind !== 'write' && a.kind !== 'read' && a.output && a.output !== 'Declined' && el('pre', { class: 'action-output' }, a.output)))
        : el('div', { class: 'muted small' }, m.content));
  }

  function renderPermission(pm) {
    const canAlways = (pm.kind === 'write' || pm.kind === 'run' || pm.kind === 'read') && !pm.danger;
    const reply = d => send('permissionReply', { id: pm.id, decision: d });
    return el('div', { class: `permission ${pm.danger ? 'danger' : ''}` },
      el('div', { class: 'perm-title' }, icon(pm.kind === 'write' || pm.kind === 'read' ? 'file' : pm.kind === 'run' ? 'terminal' : 'git', 14), el('span', {}, pm.title)),
      pm.kind === 'write' && el('div', { class: 'perm-sub muted small' }, pm.exists ? 'Replaces the current file (undo with ⌘Z).' : 'Creates a new file.'),
      pm.danger && el('div', { class: 'perm-sub danger small' }, icon('alert', 12), ' This command can delete data or change your system. Check it carefully.'),
      pm.command && pm.kind !== 'commit' && el('pre', { class: 'perm-code' }, pm.command),
      pm.message && el('pre', { class: 'perm-code' }, pm.message),
      pm.code !== undefined && el('pre', { class: 'perm-code scroll' }, pm.code),
      el('div', { class: 'row perm-actions' },
        el('button', { class: 'primary small', onclick: () => reply('allow') }, pm.kind === 'write' ? (pm.exists ? 'Apply' : 'Create') : pm.kind === 'commit' ? 'Commit' : pm.kind === 'push' ? 'Push' : pm.kind === 'read' ? 'Allow' : 'Run'),
        pm.kind === 'write' && el('button', { class: 'ghost small', title: 'Allow edits to this file for the rest of this chat', onclick: () => reply('file') }, 'Allow this file'),
        canAlways && el('button', { class: 'ghost small', title: 'Allow this kind of action for the rest of this chat', onclick: () => reply('always') },
          pm.kind === 'write' ? 'Allow all edits' : pm.kind === 'read' ? 'Always allow reading' : 'Allow all commands'),
        pm.kind === 'write' && el('button', { class: 'ghost small', onclick: () => send('viewDiff', { id: pm.id }) }, 'View diff'),
        el('span', { class: 'grow' }),
        el('button', { class: 'link small', onclick: () => reply('deny') }, 'Deny')));
  }

  function renderMessage(m, idx) {
    if (m.tool) return renderToolEntry(m);
    const isLast = idx === state.history.length - 1;
    if (m.role === 'user') {
      const images = (m.attachments || []).filter(a => a.kind === 'image');
      const files = (m.attachments || []).filter(a => a.kind !== 'image');
      const copiedU = copiedIdx === idx;
      return el('div', { class: 'msg user' },
        el('div', { class: 'user-avatar' }, initial()),
        el('div', { class: 'user-col' },
          el('div', { class: 'user-box' },
            images.length > 0 && el('div', { class: 'msg-images' }, images.map(a => imageEl(a, false))),
            files.length > 0 && attachmentList(files, false),
            m.content && el('div', { class: 'user-text' }, m.content)),
          m.content && el('div', { class: 'msg-actions user-actions' },
            btn(copiedU ? 'check' : 'copy', copiedU ? 'Copied' : 'Copy message', () => copyText(m.content, idx), 'icon-btn tiny', 13))));
    }
    const copied = copiedIdx === idx;
    const images = (m.attachments || []).filter(a => a.kind === 'image');
    return el('div', { class: 'msg assistant' },
      el('div', { class: 'md' }, renderMarkdown(m.content)),
      images.map(a => el('div', { class: 'gen-image' },
        imageEl(a, true, m.savedPath),
        m.savedPath && el('div', { class: 'row gen-actions' },
          el('button', { class: 'chip-btn', onclick: () => send('openFile', { path: m.savedPath }) }, icon('open', 13), 'Open file'),
          el('button', { class: 'chip-btn', title: 'Copy path', onclick: () => send('copy', { text: m.savedPath }) }, icon('copy', 13), m.savedPath)))),
      el('div', { class: `msg-actions ${isLast ? 'always' : ''}` },
        btn(copied ? 'check' : 'copy', copied ? 'Copied' : 'Copy reply', () => copyText(m.content, idx), 'icon-btn tiny', 14),
        isLast && !state.busy && btn('retry', 'Retry', () => { banner = null; send('retry'); }, 'icon-btn tiny', 14),
        m.via && el('span', { class: 'via' }, m.via)));
  }

  function copyText(text, idx) {
    send('copy', { text });
    copiedIdx = idx; render();
    setTimeout(() => { copiedIdx = -1; render(); }, 1400);
  }

  // ⌘C / Ctrl+C: copy the selected chat text even if the editor doesn't handle it in this panel.
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      const t = document.activeElement;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) return;
      const sel = String(window.getSelection() || '');
      if (sel) { e.preventDefault(); send('copy', { text: sel }); }
    }
  });

  function typingText() {
    if (voiceState === 'transcribing') return 'Transcribing your voice…';
    const secs = Math.ceil((waitingUntil - Date.now()) / 1000);
    if (secs > 0) return `${statusText || 'Rate limited'} · retrying in ${secs}s`;
    return statusText || 'Thinking…';
  }
  setInterval(() => {
    const t = document.getElementById('typing-text');
    if (t && waitingUntil) t.textContent = typingText();
  }, 1000);

  function streamingEl() {
    return el('div', { class: 'msg assistant streaming', id: 'streaming' },
      withCursor(el('div', { class: 'md', id: 'stream-md' }, renderMarkdown(streamText))));
  }

  /** Put the blinking cursor at the end of the last paragraph / list item. */
  function withCursor(md) {
    let target = md.lastElementChild;
    while (target && (target.tagName === 'UL' || target.tagName === 'OL')) target = target.lastElementChild;
    if (!target || target.classList.contains('code')) target = md;
    target.append(el('span', { class: 'cursor' }));
    return md;
  }

  /** Update only the streaming bubble (fast path), keeping scroll pinned to the bottom. */
  function updateStream() {
    const md = document.getElementById('stream-md');
    if (!md || !state.busy || state.permission) { render(); return; }
    const log = document.getElementById('log');
    const pinned = log && log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    md.replaceChildren(renderMarkdown(streamText));
    withCursor(md);
    if (log && pinned) log.scrollTop = log.scrollHeight;
  }

  function thinkingEl() {
    return el('div', { class: 'msg assistant' },
      el('div', { class: 'thinking' },
        el('span', { class: 'spark-spin' }, icon('spark', 16)),
        el('span', { id: 'typing-text' }, typingText())));
  }

  // Composer textarea is created once so typing and the caret survive re-renders.
  let inputEl = null;
  function getInput() {
    if (inputEl) return inputEl;
    inputEl = el('textarea', {
      id: 'input', rows: 1, placeholder: 'How can I help you today?  (@ to add a file)',
      onpaste: onPaste,
      oninput: e => { draft = e.target.value; saveDraft(); autoGrow(); updateSendState(); checkMention(); checkSlash(); },
      onclick: () => checkMention(),
      onblur: () => setTimeout(() => { if (mention && document.activeElement !== inputEl) { mention = null; renderMentions(); } }, 150),
      onkeydown: e => {
        if (slash && slash.items.length) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const n = slash.items.length;
            slash.sel = (slash.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
            renderSlash();
            return;
          }
          if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.isComposing) {
            const it = slash.items[slash.sel];
            // Enter on an exact, argument-less command runs it; otherwise complete it.
            if (!(e.key === 'Enter' && draft.trim() === '/' + it.cmd && !it.arg)) { e.preventDefault(); pickSlash(it); return; }
          }
          if (e.key === 'Escape') { e.preventDefault(); slash = null; renderSlash(); return; }
        }
        if (mention && mention.files.length) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const n = mention.files.length;
            mention.sel = (mention.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
            renderMentions();
            return;
          }
          if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            pickMention(mention.files[mention.sel]);
            return;
          }
        }
        if (e.key === 'Escape' && mention) { e.preventDefault(); mention = null; renderMentions(); return; }
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
        if (e.key === 'Escape' && menuOpen) { menuOpen = false; render(); }
      },
    });
    return inputEl;
  }
  // ---------- /commands ----------

  function checkSlash() {
    if (!inputEl) return;
    const m = inputEl.value.match(/^\/(\w*)$/);
    if (!m || inputEl.selectionStart !== inputEl.value.length) { if (slash) { slash = null; renderSlash(); } return; }
    const q = m[1].toLowerCase();
    const items = COMMANDS.filter(c => c.cmd.startsWith(q)).concat(COMMANDS.filter(c => !c.cmd.startsWith(q) && c.cmd.includes(q)));
    slash = { query: q, items, sel: 0 };
    renderSlash();
  }

  function pickSlash(it) {
    inputEl.value = draft = `/${it.cmd}${it.arg ? ' ' : ''}`;
    saveDraft();
    slash = null;
    renderSlash();
    updateSendState();
    inputEl.focus();
    inputEl.setSelectionRange(draft.length, draft.length);
    if (!it.arg) submit();
  }

  function renderSlash() {
    const composer = inputEl && inputEl.closest('.composer');
    if (!composer) return;
    const old = composer.querySelector('.slash-menu');
    if (old) old.remove();
    if (!slash || !slash.items.length) return;
    const box = el('div', { class: 'mentions slash-menu', role: 'listbox' },
      slash.items.map((c, i) => el('button', {
        class: `mention ${i === slash.sel ? 'sel' : ''}`, role: 'option',
        onmousedown: e => { e.preventDefault(); pickSlash(c); },
      }, icon(c.icon, 13), el('span', { class: 'mention-name' }, '/' + c.cmd), el('span', { class: 'grow mention-dir ltr' }, c.desc))));
    composer.append(box);
    const selEl = box.querySelector('.mention.sel');
    if (selEl) selEl.scrollIntoView({ block: 'nearest' });
  }

  // ---------- @file mentions ----------

  function checkMention() {
    if (!inputEl) return;
    const upto = inputEl.value.slice(0, inputEl.selectionStart);
    const m = upto.match(/(?:^|\s)@([\w./-]*)$/);
    if (!m) { if (mention) { mention = null; renderMentions(); } return; }
    const start = upto.length - m[1].length - 1;
    if (!mention || mention.start !== start || mention.query !== m[1]) {
      mention = { start, query: m[1], files: mention && mention.start === start ? mention.files : [], sel: 0 };
      send('listFiles', { query: m[1] });
    }
  }

  function pickMention(path) {
    if (!mention || !inputEl) return;
    const caret = inputEl.selectionStart;
    const before = inputEl.value.slice(0, mention.start);
    const after = inputEl.value.slice(caret);
    const insert = `@${path} `;
    inputEl.value = draft = before + insert + after;
    saveDraft();
    const pos = before.length + insert.length;
    inputEl.setSelectionRange(pos, pos);
    mention = null;
    renderMentions();
    autoGrow();
    updateSendState();
    send('attachPath', { path });
    inputEl.focus();
  }

  /** Update only the popup, so the textarea keeps focus while typing. */
  function renderMentions() {
    const composer = inputEl && inputEl.closest('.composer');
    if (!composer) return;
    const old = composer.querySelector('.mentions');
    if (old) old.remove();
    if (!mention) return;
    const box = el('div', { class: 'mentions', role: 'listbox' },
      mention.files.length === 0
        ? el('div', { class: 'mentions-empty' }, mention.query ? `No files match "${mention.query}"` : 'Type to search files…')
        : mention.files.map((f, i) => {
            const isDir = f.endsWith('/');
            const parts = f.replace(/\/$/, '').split('/');
            const name = parts.pop() + (isDir ? '/' : '');
            return el('button', {
              class: `mention ${i === mention.sel ? 'sel' : ''}`, role: 'option',
              onmousedown: e => { e.preventDefault(); pickMention(f); },
            }, icon(isDir ? 'folder' : 'file', 13), el('span', { class: 'mention-name' }, name), el('span', { class: 'grow mention-dir' }, parts.join('/')));
          }));
    composer.append(box);
    const selEl = box.querySelector('.mention.sel');
    if (selEl) selEl.scrollIntoView({ block: 'nearest' });
  }

  function autoGrow() {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 240) + 'px';
  }
  function updateSendState() {
    const b = document.getElementById('send');
    if (b && !state.busy) b.disabled = !draft.trim() && pending.length === 0;
  }
  function focusInput() {
    if (inputEl) { inputEl.focus(); inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length); }
  }

  function modelMenu(p) {
    return el('div', { class: 'menu up', onclick: e => e.stopPropagation() },
      el('div', { class: 'menu-title' }, 'API keys'),
      state.profiles.map(x => el('button', {
        class: `menu-item ${x.id === state.activeId ? 'selected' : ''}`,
        onclick: () => { menuOpen = false; send('selectProfile', { id: x.id }); },
      },
        el('span', { class: `dot ${x.status}` }),
        el('span', { class: 'grow menu-item-text' },
          el('span', {}, x.name),
          el('span', { class: 'muted small' }, `${x.model} · ${STATUS_LABEL[x.status]}`)),
        el('span', { class: 'muted small' }, x.dailyLimit > 0 ? `${x.used}/${x.dailyLimit}` : `${x.used}`),
        x.id === state.activeId && icon('check', 14))),
      p && p.kind !== 'apifreellm' && el('div', { class: 'menu-model' },
        el('div', { class: 'menu-title' }, 'Model'),
        el('div', { class: 'row' },
          modelSelect(p.model, modelCache.chat || presetModels(p.presetId), v => send('setModel', { id: p.id, model: v })),
          el('button', { class: 'ghost small', onclick: () => send('fetchModels', { id: p.id, presetId: p.presetId, target: 'chat' }) }, 'Load'),
          )),
      el('div', { class: 'menu-sep' }),
      el('button', { class: 'menu-item', onclick: () => { menuOpen = false; go('keys'); } }, icon('key', 14), el('span', { class: 'grow' }, 'Manage keys & usage')));
  }

  function renderComposer(p) {
    const input = getInput();
    if (input.value !== draft) input.value = draft;
    const imgWarn = p && p.kind === 'apifreellm' && pending.some(a => a.kind === 'image');
    return el('div', { class: 'composer' },
      pending.length > 0 && attachmentList(pending, true),
      imgWarn && el('div', { class: 'composer-note' }, icon('alert', 12), ` ${p.name} can't see images. Jarvis will use a key that can, if you have one.`),
      input,
      el('div', { class: 'composer-bar' },
        el('div', { class: 'attach-wrap' },
          btn('plus', 'Add files, folders, images…', e => { e.stopPropagation(); attachOpen = !attachOpen; menuOpen = false; render(); }, `icon-btn ${attachOpen ? 'on' : ''}`),
          attachOpen && el('div', { class: 'menu up left', onclick: e => e.stopPropagation() },
            el('button', { class: 'menu-item', onclick: () => { attachOpen = false; send('pickFiles'); render(); } }, icon('clip', 14), el('span', { class: 'grow' }, 'Files, images or zip…')),
            el('button', { class: 'menu-item', onclick: () => { attachOpen = false; send('pickFolder'); render(); } }, icon('folder', 14), el('span', { class: 'grow' }, 'Folder…')),
            el('button', { class: 'menu-item', onclick: () => { attachOpen = false; send('attachActive'); render(); } }, icon('file', 14), el('span', { class: 'grow' }, 'Current file')),
            el('button', { class: 'menu-item', onclick: () => { attachOpen = false; send('attachProject'); render(); } }, icon('project', 14), el('span', { class: 'grow' }, 'Whole project')),
            el('div', { class: 'menu-sep' }),
            el('div', { class: 'menu-hint muted small' }, 'Tip: type @ for files, / for commands'))),
        el('button', {
          class: `icon-btn mic ${voiceState === 'recording' ? 'rec' : ''}`,
          title: voiceState === 'recording' ? 'Stop and transcribe' : 'Voice input',
          'aria-label': 'Voice input',
          disabled: voiceState === 'transcribing' || state.live,
          onclick: () => send(voiceState === 'recording' ? 'voiceStop' : 'voiceStart'),
        }, icon('mic', 16)),
        el('button', {
          class: `agent-chip ${state.agent ? 'on' : ''}`,
          title: state.agent ? 'Agent mode on: Jarvis can edit files and run commands (asks permission). Click to turn off.' : 'Agent mode off: Jarvis only suggests changes. Click to turn on.',
          onclick: () => send('toggleAgent'),
        }, icon('bolt', 12), 'Agent'),
        el('div', { class: 'grow model-wrap' },
          el('button', {
            class: 'model-pill', title: p ? `${p.name} · ${usageText(p)}` : 'Add a key',
            onclick: e => { e.stopPropagation(); menuOpen = !menuOpen; render(); },
          },
            p && el('span', { class: `dot ${p.status}` }),
            el('span', { class: 'model-pill-text' }, p ? (p.kind === 'apifreellm' ? p.name : p.model) : 'Add a key'),
            p && p.dailyLimit > 0 && el('span', { class: 'model-pill-usage' }, `${p.used}/${p.dailyLimit}`),
            icon('chevron', 12)),
          menuOpen && modelMenu(p)),
        state.busy
          ? el('button', { class: 'send stop', id: 'send', title: 'Stop', onclick: () => send('stop') }, icon('stop', 12))
          : el('button', { class: 'send', id: 'send', title: 'Send (Enter)', disabled: !draft.trim() && pending.length === 0, onclick: submit }, icon('up', 16))));
  }

  function renderChat() {
    const p = active();
    if (!state.history.length && !state.busy) {
      return [renderHeader(), bannerEl(), liveBar(), el('div', { class: 'welcome', id: 'log' },
        el('div', { class: 'welcome-inner' },
          el('div', { class: 'welcome-mark' }, icon('spark', 26)),
          el('h1', { class: 'welcome-title' }, greeting()),
          renderComposer(p),
          el('div', { class: 'suggestions' }, SUGGESTIONS.map(sg => el('button', {
            class: 'suggestion',
            onclick: () => sg.file ? send('askWithFile', { prompt: sg.prompt }) : sg.send ? send('send', { text: sg.prompt, attachments: [] }) : (draft = sg.prompt, saveDraft(), render(), focusInput()),
          }, icon(sg.icon, 13), sg.label))),
          el('div', { class: 'tips' },
            el('div', { class: 'tips-title' }, 'How to use Jarvis'),
            TIPS.map(t => el('button', { class: 'tip', onclick: () => runTip(t.demo) },
              el('span', { class: 'tip-icon' }, icon(t.icon, 14)),
              el('span', { class: 'tip-text' }, el('strong', {}, t.title), el('span', { class: 'muted' }, t.text)))))))];
    }
    const log = el('div', { class: 'log', id: 'log' });
    state.history.forEach((m, i) => log.append(renderMessage(m, i)));
    if (state.permission) log.append(renderPermission(state.permission));
    else if (state.busy && streamText) log.append(streamingEl());
    else if (state.busy) log.append(thinkingEl());
    return [renderHeader(), bannerEl(), liveBar(), log, el('div', { class: 'composer-dock' }, planCard(), renderComposer(p))];
  }

  function runTip(demo) {
    if (demo === '@' || demo === '/') {
      draft = demo; saveDraft();
      if (inputEl) inputEl.value = demo;
      render(); focusInput();
      if (demo === '@') checkMention(); else checkSlash();
    } else if (demo === 'build') {
      draft = 'Create a simple to-do app in todo.html with add, complete and delete'; saveDraft(); render(); focusInput();
    } else if (demo === 'paste') {
      banner = { kind: 'notice', text: 'Copy a screenshot (⌘⇧⌃4 on Mac) or a file\'s text, click the message box and press ⌘V. Long text becomes a "Pasted text" chip you can click to open.' };
      render(); focusInput();
    } else if (demo === 'drag') {
      banner = { kind: 'notice', text: 'Drag a file, folder, image or zip from Finder or the VS Code Explorer onto this panel. VS Code needs you to hold Shift while dropping. You can also use + → Files / Folder, or right-click a file → Add to Jarvis Chat.' };
      render();
    }
  }

  function planCard() {
    const plan = state.plan;
    if (!plan || !plan.length) return null;
    const done = plan.filter(i => i.done).length;
    const current = plan.findIndex(i => !i.done);
    const pct = Math.round((done / plan.length) * 100);
    return el('div', { class: `plan ${planOpen ? 'open' : ''}` },
      el('button', { class: 'plan-head', onclick: () => { planOpen = !planOpen; render(); } },
        icon('check', 13),
        el('span', { class: 'grow' }, done === plan.length ? 'Plan complete' : `Plan · step ${current + 1} of ${plan.length}`),
        el('span', { class: 'plan-count' }, `${done}/${plan.length}`),
        el('span', { class: 'plan-chev' }, icon('chevron', 12))),
      el('div', { class: 'plan-bar' }, el('div', { class: 'plan-fill', style: `width:${pct}%` })),
      planOpen && el('ol', { class: 'plan-list' }, plan.map((it, i) => el('li', { class: it.done ? 'done' : i === current ? 'current' : '' },
        el('span', { class: 'plan-mark' }, it.done ? icon('check', 11) : i === current && state.busy ? el('span', { class: 'plan-spin' }) : null),
        el('span', {}, it.text)))));
  }

  function liveBar() {
    if (!state.live) return null;
    const label = { listening: 'Listening… just talk', transcribing: 'Understanding…', thinking: 'Thinking…', idle: 'Live voice chat' }[voiceState] || 'Live voice chat';
    return el('div', { class: `live-bar ${voiceState}` },
      el('span', { class: 'live-dot' }), el('span', { class: 'grow' }, label, el('span', { class: 'muted small' }, '  · say "stop" to end')),
      el('button', { class: 'ghost small', onclick: () => send('liveStop') }, 'End'));
  }

  function submit() {
    const text = draft.trim();
    if ((!text && !pending.length) || state.busy) return;
    banner = null;
    menuOpen = false;
    slash = null; mention = null;
    const attachments = pending;
    pending = [];
    draft = ''; saveDraft();
    if (inputEl) { inputEl.value = ''; autoGrow(); }
    send('send', { text, attachments });
  }

  // ---------- attachments ----------

  function fmtSize(n) {
    return n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
  }

  function attachmentList(list, removable) {
    return el('div', { class: 'attachments' }, list.map(a => el('div', {
      class: `chip ${a.kind} ${a.kind !== 'image' && a.text ? 'openable' : ''}`,
      title: a.kind !== 'image' && a.text ? `${a.label || a.name} — click to open` : a.name,
      onclick: e => { if (a.kind !== 'image' && a.text && !e.target.closest('.chip-x')) send('openAttachment', { name: a.name, text: a.text }); },
    },
      a.kind === 'image' && a.dataUrl
        ? el('img', { src: a.dataUrl, alt: a.name, onclick: () => openViewer(a) })
        : el('span', { class: 'file-icon' }, icon(a.kind === 'folder' ? 'folder' : 'file', 14)),
      el('span', { class: 'chip-text' },
        el('span', { class: 'chip-name' }, a.label || (a.kind === 'folder' ? a.name : a.name.split('/').pop())),
        el('span', { class: 'chip-size' }, a.kind === 'image' ? 'Image' : a.kind === 'folder' ? (a.name.endsWith('.zip') ? 'Zip' : 'Folder') : a.pasted ? `${a.lines} lines` : fmtSize(a.size))),
      removable && btn('x', 'Remove', () => { pending = pending.filter(x => x.id !== a.id); render(); updateSendState(); }, 'icon-btn chip-x', 11))));
  }

  function addPending(list) {
    for (const a of list) if (!pending.some(x => x.name === a.name && x.size === a.size)) pending.push(a);
    render();
    focusInput();
  }

  function readBrowserFile(file) {
    return new Promise((resolve, reject) => {
      const name = file.name || `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`;
      const isImage = (file.type || '').startsWith('image/') || IMAGE_EXT.test(name);
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Could not read ${name}`));
      if (/\.(mp4|mov|m4v|webm|avi|mkv|wmv|flv)$/i.test(name) || (file.type || '').startsWith('video/')) {
        return reject(new Error(`${name}: videos can't be sent to AI models here yet. Attach a screenshot of the part you mean, or describe it.`));
      }
      if (/\.zip$/i.test(name)) {
        if (file.size > 50 * 1024 * 1024) return reject(new Error(`${name} is larger than 50 MB.`));
        reader.onload = () => { send('attachZipBytes', { name, data: String(reader.result).split(',')[1] }); resolve(null); };
        reader.readAsDataURL(file);
        return;
      }
      if (isImage) {
        if (file.size > MAX_IMAGE) return reject(new Error(`${name} is larger than 5 MB.`));
        reader.onload = () => resolve({ id: uid(), kind: 'image', name, size: file.size, dataUrl: reader.result });
        reader.readAsDataURL(file);
      } else {
        reader.onload = () => {
          const bytes = new Uint8Array(reader.result);
          if (bytes.subarray(0, 8000).includes(0)) return reject(new Error(`${name} looks like a binary file (PDF, Word, etc.). Supported: text/code files, images, zip files and folders.`));
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
      try { const a = await readBrowserFile(f); if (a) ok.push(a); } catch (e) { errors.push(e.message); }
    }
    if (errors.length) banner = { kind: 'error', text: errors.join('\n') };
    if (ok.length) addPending(ok); else render();
  }

  function onPaste(e) {
    const files = Array.from(e.clipboardData ? e.clipboardData.files : []);
    if (files.length) { e.preventDefault(); addBrowserFiles(files); return; }
    // Long pastes (a whole file, logs…) become an attachment chip instead of flooding the box.
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    const lines = text.split('\n').length;
    if (text.length > 2000 || lines > 40) {
      e.preventDefault();
      pasteCount++;
      addPending([{ id: uid(), kind: 'text', name: `pasted-${pasteCount}.txt`, label: `Pasted text ${pasteCount}`, lines, size: text.length, text, pasted: true }]);
    }
  }

  document.addEventListener('dragover', e => {
    e.preventDefault();
    if (!document.body.classList.contains('dragging')) {
      document.body.classList.add('dragging');
      document.body.append(el('div', { class: 'drop-overlay', id: 'drop-overlay' },
        el('div', { class: 'drop-box' }, icon('folder', 28),
          el('strong', {}, 'Drop to attach'),
          el('span', {}, 'Files, folders, images or zip'),
          el('span', { class: 'muted small' }, 'In VS Code, hold Shift while dropping'))));
    }
  });
  const clearDrag = () => { document.body.classList.remove('dragging'); const o = document.getElementById('drop-overlay'); if (o) o.remove(); };
  document.addEventListener('dragend', clearDrag);
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) clearDrag(); });
  document.addEventListener('drop', e => {
    e.preventDefault();
    clearDrag();
    if (screen !== 'chat') go('chat');
    const dt = e.dataTransfer;
    if (!dt) return;
    // Folders dropped from Finder/Explorer: walk them with the entries API.
    const entries = Array.from(dt.items || []).map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    const dirs = entries.filter(en => en.isDirectory);
    if (dirs.length) {
      dirs.forEach(d => readDroppedFolder(d));
      const rest = entries.filter(en => en.isFile);
      if (!rest.length) return;
    }
    const files = Array.from(dt.files || []).filter((f, i) => !(entries[i] && entries[i].isDirectory));
    if (files.length) return addBrowserFiles(files);
    const uriList = dt.getData('application/vnd.code.uri-list') || dt.getData('text/uri-list') || dt.getData('resourceurls') || dt.getData('text/plain');
    let uris = [];
    try { uris = JSON.parse(uriList); } catch { uris = (uriList || '').split(/\r?\n/); }
    uris = uris.filter(Boolean);
    if (uris.length) send('dropUris', { uris });
  });

  const SKIP_DIR = /^(node_modules|\.git|\.venv|venv|__pycache__|dist|build|out|target|\.next|\.cache|__MACOSX)$/;
  const SKIP_FILE = /\.(png|jpe?g|gif|webp|ico|icns|pdf|zip|gz|7z|rar|mp[34]|mov|wav|woff2?|ttf|exe|dll|so|dylib|bin|lock|pyc|class|jar)$|^\.DS_Store$|^\.env/i;

  async function readDroppedFolder(dirEntry) {
    statusText = `Reading ${dirEntry.name}…`;
    const paths = [], parts = [];
    let used = 0, skipped = 0;
    const readAll = reader => new Promise(res => { const all = []; const next = () => reader.readEntries(b => { if (!b.length) res(all); else { all.push(...b); next(); } }, () => res(all)); next(); });
    const fileOf = entry => new Promise(res => entry.file(res, () => res(null)));
    async function walk(entry, prefix) {
      if (paths.length > 3000) return;
      if (entry.isDirectory) {
        if (SKIP_DIR.test(entry.name)) return;
        for (const child of await readAll(entry.createReader())) await walk(child, prefix + entry.name + '/');
        return;
      }
      const rel = prefix + entry.name;
      paths.push(rel);
      if (SKIP_FILE.test(entry.name)) { skipped++; return; }
      const f = await fileOf(entry);
      if (!f || f.size > 100000 || used + f.size > 60000) { skipped++; return; }
      const buf = new Uint8Array(await f.arrayBuffer());
      if (buf.subarray(0, 8000).includes(0)) { skipped++; return; }
      const text = new TextDecoder().decode(buf);
      parts.push(`--- ${rel} ---\n\`\`\`${rel.split('.').pop()}\n${text}\n\`\`\``);
      used += text.length;
    }
    for (const child of await readAll(dirEntry.createReader())) await walk(child, '');
    statusText = '';
    const name = dirEntry.name + '/';
    const text = [`Folder ${name} — ${paths.length} files (${parts.length} included below${skipped ? `, ${skipped} skipped` : ''}).`, ...parts, `File tree of ${name}:\n${paths.slice(0, 500).join('\n')}`].join('\n\n');
    addPending([{ id: uid(), kind: 'folder', name, size: used, text }]);
  }

  // ---------- image viewer ----------

  function renderViewer() {
    if (!viewer) return null;
    const v = viewer;
    const close = () => { viewer = null; render(); };
    return el('div', { class: 'viewer', onclick: close },
      el('div', { class: 'viewer-bar', onclick: e => e.stopPropagation() },
        el('span', { class: 'grow viewer-name', title: v.name }, v.name.split('/').pop()),
        btn('zoom', v.zoom ? 'Fit to window' : 'Actual size', () => { v.zoom = !v.zoom; render(); }, 'icon-btn light'),
        v.savedPath
          ? btn('open', 'Open file in editor', () => send('openFile', { path: v.savedPath }), 'icon-btn light')
          : btn('download', 'Save to project', () => send('saveImage', { dataUrl: v.src, name: v.name }), 'icon-btn light'),
        btn('x', 'Close (Esc)', close, 'icon-btn light')),
      el('div', { class: `viewer-stage ${v.zoom ? 'zoomed' : ''}` },
        el('img', { src: v.src, alt: v.name, onclick: e => { e.stopPropagation(); v.zoom = !v.zoom; render(); } })));
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && viewer) { viewer = null; render(); }
  });

  // ---------- chats screen ----------

  function renderChats() {
    const q = chatFilter.toLowerCase();
    const list = state.chats.filter(c => !q || c.title.toLowerCase().includes(q));
    return [
      topBar('Chats', el('button', { class: 'primary small', onclick: () => send('newChat') }, icon('plus', 13), 'New')),
      el('div', { class: 'page' },
        el('label', { class: 'search' }, icon('search', 14),
          el('input', { value: chatFilter, placeholder: 'Search chats', oninput: e => { chatFilter = e.target.value; renderKeepFocus(e.target); } })),
        list.length === 0 && el('p', { class: 'muted center' }, state.chats.length ? 'No chats match.' : 'No saved chats yet. Your conversations will appear here.'),
        el('div', { class: 'chat-list' }, list.map(c => el('div', {
          class: `chat-item ${c.id === state.chatId ? 'current' : ''}`,
          onclick: () => send('openChat', { id: c.id }),
        },
          el('div', { class: 'grow chat-item-text' },
            el('span', { class: 'chat-item-title' }, c.title),
            el('span', { class: 'muted small' }, `${relTime(c.updated)} · ${Math.ceil(c.count / 2)} message${c.count > 2 ? 's' : ''}`)),
          btn('trash', 'Delete chat', e => { e.stopPropagation(); send('deleteChat', { id: c.id }); }, 'icon-btn tiny danger-hover', 14)))),
        state.chats.length > 0 && el('button', { class: 'link danger small center-btn', onclick: () => send('clearChats') }, 'Delete all chats'))];
  }

  function renderKeepFocus(input) {
    const pos = input.selectionStart;
    render();
    const again = app.querySelector('.search input');
    if (again) { again.focus(); again.setSelectionRange(pos, pos); }
  }

  // ---------- account screen ----------

  function renderAccount() {
    const acc = state.account || {};
    const totalToday = state.profiles.reduce((n, p) => n + p.used, 0);
    const totalAll = state.profiles.reduce((n, p) => n + p.total, 0);
    return [
      topBar('Account'),
      el('div', { class: 'page' },
        el('div', { class: 'profile' },
          el('div', { class: 'profile-avatar' }, initial()),
          el('div', { class: 'grow' },
            el('label', { class: 'field' }, el('span', {}, 'Your name'),
              el('input', { value: acc.name || '', placeholder: 'What should Jarvis call you?', maxlength: 40, onchange: e => send('setName', { name: e.target.value }) })),
            el('span', { class: 'muted small' }, 'Used for the greeting. Stored only on this computer.'))),
        el('div', { class: 'stats' },
          el('div', { class: 'stat' }, el('span', { class: 'stat-num' }, String(totalToday)), el('span', { class: 'muted small' }, 'requests today')),
          el('div', { class: 'stat' }, el('span', { class: 'stat-num' }, String(totalAll)), el('span', { class: 'muted small' }, 'all time')),
          el('div', { class: 'stat' }, el('span', { class: 'stat-num' }, String(state.chats.length)), el('span', { class: 'muted small' }, 'saved chats'))),
        el('div', { class: 'section-title' }, 'Usage by key'),
        state.profiles.length === 0 && el('p', { class: 'muted' }, 'No keys yet.'),
        state.profiles.map(p => {
          const pct = p.dailyLimit > 0 ? Math.min(100, Math.round(p.used / p.dailyLimit * 100)) : 0;
          return el('div', { class: 'usage-row' },
            el('div', { class: 'row' }, el('span', { class: `dot ${p.status}` }), el('span', { class: 'grow' }, p.name), el('span', { class: 'muted small' }, usageText(p))),
            el('div', { class: 'meter' }, el('div', { class: `fill ${p.status}`, style: `width:${p.dailyLimit > 0 ? pct : (p.used ? 100 : 0)}%` })));
        }),
        el('div', { class: 'section-title' }, 'Agent permissions'),
        el('div', { class: 'link-list' },
          toggleRow('bolt', 'Agent mode', 'Edit files & run commands', state.agent, v => send('setSetting', { key: 'agentMode', value: v })),
          toggleRow('file', 'Auto-approve reading files', 'Read & list project files', (state.settings || {}).autoApproveReads, v => send('setSetting', { key: 'autoApproveReads', value: v })),
          toggleRow('file', 'Auto-approve edits', 'Create & change files without asking', (state.settings || {}).autoApproveEdits, v => send('setSetting', { key: 'autoApproveEdits', value: v })),
          toggleRow('terminal', 'Auto-approve commands', 'Destructive commands still ask', (state.settings || {}).autoApproveCommands, v => send('setSetting', { key: 'autoApproveCommands', value: v })),
          toggleRow('terminal', 'Run in terminal', 'Show commands in a Jarvis terminal', (state.settings || {}).runInTerminal, v => send('setSetting', { key: 'runInTerminal', value: v }))),
        el('div', { class: 'section-title' }, 'Settings'),
        el('div', { class: 'link-list' },
          el('button', { class: 'list-btn', onclick: () => go('keys') }, icon('key', 15), el('span', { class: 'grow' }, 'API keys & limits'), el('span', { class: 'muted small' }, String(state.profiles.length))),
          el('button', { class: 'list-btn', onclick: () => send('openSettings') }, icon('gear', 15), el('span', { class: 'grow' }, 'Extension settings'), el('span', { class: 'muted small' }, 'prompt, images')),
          el('div', { class: 'list-btn static' }, icon('image', 15), el('span', { class: 'grow' }, 'Images saved to'), el('span', { class: 'muted small' }, acc.imageFolder || '')),
          el('button', { class: 'list-btn', onclick: () => go('chats') }, icon('history', 15), el('span', { class: 'grow' }, 'Chat history'), el('span', { class: 'muted small' }, String(state.chats.length))),
          toggleRow('download', 'Automatic updates', 'From GitHub releases', (state.settings || {}).autoUpdate, v => send('setSetting', { key: 'autoUpdate', value: v })),
          el('button', { class: 'list-btn', onclick: () => send('checkUpdates') }, icon('retry', 15), el('span', { class: 'grow' }, 'Check for updates'), el('span', { class: 'muted small' }, acc.version ? 'v' + acc.version : ''))),
        el('p', { class: 'muted small center' }, `Jarvis AI Chat & Code Assistant${acc.version ? ' v' + acc.version : ''} · by Adil Mustafa`))];
  }

  function toggleRow(ic, title, sub, on, onChange) {
    return el('label', { class: 'list-btn toggle-row' }, icon(ic, 15),
      el('span', { class: 'grow toggle-text' }, el('span', {}, title), el('span', { class: 'muted small' }, sub)),
      el('input', { type: 'checkbox', class: 'switch', checked: !!on, onchange: e => onChange(e.target.checked) }));
  }

  // ---------- keys screen ----------

  function presetModels(presetId) {
    return (state.presets.find(p => p.id === presetId) || {}).models || [];
  }

  function blankForm(presetId = 'apifreellm') {
    const pr = state.presets.find(p => p.id === presetId) || state.presets[0] || { id: presetId, defaultModel: '', baseUrl: '', dailyLimit: 0 };
    return { id: '', presetId: pr.id, name: '', key: '', model: pr.defaultModel, baseUrl: pr.baseUrl, dailyLimit: pr.dailyLimit };
  }

  function renderKeys() {
    const intro = !state.profiles.length && el('div', { class: 'welcome-card' },
      el('div', { class: 'welcome-mark small' }, icon('spark', 20)),
      el('h3', {}, 'Welcome to Jarvis'),
      el('p', { class: 'muted' }, 'Paste an API key to start. Add several and Jarvis switches to the next one when one runs out.'));

    const list = el('div', { class: 'cards' }, state.profiles.map((p, i) => {
      const pct = p.dailyLimit > 0 ? Math.min(100, Math.round(p.used / p.dailyLimit * 100)) : 0;
      return el('div', { class: `card ${p.id === state.activeId ? 'active' : ''}` },
        el('div', { class: 'row' },
          el('span', { class: `dot ${p.status}` }),
          el('strong', { class: 'grow' }, p.name, p.id === state.activeId && el('span', { class: 'in-use' }, 'In use')),
          el('span', { class: `badge ${p.status}` }, STATUS_LABEL[p.status])),
        el('div', { class: 'muted small' }, `${p.model || '(no model)'} · ${p.hasKey ? p.keyHint : 'no key'}`),
        el('div', { class: 'meter', title: usageText(p) }, el('div', { class: `fill ${p.status}`, style: `width:${p.dailyLimit > 0 ? pct : 0}%` })),
        el('div', { class: 'small' }, usageText(p), p.dailyLimit > 0 ? '' : ' · no limit set', ` · ${p.total} total`, p.cooldownSecs ? ` · retry in ${p.cooldownSecs}s` : ''),
        p.lastError && el('div', { class: 'small error-text' }, p.lastError),
        el('div', { class: 'row actions' },
          p.id !== state.activeId && el('button', { class: 'link', onclick: () => send('selectProfile', { id: p.id }) }, 'Use'),
          el('button', { class: 'link', onclick: () => { editing = { ...p, key: '' }; render(); } }, 'Edit'),
          el('button', { class: 'link', onclick: () => send('toggleProfile', { id: p.id }) }, p.enabled ? 'Disable' : 'Enable'),
          el('button', { class: 'link', onclick: () => send('resetUsage', { id: p.id }) }, 'Reset'),
          el('button', { class: 'link', disabled: i === 0, title: 'Higher priority', onclick: () => send('moveProfile', { id: p.id, dir: -1 }) }, '↑'),
          el('button', { class: 'link', disabled: i === state.profiles.length - 1, title: 'Lower priority', onclick: () => send('moveProfile', { id: p.id, dir: 1 }) }, '↓'),
          el('span', { class: 'grow' }),
          el('button', { class: 'link danger', onclick: () => send('deleteProfile', { id: p.id }) }, 'Remove')));
    }));

    return [
      topBar('API keys & usage', !editing && el('button', { class: 'primary small', onclick: () => { editing = blankForm(); render(); } }, icon('plus', 13), 'Add key')),
      bannerEl(),
      el('div', { class: 'page' }, intro, editing && renderForm(), list, freeGuide(),
        state.profiles.length > 1 && el('p', { class: 'muted small' }, 'Order = fallback priority. The key in use is tried first, then the others from top to bottom.'))];
  }

  let guideOpen = false;
  function freeGuide() {
    const free = state.presets.filter(p => p.tier === 'free');
    return el('div', { class: `card guide ${guideOpen ? 'open' : ''}` },
      el('button', { class: 'guide-head', onclick: () => { guideOpen = !guideOpen; render(); } },
        icon('key', 14), el('span', { class: 'grow' }, `Get free keys (${free.length} providers)`), el('span', { class: 'plan-chev' }, icon('chevron', 12))),
      guideOpen && el('div', { class: 'guide-body' },
        el('p', { class: 'muted small' }, 'Add as many keys as you like. Jarvis uses them top to bottom and switches automatically when one runs out. Use one key per provider; creating extra accounts to get around limits can break a provider\'s terms.'),
        free.map(p => el('div', { class: 'guide-row' },
          el('div', { class: 'grow' },
            el('strong', {}, p.label),
            p.vision === 'yes' && el('span', { class: 'guide-tag' }, 'images'),
            el('div', { class: 'muted small' }, p.note || '')),
          p.keyUrl && el('button', { class: 'ghost small', onclick: () => send('openUrl', { url: p.keyUrl }) }, 'Get key ↗'),
          el('button', { class: 'primary small', onclick: () => { editing = blankForm(p.id); guideOpen = false; render(); } }, 'Add')))));
  }

  function renderForm() {
    const f = editing;
    const pr = state.presets.find(p => p.id === f.presetId) || state.presets[0] || {};
    const isNew = !f.id;
    const field = (label, node, hint) => el('label', { class: 'field' }, el('span', {}, label), node, hint && el('span', { class: 'muted small' }, hint));
    const bind = k => e => { f[k] = e.target.value; };
    return el('div', { class: 'card form' },
      el('strong', {}, isNew ? 'Add a key' : `Edit ${f.name}`),
      field('Provider', el('select', {
        onchange: e => {
          // Keep a custom name, but replace a name that was just the old provider's label.
          const keepName = !isNew && f.name && f.name !== pr.label && !f.name.startsWith(pr.label + ' #');
          editing = { ...blankForm(e.target.value), key: f.key, id: f.id, name: keepName ? f.name : '' };
          modelCache.form = null; render();
        },
      }, [['free', 'Free tier'], ['local', 'On your computer / custom URL'], ['paid', 'Paid']].map(([tier, label]) =>
        el('optgroup', { label }, state.presets.filter(p => (p.tier || 'paid') === tier)
          .map(p => el('option', { value: p.id, selected: p.id === f.presetId }, p.label + (tier === 'free' ? ' · free' : ''))))))),
      el('div', { class: 'muted small vision-note' },
        icon('image', 12),
        pr.vision === 'yes' ? ' Can read images' : pr.vision === 'no' ? ' Text only (no images)' : ' Images depend on the model (e.g. vision models)'),
      pr.keyUrl && el('button', { class: 'link small left', onclick: () => send('openUrl', { url: pr.keyUrl }) }, `Get a ${pr.label} key ↗`),
      field('API key', el('input', {
        type: 'password', value: f.key, oninput: bind('key'), autocomplete: 'off',
        placeholder: isNew ? (pr.needsKey ? 'Paste your key' : 'Optional') : 'Leave empty to keep the saved key',
      })),
      pr.kind !== 'apifreellm' && field('Model', el('span', { class: 'row' },
        modelSelect(f.model, modelCache.form || pr.models || [], v => { f.model = v; }),
        el('button', { class: 'ghost small', onclick: () => send('fetchModels', { id: f.id, presetId: f.presetId, baseUrl: f.baseUrl, key: f.key, target: 'form' }) }, 'Load list'),
        )),
      pr.kind !== 'apifreellm' && field('Base URL', el('input', { value: f.baseUrl, oninput: bind('baseUrl'), placeholder: 'https://…/v1' })),
      field('Daily request limit', el('input', { type: 'number', min: 0, value: f.dailyLimit, oninput: bind('dailyLimit') }),
        'Jarvis switches to your next key after this many requests per day. 0 = no limit (still switches on quota errors).'),
      field('Name (optional)', el('input', { value: f.name, oninput: bind('name'), placeholder: pr.label })),
      el('div', { class: 'row' },
        el('button', { class: 'primary', onclick: () => send('saveProfile', { ...f }) }, isNew ? 'Save key' : 'Save'),
        state.profiles.length > 0 && el('button', { class: 'secondary', onclick: () => { editing = null; modelCache.form = null; render(); } }, 'Cancel')));
  }

  /** Dropdown of known models plus "Custom…" which reveals a text box. */
  function modelSelect(value, list, onChange) {
    const options = [...new Set([...(list || []), value].filter(Boolean))];
    const wrap = el('span', { class: 'grow model-select' });
    const input = el('input', { class: 'grow', value, placeholder: 'model name', oninput: e => onChange(e.target.value) });
    if (!options.length) { wrap.append(input); return wrap; }
    const sel = el('select', {
      class: 'grow',
      onchange: e => {
        if (e.target.value === '__custom') { wrap.replaceChildren(input); input.focus(); }
        else onChange(e.target.value);
      },
    }, options.map(m => el('option', { value: m, selected: m === value }, m)), el('option', { value: '__custom' }, 'Custom…'));
    wrap.append(sel);
    return wrap;
  }

  // ---------- render loop ----------

  function go(s) {
    screen = s;
    banner = null;
    menuOpen = false;
    if (s === 'keys' && !state.profiles.length && !editing) editing = blankForm();
    render();
  }

  function render() {
    const inputFocused = inputEl && document.activeElement === inputEl;
    const sel = inputFocused ? [inputEl.selectionStart, inputEl.selectionEnd] : null;
    const log = document.getElementById('log');
    const nearBottom = !log || log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const prevScroll = log ? log.scrollTop : 0;
    const views = { keys: renderKeys, chats: renderChats, account: renderAccount, chat: renderChat };
    app.className = `screen-${screen}`;
    app.replaceChildren(...(views[screen] || renderChat)().filter(Boolean), ...[renderViewer()].filter(Boolean));
    const newLog = document.getElementById('log');
    if (newLog) newLog.scrollTop = nearBottom ? newLog.scrollHeight : prevScroll;
    if (screen === 'chat') { autoGrow(); renderMentions(); renderSlash(); }
    if (inputFocused && inputEl && inputEl.isConnected) {
      inputEl.focus();
      inputEl.setSelectionRange(sel[0], sel[1]);
    }
  }

  document.addEventListener('click', () => { if (menuOpen || attachOpen) { menuOpen = false; attachOpen = false; render(); } });

  window.addEventListener('message', ({ data: m }) => {
    switch (m.type) {
      case 'state':
        state = m;
        if (!state.busy) streamText = '';
        if (screen === 'chat' && !state.profiles.length) { screen = 'keys'; if (!editing) editing = blankForm(); }
        break;
      case 'screen':
        go(m.screen);
        return;
      case 'saved':
        editing = null;
        modelCache.form = null;
        banner = { kind: 'notice', text: 'Key saved. You can start chatting.' };
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
      case 'permission':
        state.permission = m.permission;
        break;
      case 'voice':
        voiceState = m.state;
        break;
      case 'voiceText':
        if (m.text) {
          draft = (draft ? draft.replace(/\s*$/, ' ') : '') + m.text;
          saveDraft();
          if (inputEl) inputEl.value = draft;
          setTimeout(focusInput, 0);
        }
        break;
      case 'files':
        if (mention && m.query === mention.query) {
          mention.files = m.files;
          mention.sel = Math.min(mention.sel, Math.max(0, m.files.length - 1));
          renderMentions();
        }
        return;
      case 'stream':
        streamText = m.text || '';
        if (screen === 'chat') updateStream();
        return;
      case 'status':
        statusText = m.text || '';
        break;
      case 'waiting':
        waitingUntil = m.seconds ? Date.now() + m.seconds * 1000 : 0;
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
    }
    render();
  });

  render();
  send('ready');
})();
