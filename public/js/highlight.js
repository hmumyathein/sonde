/**
 * Tiny syntax highlighters for the response viewer.
 * Regex-based on purpose — they run on every render and must stay cheap.
 */
import { escapeHtml } from './utils.js';

const MAX_HIGHLIGHT_BYTES = 512 * 1024; // beyond this, plain text is faster and just as readable

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g;

/**
 * Colour a JSON document.
 *
 * Tokenises the raw text and escapes each piece as it is emitted. Escaping the
 * whole string first would turn every `"` into `&quot;`, and then no string or
 * key would ever match — leaving only numbers and punctuation coloured.
 */
export function highlightJson(text) {
  if (text.length > MAX_HIGHLIGHT_BYTES) return escapeHtml(text);

  let out = '';
  let last = 0;

  for (const match of text.matchAll(JSON_TOKEN)) {
    const [token, str, colon, literal, num, punc] = match;
    out += escapeHtml(text.slice(last, match.index));

    if (str !== undefined) {
      out += colon
        ? `<span class="tok-key">${escapeHtml(str)}</span><span class="tok-punc">${escapeHtml(colon)}</span>`
        : `<span class="tok-str">${escapeHtml(str)}</span>`;
    } else if (literal !== undefined) {
      out += `<span class="${literal === 'null' ? 'tok-null' : 'tok-bool'}">${literal}</span>`;
    } else if (num !== undefined) {
      out += `<span class="tok-num">${num}</span>`;
    } else if (punc !== undefined) {
      out += `<span class="tok-punc">${punc}</span>`;
    }

    last = match.index + token.length;
  }

  return out + escapeHtml(text.slice(last));
}

export function highlightXml(text) {
  if (text.length > MAX_HIGHLIGHT_BYTES) return escapeHtml(text);
  return escapeHtml(text)
    .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-cmt">$1</span>')
    .replace(/(&lt;\/?)([\w:.-]+)/g, '<span class="tok-punc">$1</span><span class="tok-tag">$2</span>')
    .replace(/([\w:.-]+)=(&quot;.*?&quot;|'.*?')/g,
      '<span class="tok-attr">$1</span><span class="tok-punc">=</span><span class="tok-str">$2</span>')
    .replace(/(\/?&gt;)/g, '<span class="tok-punc">$1</span>');
}

export function highlight(text, language) {
  if (language === 'json') return highlightJson(text);
  if (language === 'xml' || language === 'html') return highlightXml(text);
  return escapeHtml(text);
}

/** Guess a language from a Content-Type plus a sniff of the payload. */
export function detectLanguage(contentType = '', body = '') {
  const ct = contentType.toLowerCase();
  if (ct.includes('json') || /^\s*[{[]/.test(body.slice(0, 200))) return 'json';
  if (ct.includes('html')) return 'html';
  if (ct.includes('xml') || /^\s*<\?xml/.test(body.slice(0, 40))) return 'xml';
  if (ct.includes('javascript')) return 'javascript';
  if (ct.includes('css')) return 'css';
  return 'text';
}
