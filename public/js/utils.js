/** Small DOM + formatting helpers shared across the UI. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let seq = 0;
export function uid(prefix = 'id') {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Build an element. `attrs` understands `class`, `dataset`, `style`,
 * on* event handlers, and everything else as a property or attribute.
 *
 * `value` is applied last, after the children are in place: assigning to a
 * <select>'s value while it still has no <option>s silently does nothing, so
 * setting it first would quietly leave the element showing its first option.
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  let deferredValue;

  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'value') deferredValue = value;
    else if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }

  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  if (deferredValue !== undefined) node.value = deferredValue;
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatMs(ms) {
  if (ms == null) return '—';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatRelative(ts) {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function debounce(fn, wait = 300) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.flush = (...args) => { clearTimeout(timer); fn(...args); };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function statusClass(code) {
  if (!code) return 'status-err';
  if (code < 300) return 'status-2xx';
  if (code < 400) return 'status-3xx';
  if (code < 500) return 'status-4xx';
  return 'status-5xx';
}

export function methodClass(method) {
  const m = String(method || 'get').toLowerCase();
  return ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(m)
    ? `m-${m}`
    : 'm-other';
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000; // avoid blowing the argument limit on large buffers
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function utf8ToBase64(str) {
  return bytesToBase64(new TextEncoder().encode(str));
}

export function download(filename, content, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; fall back to a hidden textarea.
    const ta = el('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function prettyJson(text) {
  return JSON.stringify(JSON.parse(text), null, 2);
}

/** Cheap, forgiving XML/HTML indenter — good enough for a response viewer. */
export function prettyXml(text) {
  const withBreaks = text.replace(/>\s*</g, '>\n<');
  let depth = 0;
  return withBreaks
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (/^<\/.+>/.test(trimmed)) depth = Math.max(0, depth - 1);
      const out = '  '.repeat(depth) + trimmed;
      if (/^<[^!?/][^>]*[^/]>$/.test(trimmed) && !/^<.+<\/.+>$/.test(trimmed)) depth += 1;
      return out;
    })
    .join('\n');
}
