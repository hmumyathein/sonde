/** The request editor: URL bar plus the Params / Auth / Headers / Body / Scripts / Settings tabs. */
import { $, $$, el, clear, uid, debounce, bytesToBase64, formatBytes, escapeHtml } from './utils.js';
import { kvTable, toast } from './ui-common.js';
import * as store from './store.js';
import { METHODS, BODY_MODES, RAW_LANGUAGES, AUTH_TYPES } from './model.js';
import { resolve, usedVars, isDynamic, highlightVars } from './vars.js';
import { PATH_PARAM_RE } from './send.js';
import { highlight } from './highlight.js';
import { prettyJson } from './utils.js';

let activeSubtab = 'params';
let renderKey = null;

/** Force the next render to rebuild the panel from scratch. */
export function invalidateRequestPanel() {
  renderKey = null;
}

/* ------------------------------------------------------------------ *
 * URL ⇄ query-param synchronisation
 *
 * The URL bar is what gets sent; the Params grid is an editable view of its
 * query string. Values stay raw (never percent-encoded here) so {{vars}}
 * survive round-tripping — encoding happens once, at send time.
 * ------------------------------------------------------------------ */

function splitUrl(url) {
  const hashAt = url.indexOf('#');
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const withoutHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = withoutHash.indexOf('?');
  return {
    base: queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt),
    query: queryAt === -1 ? '' : withoutHash.slice(queryAt + 1),
    hash,
  };
}

export function paramsFromUrl(url, previous = []) {
  const { query } = splitUrl(url ?? '');
  const rows = query.split('&').filter(Boolean).map((pair) => {
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    const carried = previous.find((p) => p.key === key);
    return {
      id: carried?.id ?? uid('kv'),
      key,
      value,
      description: carried?.description ?? '',
      enabled: true,
    };
  });

  // Disabled rows have no representation in the URL, so carry them across or
  // they'd vanish the moment the user unticks one. This is also what lets an
  // imported spec offer its optional parameters pre-filled but switched off.
  const present = new Set(rows.map((r) => r.key));
  for (const row of previous) {
    if (row.enabled === false && !present.has(row.key)) rows.push({ ...row });
  }
  return rows;
}

/**
 * Path variables are read out of the URL, never written back to it — the URL
 * owns the names, the table owns the values. Existing values survive edits
 * elsewhere in the URL.
 */
export function pathParamsFromUrl(url, previous = []) {
  const { base } = splitUrl(url ?? '');
  const names = [];
  for (const [, name] of base.matchAll(PATH_PARAM_RE)) {
    if (!names.includes(name)) names.push(name);
  }
  return names.map((name) => {
    const carried = previous.find((p) => p.key === name);
    return {
      id: carried?.id ?? uid('kv'),
      key: name,
      value: carried?.value ?? '',
      description: carried?.description ?? '',
      enabled: true,
    };
  });
}

export function urlFromParams(url, params) {
  const { base, hash } = splitUrl(url ?? '');
  const query = params
    .filter((p) => p.enabled !== false && (p.key || p.value))
    .map((p) => (p.value === '' ? p.key : `${p.key}=${p.value}`))
    .join('&');
  return `${base}${query ? `?${query}` : ''}${hash}`;
}

/* ------------------------------------------------------------------ *
 * Change plumbing
 * ------------------------------------------------------------------ */

/** Record an edit without re-rendering the panel (which would steal focus). */
function touched(tab) {
  store.markDirty(tab);
  store.persist();
  refreshCounts();
  document.dispatchEvent(new CustomEvent('tabstrip:refresh'));
}

function countEnabled(rows) {
  return (rows ?? []).filter((r) => r.enabled !== false && (r.key || r.value)).length;
}

function setCount(name, value) {
  const node = $(`[data-count="${name}"]`);
  if (node) node.textContent = value ? String(value) : '';
}

