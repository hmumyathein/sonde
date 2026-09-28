/**
 * Import/export in Postman Collection v2.1 format, so collections can move
 * between this client and Postman itself.
 */
import { uid } from './utils.js';
import { newRequest, newAuth, newCollection, newEnvironment } from './model.js';
import { parseYaml } from './yaml.js';
import { isOpenApiDocument, openApiToCollection } from './openapi.js';

const SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/* ------------------------------- export ------------------------------- */

function authToV21(auth) {
  if (!auth || auth.type === 'none' || auth.type === 'inherit') return undefined;
  const entry = (key, value) => ({ key, value, type: 'string' });
  switch (auth.type) {
    case 'bearer':
      return { type: 'bearer', bearer: [entry('token', auth.bearer.token)] };
    case 'basic':
      return { type: 'basic', basic: [entry('username', auth.basic.username), entry('password', auth.basic.password)] };
    case 'apikey':
      return { type: 'apikey', apikey: [entry('key', auth.apikey.key), entry('value', auth.apikey.value), entry('in', auth.apikey.in)] };
    default:
      return undefined;
  }
}

function urlToV21(raw) {
  const out = { raw };
  try {
    const url = new URL(raw);
    out.protocol = url.protocol.replace(':', '');
    out.host = url.hostname.split('.');
    out.path = url.pathname.split('/').filter(Boolean);
    if (url.port) out.port = url.port;
    const query = [...url.searchParams.entries()].map(([key, value]) => ({ key, value }));
    if (query.length) out.query = query;
  } catch {
    // {{baseUrl}}/path and friends aren't parseable URLs — `raw` is enough.
  }
  return out;
}

function eventsToV21(scripts) {
  const events = [];
  if (scripts?.preRequest?.trim()) {
    events.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: scripts.preRequest.split('\n') } });
  }
  if (scripts?.test?.trim()) {
    events.push({ listen: 'test', script: { type: 'text/javascript', exec: scripts.test.split('\n') } });
  }
  return events.length ? events : undefined;
}

function bodyToV21(body) {
  if (!body || body.mode === 'none') return undefined;
  switch (body.mode) {
    case 'raw':
      return {
        mode: 'raw',
        raw: body.raw.text,
        options: { raw: { language: body.raw.language } },
      };
    case 'form-urlencoded':
      return {
        mode: 'urlencoded',
        urlencoded: body['form-urlencoded'].map((r) => ({ key: r.key, value: r.value, disabled: r.enabled === false })),
      };
    case 'form-data':
      return {
        mode: 'formdata',
        formdata: body['form-data'].map((r) => (
          r.type === 'file'
            ? { key: r.key, type: 'file', src: r.fileName || null, disabled: r.enabled === false }
            : { key: r.key, value: r.value, type: 'text', disabled: r.enabled === false }
        )),
      };
    case 'binary':
      return { mode: 'file', file: { src: body.binary.fileName || null } };
    default:
      return undefined;
  }
}

function itemToV21(item) {
  if (item.type === 'folder') {
    return { name: item.name, item: item.items.map(itemToV21) };
  }
  const r = item.request;
  return {
    name: item.name,
    event: eventsToV21(r.scripts),
    request: {
      method: r.method,
      header: r.headers.map((h) => ({ key: h.key, value: h.value, description: h.description, disabled: h.enabled === false })),
      url: urlToV21(r.url),
      body: bodyToV21(r.body),
      auth: authToV21(r.auth),
    },
  };
}

export function exportCollection(collection) {
  return {
    info: {
      _postman_id: collection.id,
      name: collection.name,
      schema: SCHEMA,
    },
    item: collection.items.map(itemToV21),
    auth: authToV21(collection.auth),
    variable: (collection.variables ?? []).map((v) => ({ key: v.key, value: v.value, disabled: v.enabled === false })),
  };
}

export function exportEnvironment(env) {
  return {
    id: env.id,
    name: env.name,
    values: env.values.map((v) => ({ key: v.key, value: v.value, enabled: v.enabled !== false, type: 'default' })),
    _postman_variable_scope: 'environment',
  };
}

/* ------------------------------- import ------------------------------- */

function pairsFromV21(list, valueKey = 'value') {
  return (list ?? []).map((row) => ({
    id: uid('kv'),
    key: row.key ?? '',
    value: row[valueKey] ?? row.value ?? '',
    description: typeof row.description === 'string' ? row.description : row.description?.content ?? '',
    enabled: row.disabled !== true && row.enabled !== false,
  }));
}

function authFromV21(node) {
  const auth = newAuth();
  if (!node?.type) return auth;
  const pick = (list, key) => (list ?? []).find((e) => e.key === key)?.value ?? '';
  switch (node.type) {
    case 'bearer':
      auth.type = 'bearer';
      auth.bearer.token = pick(node.bearer, 'token');
      break;
    case 'basic':
      auth.type = 'basic';
      auth.basic.username = pick(node.basic, 'username');
      auth.basic.password = pick(node.basic, 'password');
      break;
    case 'apikey':
      auth.type = 'apikey';
      auth.apikey.key = pick(node.apikey, 'key');
      auth.apikey.value = pick(node.apikey, 'value');
      auth.apikey.in = pick(node.apikey, 'in') || 'header';
      break;
    case 'noauth':
      auth.type = 'none';
      break;
    default:
      auth.type = 'none';
  }
  return auth;
}

