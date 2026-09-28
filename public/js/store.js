/**
 * Single source of truth for the app.
 *
 * The workspace (collections, environments, history, open tabs) is persisted
 * to the server, which writes it to data/workspace.json. localStorage is the
 * fallback when the server is unreachable, so the UI still works standalone.
 */
import { clone, debounce, uid } from './utils.js';
import { newTab, newCollection, serialiseTab, newRequest } from './model.js';

const LS_KEY = 'sonde:workspace';
const MAX_HISTORY = 200;

const listeners = new Set();

export const state = {
  collections: [],
  environments: [],
  globals: [],
  activeEnvId: null,
  history: [],
  tabs: [],
  activeTabId: null,
  sidebarView: 'collections',
  filter: '',
  saveStatus: 'idle',   // idle | saving | saved | error
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let scheduled = false;
/**
 * Coalesce every state change in one synchronous block into a single render.
 *
 * Deliberately a microtask rather than requestAnimationFrame: rAF callbacks do
 * not run while the document is hidden, which would latch the pending flag and
 * freeze the UI for the whole time the tab sits in the background.
 */
export function emit() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    for (const fn of listeners) {
      try {
        fn();
      } catch (err) {
        // One bad renderer must not take the rest of the UI down with it.
        console.error('render failed', err);
      }
    }
  });
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

function snapshot() {
  return {
    version: 1,
    collections: clone(state.collections),
    environments: clone(state.environments),
    globals: clone(state.globals),
    activeEnvId: state.activeEnvId,
    history: clone(state.history.slice(0, MAX_HISTORY)),
    tabs: state.tabs.map(serialiseTab),
    activeTabId: state.activeTabId,
  };
}

function hydrate(data) {
  state.collections = data.collections ?? [];
  state.environments = data.environments ?? [];
  state.globals = data.globals ?? [];
  state.activeEnvId = data.activeEnvId ?? null;
  state.history = data.history ?? [];
  state.tabs = (data.tabs ?? []).map((t) => newTab(t));
  state.activeTabId = data.activeTabId ?? state.tabs[0]?.id ?? null;
  if (!state.tabs.some((t) => t.id === state.activeTabId)) {
    state.activeTabId = state.tabs[0]?.id ?? null;
  }
}

async function persistNow() {
  const payload = snapshot();
  try { localStorage.setItem(LS_KEY, JSON.stringify(payload)); } catch { /* quota — server is authoritative */ }
  state.saveStatus = 'saving';
  emit();
  try {
    const res = await fetch('/api/workspace', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.saveStatus = 'saved';
  } catch {
    state.saveStatus = 'error';
  }
  emit();
}

export const persist = debounce(persistNow, 500);

/** Mutate state and schedule both a render and a save. */
export function commit(mutator) {
  mutator(state);
  emit();
  persist();
}

export async function init() {
  let data = null;
  try {
    const res = await fetch('/api/workspace');
    if (res.ok) data = await res.json();
  } catch { /* offline — fall through to localStorage */ }

  if (!data || (!data.collections?.length && !data.tabs?.length)) {
    try {
      const cached = localStorage.getItem(LS_KEY);
      if (cached) data = JSON.parse(cached);
    } catch { /* ignore corrupt cache */ }
  }

  hydrate(data ?? {});

  if (!state.collections.length) seedExample();
  if (!state.tabs.length) openNewTab();

  emit();
}

/** First-run content so the app isn't an empty shell. */
function seedExample() {
  const collection = newCollection('Sample API');
  collection.items = [
    {
      id: uid('req'),
      type: 'request',
      name: 'Get a post',
      request: newRequest({
        method: 'GET',
        url: '{{baseUrl}}/posts/1',
        scripts: {
          preRequest: '',
          test: [
            'pm.test("status is 200", () => {',
            '  pm.response.to.have.status(200);',
            '});',
            '',
            'pm.test("body has a title", () => {',
            '  const data = pm.response.json();',
            '  pm.expect(data).to.have.property("title");',
            '});',
          ].join('\n'),
        },
      }),
    },
    {
      id: uid('req'),
      type: 'request',
      name: 'Create a post',
      request: newRequest({
        method: 'POST',
        url: '{{baseUrl}}/posts',
        body: {
          mode: 'raw',
          raw: { text: '{\n  "title": "hello",\n  "body": "world",\n  "userId": 1\n}', language: 'json' },
          'form-urlencoded': [],
          'form-data': [],
          binary: { fileName: '', data: '', contentType: '' },
        },
      }),
    },
  ];
  state.collections = [collection];

  const env = { id: uid('env'), name: 'Sample', values: [
    { id: uid('kv'), key: 'baseUrl', value: 'https://jsonplaceholder.typicode.com', description: '', enabled: true },
  ] };
  state.environments = [env];
  state.activeEnvId = env.id;
}

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

export function activeTab() {
  return state.tabs.find((t) => t.id === state.activeTabId) ?? null;
}

export function openNewTab(init = {}) {
  const tab = newTab(init);
  state.tabs.push(tab);
  state.activeTabId = tab.id;
  emit();
  persist();
  return tab;
}

/** Open a saved collection item — focus the existing tab if already open. */
export function openItem(item, collectionId) {
  const existing = state.tabs.find((t) => t.sourceId === item.id);
  if (existing) {
    state.activeTabId = existing.id;
    emit();
    persist();
    return existing;
  }
  return openNewTab({
    name: item.name,
    sourceId: item.id,
    collectionId,
    request: clone(item.request),
  });
}

export function closeTab(id) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  state.tabs.splice(idx, 1);
  if (state.activeTabId === id) {
    state.activeTabId = state.tabs[Math.min(idx, state.tabs.length - 1)]?.id ?? null;
  }
  emit();
  persist();
}

