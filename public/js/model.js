/** Factory functions + defaults for the workspace data model. */
import { uid, clone } from './utils.js';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export const BODY_MODES = [
  { id: 'none', label: 'none' },
  { id: 'raw', label: 'raw' },
  { id: 'form-urlencoded', label: 'x-www-form-urlencoded' },
  { id: 'form-data', label: 'form-data' },
  { id: 'binary', label: 'binary' },
];

export const RAW_LANGUAGES = [
  { id: 'json', label: 'JSON', contentType: 'application/json' },
  { id: 'text', label: 'Text', contentType: 'text/plain' },
  { id: 'xml', label: 'XML', contentType: 'application/xml' },
  { id: 'html', label: 'HTML', contentType: 'text/html' },
  { id: 'javascript', label: 'JavaScript', contentType: 'application/javascript' },
];

export const AUTH_TYPES = [
  { id: 'inherit', label: 'Inherit from parent' },
  { id: 'none', label: 'No auth' },
  { id: 'bearer', label: 'Bearer token' },
  { id: 'basic', label: 'Basic auth' },
  { id: 'apikey', label: 'API key' },
];

export function kv(key = '', value = '', extra = {}) {
  return { id: uid('kv'), key, value, description: '', enabled: true, ...extra };
}

export function newAuth() {
  return {
    type: 'inherit',
    bearer: { token: '' },
    basic: { username: '', password: '' },
    apikey: { key: '', value: '', in: 'header' },
  };
}

export function newBody() {
  return {
    mode: 'none',
    raw: { text: '', language: 'json' },
    'form-urlencoded': [],
    'form-data': [],
    binary: { fileName: '', data: '', contentType: '' },
  };
}

export function newRequest(overrides = {}) {
  return {
    method: 'GET',
    url: '',
    params: [],
    // Path variables are per-request by nature — /orders/:id and /users/:id
    // are unrelated values — so they live on the request, not in a shared
    // variable scope.
    pathParams: [],
    headers: [],
    auth: newAuth(),
    body: newBody(),
    scripts: { preRequest: '', test: '' },
    settings: { timeoutMs: 30000, followRedirects: true, verifySsl: true },
    ...clone(overrides),
  };
}

export function newTab(overrides = {}) {
  return {
    id: uid('tab'),
    name: 'Untitled request',
    sourceId: null,      // collection item this tab is bound to, if saved
    collectionId: null,
    dirty: false,
    request: newRequest(),
    // Runtime-only, never persisted:
    response: null,
    testResults: [],
    consoleLines: [],
    sending: false,
    ...overrides,
  };
}

export function newFolder(name = 'New folder') {
  return { id: uid('fld'), type: 'folder', name, open: true, items: [] };
}

export function newRequestItem(name = 'New request', request = newRequest()) {
  return { id: uid('req'), type: 'request', name, request };
}

export function newCollection(name = 'New collection') {
  return {
    id: uid('col'),
    name,
    open: true,
    auth: newAuth(),
    variables: [],
    items: [],
  };
}

export function newEnvironment(name = 'New environment') {
  return { id: uid('env'), name, values: [] };
}

/** Strip runtime-only fields before persisting. */
export function serialiseTab(tab) {
  const { response, testResults, consoleLines, sending, ...rest } = tab;
  return clone(rest);
}
