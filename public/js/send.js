/**
 * The request pipeline: resolve → build → pre-request script → send → test script.
 */
import { clone, bytesToBase64, base64ToBytes, utf8ToBase64 } from './utils.js';
import { resolve } from './vars.js';
import { runScript } from './sandbox.js';
import { RAW_LANGUAGES } from './model.js';
import * as store from './store.js';

const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|graphql|ld\+json|problem\+json|.*\+json|.*\+xml)|image\/svg)/i;

function enabled(rows) {
  return (rows ?? []).filter((r) => r.enabled !== false && (r.key || r.value));
}

/** Walk up to the collection for `inherit` auth. Returns a concrete auth object. */
export function effectiveAuth(request, collectionId) {
  if (request.auth?.type && request.auth.type !== 'inherit') return request.auth;
  const collection = store.state.collections.find((c) => c.id === collectionId);
  const inherited = collection?.auth;
  if (inherited && inherited.type !== 'inherit') return inherited;
  return { type: 'none' };
}

function applyAuth(auth, headers, url, vars) {
  const r = (s) => resolve(s ?? '', vars);
  switch (auth?.type) {
    case 'bearer': {
      const token = r(auth.bearer?.token);
      if (token) headers.push(['Authorization', `Bearer ${token}`]);
      break;
    }
    case 'basic': {
      const user = r(auth.basic?.username);
      const pass = r(auth.basic?.password);
      if (user || pass) headers.push(['Authorization', `Basic ${utf8ToBase64(`${user}:${pass}`)}`]);
      break;
    }
    case 'apikey': {
      const key = r(auth.apikey?.key);
      const value = r(auth.apikey?.value);
      if (!key) break;
      if (auth.apikey.in === 'query') url.searchParams.set(key, value);
      else headers.push([key, value]);
      break;
    }
    default:
      break;
  }
}

function randomBoundary() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `----SondeBoundary${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Turn the body editor state into { data: base64, contentType } (or null). */
function buildBody(body, vars) {
  const enc = new TextEncoder();
  const r = (s) => resolve(s ?? '', vars);

  switch (body?.mode) {
    case 'raw': {
      const text = r(body.raw?.text);
      if (!text) return null;
      const lang = RAW_LANGUAGES.find((l) => l.id === body.raw?.language);
      return { data: utf8ToBase64(text), contentType: lang?.contentType ?? 'text/plain' };
    }
    case 'form-urlencoded': {
      const params = new URLSearchParams();
      for (const row of enabled(body['form-urlencoded'])) params.append(r(row.key), r(row.value));
      const text = params.toString();
      if (!text) return null;
      return { data: utf8ToBase64(text), contentType: 'application/x-www-form-urlencoded' };
    }
    case 'form-data': {
      const rows = enabled(body['form-data']);
      if (!rows.length) return null;
      const boundary = randomBoundary();
      const parts = [];
      for (const row of rows) {
        const name = r(row.key);
        let head = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"`;
        if (row.type === 'file') {
          head += `; filename="${row.fileName || 'file'}"\r\nContent-Type: ${row.contentType || 'application/octet-stream'}`;
        }
        head += '\r\n\r\n';
        parts.push(enc.encode(head));
        parts.push(row.type === 'file' && row.data ? base64ToBytes(row.data) : enc.encode(r(row.value)));
        parts.push(enc.encode('\r\n'));
      }
      parts.push(enc.encode(`--${boundary}--\r\n`));
      return {
        data: bytesToBase64(concatBytes(parts)),
        contentType: `multipart/form-data; boundary=${boundary}`,
      };
    }
    case 'binary': {
      if (!body.binary?.data) return null;
      return { data: body.binary.data, contentType: body.binary.contentType || 'application/octet-stream' };
    }
    default:
      return null;
  }
}

