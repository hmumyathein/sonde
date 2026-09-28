/** The response viewer: body, headers, test results, timing breakdown, console. */
import { $, $$, el, clear, formatBytes, formatMs, statusClass, copyText, download, prettyJson, prettyXml } from './utils.js';
import { readonlyTable, toast } from './ui-common.js';
import { highlight, detectLanguage } from './highlight.js';
import * as store from './store.js';

let activeSubtab = 'body';
let bodyView = 'pretty';   // pretty | raw | preview
let wrapLines = true;
let renderKey = null;

export function invalidateResponsePanel() {
  renderKey = null;
}

export function showResponseTab(name) {
  activeSubtab = name;
  invalidateResponsePanel();
}

/* ------------------------------------------------------------------ *
 * Body
 * ------------------------------------------------------------------ */

function prettify(text, language) {
  try {
    if (language === 'json') return prettyJson(text);
    if (language === 'xml' || language === 'html') return prettyXml(text);
  } catch {
    // Malformed payload — show it exactly as received.
  }
  return text;
}

function binaryPanel(response) {
  const blob = new Blob([response.bytes], { type: response.contentType || 'application/octet-stream' });
  const isImage = /^image\//i.test(response.contentType);
  const children = [
    el('p', {}, `Binary response — ${response.contentType || 'unknown type'}, ${formatBytes(response.size.body)}.`),
    el('button', {
      class: 'btn',
      onclick: () => download(suggestFilename(response), response.bytes, response.contentType || 'application/octet-stream'),
    }, 'Download'),
  ];
  if (isImage) {
    children.unshift(el('img', { class: 'img-preview', src: URL.createObjectURL(blob), alt: 'Response preview' }));
  }
  return el('div', { class: 'pane-note' }, children);
}

function suggestFilename(response) {
  const disposition = response.headers.find(([k]) => k.toLowerCase() === 'content-disposition')?.[1] ?? '';
  const match = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(disposition);
  if (match) return decodeURIComponent(match[1]);
  try {
    const name = new URL(response.url).pathname.split('/').filter(Boolean).pop();
    if (name) return name;
  } catch { /* fall through */ }
  return 'response';
}

function bodyPanel(response) {
  if (response.isBinary) return binaryPanel(response);

  const text = response.bodyText ?? '';
  const language = detectLanguage(response.contentType, text);

  if (!text) {
    return el('div', { class: 'pane-note' }, `Empty body (${response.status} ${response.statusText}).`);
  }

  const content = el('div', { style: { flex: '1', minHeight: '0', display: 'flex' } });
  const renderContent = () => {
    clear(content);
    if (bodyView === 'preview' && /html/i.test(language)) {
      // Sandboxed with no allow-* tokens: the response can render, but cannot
      // run scripts or reach back into this page.
      const frame = el('iframe', { class: 'raw-preview', sandbox: '', srcdoc: text });
      content.append(frame);
      return;
    }
    // Raw means unformatted, not uncoloured — it is still JSON or XML, and
    // colour is what makes a single-line payload readable at all.
    const shown = bodyView === 'pretty' ? prettify(text, language) : text;
    const pre = el('pre', { class: `code-view${wrapLines ? '' : ' nowrap'}` });
    pre.innerHTML = highlight(shown, language);
    content.append(pre);
  };

  const viewButton = (id, label) => el('button', {
    class: bodyView === id ? 'is-active' : '',
    onclick: (e) => {
      bodyView = id;
      for (const btn of e.target.parentElement.children) btn.classList.toggle('is-active', btn === e.target);
      renderContent();
    },
  }, label);

  const toolbar = el('div', { class: 'toolbar-row' },
    el('div', { class: 'seg', style: { margin: 0 } },
      viewButton('pretty', 'Pretty'),
      viewButton('raw', 'Raw'),
      /html/i.test(language) ? viewButton('preview', 'Preview') : null),
    el('span', { style: { color: 'var(--text-faint)', fontSize: '11px' } }, language.toUpperCase()),
    el('span', { class: 'spacer' }),
    el('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', color: 'var(--text-dim)' } },
      el('input', {
        type: 'checkbox', checked: wrapLines,
        onchange: (e) => { wrapLines = e.target.checked; renderContent(); },
      }), 'Wrap'),
    el('button', {
      class: 'btn btn-sm',
      onclick: async () => {
        await copyText(bodyView === 'pretty' ? prettify(text, language) : text);
        toast('Response body copied.', 'ok');
      },
    }, 'Copy'),
    el('button', {
      class: 'btn btn-sm',
      onclick: () => download(suggestFilename(response), text, response.contentType || 'text/plain'),
    }, 'Save'));

  renderContent();
  return el('div', { class: 'body-view-wrap' }, toolbar, content);
}

/* ------------------------------------------------------------------ *
 * Other tabs
 * ------------------------------------------------------------------ */

function headersPanel(response) {
  const parts = [];
  if (response.redirects?.length) {
    parts.push(el('div', { class: 'redirect-chain' },
      `Followed ${response.redirects.length} redirect${response.redirects.length > 1 ? 's' : ''}: `,
      response.redirects.map((r) => `${r.status} → ${r.location}`).join('  ·  ')));
  }
  parts.push(readonlyTable(response.headers, ['Header', 'Value']));
  return el('div', {}, parts);
}

