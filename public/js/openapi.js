/**
 * Convert an OpenAPI 3.x or Swagger 2.0 document into a collection.
 *
 * Operations are arranged into folders by tag or by path segment (see
 * GROUPINGS). Path parameters become {{variables}} so they resolve through the
 * normal variable machinery, and are seeded as collection variables from their
 * examples.
 */
import { uid } from './utils.js';
import { newCollection, newFolder, newRequest, newAuth, newBody } from './model.js';

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];
const MAX_REF_DEPTH = 8;

/** How imported requests are named. Each choice still falls back if empty. */
export const NAMINGS = [
  { id: 'fallback', label: 'Fallback', hint: 'The first of summary, operationId or description that the operation defines, otherwise its path.' },
  { id: 'summary', label: 'Summary', hint: "The operation's summary, e.g. “Find pet by ID”." },
  { id: 'operationId', label: 'Operation ID', hint: 'The operationId, e.g. “getPetById”.' },
  { id: 'description', label: 'Description', hint: 'The description, trimmed to its first line.' },
  { id: 'url', label: 'URL', hint: 'The operation path, e.g. “/pet/{petId}”. The method already shows beside it.' },
];

const NAME_ORDER = ['summary', 'operationId', 'description', 'url'];
const MAX_NAME_LENGTH = 72;

/** First line, collapsed whitespace, trimmed to something that fits a sidebar. */
function tidyName(value) {
  const text = String(value ?? '').split('\n')[0].replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > MAX_NAME_LENGTH ? `${text.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…` : text;
}

/**
 * Pick a request name. The requested field wins; anything else is tried after
 * it, so an operation missing that field still gets a useful name instead of
 * an empty one.
 */
function nameFor(path, method, operation, naming) {
  const candidates = {
    summary: operation.summary,
    operationId: operation.operationId,
    description: operation.description,
    url: path,
  };
  const order = naming === 'fallback' ? NAME_ORDER : [naming, ...NAME_ORDER.filter((k) => k !== naming)];
  for (const key of order) {
    const name = tidyName(candidates[key]);
    if (name) return name;
  }
  return `${method.toUpperCase()} ${path}`;
}

/** How imported operations are arranged into folders. */
export const GROUPINGS = [
  { id: 'tags', label: 'Tags', hint: "A folder per tag, from each operation's first tag. Untagged operations sit at the top level." },
  { id: 'paths', label: 'Path segments', hint: 'Folders mirror the URL hierarchy — /store/order becomes store ▸ order. Path parameters are skipped.' },
  { id: 'none', label: "Don't group", hint: 'Every operation at the top level, in the order the spec lists them.' },
];

export function isOpenApiDocument(doc) {
  return !!doc && typeof doc === 'object' && (typeof doc.openapi === 'string' || typeof doc.swagger === 'string');
}

/* --------------------------- $ref resolution --------------------------- */

/** Resolve a local `#/a/b` pointer. External refs are left unresolved. */
function resolveRef(doc, ref, seen) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  if (seen.has(ref)) return null;   // cyclic — stop rather than recurse forever
  let node = doc;
  for (const rawPart of ref.slice(2).split('/')) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (node == null || typeof node !== 'object') return null;
    node = node[part];
  }
  return node ?? null;
}

/** Follow $ref (recursively) and merge allOf, returning a plain schema. */
function deref(doc, node, seen = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > MAX_REF_DEPTH) return node;

  if (node.$ref) {
    const target = resolveRef(doc, node.$ref, seen);
    if (!target) return {};
    const nextSeen = new Set(seen).add(node.$ref);
    const { $ref, ...siblings } = node;
    return { ...deref(doc, target, nextSeen, depth + 1), ...siblings };
  }

  if (Array.isArray(node.allOf)) {
    const merged = { type: 'object', properties: {}, required: [] };
    for (const part of node.allOf) {
      const resolved = deref(doc, part, seen, depth + 1);
      Object.assign(merged.properties, resolved.properties ?? {});
      if (Array.isArray(resolved.required)) merged.required.push(...resolved.required);
      if (resolved.type && resolved.type !== 'object') merged.type = resolved.type;
    }
    const { allOf, ...rest } = node;
    return { ...merged, ...rest, properties: merged.properties, required: merged.required };
  }

  return node;
}

