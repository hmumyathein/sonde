/** Left rail: collections tree, environment list, request history. */
import { $, el, clear, uid, formatRelative, formatBytes, statusClass, methodClass, download, clone, base64ToBytes } from './utils.js';
import { kvTable, openModal, closeModal, promptText, confirmAction, toast } from './ui-common.js';
import * as store from './store.js';
import { newFolder, newRequestItem, newCollection, newEnvironment, newRequest, AUTH_TYPES } from './model.js';
import { exportCollection, exportEnvironment, importAny, parseSpecText } from './collection-io.js';
import { GROUPINGS, NAMINGS } from './openapi.js';

/* ------------------------------------------------------------------ *
 * Collections tree
 * ------------------------------------------------------------------ */

function matchesFilter(node, needle) {
  if (!needle) return true;
  if (node.name?.toLowerCase().includes(needle)) return true;
  if (node.request?.url?.toLowerCase().includes(needle)) return true;
  return (node.items ?? []).some((child) => matchesFilter(child, needle));
}

function iconBtn(glyph, title, onclick) {
  return el('button', {
    class: 'icon-btn',
    title,
    onclick: (e) => { e.stopPropagation(); onclick(e); },
  }, glyph);
}

function renderRequestNode(item, collection, depth) {
  const active = store.activeTab()?.sourceId === item.id;
  return el('div', {
    class: `tree-node${active ? ' is-active' : ''}`,
    style: { paddingLeft: `${depth * 14 + 8}px` },
    title: item.request.url || item.name,
    onclick: () => store.openItem(item, collection.id),
  },
    el('span', { class: `method-tag ${methodClass(item.request.method)}` }, item.request.method),
    el('span', { class: 'tree-label' }, item.name),
    el('span', { class: 'tree-actions' },
      iconBtn('⧉', 'Duplicate', () => {
        const copy = clone(item);
        copy.id = uid('req');
        copy.name = `${item.name} copy`;
        const hit = store.findItem(item.id);
        hit.siblings.splice(hit.index + 1, 0, copy);
        store.commit(() => {});
      }),
      iconBtn('✎', 'Rename', async () => {
        const name = await promptText({ title: 'Rename request', value: item.name });
        if (name) store.commit(() => { item.name = name;
          for (const t of store.state.tabs) if (t.sourceId === item.id) t.name = name;
        });
      }),
      iconBtn('🗑', 'Delete', async () => {
        if (await confirmAction({ title: 'Delete request', message: `Delete “${item.name}”? This can't be undone.` })) {
          store.removeItem(item.id);
        }
      })
    )
  );
}

function renderFolderNode(folder, collection, depth, needle) {
  const nodes = [el('div', {
    class: 'tree-node',
    style: { paddingLeft: `${depth * 14 + 8}px` },
    onclick: () => store.commit(() => { folder.open = !folder.open; }),
  },
    el('span', { class: `tree-caret${folder.open ? ' is-open' : ''}` }, '▶'),
    el('span', { class: 'tree-label' }, folder.name),
    el('span', { class: 'tree-actions' },
      iconBtn('＋', 'New request here', () => {
        const item = newRequestItem();
        folder.open = true;
        folder.items.push(item);
        store.commit(() => {});
        store.openItem(item, collection.id);
      }),
      iconBtn('✎', 'Rename', async () => {
        const name = await promptText({ title: 'Rename folder', value: folder.name });
        if (name) store.commit(() => { folder.name = name; });
      }),
      iconBtn('🗑', 'Delete', async () => {
        if (await confirmAction({ title: 'Delete folder', message: `Delete “${folder.name}” and everything inside it?` })) {
          store.removeItem(folder.id);
        }
      })
    )
  )];

  if (folder.open || needle) {
    for (const child of folder.items) {
      if (!matchesFilter(child, needle)) continue;
      nodes.push(...(child.type === 'folder'
        ? renderFolderNode(child, collection, depth + 1, needle)
        : [renderRequestNode(child, collection, depth + 1)]));
    }
  }
  return nodes;
}