export function refreshCounts() {
  const tab = store.activeTab();
  if (!tab) return;
  const r = tab.request;
  setCount('params', countEnabled(r.params) + (r.pathParams?.length ?? 0));
  setCount('headers', countEnabled(r.headers));
  setCount('auth', r.auth?.type && !['none', 'inherit'].includes(r.auth.type) ? '•' : '');
  setCount('body', r.body?.mode && r.body.mode !== 'none' ? '•' : '');
  setCount('scripts', (r.scripts?.preRequest?.trim() || r.scripts?.test?.trim()) ? '•' : '');
}

/* ------------------------------------------------------------------ *
 * Sub-panels
 * ------------------------------------------------------------------ */

/** Name column is read-only: the URL decides the names, this sets the values. */
function pathParamsTable(rows, onChange) {
  const body = el('tbody', {}, rows.map((row) => el('tr', {},
    el('td', { style: { width: '32px' } }),
    el('td', {}, el('input', {
      type: 'text', value: `:${row.key}`, readOnly: true,
      style: { color: 'var(--accent)' },
      title: 'Defined by the URL — edit the URL to rename it',
    })),
    el('td', {}, el('input', {
      type: 'text', value: row.value ?? '', placeholder: 'value', spellcheck: false,
      oninput: (e) => { row.value = e.target.value; onChange(); },
    })),
    el('td', { style: { width: '26%' } }, el('input', {
      type: 'text', value: row.description ?? '', placeholder: 'description', spellcheck: false,
      oninput: (e) => { row.description = e.target.value; onChange(); },
    })),
    el('td', { style: { width: '34px' } })
  )));

  return el('table', { class: 'kv' },
    el('thead', {}, el('tr', {},
      el('th', { style: { width: '32px' } }),
      el('th', {}, 'Path variable'),
      el('th', {}, 'Value'),
      el('th', { style: { width: '26%' } }, 'Description'),
      el('th', { style: { width: '34px' } }))),
    body);
}

function paramsPanel(tab) {
  const request = tab.request;
  request.params = paramsFromUrl(request.url, request.params);
  request.pathParams = pathParamsFromUrl(request.url, request.pathParams ?? []);

  const table = kvTable(request.params, {
    keyLabel: 'Query parameter',
    onChange: () => {
      request.url = urlFromParams(request.url, request.params);
      const input = $('#url');
      if (input) input.value = request.url;
      paintUrlHighlight(tab);
      updateUrlPreview(tab);
      touched(tab);
    },
  });

  const sections = [
    el('div', { class: 'section-label' }, 'Query params'),
    table,
  ];

  if (request.pathParams.length) {
    sections.push(
      el('div', { class: 'section-label' }, 'Path variables'),
      pathParamsTable(request.pathParams, () => { paintUrlHighlight(tab); touched(tab); }));
  }

  return el('div', {}, sections);
}

function authPanel(tab) {
  const auth = tab.request.auth;
  const fields = el('div', { class: 'pane-pad' });

  const field = (label, group, key, { password = false } = {}) => el('div', { class: 'field-row' },
    el('label', {}, label),
    el('input', {
      type: password ? 'password' : 'text',
      value: auth[group][key] ?? '',
      spellcheck: false,
      oninput: (e) => { auth[group][key] = e.target.value; touched(tab); },
    }));

  const renderFields = () => {
    clear(fields);
    switch (auth.type) {
      case 'bearer':
        fields.append(field('Token', 'bearer', 'token'));
        break;
      case 'basic':
        fields.append(field('Username', 'basic', 'username'), field('Password', 'basic', 'password', { password: true }));
        break;
      case 'apikey':
        fields.append(
          field('Key', 'apikey', 'key'),
          field('Value', 'apikey', 'value'),
          el('div', { class: 'field-row' },
            el('label', {}, 'Add to'),
            el('select', {
              value: auth.apikey.in,
              onchange: (e) => { auth.apikey.in = e.target.value; touched(tab); },
            },
              el('option', { value: 'header' }, 'Header'),
              el('option', { value: 'query' }, 'Query params'))));
        break;
      case 'inherit': {
        const collection = store.state.collections.find((c) => c.id === tab.collectionId);
        const parentType = collection?.auth?.type ?? 'none';
        fields.append(el('div', { class: 'field-note' },
          collection
            ? `From ${collection.name}: ${AUTH_TYPES.find((a) => a.id === parentType)?.label ?? parentType}`
            : 'Not in a collection — nothing inherited'));
        break;
      }
      default:
    }
  };

  const select = el('select', { value: auth.type },
    AUTH_TYPES.map((a) => el('option', { value: a.id }, a.label)));
  select.addEventListener('change', () => {
    auth.type = select.value;
    renderFields();
    touched(tab);
  });
  renderFields();

  return el('div', {},
    el('div', { class: 'toolbar-row' }, el('label', { style: { color: 'var(--text-dim)' } }, 'Type'), select),
    fields);
}