function testsPanel(tab) {
  const tests = tab.testResults ?? [];
  if (!tests.length) {
    return el('div', { class: 'pane-note' },
      'No tests ran for this request.', el('br'),
      'Add assertions under the ', el('code', {}, 'Scripts'), ' tab.');
  }
  const passed = tests.filter((t) => t.passed).length;
  return el('div', {},
    el('div', { class: 'toolbar-row' },
      el('span', { class: passed === tests.length ? 'status-2xx' : 'status-5xx' },
        `${passed}/${tests.length} passing`)),
    tests.map((t) => el('div', { class: 'test-row' },
      el('span', { class: `test-badge ${t.passed ? 'test-pass' : 'test-fail'}` }, t.passed ? 'PASS' : 'FAIL'),
      el('span', { class: 'test-name' }, t.name),
      t.error ? el('span', { class: 'test-error' }, t.error) : null)));
}

const TIMING_ROWS = [
  ['dns', 'DNS lookup'],
  ['connect', 'TCP connect'],
  ['tls', 'TLS handshake'],
  ['wait', 'Waiting (TTFB)'],
  ['download', 'Download'],
];

function timingPanel(response) {
  const timings = response.timings ?? {};
  const total = TIMING_ROWS.reduce((sum, [key]) => sum + (timings[key] ?? 0), 0) || 1;

  return el('div', { class: 'timing-list' },
    TIMING_ROWS.map(([key, label]) => {
      const value = timings[key];
      return el('div', { class: 'timing-row' },
        el('span', { class: 'timing-label' }, label),
        el('div', { class: 'timing-bar-track' },
          el('div', { class: 'timing-bar', style: { width: `${((value ?? 0) / total) * 100}%` } })),
        el('span', { class: 'timing-val' }, value == null ? '—' : formatMs(value)));
    }),
    el('div', { class: 'timing-row', style: { marginTop: '14px', borderTop: '1px solid var(--border)', paddingTop: '12px' } },
      el('span', { class: 'timing-label', style: { fontWeight: '600' } }, 'Total'),
      el('div', { class: 'timing-bar-track', style: { visibility: 'hidden' } }),
      el('span', { class: 'timing-val', style: { fontWeight: '600' } }, formatMs(response.timeMs))),
    el('p', { class: 'field-hint' },
      'Measured on the proxy, so it excludes the browser↔proxy hop. Phases the connection reused show as —.'));
}

function consolePanel(tab) {
  const lines = tab.consoleLines ?? [];
  if (!lines.length) {
    return el('div', { class: 'pane-note' },
      'Nothing logged.', el('br'), 'Calls to ', el('code', {}, 'console.log()'), ' in your scripts appear here.');
  }
  return el('div', {}, lines.map((line) => el('div', {
    class: `console-line${line.level === 'error' ? ' console-error' : line.level === 'warn' ? ' console-warn' : ''}`,
  }, line.text)));
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

function renderMeta(tab) {
  const meta = clear($('#response-meta'));
  const response = tab.response;
  if (!response) return;

  if (!response.ok) {
    meta.append(el('span', { class: 'status-err' }, 'Error'));
    return;
  }
  meta.append(
    el('span', {}, el('span', { class: 'meta-label' }, 'Status '),
      el('b', { class: statusClass(response.status) }, `${response.status} ${response.statusText}`)),
    el('span', {}, el('span', { class: 'meta-label' }, 'Time '), el('b', {}, formatMs(response.timeMs))),
    el('span', {}, el('span', { class: 'meta-label' }, 'Size '),
      el('b', {}, formatBytes((response.size?.body ?? 0) + (response.size?.headers ?? 0))))
  );
}

export function renderResponsePanel() {
  const tab = store.activeTab();
  if (!tab) return;

  const key = [
    tab.id,
    activeSubtab,
    tab.sending ? 'sending' : 'idle',
    tab.response?.__stamp ?? 'none',
  ].join(':');
  if (key === renderKey) return;
  renderKey = key;

  for (const btn of $$('#response-subtabs .subtab')) {
    btn.classList.toggle('is-active', btn.dataset.res === activeSubtab);
  }

  const failed = (tab.testResults ?? []).filter((t) => !t.passed).length;
  const testCount = (tab.testResults ?? []).length;
  $('[data-count="res-tests"]').textContent = testCount ? (failed ? `${failed}✕` : `${testCount}✓`) : '';
  $('[data-count="res-headers"]').textContent = tab.response?.headers?.length || '';
  $('[data-count="res-console"]').textContent = tab.consoleLines?.length || '';

  renderMeta(tab);
  const host = clear($('#response-body'));

  if (tab.sending) {
    host.append(el('div', { class: 'pane-note' }, el('span', { class: 'spinner' }), ' Sending…'));
    return;
  }
  if (!tab.response) {
    host.append(el('div', { class: 'pane-note' },
      'Hit ', el('code', {}, 'Send'), ' to see the response here.', el('br'),
      el('span', { style: { fontSize: '11px' } }, '⌘/Ctrl + Enter also works.')));
    return;
  }
  if (!tab.response.ok) {
    host.append(el('div', { class: 'pane-note' },
      el('div', { class: 'status-err', style: { fontSize: '14px', marginBottom: '10px' } }, 'Request failed'),
      el('div', { style: { fontFamily: 'var(--mono)', fontSize: '12px', color: 'var(--text)' } }, tab.response.error),
      el('p', { class: 'field-hint' },
        'Check the URL, that the host is reachable, and — for self-signed certificates — the TLS setting under Settings.')));
    return;
  }

  switch (activeSubtab) {
    case 'headers': host.append(headersPanel(tab.response)); break;
    case 'tests': host.append(testsPanel(tab)); break;
    case 'timing': host.append(timingPanel(tab.response)); break;
    case 'console': host.append(consolePanel(tab)); break;
    default: host.append(bodyPanel(tab.response));
  }
}

export function initResponsePanel() {
  for (const btn of $$('#response-subtabs .subtab')) {
    btn.addEventListener('click', () => {
      activeSubtab = btn.dataset.res;
      invalidateResponsePanel();
      store.emit();
    });
  }
}
