/** Bootstrap: tab strip, send/save actions, code generation, shortcuts, layout. */
import { $, $$, el, clear, uid, clone, methodClass, copyText } from './utils.js';
import { openModal, closeModal, isModalOpen, promptText, toast } from './ui-common.js';
import * as store from './store.js';
import { newRequestItem, newCollection } from './model.js';
import { sendRequest, buildSpec } from './send.js';
import { GENERATORS, generate } from './codegen.js';
import { highlight } from './highlight.js';
import { initSidebar, renderSidebar, openEnvironmentEditor, createEnvironment } from './sidebar.js';
import {
  initRequestPanel, renderRequestPanel, invalidateRequestPanel, refreshUrlDecorations,
} from './request-panel.js';
import {
  initResponsePanel, renderResponsePanel, invalidateResponsePanel, showResponseTab,
} from './response-panel.js';

/* ------------------------------------------------------------------ *
 * Tab strip
 * ------------------------------------------------------------------ */

function renderTabStrip() {
  const strip = clear($('#tabstrip'));
  for (const tab of store.state.tabs) {
    const isActive = tab.id === store.state.activeTabId;
    strip.append(el('div', {
      class: `rtab${isActive ? ' is-active' : ''}${tab.dirty ? ' is-dirty' : ''}`,
      title: tab.request.url || tab.name,
      onclick: () => {
        if (tab.id === store.state.activeTabId) return;
        store.state.activeTabId = tab.id;
        invalidateRequestPanel();
        invalidateResponsePanel();
        store.commit(() => {});
      },
      onauxclick: (e) => { if (e.button === 1) { e.preventDefault(); closeTabSafely(tab); } },
    },
      el('span', { class: `method-tag ${methodClass(tab.request.method)}`, style: { width: 'auto' } }, tab.request.method),
      el('span', { class: 'rtab-name' }, tab.name),
      el('span', {
        class: 'rtab-close',
        title: tab.dirty ? 'Unsaved changes — click to close' : 'Close',
        onclick: (e) => { e.stopPropagation(); closeTabSafely(tab); },
      }, tab.dirty ? '' : '✕')
    ));
  }
  strip.append(el('button', { class: 'tab-add', title: 'New request (⌘T)', onclick: () => newTab() }, '＋'));
}

function newTab() {
  store.openNewTab();
  invalidateRequestPanel();
  invalidateResponsePanel();
}

async function closeTabSafely(tab) {
  if (tab.dirty) {
    const keep = await import('./ui-common.js').then((m) => m.confirmAction({
      title: 'Close without saving?',
      message: `“${tab.name}” has unsaved changes.`,
      confirmLabel: 'Discard',
    }));
    if (!keep) return;
  }
  store.closeTab(tab.id);
  invalidateRequestPanel();
  invalidateResponsePanel();
}

/* ------------------------------------------------------------------ *
 * Send
 * ------------------------------------------------------------------ */

async function doSend() {
  const tab = store.activeTab();
  if (!tab || tab.sending) return;

  if (!tab.request.url.trim()) {
    toast('Enter a URL first.', 'error');
    $('#url').focus();
    return;
  }

  tab.sending = true;
  tab.testResults = [];
  tab.consoleLines = [];
  $('#send').disabled = true;
  $('#send').textContent = 'Sending';
  invalidateResponsePanel();
  store.emit();

  let result;
  try {
    result = await sendRequest(tab);
  } catch (err) {
    result = { response: { ok: false, error: err.message }, tests: [], logs: [] };
  }

  tab.sending = false;
  tab.response = { ...result.response, __stamp: uid('r') };
  tab.testResults = result.tests;
  tab.consoleLines = result.logs;
  $('#send').disabled = false;
  $('#send').textContent = 'Send';

  // Land on the tab most likely to matter: failures first.
  if (result.tests.some((t) => !t.passed)) showResponseTab('tests');
  else if (!result.response.ok) showResponseTab('body');

  store.pushHistory({
    name: tab.name,
    method: tab.request.method,
    url: tab.request.url,
    status: result.response.ok ? result.response.status : null,
    request: clone(tab.request),
  });

  invalidateResponsePanel();
  store.emit();
}

/* ------------------------------------------------------------------ *
 * Save
 * ------------------------------------------------------------------ */