function headersPanel(tab) {
  const table = kvTable(tab.request.headers, {
    keyLabel: 'Header',
    keyPlaceholder: 'Content-Type',
    valuePlaceholder: 'application/json',
    onChange: () => touched(tab),
  });
  return el('div', {}, table);
}

function bodyPanel(tab) {
  const body = tab.request.body;
  const editor = el('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } });

  const renderEditor = () => {
    clear(editor);
    switch (body.mode) {
      case 'raw': {
        // Same trick as the URL bar: a mirror layer paints the syntax colours
        // behind a real <textarea>, which keeps native editing intact.
        const mirror = el('pre', { class: 'code-mirror', 'aria-hidden': 'true' });
        const area = el('textarea', {
          class: 'code-area code-area-mirrored',
          spellcheck: false,
          value: body.raw.text,
          placeholder: '{\n  "key": "value"\n}',
        });

        const repaint = () => {
          // A trailing newline collapses in a <pre>; a space keeps the last
          // line's height so the two layers stay the same height.
          const text = area.value.endsWith('\n') ? `${area.value} ` : area.value;
          mirror.innerHTML = highlight(text, body.raw.language);
          mirror.scrollTop = area.scrollTop;
          mirror.scrollLeft = area.scrollLeft;
        };

        area.addEventListener('input', () => {
          body.raw.text = area.value;
          repaint();
          touched(tab);
        });
        area.addEventListener('scroll', () => {
          mirror.scrollTop = area.scrollTop;
          mirror.scrollLeft = area.scrollLeft;
        });
        area.addEventListener('keydown', (e) => {
          if (e.key === 'Tab') {
            e.preventDefault();
            const { selectionStart: start, selectionEnd: end } = area;
            area.value = `${area.value.slice(0, start)}  ${area.value.slice(end)}`;
            area.selectionStart = area.selectionEnd = start + 2;
            body.raw.text = area.value;
            repaint();
            touched(tab);
          }
        });

        repaint();
        editor.append(el('div', { class: 'code-stack' }, mirror, area));
        break;
      }
      case 'form-urlencoded':
        editor.append(kvTable(body['form-urlencoded'], { description: false, onChange: () => touched(tab) }));
        break;
      case 'form-data':
        editor.append(kvTable(body['form-data'], { files: true, onChange: () => touched(tab) }));
        break;
      case 'binary': {
        const label = el('div', { style: { color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: '12px' } },
          body.binary.fileName ? `${body.binary.fileName} · ${formatBytes(Math.round(body.binary.data.length * 0.75))}` : 'No file selected');
        const picker = el('input', {
          type: 'file',
          style: { display: 'none' },
          onchange: async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            body.binary.fileName = file.name;
            body.binary.contentType = file.type || 'application/octet-stream';
            body.binary.data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
            label.textContent = `${file.name} · ${formatBytes(file.size)}`;
            touched(tab);
          },
        });
        editor.append(el('div', { class: 'pane-pad' },
          el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } },
            el('button', { class: 'btn', onclick: () => picker.click() }, 'Choose file'),
            label, picker)));
        break;
      }
      default:
        editor.append(el('div', { class: 'pane-note' }, 'This request does not have a body.'));
    }
  };

  const modes = el('div', { class: 'radio-group' }, BODY_MODES.map((mode) => el('label', {},
    el('input', {
      type: 'radio', name: `body-mode-${tab.id}`, value: mode.id, checked: body.mode === mode.id,
      onchange: () => { body.mode = mode.id; renderEditor(); renderToolbar(); touched(tab); },
    }),
    mode.label)));

  const extras = el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } });
  const renderToolbar = () => {
    clear(extras);
    if (body.mode !== 'raw') return;
    extras.append(el('select', {
      value: body.raw.language,
      onchange: (e) => { body.raw.language = e.target.value; touched(tab); },
    }, RAW_LANGUAGES.map((l) => el('option', { value: l.id }, l.label))));
    extras.append(el('button', {
      class: 'btn btn-sm',
      title: 'Format the body',
      onclick: () => {
        try {
          body.raw.text = body.raw.language === 'json' ? prettyJson(body.raw.text) : body.raw.text;
          renderEditor();
          touched(tab);
        } catch (err) {
          toast(`Can't format: ${err.message}`, 'error');
        }
      },
    }, 'Beautify'));
  };
  renderToolbar();
  renderEditor();

  return el('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
    el('div', { class: 'toolbar-row' }, modes, el('span', { class: 'spacer' }), extras),
    editor);
}