/* ------------------------- schema → sample value ------------------------- */

/** Build a representative value for a schema, for use as a body example. */
function sampleFor(doc, rawSchema, depth = 0, seen = new Set()) {
  const schema = deref(doc, rawSchema, seen, depth);
  if (!schema || typeof schema !== 'object' || depth > MAX_REF_DEPTH) return null;

  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];

  const branch = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (branch) return sampleFor(doc, branch, depth + 1, seen);

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type
    ?? (schema.properties ? 'object' : schema.items ? 'array' : undefined);

  switch (type) {
    case 'object': {
      const out = {};
      for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        out[key] = sampleFor(doc, prop, depth + 1, seen);
      }
      return out;
    }
    case 'array':
      return [sampleFor(doc, schema.items ?? {}, depth + 1, seen)].filter((v) => v !== null || schema.items);
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'string':
      return stringSample(schema);
    default:
      return schema.properties ? sampleFor(doc, { ...schema, type: 'object' }, depth, seen) : null;
  }
}

function stringSample(schema) {
  switch (schema.format) {
    case 'date-time': return new Date().toISOString();
    case 'date': return new Date().toISOString().slice(0, 10);
    case 'uuid': return '00000000-0000-4000-8000-000000000000';
    case 'email': return 'user@example.com';
    case 'uri':
    case 'url': return 'https://example.com';
    case 'byte': return 'ZXhhbXBsZQ==';
    case 'password': return 'password';
    default: return schema.pattern ? '' : 'string';
  }
}

/* ------------------------------- servers ------------------------------- */

/**
 * The base URL, with server-variable defaults substituted in.
 *
 * Server URLs are allowed to be relative ("/api/v3" is what the Swagger
 * Petstore ships), which only means anything next to the address the spec came
 * from — so resolve against `sourceUrl` when we have one.
 */
function baseUrlFor(doc, sourceUrl = null) {
  const absolute = (url) => {
    if (!url) return '';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
    if (!sourceUrl) return url;
    try {
      return new URL(url, sourceUrl).toString().replace(/\/+$/, '');
    } catch {
      return url;
    }
  };

  if (Array.isArray(doc.servers) && doc.servers.length) {
    const server = doc.servers[0];
    let url = String(server.url ?? '').replace(/\/+$/, '');
    for (const [name, variable] of Object.entries(server.variables ?? {})) {
      url = url.replaceAll(`{${name}}`, String(variable?.default ?? variable?.enum?.[0] ?? ''));
    }
    return absolute(url);
  }

  // Swagger 2.0 describes the server across host/basePath/schemes.
  if (doc.host) {
    const scheme = doc.schemes?.includes('https') ? 'https' : doc.schemes?.[0] ?? 'https';
    return `${scheme}://${doc.host}${(doc.basePath ?? '').replace(/\/+$/, '')}`;
  }
  if (doc.basePath) return absolute(String(doc.basePath).replace(/\/+$/, ''));

  // No server block at all — the host the spec came from is the best guess.
  if (sourceUrl) {
    try {
      return new URL(sourceUrl).origin;
    } catch {
      return '';
    }
  }
  return '';
}

/* -------------------------------- auth -------------------------------- */

