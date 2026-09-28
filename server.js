#!/usr/bin/env node
/**
 * Sonde — local API client backend.
 *
 * Two jobs:
 *   1. Serve the static UI out of ./public
 *   2. Act as the request proxy (/api/send). The browser can't issue arbitrary
 *      cross-origin requests with custom headers, so the real HTTP call happens
 *      here, in Node, where we also get raw headers, redirect chains, TLS
 *      control and connection timings.
 *
 * Bound to 127.0.0.1 by default: this is developer tooling that will fetch any
 * URL it is handed, so it must not be exposed to a network.
 *
 * Run with --app to pick a free port and open a standalone browser window;
 * that's how the bundled Sonde.app starts it.
 */
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// Bundled as an app, the code may live somewhere read-only (/Applications), so
// the launcher points this at the user's Application Support directory.
const DATA_DIR = process.env.SONDE_DATA_DIR || path.join(__dirname, 'data');
const WORKSPACE_FILE = path.join(DATA_DIR, 'workspace.json');

const APP_MODE = process.argv.includes('--app');
// Started by the native shell: pick a free port, announce it on stdout, and
// leave the window to the host rather than opening a browser.
const EMBEDDED = process.argv.includes('--embedded');
const PORT = Number(process.env.PORT) || (APP_MODE || EMBEDDED ? 0 : 5173);
const HOST = process.env.HOST || '127.0.0.1';

const MAX_REDIRECTS = 10;
const MAX_BODY_BYTES = 64 * 1024 * 1024; // refuse to buffer responses larger than this
const DEFAULT_TIMEOUT = 60_000;

/* ------------------------------------------------------------------ *
 * HTTP client
 * ------------------------------------------------------------------ */

/** Headers that describe a single hop and must not be forwarded verbatim. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

function decodeBody(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  if (!enc || enc === 'identity' || buffer.length === 0) return buffer;
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buffer);
    if (enc === 'deflate') {
      try { return zlib.inflateSync(buffer); } catch { return zlib.inflateRawSync(buffer); }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(buffer);
    if (enc === 'zstd' && typeof zlib.zstdDecompressSync === 'function') {
      return zlib.zstdDecompressSync(buffer);
    }
  } catch {
    // Server lied about the encoding, or the body is truncated. Show the bytes.
  }
  return buffer;
}

/** Perform exactly one request — no redirect handling. */
function sendOnce({ url, method, headers, body, timeoutMs, verifySsl }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const t0 = performance.now();
    const timings = { start: t0, dns: null, connect: null, tls: null, firstByte: null, done: null };

    const req = lib.request(
      url,
      {
        method,
        headers,
        rejectUnauthorized: verifySsl !== false,
        // Node normally strips the port for the default; keep servername sane for SNI.
        servername: url.protocol === 'https:' && !/^[\d.]+$/.test(url.hostname) ? url.hostname : undefined,
      },
      (res) => {
        timings.firstByte = performance.now();
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy(new Error(`Response exceeded ${MAX_BODY_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          timings.done = performance.now();
          const raw = Buffer.concat(chunks);
          const decoded = decodeBody(raw, res.headers['content-encoding']);
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage || '',
            httpVersion: res.httpVersion,
            headers: pairsFromRaw(res.rawHeaders),
            body: decoded,
            transferredBytes: raw.length,
            timings,
          });
        });
        res.on('error', reject);
      }
    );

    req.on('socket', (socket) => {
      socket.once('lookup', () => { timings.dns = performance.now(); });
      socket.once('connect', () => { timings.connect = performance.now(); });
      socket.once('secureConnect', () => { timings.tls = performance.now(); });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs} ms`));
    });

    req.on('error', reject);

    if (body && body.length) req.write(body);
    req.end();
  });
}

function pairsFromRaw(rawHeaders) {
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) out.push([rawHeaders[i], rawHeaders[i + 1]]);
  return out;
}

/** Rebuild the outgoing headers for a redirect hop. */
function headersForRedirect(headers, fromUrl, toUrl) {
  const sameOrigin = fromUrl.protocol === toUrl.protocol && fromUrl.host === toUrl.host;
  if (sameOrigin) return { ...headers };
  // Never leak credentials to a different origin.
  const next = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (lower === 'authorization' || lower === 'cookie' || lower === 'proxy-authorization') continue;
    next[k] = v;
  }
  return next;
}