const SNIPPETS = [
  { label: 'Status is 200', code: 'pm.test("status is 200", () => {\n  pm.response.to.have.status(200);\n});' },
  { label: 'Response is JSON', code: 'pm.test("response is JSON", () => {\n  pm.response.to.have.jsonBody();\n});' },
  { label: 'Body contains value', code: 'pm.test("body contains id", () => {\n  pm.expect(pm.response.json()).to.have.property("id");\n});' },
  { label: 'Response time < 500ms', code: 'pm.test("responds quickly", () => {\n  pm.expect(pm.response.responseTime).to.be.below(500);\n});' },
  { label: 'Save a value to the environment', code: 'pm.environment.set("token", pm.response.json().token);' },
];

function scriptsPanel(tab) {
  const scripts = tab.request.scripts;

  const area = (key, placeholder) => {
    const node = el('textarea', {
      class: 'code-area',
      spellcheck: false,
      value: scripts[key],
      placeholder,
      style: { minHeight: '150px', height: 'auto', flex: '1' },
      oninput: (e) => { scripts[key] = e.target.value; touched(tab); },
    });
    return node;
  };

  const testArea = area('test', '// pm.test("name", () => { ... })');
  const preArea = area('preRequest', '// pm.environment.set("nonce", Date.now());');

  return el('div', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: '0' } },
    el('div', { class: 'toolbar-row' },
      el('strong', { style: { fontSize: '12px' } }, 'Pre-request')),
    el('div', { style: { flex: '1', minHeight: '110px', display: 'flex' } }, preArea),
    el('div', { class: 'toolbar-row', style: { borderTop: '1px solid var(--border)' } },
      el('strong', { style: { fontSize: '12px' } }, 'Tests'),
      el('span', { class: 'spacer' }),
      el('select', {
        value: '',
        onchange: (e) => {
          const snippet = SNIPPETS.find((s) => s.label === e.target.value);
          if (!snippet) return;
          scripts.test = scripts.test ? `${scripts.test.replace(/\s*$/, '')}\n\n${snippet.code}` : snippet.code;
          testArea.value = scripts.test;
          e.target.value = '';
          touched(tab);
        },
      },
        el('option', { value: '' }, 'Insert snippet…'),
        SNIPPETS.map((s) => el('option', { value: s.label }, s.label)))),
    el('div', { style: { flex: '1.4', minHeight: '110px', display: 'flex' } }, testArea));
}