/** Map the first usable security scheme onto our auth model. */
function authFor(doc, requirements) {
  const schemes = doc.components?.securitySchemes ?? doc.securityDefinitions ?? {};
  const auth = newAuth();

  for (const requirement of requirements ?? []) {
    for (const name of Object.keys(requirement ?? {})) {
      const scheme = deref(doc, schemes[name]);
      if (!scheme) continue;
      const type = String(scheme.type ?? '').toLowerCase();

      if (type === 'http') {
        const s = String(scheme.scheme ?? '').toLowerCase();
        if (s === 'bearer') { auth.type = 'bearer'; auth.bearer.token = '{{token}}'; return auth; }
        if (s === 'basic') { auth.type = 'basic'; auth.basic.username = '{{username}}'; auth.basic.password = '{{password}}'; return auth; }
      }
      if (type === 'apikey' && scheme.name) {
        auth.type = 'apikey';
        auth.apikey.key = scheme.name;
        auth.apikey.value = '{{apiKey}}';
        auth.apikey.in = scheme.in === 'query' ? 'query' : 'header';
        return auth;
      }
      // Swagger 2.0 spelled Basic auth as its own type.
      if (type === 'basic') {
        auth.type = 'basic';
        auth.basic.username = '{{username}}';
        auth.basic.password = '{{password}}';
        return auth;
      }
      if (type === 'oauth2' || type === 'openidconnect') {
        auth.type = 'bearer';
        auth.bearer.token = '{{accessToken}}';
        return auth;
      }
    }
  }
  return auth;
}

/* ------------------------------- bodies ------------------------------- */

const PREFERRED_MEDIA = ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];

function pickMediaType(content) {
  const available = Object.keys(content ?? {});
  if (!available.length) return null;
  const exact = PREFERRED_MEDIA.find((m) => available.includes(m));
  if (exact) return exact;
  const jsonish = available.find((m) => /\+json$|\/json/i.test(m));
  return jsonish ?? available[0];
}

function bodyFor(doc, operation) {
  const body = newBody();

  // Swagger 2.0: the body is a parameter with in: body / in: formData.
  if (doc.swagger) {
    const params = (operation.parameters ?? []).map((p) => deref(doc, p));
    const bodyParam = params.find((p) => p?.in === 'body');
    if (bodyParam) {
      body.mode = 'raw';
      body.raw.language = 'json';
      body.raw.text = JSON.stringify(sampleFor(doc, bodyParam.schema ?? {}), null, 2);
      return body;
    }
    const formParams = params.filter((p) => p?.in === 'formData');
    if (formParams.length) {
      const isMultipart = (operation.consumes ?? doc.consumes ?? []).some((c) => /multipart/i.test(c))
        || formParams.some((p) => p.type === 'file');
      body.mode = isMultipart ? 'form-data' : 'form-urlencoded';
      body[body.mode] = formParams.map((p) => ({
        id: uid('kv'),
        key: p.name ?? '',
        value: p.type === 'file' ? '' : String(sampleFor(doc, p) ?? ''),
        description: p.description ?? '',
        enabled: p.required !== false,
        ...(isMultipart ? { type: p.type === 'file' ? 'file' : 'text', fileName: '', data: '', contentType: '' } : {}),
      }));
      return body;
    }
    return body;
  }

  const requestBody = deref(doc, operation.requestBody);
  const media = pickMediaType(requestBody?.content);
  if (!media) return body;

  const spec = deref(doc, requestBody.content[media]);
  const example = spec.example ?? Object.values(spec.examples ?? {})[0]?.value
    ?? (spec.schema ? sampleFor(doc, spec.schema) : null);

  if (media === 'application/x-www-form-urlencoded' || media === 'multipart/form-data') {
    const schema = deref(doc, spec.schema ?? {});
    const required = new Set(schema.required ?? []);
    const isMultipart = media === 'multipart/form-data';
    body.mode = isMultipart ? 'form-data' : 'form-urlencoded';
    body[body.mode] = Object.entries(schema.properties ?? {}).map(([key, prop]) => {
      const resolved = deref(doc, prop);
      const isFile = resolved.format === 'binary' || resolved.format === 'byte';
      return {
        id: uid('kv'),
        key,
        value: isFile ? '' : String(sampleFor(doc, prop) ?? ''),
        description: resolved.description ?? '',
        enabled: required.has(key) || required.size === 0,
        ...(isMultipart ? { type: isFile ? 'file' : 'text', fileName: '', data: '', contentType: '' } : {}),
      };
    });
    return body;
  }

  body.mode = 'raw';
  if (/json/i.test(media)) {
    body.raw.language = 'json';
    body.raw.text = JSON.stringify(example, null, 2);
  } else if (/xml/i.test(media)) {
    body.raw.language = 'xml';
    body.raw.text = typeof example === 'string' ? example : '';
  } else {
    body.raw.language = 'text';
    body.raw.text = typeof example === 'string' ? example : JSON.stringify(example ?? '', null, 2);
  }
  return body;
}