function urlFromV21(url) {
  if (typeof url === 'string') return url;
  if (!url) return '';
  if (url.raw) return url.raw;
  const host = Array.isArray(url.host) ? url.host.join('.') : url.host ?? '';
  const path = Array.isArray(url.path) ? url.path.join('/') : url.path ?? '';
  const query = (url.query ?? [])
    .filter((q) => !q.disabled)
    .map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value ?? '')}`)
    .join('&');
  const base = `${url.protocol ? `${url.protocol}://` : ''}${host}${url.port ? `:${url.port}` : ''}/${path}`;
  return query ? `${base}?${query}` : base;
}

function bodyFromV21(body) {
  const out = newRequest().body;
  if (!body) return out;
  switch (body.mode) {
    case 'raw':
      out.mode = 'raw';
      out.raw.text = body.raw ?? '';
      out.raw.language = body.options?.raw?.language ?? 'json';
      break;
    case 'urlencoded':
      out.mode = 'form-urlencoded';
      out['form-urlencoded'] = pairsFromV21(body.urlencoded);
      break;
    case 'formdata':
      out.mode = 'form-data';
      out['form-data'] = (body.formdata ?? []).map((row) => ({
        id: uid('kv'),
        key: row.key ?? '',
        value: row.value ?? '',
        type: row.type === 'file' ? 'file' : 'text',
        // File contents can't travel in a collection — the user re-picks the file.
        fileName: Array.isArray(row.src) ? row.src[0] : row.src ?? '',
        data: '',
        contentType: '',
        enabled: row.disabled !== true,
      }));
      break;
    case 'file':
      out.mode = 'binary';
      out.binary.fileName = body.file?.src ?? '';
      break;
    default:
      break;
  }
  return out;
}

function scriptsFromV21(events) {
  const scripts = { preRequest: '', test: '' };
  for (const event of events ?? []) {
    const code = Array.isArray(event.script?.exec) ? event.script.exec.join('\n') : event.script?.exec ?? '';
    if (event.listen === 'prerequest') scripts.preRequest = code;
    if (event.listen === 'test') scripts.test = code;
  }
  return scripts;
}

function itemFromV21(node) {
  if (Array.isArray(node.item)) {
    return {
      id: uid('fld'),
      type: 'folder',
      name: node.name ?? 'Folder',
      open: false,
      items: node.item.map(itemFromV21),
    };
  }
  const req = node.request ?? {};
  return {
    id: uid('req'),
    type: 'request',
    name: node.name ?? 'Request',
    request: newRequest({
      method: (typeof req === 'string' ? 'GET' : req.method) ?? 'GET',
      url: urlFromV21(typeof req === 'string' ? req : req.url),
      headers: pairsFromV21(req.header),
      auth: authFromV21(req.auth),
      body: bodyFromV21(req.body),
      scripts: scriptsFromV21(node.event),
    }),
  };
}

/**
 * Parse an imported document. Accepts a Postman v2.1 collection, an environment
 * export, an OpenAPI 3.x / Swagger 2.0 spec, or an array of any of those.
 * @param {object|Array} json
 * @param {object} [options]
 * @param {string} [options.sourceUrl] address the document was fetched from,
 *   used to resolve relative OpenAPI server URLs
 * @param {'tags'|'paths'|'none'} [options.grouping] OpenAPI folder layout
 * @param {string} [options.naming] which field OpenAPI requests are named after
 * @returns {{collections: object[], environments: object[], notes: string[]}}
 */
export function importAny(json, { sourceUrl = null, grouping = 'tags', naming = 'fallback' } = {}) {
  const collections = [];
  const environments = [];
  const notes = [];

  const one = (data) => {
    if (!data || typeof data !== 'object') return;

    if (isOpenApiDocument(data)) {
      const { collection, environment, stats } = openApiToCollection(data, { sourceUrl, grouping, naming });
      collections.push(collection);
      environments.push(environment);
      notes.push(`${stats.spec} · ${stats.operations} operations`);
      return;
    }

    if (data._postman_variable_scope === 'environment' || (data.values && !data.item && !data.info)) {
      const env = newEnvironment(data.name ?? 'Imported environment');
      env.values = (data.values ?? []).map((v) => ({
        id: uid('kv'), key: v.key ?? '', value: v.value ?? '', description: '', enabled: v.enabled !== false,
      }));
      environments.push(env);
      return;
    }

    if (data.item || data.info) {
      const collection = newCollection(data.info?.name ?? data.name ?? 'Imported collection');
      collection.items = (data.item ?? []).map(itemFromV21);
      collection.auth = authFromV21(data.auth);
      collection.variables = pairsFromV21(data.variable);
      collections.push(collection);
      return;
    }

    throw new Error('Unrecognised document — expected an OpenAPI/Swagger spec, or a Postman v2.1 collection or environment export.');
  };

  if (Array.isArray(json)) json.forEach(one);
  else one(json);

  if (!collections.length && !environments.length) {
    throw new Error('Nothing to import from that file.');
  }
  return { collections, environments, notes };
}

/**
 * Parse a document that may be JSON or YAML.
 * JSON is tried first — it's also valid YAML, but the real JSON parser is
 * faster and gives better errors.
 */
export function parseSpecText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new Error('Nothing to import — the document is empty.');

  if (trimmed[0] === '{' || trimmed[0] === '[') {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Invalid JSON: ${err.message}`);
    }
  }
  try {
    return parseYaml(trimmed);
  } catch (err) {
    // Might still be JSON with leading whitespace or a BOM.
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new Error(`Could not parse as YAML or JSON — ${err.message}`);
    }
  }
}