function settingsPanel(tab) {
  const settings = tab.request.settings;
  const toggle = (label, key, hint) => el('div', { class: 'field-row' },
    el('label', {}, label),
    el('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--text-dim)' } },
      el('input', {
        type: 'checkbox', checked: settings[key] !== false,
        onchange: (e) => { settings[key] = e.target.checked; touched(tab); },
      }), hint));

  return el('div', { class: 'pane-pad' },
    el('div', { class: 'field-row' },
      el('label', {}, 'Timeout (ms)'),
      el('input', {
        type: 'text', value: String(settings.timeoutMs ?? 30000), style: { maxWidth: '140px' },
        oninput: (e) => { settings.timeoutMs = Number(e.target.value.replace(/\D/g, '')) || 30000; touched(tab); },
      })),
    toggle('Redirects', 'followRedirects', 'Follow redirects'),
    toggle('TLS', 'verifySsl', 'Verify certificate'));
}

const PANELS = {
  params: paramsPanel,
  auth: authPanel,
  headers: headersPanel,
  body: bodyPanel,
  scripts: scriptsPanel,
  settings: settingsPanel,
};

/* ------------------------------------------------------------------ *
 * URL bar
 * ------------------------------------------------------------------ */

/**
 * Repaint the layer behind the URL input so each {{name}} gets a chip —
 * green when it resolves, red when nothing defines it.
 */
export function paintUrlHighlight(tab) {
  const layer = $('#url-highlight');
  const input = $('#url');
  if (!layer || !input || !tab) return;

  const text = input.value ?? '';
  layer.innerHTML = text.includes('{{')
    ? highlightVars(text, store.variableMap(tab.collectionId))
    : escapeHtml(text);
  // The mirror doesn't scroll itself; keep it aligned with the input.
  layer.scrollLeft = input.scrollLeft;
}

/**
 * Show what the URL actually becomes: the fully resolved address, then one row
 * per variable it references with the value and the scope it came from.
 */
export function updateUrlPreview(tab) {
  const preview = $('#url-preview');
  if (!preview || !tab) return;

  const raw = tab.request.url ?? '';
  if (!raw.includes('{{')) {
    preview.hidden = true;
    return;
  }

  const vars = store.variableMap(tab.collectionId);
  const names = usedVars(raw);
  const resolved = resolve(raw, vars);
  const unresolved = resolved.includes('{{');

  clear(preview);
  preview.hidden = false;

  preview.append(el('div', { class: 'url-resolved' },
    el('span', { class: 'url-resolved-label' }, unresolved ? 'Resolves to (incomplete)' : 'Resolves to'),
    el('span', { class: `url-resolved-value${unresolved ? ' var-missing' : ''}` }, resolved || '—')));

  const rows = el('div', { class: 'var-rows' });
  for (const name of names) {
    if (isDynamic(name)) {
      rows.append(el('div', { class: 'var-row' },
        el('span', { class: 'var-chip var-ok' }, `{{${name}}}`),
        el('span', { class: 'var-scope' }, 'Generated'),
        el('span', { class: 'var-value' }, 'a new value each time you send')));
      continue;
    }

    const hit = store.resolveVariable(name, tab.collectionId);
    rows.append(el('div', { class: 'var-row' },
      el('span', { class: `var-chip ${hit.found ? 'var-ok' : 'var-missing'}` }, `{{${name}}}`),
      el('span', { class: `var-scope${hit.found ? '' : ' var-scope-missing'}` },
        hit.found ? (hit.scopeName ? `${hit.scope} · ${hit.scopeName}` : hit.scope) : 'Not defined'),
      el('span', { class: 'var-value' },
        hit.found ? (hit.value === '' ? '(empty)' : hit.value) : 'set it in an environment, the collection, or globals')));
  }
  preview.append(rows);
}