/* ------------------------------ operations ------------------------------ */

/** A name usable as a `:param`; OpenAPI allows things like `{*}` that aren't. */
function pathParamName(raw) {
  const cleaned = String(raw).replace(/[^A-Za-z0-9_-]/g, '');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `param${cleaned}` || 'param';
}

/**
 * OpenAPI writes `/pets/{petId}`; we write `/pets/:petId`.
 *
 * Deliberately not `{{petId}}`: that would make every endpoint with an `{id}`
 * share one collection variable, so setting the id for one request would
 * change it for all the others. Path values belong to a single request.
 */
function templatePath(path) {
  return String(path).replace(/\{([^{}/]+)\}/g, (_, name) => `:${pathParamName(name)}`);
}

function buildRequest(doc, path, method, operation, pathLevelParams) {
  const params = [...(pathLevelParams ?? []), ...(operation.parameters ?? [])]
    .map((p) => deref(doc, p))
    .filter(Boolean);

  const queryParams = [];
  const headers = [];
  const pathParams = [];

  for (const param of params) {
    const sample = param.example ?? param.schema?.example ?? sampleFor(doc, param.schema ?? param) ?? '';
    const value = sample === null || typeof sample === 'object' ? '' : String(sample);
    const description = String(param.description ?? '').split('\n')[0];

    if (param.in === 'query') {
      // Required parameters arrive switched on (and so land in the URL);
      // optional ones are listed but disabled, ready to tick.
      queryParams.push({
        id: uid('kv'),
        key: param.name,
        value,
        description,
        enabled: !!param.required,
      });
    } else if (param.in === 'header' && param.name?.toLowerCase() !== 'authorization') {
      headers.push({
        id: uid('kv'),
        key: param.name,
        value,
        description,
        enabled: !!param.required,
      });
    } else if (param.in === 'path') {
      pathParams.push({
        id: uid('kv'),
        key: pathParamName(param.name),
        value,
        description,
        enabled: true,
      });
    }
  }

  const query = queryParams
    .filter((p) => p.enabled)
    .map((p) => (p.value === '' ? p.key : `${p.key}=${p.value}`))
    .join('&');
  const url = `{{baseUrl}}${templatePath(path)}${query ? `?${query}` : ''}`;

  /*
   * The URL template is the authority on path-variable names, not the declared
   * parameter list — specs disagree, e.g. a path of `/assets/{path}` whose
   * parameter is declared as `*`. Derive the names from the URL and attach the
   * declared example where the names line up, so the table always matches the
   * URL and no row is orphaned.
   */
  const declared = new Map(pathParams.map((p) => [p.key, p]));
  const fromUrl = [];
  for (const [, name] of url.matchAll(/\/:([A-Za-z_][\w-]*)/g)) {
    if (!fromUrl.includes(name)) fromUrl.push(name);
  }
  const resolvedPathParams = fromUrl.map((name) => declared.get(name) ?? {
    id: uid('kv'), key: name, value: '', description: '', enabled: true,
  });

  const request = newRequest({
    method: method.toUpperCase(),
    url,
    params: queryParams,
    pathParams: resolvedPathParams,
    headers,
    body: bodyFor(doc, operation),
    auth: operation.security ? authFor(doc, operation.security) : newAuth(),
  });

  // Operation-level security overrides; otherwise inherit the collection's.
  if (!operation.security) request.auth.type = 'inherit';

  return request;
}

/* -------------------------------- entry -------------------------------- */