function renderCollections(root) {
  const needle = store.state.filter.toLowerCase();

  if (!store.state.collections.length) {
    root.append(el('div', { class: 'tree-empty' },
      'No collections yet.', el('br'), 'Use ＋ to create one.'));
    return;
  }

  for (const collection of store.state.collections) {
    if (!matchesFilter(collection, needle)) continue;

    root.append(el('div', {
      class: 'tree-node',
      style: { paddingLeft: '6px', fontWeight: '600' },
      onclick: () => store.commit(() => { collection.open = !collection.open; }),
    },
      el('span', { class: `tree-caret${collection.open ? ' is-open' : ''}` }, '▶'),
      el('span', { class: 'tree-label' }, collection.name),
      el('span', { class: 'tree-actions' },
        iconBtn('＋', 'New request', () => {
          const item = newRequestItem();
          collection.open = true;
          collection.items.push(item);
          store.commit(() => {});
          store.openItem(item, collection.id);
        }),
        iconBtn('🗀', 'New folder', () => {
          collection.open = true;
          collection.items.push(newFolder());
          store.commit(() => {});
        }),
        iconBtn('⚙', 'Collection settings', () => openCollectionSettings(collection)),
        iconBtn('↓', 'Export', () => {
          download(`${collection.name.replace(/\W+/g, '-').toLowerCase()}.postman_collection.json`,
            JSON.stringify(exportCollection(collection), null, 2));
        }),
        iconBtn('🗑', 'Delete', async () => {
          if (await confirmAction({ title: 'Delete collection', message: `Delete “${collection.name}” and all its requests?` })) {
            store.commit((s) => { s.collections = s.collections.filter((c) => c.id !== collection.id); });
          }
        })
      )
    ));

    if (collection.open || needle) {
      for (const child of collection.items) {
        if (!matchesFilter(child, needle)) continue;
        root.append(...(child.type === 'folder'
          ? renderFolderNode(child, collection, 1, needle)
          : [renderRequestNode(child, collection, 1)]));
      }
      if (!collection.items.length) {
        root.append(el('div', { class: 'tree-empty', style: { padding: '8px 14px', textAlign: 'left' } }, 'Empty collection'));
      }
    }
  }
}

/** Collection-level auth + variables. */
function openCollectionSettings(collection) {
  const authSelect = el('select', { value: collection.auth?.type ?? 'inherit' },
    AUTH_TYPES.filter((a) => a.id !== 'inherit').map((a) => el('option', { value: a.id }, a.label)));
  const authFields = el('div');

  const renderAuthFields = () => {
    clear(authFields);
    const type = authSelect.value;
    const field = (label, key, path, password = false) => el('div', { class: 'field-row' },
      el('label', {}, label),
      el('input', {
        type: password ? 'password' : 'text',
        value: collection.auth[path][key] ?? '',
        oninput: (e) => { collection.auth[path][key] = e.target.value; store.persist(); },
      }));
    if (type === 'bearer') authFields.append(field('Token', 'token', 'bearer'));
    if (type === 'basic') authFields.append(field('Username', 'username', 'basic'), field('Password', 'password', 'basic', true));
    if (type === 'apikey') {
      authFields.append(field('Key', 'key', 'apikey'), field('Value', 'value', 'apikey'),
        el('div', { class: 'field-row' },
          el('label', {}, 'Add to'),
          el('select', {
            value: collection.auth.apikey.in,
            onchange: (e) => { collection.auth.apikey.in = e.target.value; store.persist(); },
          }, el('option', { value: 'header' }, 'Header'), el('option', { value: 'query' }, 'Query params'))));
    }
  };
  authSelect.addEventListener('change', () => {
    collection.auth.type = authSelect.value;
    store.persist();
    renderAuthFields();
  });
  renderAuthFields();

  collection.variables ??= [];
  const body = el('div', {},
    el('h4', { style: { margin: '0 0 10px' } }, 'Authorization'),
    el('div', { class: 'field-row' }, el('label', {}, 'Type'), authSelect),
    authFields,
    el('p', { class: 'field-hint' },
      'Requests set to “Inherit from parent” use this. Requests with their own auth override it.'),
    el('h4', { style: { margin: '22px 0 10px' } }, 'Collection variables'),
    kvTable(collection.variables, { onChange: () => store.persist() }),
    el('p', { class: 'field-hint' },
      'Referenced as {{name}}. Environment variables of the same name win.')
  );

  openModal({
    title: `${collection.name} — settings`,
    body,
    footer: [el('button', { class: 'btn btn-primary', onclick: () => { closeModal(); store.emit(); } }, 'Done')],
  });
}

/* ------------------------------------------------------------------ *
 * Environments
 * ------------------------------------------------------------------ */