const onUrlInput = debounce((tab) => {
  tab.request.params = paramsFromUrl(tab.request.url, tab.request.params);
  tab.request.pathParams = pathParamsFromUrl(tab.request.url, tab.request.pathParams ?? []);
  if (activeSubtab === 'params') {
    invalidateRequestPanel();
    store.emit();
  }
  touched(tab);
}, 250);

function initUrlBar() {
  const methodSelect = $('#method');
  for (const method of METHODS) methodSelect.append(el('option', { value: method }, method));

  methodSelect.addEventListener('change', () => {
    const tab = store.activeTab();
    if (!tab) return;
    tab.request.method = methodSelect.value;
    touched(tab);
  });

  const urlInput = $('#url');
  urlInput.addEventListener('input', () => {
    const tab = store.activeTab();
    if (!tab) return;
    tab.request.url = urlInput.value;
    paintUrlHighlight(tab);
    updateUrlPreview(tab);
    onUrlInput(tab);
  });
  // Long URLs scroll inside the input; the mirror has to follow.
  urlInput.addEventListener('scroll', () => { $('#url-highlight').scrollLeft = urlInput.scrollLeft; });
  const preview = $('#url-preview');
  let overPreview = false;
  preview.addEventListener('mouseenter', () => { overPreview = true; });
  preview.addEventListener('mouseleave', () => {
    overPreview = false;
    if (document.activeElement !== urlInput) preview.hidden = true;
  });

  urlInput.addEventListener('focus', () => updateUrlPreview(store.activeTab()));
  urlInput.addEventListener('mouseenter', () => {
    if (document.activeElement !== urlInput) updateUrlPreview(store.activeTab());
  });
  urlInput.addEventListener('mouseleave', () => {
    // Give the pointer a moment to reach the panel before hiding it.
    setTimeout(() => {
      if (!overPreview && document.activeElement !== urlInput) preview.hidden = true;
    }, 140);
  });
  urlInput.addEventListener('blur', () => {
    setTimeout(() => { if (!overPreview) preview.hidden = true; }, 140);
  });
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

export function renderRequestPanel() {
  const tab = store.activeTab();
  $('#editor').hidden = !tab;
  $('#pane-empty').hidden = !!tab;
  if (!tab) return;

  const key = `${tab.id}:${activeSubtab}`;
  const methodSelect = $('#method');
  const urlInput = $('#url');

  if (key !== renderKey) {
    renderKey = key;
    methodSelect.value = tab.request.method;
    if (document.activeElement !== urlInput) {
      urlInput.value = tab.request.url;
      // The preview belongs to the URL bar while it has focus; on a tab switch
      // it would otherwise keep showing the previous request's URL.
      $('#url-preview').hidden = true;
    } else {
      updateUrlPreview(tab);
    }

    for (const btn of $$('#request-subtabs .subtab')) {
      btn.classList.toggle('is-active', btn.dataset.req === activeSubtab);
    }
    const host = clear($('#request-body'));
    host.append(PANELS[activeSubtab](tab));
  } else if (document.activeElement !== methodSelect) {
    methodSelect.value = tab.request.method;
  }

  // Outside the key guard on purpose: editing a variable's value or toggling it
  // in the environment editor changes what the URL resolves to without changing
  // the tab or sub-tab, so the chips and the resolved panel must repaint anyway.
  refreshUrlDecorations(tab);
  refreshCounts();
}

/**
 * Refresh both URL decorations together — the chip layer and the resolved
 * panel read the same state, so updating one without the other leaves the
 * pane showing a stale URL.
 */
export function refreshUrlDecorations(tab = store.activeTab()) {
  if (!tab) return;
  paintUrlHighlight(tab);
  if (!$('#url-preview').hidden || document.activeElement === $('#url')) updateUrlPreview(tab);
}

export function initRequestPanel() {
  initUrlBar();
  for (const btn of $$('#request-subtabs .subtab')) {
    btn.addEventListener('click', () => {
      activeSubtab = btn.dataset.req;
      invalidateRequestPanel();
      store.emit();
    });
  }
}