/**
 * @param {object} doc      the parsed spec
 * @param {object} [options]
 * @param {string} [options.sourceUrl] where the spec was fetched from, used to
 *   resolve relative server URLs
 * @param {'tags'|'paths'|'none'} [options.grouping] how to arrange folders
 * @param {'fallback'|'summary'|'operationId'|'description'|'url'} [options.naming]
 *   which field to name requests after
 * @returns {{collection: object, environment: object, stats: object}}
 */
export function openApiToCollection(doc, { sourceUrl = null, grouping = 'tags', naming = 'fallback' } = {}) {
  if (!isOpenApiDocument(doc)) {
    throw new Error('Not an OpenAPI document — no "openapi" or "swagger" version field.');
  }

  if (!GROUPINGS.some((g) => g.id === grouping)) {
    throw new Error(`Unknown grouping "${grouping}" — expected one of ${GROUPINGS.map((g) => g.id).join(', ')}.`);
  }
  if (!NAMINGS.some((n) => n.id === naming)) {
    throw new Error(`Unknown naming "${naming}" — expected one of ${NAMINGS.map((n) => n.id).join(', ')}.`);
  }

  const title = doc.info?.title?.trim() || 'Imported API';
  const collection = newCollection(title);
  collection.auth = authFor(doc, doc.security);

  const baseUrl = baseUrlFor(doc, sourceUrl);
  const folders = new Map();
  let operationCount = 0;

  /** Find or create the folder chain `segments`, returning the deepest one. */
  const folderChain = (segments) => {
    let parent = collection;
    let key = '';
    for (const segment of segments) {
      key = key ? `${key}/${segment}` : segment;
      if (!folders.has(key)) {
        const folder = newFolder(segment);
        folder.open = false;
        folders.set(key, folder);
        parent.items.push(folder);
      }
      parent = folders.get(key);
    }
    return parent;
  };

  // Templated segments make poor folder names, and skipping them keeps
  // /pet and /pet/{petId} together where they belong.
  const staticSegments = (path) => String(path)
    .split('/')
    .filter(Boolean)
    .filter((segment) => !/^\{.*\}$/.test(segment));

  const containerFor = (path, operation) => {
    if (grouping === 'none') return collection;
    if (grouping === 'paths') return folderChain(staticSegments(path));
    const tag = operation.tags?.[0];
    return tag ? folderChain([tag]) : collection;
  };

  for (const [path, rawItem] of Object.entries(doc.paths ?? {})) {
    const pathItem = deref(doc, rawItem);
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const method of METHODS) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== 'object') continue;

      const name = nameFor(path, method, operation, naming);
      const request = buildRequest(doc, path, method, operation, pathItem.parameters);
      containerFor(path, operation).items.push({ id: uid('req'), type: 'request', name, request });
      operationCount++;
    }
  }

  // Only the server URL is genuinely collection-wide; path values live on
  // their own requests.
  collection.variables = [
    { id: uid('kv'), key: 'baseUrl', value: baseUrl, description: 'Server URL from the spec', enabled: true },
  ];

  const authVars = [];
  const seedAuth = (key, value = '') => authVars.push({ id: uid('kv'), key, value, description: 'Credential', enabled: true });
  if (collection.auth.type === 'bearer') seedAuth(collection.auth.bearer.token.replace(/[{}]/g, ''));
  if (collection.auth.type === 'basic') { seedAuth('username'); seedAuth('password'); }
  if (collection.auth.type === 'apikey') seedAuth('apiKey');

  const environment = {
    id: uid('env'),
    name: `${title} — env`,
    values: [
      { id: uid('kv'), key: 'baseUrl', value: baseUrl, description: 'Server URL from the spec', enabled: true },
      ...authVars,
    ],
  };

  return {
    collection,
    environment,
    stats: {
      title,
      version: doc.info?.version ?? '',
      operations: operationCount,
      folders: folders.size,
      grouping,
      naming,
      baseUrl,
      spec: doc.openapi ? `OpenAPI ${doc.openapi}` : `Swagger ${doc.swagger}`,
    },
  };
}