function renderEnvironments(root) {
  const needle = store.state.filter.toLowerCase();
  const envs = store.state.environments.filter((e) => e.name.toLowerCase().includes(needle));

  root.append(el('div', {
    class: `tree-node${store.state.activeEnvId === null ? ' is-active' : ''}`,
    style: { paddingLeft: '10px' },
    onclick: () => store.commit((s) => { s.activeEnvId = null; }),
  },
    el('span', { class: 'tree-label', style: { color: 'var(--text-dim)' } }, 'No environment'),
  ));

  for (const env of envs) {
    root.append(el('div', {
      class: `tree-node${env.id === store.state.activeEnvId ? ' is-active' : ''}`,
      style: { paddingLeft: '10px' },
      onclick: () => store.commit((s) => { s.activeEnvId = env.id; }),
    },
      el('span', { class: 'tree-label' }, env.name),
      el('span', { style: { color: 'var(--text-faint)', fontSize: '11px' } }, `${env.values.length}`),
      el('span', { class: 'tree-actions' },
        iconBtn('✎', 'Edit variables', () => openEnvironmentEditor(env)),
        iconBtn('⧉', 'Duplicate', () => store.commit((s) => {
          const copy = clone(env);
          copy.id = uid('env');
          copy.name = `${env.name} copy`;
          copy.values.forEach((v) => { v.id = uid('kv'); });
          s.environments.push(copy);
        })),
        iconBtn('↓', 'Export', () => download(
          `${env.name.replace(/\W+/g, '-').toLowerCase()}.postman_environment.json`,
          JSON.stringify(exportEnvironment(env), null, 2))),
        iconBtn('🗑', 'Delete', async () => {
          if (await confirmAction({ title: 'Delete environment', message: `Delete “${env.name}”?` })) {
            store.commit((s) => {
              s.environments = s.environments.filter((e) => e.id !== env.id);
              if (s.activeEnvId === env.id) s.activeEnvId = null;
            });
          }
        })
      )
    ));
  }

  if (!store.state.environments.length) {
    root.append(el('div', { class: 'tree-empty' },
      'No environments yet.', el('br'), 'Use ＋ to add one.'));
  }

  root.append(el('div', { style: { padding: '14px 10px 0' } },
    el('div', { style: { color: 'var(--text-faint)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: '6px' } }, 'Globals'),
    el('button', {
      class: 'btn btn-sm',
      style: { width: 'calc(100% - 20px)', marginLeft: '0' },
      onclick: () => openGlobalsEditor(),
    }, `Edit globals (${store.state.globals.length})`)
  ));
}

/** Prompt for a name, create the environment, and open it for editing. */
export async function createEnvironment() {
  const name = await promptText({ title: 'New environment', value: 'New environment' });
  if (!name) return null;
  const env = newEnvironment(name);
  store.commit((s) => {
    s.environments.push(env);
    s.activeEnvId ??= env.id;
  });
  openEnvironmentEditor(env);
  return env;
}

export function openEnvironmentEditor(env) {
  const nameInput = el('input', {
    type: 'text', value: env.name,
    oninput: (e) => { env.name = e.target.value; store.persist(); store.emit(); },
  });
  openModal({
    title: 'Edit environment',
    body: el('div', {},
      el('div', { class: 'field-row' }, el('label', {}, 'Name'), nameInput),
      kvTable(env.values, { onChange: () => { store.persist(); store.emit(); } }),
      el('p', { class: 'field-hint' }, 'Use these anywhere with {{name}} — URL, headers, body, auth and scripts.')
    ),
    footer: [el('button', { class: 'btn btn-primary', onclick: () => { closeModal(); store.emit(); } }, 'Done')],
  });
}

function openGlobalsEditor() {
  openModal({
    title: 'Global variables',
    body: el('div', {},
      kvTable(store.state.globals, { onChange: () => { store.persist(); store.emit(); } }),
      el('p', { class: 'field-hint' }, 'Available in every request. Collection and environment variables of the same name take priority.')
    ),
    footer: [el('button', { class: 'btn btn-primary', onclick: () => { closeModal(); store.emit(); } }, 'Done')],
  });
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

function renderHistory(root) {
  const needle = store.state.filter.toLowerCase();
  const entries = store.state.history.filter((h) => h.url.toLowerCase().includes(needle));

  if (!entries.length) {
    root.append(el('div', { class: 'tree-empty' },
      store.state.history.length ? 'Nothing matches that filter.' : 'Sent requests show up here.'));
    return;
  }

  root.append(el('div', { style: { padding: '4px 10px 8px', textAlign: 'right' } },
    el('button', {
      class: 'btn btn-sm btn-danger',
      onclick: async () => {
        if (await confirmAction({ title: 'Clear history', message: 'Remove all history entries?', confirmLabel: 'Clear' })) {
          store.clearHistory();
        }
      },
    }, 'Clear history')));

  for (const entry of entries) {
    root.append(el('div', {
      class: 'tree-node',
      style: { paddingLeft: '8px' },
      title: entry.url,
      onclick: () => store.openNewTab({ name: entry.name || entry.url, request: clone(entry.request) }),
    },
      el('span', { class: `method-tag ${methodClass(entry.method)}` }, entry.method),
      el('span', { class: 'tree-label', style: { fontSize: '12px' } }, entry.url),
      el('span', { class: statusClass(entry.status), style: { fontSize: '11px', fontFamily: 'var(--mono)' } },
        entry.status ?? 'ERR'),
      el('span', { style: { color: 'var(--text-faint)', fontSize: '10px', width: '54px', textAlign: 'right' } },
        formatRelative(entry.at))
    ));
  }
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

/** Import settings are remembered between imports; they're preferences, not data. */
function loadPreference(key, options, fallback) {
  try {
    const saved = localStorage.getItem(`sonde:import-${key}`);
    if (options.some((o) => o.id === saved)) return saved;
  } catch { /* storage unavailable — use the default */ }
  return fallback;
}

function savePreference(key, value) {
  try { localStorage.setItem(`sonde:import-${key}`, value); } catch { /* not worth surfacing */ }
}

/** A labelled dropdown that explains the selected option underneath itself. */
function optionRow(label, options, key, fallback) {
  const hint = el('div', { class: 'field-hint', style: { margin: '4px 0 0 140px' } });
  const select = el('select', {
    value: loadPreference(key, options, fallback),
    onchange: () => { savePreference(key, select.value); showHint(); },
  }, options.map((o) => el('option', { value: o.id }, o.label)));
  const showHint = () => { hint.textContent = options.find((o) => o.id === select.value)?.hint ?? ''; };
  showHint();
  return {
    select,
    nodes: [el('div', { class: 'field-row', style: { marginBottom: '2px' } }, el('label', {}, label), select), hint],
  };
}

export function openImportDialog() {
  const textarea = el('textarea', {
    placeholder: 'Paste an OpenAPI/Swagger spec (JSON or YAML), or a Postman collection or environment export…',
    spellcheck: false,
  });

  const picker = el('input', {
    type: 'file',
    accept: '.json,.yaml,.yml,application/json,text/yaml',
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      textarea.value = await file.text();
      fetchedFrom = null;
      status.textContent = `Loaded ${file.name} (${formatBytes(file.size)}).`;
      status.style.color = 'var(--text-dim)';
    },
  });

  const urlInput = el('input', {
    type: 'text',
    placeholder: 'https://petstore3.swagger.io/api/v3/openapi.json',
    spellcheck: false,
    style: { flex: '1', minWidth: '0' },
  });
  const status = el('div', { class: 'field-hint', style: { margin: '8px 0 0' } });
  // Remembered so relative OpenAPI server URLs can be resolved against it.
  let fetchedFrom = null;

  const grouping = optionRow('Folders by', GROUPINGS, 'grouping', 'tags');
  const naming = optionRow('Name requests by', NAMINGS, 'naming', 'fallback');

  const setStatus = (message, kind = 'info') => {
    status.textContent = message;
    status.style.color = kind === 'error' ? 'var(--red)' : kind === 'ok' ? 'var(--green)' : 'var(--text-dim)';
  };

  /**
   * Fetch through the local proxy rather than directly: the browser would be
   * blocked by CORS on most spec URLs, and the proxy is already there.
   */
  const fetchSpec = async () => {
    const target = urlInput.value.trim();
    if (!target) { urlInput.focus(); return; }
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `https://${target}`;

    fetchBtn.disabled = true;
    fetchBtn.textContent = 'Fetching…';
    setStatus('Fetching the spec…');
    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'GET',
          url,
          headers: [['Accept', 'application/json, application/yaml, text/yaml, text/plain, */*']],
          timeoutMs: 30000,
          followRedirects: true,
        }),
      });
      const raw = await res.json();
      if (!raw.ok) throw new Error(raw.error);
      if (raw.status >= 400) throw new Error(`The server returned ${raw.status} ${raw.statusText}.`);

      const bytes = base64ToBytes(raw.bodyBase64);
      textarea.value = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      fetchedFrom = raw.url || url;
      setStatus(`Fetched ${formatBytes(bytes.length)} from ${raw.url} — review below, then Import.`, 'ok');
    } catch (err) {
      setStatus(`Could not fetch that URL: ${err.message}`, 'error');
    } finally {
      fetchBtn.disabled = false;
      fetchBtn.textContent = 'Fetch';
    }
  };

  const fetchBtn = el('button', { class: 'btn', onclick: fetchSpec }, 'Fetch');
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') fetchSpec(); });

  const doImport = () => {
    let parsed;
    try {
      parsed = parseSpecText(textarea.value);
    } catch (err) {
      setStatus(err.message, 'error');
      return;
    }
    try {
      const { collections, environments, notes } = importAny(parsed, {
        sourceUrl: fetchedFrom,
        grouping: grouping.select.value,
        naming: naming.select.value,
      });
      store.commit((s) => {
        s.collections.push(...collections);
        s.environments.push(...environments);
        if (!s.activeEnvId && environments.length) s.activeEnvId = environments[0].id;
      });
      closeModal();
      const parts = [];
      if (collections.length) parts.push(`${collections.length} collection${collections.length > 1 ? 's' : ''}`);
      if (environments.length) parts.push(`${environments.length} environment${environments.length > 1 ? 's' : ''}`);
      toast(`Imported ${parts.join(' and ')}${notes.length ? ` — ${notes.join(', ')}` : ''}.`, 'ok');
    } catch (err) {
      setStatus(err.message, 'error');
    }
  };

  openModal({
    title: 'Import',
    body: el('div', {},
      el('div', { class: 'field-row' },
        el('label', {}, 'From URL'),
        urlInput,
        fetchBtn),
      el('div', { class: 'field-row' },
        el('label', {}, 'From file'),
        picker),
      el('div', { style: { margin: '16px 0 8px', color: 'var(--text-faint)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.5px' } },
        'OpenAPI options'),
      grouping.nodes,
      naming.nodes,
      el('div', { style: { margin: '16px 0 6px', color: 'var(--text-faint)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.5px' } },
        'Document'),
      textarea,
      status),
    footer: [
      el('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      el('button', { class: 'btn btn-primary', onclick: doImport }, 'Import'),
    ],
  });
  setTimeout(() => urlInput.focus(), 0);
}