async function performRequest(spec) {
  const {
    method = 'GET',
    headers: headerPairs = [],
    body = null,
    timeoutMs = DEFAULT_TIMEOUT,
    followRedirects = true,
    verifySsl = true,
  } = spec;

  let url;
  try {
    url = new URL(spec.url);
  } catch {
    throw new HttpError(400, `Invalid URL: ${spec.url || '(empty)'}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, `Unsupported protocol "${url.protocol}" — only http and https are supported.`);
  }

  let outHeaders = {};
  for (const [k, v] of headerPairs) {
    if (!k) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    // Preserve duplicates (e.g. multiple Cookie or Accept entries).
    outHeaders[k] = k in outHeaders ? [].concat(outHeaders[k], v) : v;
  }
  if (!Object.keys(outHeaders).some((k) => k.toLowerCase() === 'accept-encoding')) {
    outHeaders['Accept-Encoding'] = 'gzip, deflate, br';
  }
  if (!Object.keys(outHeaders).some((k) => k.toLowerCase() === 'user-agent')) {
    outHeaders['User-Agent'] = 'sonde/1.0';
  }

  let payload = body ? Buffer.from(body.data, 'base64') : null;
  if (payload && payload.length && !Object.keys(outHeaders).some((k) => k.toLowerCase() === 'content-type') && body.contentType) {
    outHeaders['Content-Type'] = body.contentType;
  }

  let currentMethod = method.toUpperCase();
  const chain = [];
  const started = performance.now();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await sendOnce({
      url,
      method: currentMethod,
      headers: outHeaders,
      body: payload,
      timeoutMs,
      verifySsl,
    });

    const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
    const location = res.headers.find(([k]) => k.toLowerCase() === 'location')?.[1];

    if (followRedirects && isRedirect && location && hop < MAX_REDIRECTS) {
      chain.push({ status: res.status, url: url.toString(), location });
      let next;
      try {
        next = new URL(location, url);
      } catch {
        // Unparseable Location — surface the redirect response as-is.
        return finalize(res, url, chain, started, currentMethod);
      }
      outHeaders = headersForRedirect(outHeaders, url, next);
      // Browsers downgrade to GET on 301/302 (for POST) and always on 303.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === 'POST')) {
        currentMethod = 'GET';
        payload = null;
        for (const k of Object.keys(outHeaders)) {
          if (['content-type', 'content-length'].includes(k.toLowerCase())) delete outHeaders[k];
        }
      }
      url = next;
      continue;
    }

    return finalize(res, url, chain, started, currentMethod);
  }

  throw new HttpError(508, `Too many redirects (>${MAX_REDIRECTS})`);
}

function finalize(res, url, chain, started, method) {
  const t = res.timings;
  const phase = (a, b) => (a != null && b != null ? Math.max(0, b - a) : null);
  return {
    ok: true,
    status: res.status,
    statusText: res.statusText,
    httpVersion: res.httpVersion,
    url: url.toString(),
    method,
    headers: res.headers,
    bodyBase64: res.body.toString('base64'),
    size: {
      body: res.body.length,
      transferred: res.transferredBytes,
      headers: res.headers.reduce((n, [k, v]) => n + k.length + v.length + 4, 0),
    },
    timeMs: Math.round(performance.now() - started),
    timings: {
      dns: phase(t.start, t.dns),
      connect: phase(t.dns ?? t.start, t.connect),
      tls: phase(t.connect, t.tls),
      wait: phase(t.tls ?? t.connect ?? t.start, t.firstByte),
      download: phase(t.firstByte, t.done),
    },
    redirects: chain,
  };
}

/* ------------------------------------------------------------------ *
 * Workspace persistence
 * ------------------------------------------------------------------ */

const EMPTY_WORKSPACE = {
  version: 1,
  collections: [],
  environments: [],
  globals: [],
  activeEnvId: null,
  history: [],
};

async function readWorkspace() {
  try {
    const text = await fs.readFile(WORKSPACE_FILE, 'utf8');
    return { ...EMPTY_WORKSPACE, ...JSON.parse(text) };
  } catch (err) {
    if (err.code === 'ENOENT') return EMPTY_WORKSPACE;
    throw new HttpError(500, `Workspace file is unreadable: ${err.message}`);
  }
}

let writeQueue = Promise.resolve();
function writeWorkspace(data) {
  // Serialise writes and swap atomically so a crash mid-save can't truncate.
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${WORKSPACE_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, WORKSPACE_FILE);
  });
  return writeQueue;
}

/* ------------------------------------------------------------------ *
 * Server plumbing
 * ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req, limit = 128 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(new HttpError(400, `Malformed JSON body: ${err.message}`));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  // Reject anything that escapes the public directory.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(target).pipe(res);
  } catch {
    sendJson(res, 404, { error: `Not found: ${pathname}` });
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (pathname === '/api/send' && req.method === 'POST') {
      const spec = await readJsonBody(req);
      try {
        return sendJson(res, 200, await performRequest(spec));
      } catch (err) {
        // A failed upstream request is a normal outcome, not a server fault:
        // report it as data so the UI can render it in the response pane.
        return sendJson(res, 200, {
          ok: false,
          error: err.message,
          code: err.code || null,
        });
      }
    }

    if (pathname === '/api/workspace') {
      if (req.method === 'GET') return sendJson(res, 200, await readWorkspace());
      if (req.method === 'PUT') {
        const data = await readJsonBody(req);
        await writeWorkspace(data);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: `No such endpoint: ${req.method} ${pathname}` });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }
    await serveStatic(req, res, pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (!res.headersSent) sendJson(res, status, { error: err.message });
    else res.end();
  }
});

/* ------------------------------------------------------------------ *
 * Launching a window
 * ------------------------------------------------------------------ */

/**
 * Chromium's `--app=` gives a window with no tabs or address bar, which is what
 * makes this feel like an application rather than a web page. Fall back to the
 * default browser when no Chromium-family browser is installed.
 */
function openAppWindow(url) {
  const detached = { detached: true, stdio: 'ignore' };

  if (process.platform === 'darwin') {
    const candidates = ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Chromium', 'Vivaldi'];
    const roots = ['/Applications', path.join(os.homedir(), 'Applications')];
    for (const name of candidates) {
      const found = roots.some((root) => existsSync(path.join(root, `${name}.app`)));
      if (!found) continue;
      spawn('open', ['-na', name, '--args', `--app=${url}`], detached).unref();
      return name;
    }
    spawn('open', [url], detached).unref();
    return 'your default browser';
  }

  if (process.platform === 'win32') {
    // `start` is a shell builtin, hence the cmd wrapper.
    spawn('cmd', ['/c', 'start', '""', 'chrome', `--app=${url}`], detached).unref();
    return 'Chrome';
  }

  for (const bin of ['google-chrome', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge']) {
    try {
      spawn(bin, [`--app=${url}`], detached).unref();
      return bin;
    } catch { /* not installed — try the next one */ }
  }
  spawn('xdg-open', [url], detached).unref();
  return 'your default browser';
}

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  const url = `http://${HOST}:${port}`;

  if (EMBEDDED) {
    // Machine-readable handshake for the native host, which blocks on this.
    console.log(`SONDE_LISTENING ${url}`);

    /*
     * Tie our lifetime to the host's. macOS has no parent-death signal, so if
     * the host is force-quit or crashes we'd linger and hold the port forever.
     * The host keeps our stdin open; EOF means it is gone, so we go too.
     */
    process.stdin.on('end', () => process.exit(0));
    process.stdin.on('close', () => process.exit(0));
    process.stdin.on('error', () => process.exit(0));
    process.stdin.resume();
    return;
  }

  console.log(`\n  Sonde  →  ${url}\n`);
  console.log(`  workspace: ${WORKSPACE_FILE}`);

  if (APP_MODE) {
    const via = openAppWindow(url);
    console.log(`  opened in ${via}`);
    console.log('  quit the app to stop the server\n');
  } else {
    console.log('  press ctrl-c to stop\n');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // A fixed port was asked for and taken. In app mode any free port will do.
    if (APP_MODE) {
      server.listen(0, HOST);
      return;
    }
    console.error(`\n  Port ${PORT} is already in use. Try:  PORT=5174 npm start\n`);
    process.exit(1);
  }
  throw err;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    // Don't let a lingering keep-alive connection block the exit.
    setTimeout(() => process.exit(0), 500).unref();
  });
}