async function doSave() {
  const tab = store.activeTab();
  if (!tab) return;

  if (tab.sourceId) {
    const hit = store.findItem(tab.sourceId);
    if (hit) {
      hit.item.request = clone(tab.request);
      hit.item.name = tab.name;
      tab.dirty = false;
      store.commit(() => {});
      toast(`Saved “${tab.name}”.`, 'ok');
      return;
    }
    tab.sourceId = null; // the item was deleted underneath us — fall through to Save As
  }
  await saveAs(tab);
}

function saveAs(tab) {
  return new Promise((resolve) => {
    // Settle once — closeModal() fires onClose, which would otherwise report a
    // cancel over a completed save. See promptText in ui-common.js.
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
      closeModal();
    };
    const nameInput = el('input', { type: 'text', value: tab.name === 'Untitled request' ? '' : tab.name, placeholder: 'Request name' });

    const collectionSelect = el('select', {},
      store.state.collections.map((c) => el('option', { value: c.id }, c.name)),
      el('option', { value: '__new__' }, '＋ New collection…'));

    const commit = async () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }

      let collection;
      if (collectionSelect.value === '__new__') {
        const collectionName = await promptText({ title: 'New collection', value: 'New collection' });
        if (!collectionName) return;
        collection = newCollection(collectionName);
        store.state.collections.push(collection);
      } else {
        collection = store.state.collections.find((c) => c.id === collectionSelect.value);
      }
      if (!collection) { toast('Pick a collection to save into.', 'error'); return; }

      const item = newRequestItem(name, clone(tab.request));
      collection.open = true;
      collection.items.push(item);

      tab.name = name;
      tab.sourceId = item.id;
      tab.collectionId = collection.id;
      tab.dirty = false;

      store.commit(() => {});
      toast(`Saved to “${collection.name}”.`, 'ok');
      finish(true);
    };

    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });

    openModal({
      title: 'Save request',
      body: el('div', {},
        el('div', { class: 'field-row' }, el('label', {}, 'Name'), nameInput),
        el('div', { class: 'field-row' }, el('label', {}, 'Save to'),
          store.state.collections.length
            ? collectionSelect
            : el('span', { style: { color: 'var(--text-dim)' } }, 'A new collection will be created.'))),
      footer: [
        el('button', { class: 'btn', onclick: () => finish(false) }, 'Cancel'),
        el('button', { class: 'btn btn-primary', onclick: commit }, 'Save'),
      ],
      width: '480px',
      onClose: () => finish(false),
    });
    setTimeout(() => nameInput.focus(), 0);
  });
}

/* ------------------------------------------------------------------ *
 * Code generation
 * ------------------------------------------------------------------ */

function openCodeGen() {
  const tab = store.activeTab();
  if (!tab) return;

  let spec;
  try {
    spec = buildSpec(tab.request, store.variableMap(tab.collectionId), tab.collectionId);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  let current = GENERATORS[0].id;
  const output = el('pre', { class: 'code-view', style: { maxHeight: '46vh', background: 'var(--bg-sunken)', borderRadius: '6px' } });

  const render = () => {
    const gen = GENERATORS.find((g) => g.id === current);
    output.innerHTML = highlight(generate(current, spec), gen.language);
  };

  const picker = el('select', {
    value: current,
    onchange: (e) => { current = e.target.value; render(); },
  }, GENERATORS.map((g) => el('option', { value: g.id }, g.label)));

  render();

  openModal({
    title: 'Generate code',
    body: el('div', {},
      el('div', { class: 'field-row' }, el('label', {}, 'Language'), picker),
      output,
      el('p', { class: 'field-hint' }, 'Variables are already resolved against the active environment.')),
    footer: [
      el('button', {
        class: 'btn',
        onclick: async () => { await copyText(generate(current, spec)); toast('Snippet copied.', 'ok'); },
      }, 'Copy'),
      el('button', { class: 'btn btn-primary', onclick: closeModal }, 'Done'),
    ],
  });
}

/* ------------------------------------------------------------------ *
 * Environment picker + theme + save indicator
 * ------------------------------------------------------------------ */

function renderEnvSelect() {
  const select = $('#env-select');
  const wanted = store.state.activeEnvId ?? '';
  // The signature must cover the names too, not just the ids — renaming an
  // environment leaves the id list identical, and the options would go stale.
  // JSON, so a name containing the separator can't forge a match.
  const signature = JSON.stringify(store.state.environments.map((e) => [e.id, e.name]));

  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    clear(select);
    select.append(el('option', { value: '' }, 'No environment'));
    for (const env of store.state.environments) select.append(el('option', { value: env.id }, env.name));
  }
  if (select.value !== wanted) select.value = wanted;
}