function exportEverything() {
  download('sonde-workspace.json', JSON.stringify({
    collections: store.state.collections.map(exportCollection),
    environments: store.state.environments.map(exportEnvironment),
  }, null, 2));
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

export function renderSidebar() {
  const root = clear($('#sidebar-body'));
  for (const btn of document.querySelectorAll('.side-tab')) {
    btn.classList.toggle('is-active', btn.dataset.side === store.state.sidebarView);
  }
  if (store.state.sidebarView === 'collections') renderCollections(root);
  else if (store.state.sidebarView === 'environments') renderEnvironments(root);
  else renderHistory(root);
}

export function initSidebar() {
  for (const btn of document.querySelectorAll('.side-tab')) {
    btn.addEventListener('click', () => store.commit((s) => { s.sidebarView = btn.dataset.side; }));
  }

  $('#sidebar-filter').addEventListener('input', (e) => {
    store.state.filter = e.target.value;
    store.emit();
  });

  $('#sidebar-new').addEventListener('click', async () => {
    const view = store.state.sidebarView;
    if (view === 'collections') {
      const name = await promptText({ title: 'New collection', value: 'New collection' });
      if (name) store.commit((s) => s.collections.push(newCollection(name)));
    } else if (view === 'environments') {
      await createEnvironment();
    } else {
      store.openNewTab();
    }
  });

  $('#sidebar-more').addEventListener('click', () => {
    openModal({
      title: 'Import & export',
      body: el('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'flex-start' } },
        el('button', { class: 'btn', onclick: () => { closeModal(); openImportDialog(); } }, 'Import from URL, file or clipboard…'),
        el('button', { class: 'btn', onclick: () => { closeModal(); exportEverything(); } }, 'Export everything'),
        el('p', { class: 'field-hint' },
          'Imports accept OpenAPI 3.x and Swagger 2.0 (JSON or YAML) as well as Postman collections. '
          + 'Exports use the Postman Collection v2.1 schema, so they open in Postman and other compatible clients.')),
      footer: [el('button', { class: 'btn', onclick: closeModal }, 'Close')],
    });
  });
}
