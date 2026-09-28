/** {{variable}} substitution, plus a few dynamic $-variables. */
import { escapeHtml } from './utils.js';

const VAR_RE = /\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g;

/** Postman-style generated values, resolved fresh on each use. */
const DYNAMIC = {
  $guid: () => (crypto.randomUUID ? crypto.randomUUID() : fallbackUuid()),
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1000)),
  $randomUUID: () => (crypto.randomUUID ? crypto.randomUUID() : fallbackUuid()),
};

function fallbackUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Replace every {{name}} in `text`.
 * Resolves nested references (a variable whose value contains {{other}}),
 * with a depth cap so a self-referential variable can't spin forever.
 */
export function resolve(text, vars = {}, depth = 0) {
  if (typeof text !== 'string' || !text.includes('{{')) return text ?? '';
  if (depth > 10) return text;
  const out = text.replace(VAR_RE, (match, name) => {
    if (name in DYNAMIC) return DYNAMIC[name]();
    if (name in vars) return vars[name] ?? '';
    return match; // unknown — leave the placeholder visible rather than blanking it
  });
  return out === text ? out : resolve(out, vars, depth + 1);
}

/** Names referenced by `text` that no scope defines. */
export function missingVars(text, vars = {}) {
  const missing = new Set();
  for (const [, name] of String(text ?? '').matchAll(VAR_RE)) {
    if (!(name in DYNAMIC) && !(name in vars)) missing.add(name);
  }
  return [...missing];
}

/** HTML preview of a string with each placeholder colour-coded. */
export function highlightVars(text, vars = {}) {
  return escapeHtml(String(text ?? '')).replace(
    /\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g,
    (match, name) => {
      const known = name in DYNAMIC || name in vars;
      const title = known ? escapeHtml(String(DYNAMIC[name] ? '(generated)' : vars[name])) : 'not defined';
      return `<span class="${known ? 'var-ok' : 'var-missing'}" title="${title}">${match}</span>`;
    }
  );
}

export const DYNAMIC_NAMES = Object.keys(DYNAMIC);

export function isDynamic(name) {
  return name in DYNAMIC;
}

/** Every {{name}} referenced by `text`, in order, without duplicates. */
export function usedVars(text) {
  const seen = new Set();
  for (const [, name] of String(text ?? '').matchAll(VAR_RE)) seen.add(name);
  return [...seen];
}
