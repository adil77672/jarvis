// Jarvis chat webview UI. Plain DOM, no framework.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  let state = { profiles: [], activeId: undefined, history: [], busy: false, presets: [] };
  let screen = 'chat';
  let editing = null;      // profile form data when the add/edit form is open
  let banner = null;       // { kind: 'error' | 'notice', text }
  let draft = (vscode.getState() || {}).draft || '';

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
      else body.textContent = m.content;
      log.append(el('div', { class: `msg ${m.role}` },
        el('div', { class: 'who' }, m.role === 'user' ? 'You' : 'Jarvis', m.via && el('span', { class: 'muted' }, ` · ${m.via}`)),
        body));
    }
    if (state.busy) log.append(el('div', { class: 'msg assistant' }, el('div', { class: 'typing' }, 'Thinking…')));

    const input = el('textarea', {
      id: 'input', rows: 3, placeholder: 'Ask Jarvis…  (Enter to send, Shift+Enter for new line)',
      oninput: e => { draft = e.target.value; saveDraft(); },
      onkeydown: e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
      },
    });
    input.value = draft;

    const footer = el('div', { class: 'composer' },
      input,
      el('div', { class: 'toolbar' },
        el('button', { class: 'link', onclick: () => send('newChat') }, 'New chat'),
        el('span', { class: 'grow' }),
        state.busy
          ? el('button', { class: 'secondary', onclick: () => send('stop') }, 'Stop')
          : el('button', { onclick: submit }, 'Send')));

    return [header, modelRow, bannerEl(), log, footer];
  }

  function submit() {
    const text = draft.trim();
    if (!text || state.busy) return;
    banner = null;
    draft = ''; saveDraft();
    send('send', { text });
  }

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
        banner = { kind: 'error', text: m.text };
        if (m.restore && !draft) { draft = m.restore; saveDraft(); }
        break;
      case 'notice':
        banner = { kind: 'notice', text: m.text };
        if (m.restore && !draft) { draft = m.restore; saveDraft(); }
        break;
    }
    render();
  });

  render();
  send('ready');
})();