function charsetOf(contentType = '') {
  const match = /charset=["']?([\w-]+)/i.exec(contentType);
  return match ? match[1].toLowerCase() : 'utf-8';
}

function decodeBody(bytes, contentType) {
  try {
    return new TextDecoder(charsetOf(contentType), { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
}

/** Colon-style path variables, as written in the URL: /orders/:orderId */
export const PATH_PARAM_RE = /\/:([A-Za-z_][\w-]*)/g;

/**
 * Replace /:name with its value. Unset ones are left in place so they show up
 * in the sent URL rather than silently collapsing the path.
 */
export function applyPathParams(url, pathParams = []) {
  if (!pathParams.length) return url ?? '';
  const values = new Map(pathParams.filter((p) => p.key).map((p) => [p.key, p.value ?? '']));
  return String(url ?? '').replace(PATH_PARAM_RE, (match, name) => {
    const value = values.get(name);
    return value ? `/${value}` : match;
  });
}

/** Build the wire-level spec the server will execute. */
export function buildSpec(request, vars, collectionId) {
  const withPath = applyPathParams(request.url ?? '', request.pathParams ?? []);
  const rawUrl = resolve(withPath, vars).trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) || !rawUrl ? rawUrl : `https://${rawUrl}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl || '(empty)'}`);
  }

  const headers = enabled(request.headers).map((h) => [resolve(h.key, vars), resolve(h.value, vars)]);
  applyAuth(effectiveAuth(request, collectionId), headers, url, vars);

  const body = buildBody(request.body, vars);
  if (body && !headers.some(([k]) => k.toLowerCase() === 'content-type')) {
    headers.push(['Content-Type', body.contentType]);
  }

  return {
    method: request.method || 'GET',
    url: url.toString(),
    headers,
    body,
    timeoutMs: Number(request.settings?.timeoutMs) || 30000,
    followRedirects: request.settings?.followRedirects !== false,
    verifySsl: request.settings?.verifySsl !== false,
  };
}

/**
 * Run one request end to end.
 * @returns {Promise<{response, tests, logs}>}
 */
export async function sendRequest(tab) {
  const vars = store.variableMap(tab.collectionId);
  const logs = [];
  const request = clone(tab.request);

  // --- pre-request script -----------------------------------------
  let spec = buildSpec(request, vars, tab.collectionId);
  if (request.scripts?.preRequest?.trim()) {
    const pre = await runScript(request.scripts.preRequest, {
      request: spec,
      response: null,
      vars,
      requestName: tab.name,
      envName: store.activeEnv()?.name ?? null,
      env: { set: store.setEnvVar, unset: store.unsetEnvVar },
      globals: { set: store.setGlobalVar, unset: () => {} },
    });
    logs.push(...pre.logs);
    if (pre.error) {
      return {
        response: { ok: false, error: `Pre-request script failed — ${pre.error}` },
        tests: [],
        logs,
      };
    }
    // pm.request writes straight through to `spec`, so any edits the script
    // made to method/url/headers/body are already in place.
  }

  // --- send --------------------------------------------------------
  const started = performance.now();
  let raw;
  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spec),
    });
    raw = await res.json();
  } catch (err) {
    return {
      response: { ok: false, error: `Could not reach the local proxy: ${err.message}` },
      tests: [],
      logs,
    };
  }

  if (!raw.ok) {
    return {
      response: { ok: false, error: raw.error || 'Request failed', timeMs: Math.round(performance.now() - started) },
      tests: [],
      logs,
    };
  }

  // --- decode ------------------------------------------------------
  const contentType = raw.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  const bytes = base64ToBytes(raw.bodyBase64);
  const isTextual = TEXTUAL.test(contentType) || (!contentType && looksLikeText(bytes));

  const response = {
    ok: true,
    status: raw.status,
    statusText: raw.statusText,
    httpVersion: raw.httpVersion,
    url: raw.url,
    method: raw.method,
    headers: raw.headers,
    bytes,
    bodyText: isTextual ? decodeBody(bytes, contentType) : '',
    isBinary: !isTextual,
    contentType,
    size: raw.size,
    timeMs: raw.timeMs,
    timings: raw.timings,
    redirects: raw.redirects ?? [],
    requestSpec: spec,
  };

  // --- test script -------------------------------------------------
  let tests = [];
  if (request.scripts?.test?.trim()) {
    const result = await runScript(request.scripts.test, {
      request: spec,
      response,
      vars,
      requestName: tab.name,
      envName: store.activeEnv()?.name ?? null,
      env: { set: store.setEnvVar, unset: store.unsetEnvVar },
      globals: { set: store.setGlobalVar, unset: () => {} },
    });
    tests = result.tests;
    logs.push(...result.logs);
  }

  return { response, tests, logs };
}

/** Heuristic for a body with no Content-Type: mostly-printable means text. */
function looksLikeText(bytes) {
  const sample = bytes.subarray(0, 512);
  if (!sample.length) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious++;
  }
  return suspicious / sample.length < 0.05;
}