export function markDirty(tab) {
  if (tab.sourceId) tab.dirty = true;
}

/* ------------------------------------------------------------------ *
 * Collection tree
 * ------------------------------------------------------------------ */

/** Depth-first search returning { item, parent, collection, index }. */
export function findItem(id, nodes = null, parent = null, collection = null) {
  const roots = nodes ?? state.collections;
  for (let i = 0; i < roots.length; i++) {
    const node = roots[i];
    const col = collection ?? node;
    if (node.id === id) return { item: node, parent, collection: col, index: i, siblings: roots };
    if (node.items?.length) {
      const hit = findItem(id, node.items, node, col);
      if (hit) return hit;
    }
  }
  return null;
}

export function removeItem(id) {
  const hit = findItem(id);
  if (!hit) return null;
  hit.siblings.splice(hit.index, 1);
  // Any tabs bound to a deleted item become unsaved drafts.
  for (const tab of state.tabs) {
    if (tab.sourceId === id) { tab.sourceId = null; tab.dirty = false; }
  }
  emit();
  persist();
  return hit.item;
}

/* ------------------------------------------------------------------ *
 * Environments + variables
 * ------------------------------------------------------------------ */

export function activeEnv() {
  return state.environments.find((e) => e.id === state.activeEnvId) ?? null;
}

/**
 * Resolution order, narrowest wins: environment → collection → globals.
 * Returns a plain { name: value } map.
 */
export function variableMap(collectionId = null) {
  const out = {};
  for (const v of state.globals) if (v.enabled !== false && v.key) out[v.key] = v.value;
  const col = collectionId ? state.collections.find((c) => c.id === collectionId) : null;
  for (const v of col?.variables ?? []) if (v.enabled !== false && v.key) out[v.key] = v.value;
  for (const v of activeEnv()?.values ?? []) if (v.enabled !== false && v.key) out[v.key] = v.value;
  return out;
}

/**
 * Look one variable up, reporting which scope supplied it.
 * Same precedence as variableMap: environment → collection → globals.
 */
export function resolveVariable(name, collectionId = null) {
  const env = activeEnv();
  const fromEnv = (env?.values ?? []).find((v) => v.enabled !== false && v.key === name);
  if (fromEnv) return { found: true, value: fromEnv.value, scope: 'Environment', scopeName: env.name };

  const collection = collectionId ? state.collections.find((c) => c.id === collectionId) : null;
  const fromCollection = (collection?.variables ?? []).find((v) => v.enabled !== false && v.key === name);
  if (fromCollection) return { found: true, value: fromCollection.value, scope: 'Collection', scopeName: collection.name };

  const fromGlobals = state.globals.find((v) => v.enabled !== false && v.key === name);
  if (fromGlobals) return { found: true, value: fromGlobals.value, scope: 'Globals', scopeName: null };

  return { found: false, value: null, scope: null, scopeName: null };
}

/** Set a variable from a script. Writes to the active environment. */
export function setEnvVar(key, value) {
  const env = activeEnv();
  if (!env) return false;
  const existing = env.values.find((v) => v.key === key);
  if (existing) existing.value = String(value);
  else env.values.push({ id: uid('kv'), key, value: String(value), description: '', enabled: true });
  persist();
  return true;
}

export function unsetEnvVar(key) {
  const env = activeEnv();
  if (!env) return false;
  env.values = env.values.filter((v) => v.key !== key);
  persist();
  return true;
}

export function setGlobalVar(key, value) {
  const existing = state.globals.find((v) => v.key === key);
  if (existing) existing.value = String(value);
  else state.globals.push({ id: uid('kv'), key, value: String(value), description: '', enabled: true });
  persist();
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

export function pushHistory(entry) {
  state.history.unshift({ id: uid('h'), at: Date.now(), ...entry });
  if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
  emit();
  persist();
}

export function clearHistory() {
  state.history = [];
  emit();
  persist();
}