function renderSaveState() {
  const node = $('#save-state');
  const label = {
    saving: 'Saving…',
    saved: 'Saved',
    error: 'Offline — local only',
    idle: '',
  }[store.state.saveStatus];
  node.textContent = label;
  node.style.color = store.state.saveStatus === 'error' ? 'var(--red)' : 'var(--text-faint)';
}

function initTheme() {
  const saved = localStorage.getItem('sonde:theme');
  const theme = saved ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = theme;
  $('#toggle-theme').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('sonde:theme', next);
  });
}

/* ------------------------------------------------------------------ *
 * Resizers
 * ------------------------------------------------------------------ */

function initResizers() {
  const drag = (handle, onMove, cursorClass) => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handle.classList.add('is-dragging');
      document.body.classList.add(cursorClass);
      const move = (ev) => onMove(ev);
      const up = () => {
        handle.classList.remove('is-dragging');
        document.body.classList.remove(cursorClass);
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
  };

  drag($('#resizer-sidebar'), (e) => {
    const width = Math.min(Math.max(e.clientX, 200), 560);
    document.documentElement.style.setProperty('--sidebar-w', `${width}px`);
  }, 'dragging-col');

  drag($('#resizer-response'), (e) => {
    const editor = $('#editor').getBoundingClientRect();
    const pct = ((editor.bottom - e.clientY) / editor.height) * 100;
    document.documentElement.style.setProperty('--response-h', `${Math.min(Math.max(pct, 8), 88)}%`);
  }, 'dragging-row');
}

/* ------------------------------------------------------------------ *
 * Shortcuts
 * ------------------------------------------------------------------ */

function initShortcuts() {
  addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;

    if (e.key === 'Escape' && isModalOpen()) { closeModal(); return; }

    if (mod && e.key === 'Enter') { e.preventDefault(); doSend(); return; }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); doSave(); return; }
    if (mod && e.key.toLowerCase() === 't') { e.preventDefault(); newTab(); return; }
    if (mod && e.key.toLowerCase() === 'w') {
      const tab = store.activeTab();
      if (tab) { e.preventDefault(); closeTabSafely(tab); }
      return;
    }
    if (mod && e.key.toLowerCase() === 'l') { e.preventDefault(); $('#url').focus(); $('#url').select(); return; }
    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); $('#sidebar-filter').focus(); }
  });
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function render() {
  renderSidebar();
  renderTabStrip();
  renderEnvSelect();
  renderRequestPanel();
  renderResponsePanel();
  renderSaveState();
}

async function main() {
  initTheme();
  initSidebar();
  initRequestPanel();
  initResponsePanel();
  initResizers();
  initShortcuts();

  $('#send').addEventListener('click', doSend);
  $('#save-request').addEventListener('click', doSave);
  $('#code-gen').addEventListener('click', openCodeGen);
  $('#empty-new').addEventListener('click', () => newTab());

  $('#env-select').addEventListener('change', (e) => {
    store.commit((s) => { s.activeEnvId = e.target.value || null; });
    // Switching environments can change which variables resolve.
    refreshUrlDecorations();
  });

  $('#env-manage').addEventListener('click', () => {
    // Show the environment list for context, then act: edit the active
    // environment, or create the first one. Switching a sidebar tab alone is
    // invisible when that tab is already showing.
    store.commit((s) => { s.sidebarView = 'environments'; });

    const env = store.activeEnv();
    if (env) {
      openEnvironmentEditor(env);
      return;
    }
    if (!store.state.environments.length) {
      createEnvironment();
      return;
    }
    toast('No environment selected — pick one from the list, or press ＋ to add one.');
  });

  $('#modal-close').addEventListener('click', () => closeModal());
  $('#modal-backdrop').addEventListener('mousedown', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });

  // The request panel edits state without a full re-render; this keeps the
  // tab strip's method chip and dirty dot in step.
  document.addEventListener('tabstrip:refresh', renderTabStrip);

  store.subscribe(render);
  await store.init();
  invalidateRequestPanel();
  invalidateResponsePanel();
  render();
}

main().catch((err) => {
  document.body.innerHTML = `<pre style="padding:24px;color:#f4736b;font-family:monospace">Failed to start: ${err.stack}</pre>`;
});
