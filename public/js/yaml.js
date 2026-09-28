/**
 * A small YAML parser — enough for OpenAPI documents, not a spec-complete one.
 *
 * Supported: block maps and sequences, flow collections ({} and []), quoted and
 * plain scalars, block scalars (| > with - + chomping), comments, multiple
 * documents (the first is returned), anchors/aliases and the `<<` merge key.
 *
 * Not supported: tags (!!type), complex keys (? :), and directives beyond ---.
 * Those don't appear in practice in OpenAPI specs; if one shows up the parser
 * reports the line rather than silently producing something wrong.
 */

class YamlError extends Error {
  constructor(message, line) {
    super(line ? `${message} (line ${line})` : message);
    this.name = 'YamlError';
    this.line = line;
  }
}

/* ------------------------------ scanning ------------------------------ */

/** Strip a trailing `# comment`, ignoring `#` inside quotes. */
function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }
  return text;
}

/**
 * Index of the `:` that separates a map key from its value: the first colon
 * that is followed by whitespace or ends the line, and sits outside quotes and
 * flow brackets. That rule is what keeps `url: https://x` from splitting at the
 * scheme's colon.
 */
function keySeparator(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    else if (ch === ':' && depth === 0 && (i + 1 === text.length || /\s/.test(text[i + 1]))) {
      return i;
    }
  }
  return -1;
}

/**
 * If `text` opens a quoted scalar that it never closes, return the quote
 * character — the value continues on the following lines.
 */
function unterminatedQuote(text) {
  const trimmed = text.trim();
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'") return null;
  let i = 1;
  while (i < trimmed.length) {
    if (quote === '"' && trimmed[i] === '\\') { i += 2; continue; }
    if (trimmed[i] === quote) {
      if (quote === "'" && trimmed[i + 1] === "'") { i += 2; continue; }
      return null;
    }
    i++;
  }
  return quote;
}

/* ------------------------------ scalars ------------------------------ */

function unescapeDouble(text) {
  return text.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (match, esc) => {
    if (esc[0] === 'u' || esc[0] === 'x') return String.fromCharCode(parseInt(esc.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', 0: '\0', '\\': '\\', '"': '"', "'": "'", '/': '/' }[esc] ?? esc;
  });
}

function parseScalar(raw) {
  const text = raw.trim();
  if (text === '') return null;

  if (text[0] === '"' && text.at(-1) === '"' && text.length > 1) return unescapeDouble(text.slice(1, -1));
  if (text[0] === "'" && text.at(-1) === "'" && text.length > 1) return text.slice(1, -1).replace(/''/g, "'");

  if (text === '~' || text === 'null' || text === 'Null' || text === 'NULL') return null;
  if (/^(true|True|TRUE|yes|Yes|YES|on|On|ON)$/.test(text)) return true;
  if (/^(false|False|FALSE|no|No|NO|off|Off|OFF)$/.test(text)) return false;
  if (/^[-+]?\d+$/.test(text)) return Number(text);
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(text)) return Number(text);
  if (/^0x[0-9a-fA-F]+$/.test(text)) return parseInt(text, 16);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(text)) return text[0] === '-' ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(text)) return NaN;

  return text;
}

/* --------------------------- flow collections --------------------------- */

/** Recursive-descent reader for `{...}` / `[...]`, returning [value, index]. */
function readFlow(text, i) {
  const skipWs = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  skipWs();

  if (text[i] === '[') {
    i++;
    const arr = [];
    skipWs();
    if (text[i] === ']') return [arr, i + 1];
    while (i < text.length) {
      let value;
      [value, i] = readFlow(text, i);
      arr.push(value);
      skipWs();
      if (text[i] === ',') { i++; skipWs(); continue; }
      if (text[i] === ']') return [arr, i + 1];
      throw new YamlError(`Expected , or ] in flow sequence near "${text.slice(i, i + 12)}"`);
    }
    throw new YamlError('Unterminated flow sequence');
  }

  if (text[i] === '{') {
    i++;
    const obj = {};
    skipWs();
    if (text[i] === '}') return [obj, i + 1];
    while (i < text.length) {
      let key;
      [key, i] = readFlowScalar(text, i, ':,}');
      skipWs();
      if (text[i] !== ':') throw new YamlError(`Expected : in flow mapping near "${text.slice(i, i + 12)}"`);
      i++;
      let value;
      [value, i] = readFlow(text, i);
      obj[String(key)] = value;
      skipWs();
      if (text[i] === ',') { i++; skipWs(); continue; }
      if (text[i] === '}') return [obj, i + 1];
      throw new YamlError(`Expected , or } in flow mapping near "${text.slice(i, i + 12)}"`);
    }
    throw new YamlError('Unterminated flow mapping');
  }

  return readFlowScalar(text, i, ',]}');
}

function readFlowScalar(text, i, stops) {
  const skipWs = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  skipWs();

  if (text[i] === '"' || text[i] === "'") {
    const quote = text[i];
    let out = quote;
    i++;
    while (i < text.length) {
      if (quote === '"' && text[i] === '\\') { out += text[i] + text[i + 1]; i += 2; continue; }
      if (text[i] === quote) { out += quote; i++; break; }
      out += text[i++];
    }
    return [parseScalar(out), i];
  }

  const start = i;
  while (i < text.length && !stops.includes(text[i])) i++;
  return [parseScalar(text.slice(start, i)), i];
}

/* ------------------------------ block parser ------------------------------ */

const isSeqItem = (content) => content === '-' || content.startsWith('- ');

/**
 * Block-structure parser over a list of scanned lines.
 *
 * Blank lines are kept in the list because block scalars need them, so every
 * structural step skips them explicitly via `next()`.
 */
class BlockParser {
  constructor(lines, anchors = new Map()) {
    this.lines = lines;
    this.anchors = anchors;
  }

  /** Index of the next non-blank line at or after `i` (or lines.length). */
  next(i) {
    while (i < this.lines.length && this.lines[i].blank) i++;
    return i;
  }

  parseNode(i, indent) {
    i = this.next(i);
    if (i >= this.lines.length) return [null, i];
    return isSeqItem(this.lines[i].content) ? this.parseSeq(i, indent) : this.parseMap(i, indent);
  }

  /**
   * Continue a quoted scalar that spans lines. YAML folds the break into a
   * space, unless the line ends with a backslash, which suppresses it:
   *   description: "... Use\
   *     \ tag1, tag2 for testing."
   */
  joinQuoted(i, rest, quote) {
    let text = rest.trim();
    let j = i + 1;
    const limit = Math.min(this.lines.length, i + 200);
    while (j < limit) {
      const piece = this.lines[j].blank ? '' : this.lines[j].content;
      if (quote === '"' && text.endsWith('\\')) text = text.slice(0, -1) + piece;
      else text += ` ${piece}`;
      j++;
      if (!unterminatedQuote(text)) return [parseScalar(text), j];
    }
    throw new YamlError('Unterminated quoted string', this.lines[i]?.line);
  }

  /**
   * Continue an unquoted scalar that wraps onto following, more-indented lines:
   *   description: For valid response try integer IDs with value < 1000. Anything
   *     above 1000 will generate API errors.
   * A deeper line that is itself a `key:` or a `-` item ends the scalar.
   */
  joinPlain(i, rest, indent) {
    let text = rest;
    let j = i + 1;
    while (j < this.lines.length) {
      let k = j;
      while (k < this.lines.length && this.lines[k].blank) k++;
      if (k >= this.lines.length) break;
      const line = this.lines[k];
      if (line.indent <= indent || isSeqItem(line.content) || keySeparator(line.content) !== -1) break;
      text += ` ${line.content}`;
      j = k + 1;
    }
    return [parseScalar(text), j];
  }

  /** The nested block under line `i`, if the following lines provide one. */
  childBlock(i, indent) {
    const j = this.next(i + 1);
    if (j >= this.lines.length) return [null, i + 1];

    if (this.lines[j].indent > indent) return this.parseNode(j, this.lines[j].indent);

    // A block sequence is allowed to sit at the same column as its key, which
    // is how most hand-written OpenAPI documents are formatted:
    //   servers:
    //   - url: /api/v3
    // A same-indent *mapping* line, by contrast, is a sibling — not a child.
    if (this.lines[j].indent === indent && isSeqItem(this.lines[j].content)) {
      return this.parseSeq(j, indent);
    }
    return [null, i + 1];
  }

  parseSeq(startIndex, indent) {
    const arr = [];
    let i = this.next(startIndex);

    while (i < this.lines.length && this.lines[i].indent === indent && isSeqItem(this.lines[i].content)) {
      const line = this.lines[i];
      const rest = line.content === '-' ? '' : line.content.slice(2).trim();

      if (rest === '') {
        const [value, after] = this.childBlock(i, indent);
        arr.push(value);
        i = this.next(after);
        continue;
      }

      if (keySeparator(rest) !== -1) {
        // `- key: value` — an inline map whose remaining keys follow, indented.
        // Re-present the inline part as a line two columns deeper so the map
        // parser sees an ordinary block, and hand it to a sub-parser.
        const inner = [{ indent: indent + 2, content: rest, blank: false, line: line.line }];
        let j = i + 1;
        while (j < this.lines.length && (this.lines[j].blank || this.lines[j].indent > indent)) {
          inner.push(this.lines[j]);
          j++;
        }
        const [value] = new BlockParser(inner, this.anchors).parseMap(0, indent + 2);
        arr.push(value);
        i = this.next(j);
        continue;
      }

      const [value, after] = this.inlineValue(rest, i, indent);
      arr.push(value);
      i = this.next(after);
    }
    return [arr, i];
  }

  parseMap(startIndex, indent) {
    const obj = {};
    let i = this.next(startIndex);

    while (i < this.lines.length && this.lines[i].indent === indent && !isSeqItem(this.lines[i].content)) {
      const { content, line } = this.lines[i];
      const sep = keySeparator(content);
      if (sep === -1) throw new YamlError(`Expected "key: value" but found "${content}"`, line);

      const key = String(parseScalar(content.slice(0, sep)));
      const rest = content.slice(sep + 1).trim();

      if (rest === '') {
        const [value, after] = this.childBlock(i, indent);
        this.assign(obj, key, value);
        i = this.next(after);
        continue;
      }

      // Block scalar: the value is the indented lines that follow.
      const block = /^([|>])([-+]?)\d*$/.exec(rest);
      if (block) {
        const [text, after] = this.readBlockScalar(i + 1, indent, block[1], block[2]);
        this.assign(obj, key, text);
        i = this.next(after);
        continue;
      }

      const [value, after] = this.inlineValue(rest, i, indent);
      this.assign(obj, key, value);
      i = this.next(after);
    }
    return [obj, i];
  }

  /** `<<: *base` merges the aliased map in; explicit keys win. */
  assign(obj, key, value) {
    if (key === '<<') {
      for (const source of Array.isArray(value) ? value : [value]) {
        if (source && typeof source === 'object') {
          for (const [k, v] of Object.entries(source)) if (!(k in obj)) obj[k] = v;
        }
      }
      return;
    }
    obj[key] = value;
  }

  /**
   * Handle `&anchor` definitions and `*alias` references around a value.
   * Returns [value, nextIndex] — `key: &anchor` with an indented body consumes
   * a whole child block, not just this line.
   */
  inlineValue(raw, i, indent) {
    const anchorMatch = /^&([^\s]+)\s*/.exec(raw);
    const name = anchorMatch ? anchorMatch[1] : null;
    const rest = anchorMatch ? raw.slice(anchorMatch[0].length) : raw;

    let value;
    let after = i + 1;
    const alias = /^\*([^\s]+)$/.exec(rest.trim());
    if (alias) {
      if (!this.anchors.has(alias[1])) throw new YamlError(`Unknown alias *${alias[1]}`, this.lines[i]?.line);
      value = this.anchors.get(alias[1]);
    } else {
      const trimmed = rest.trim();
      const openQuote = unterminatedQuote(trimmed);
      if (trimmed === '') {
        // e.g. `key: &anchor` with the body on the following lines.
        [value, after] = this.childBlock(i, indent);
      } else if (openQuote) {
        [value, after] = this.joinQuoted(i, trimmed, openQuote);
      } else if (trimmed[0] === '[' || trimmed[0] === '{') {
        value = readFlow(trimmed, 0)[0];
      } else {
        [value, after] = this.joinPlain(i, trimmed, indent);
      }
    }

    if (name) this.anchors.set(name, value);
    return [value, after];
  }

  readBlockScalar(startIndex, parentIndent, style, chomp) {
    const collected = [];
    let blockIndent = null;
    let i = startIndex;

    while (i < this.lines.length && (this.lines[i].blank || this.lines[i].indent > parentIndent)) {
      if (this.lines[i].blank) {
        collected.push('');
        i++;
        continue;
      }
      if (blockIndent === null) blockIndent = this.lines[i].indent;
      collected.push(' '.repeat(Math.max(0, this.lines[i].indent - blockIndent)) + this.lines[i].content);
      i++;
    }
    while (collected.length && collected.at(-1) === '') collected.pop();

    let text;
    if (style === '|') {
      text = collected.join('\n');
    } else {
      // Folded: a blank line becomes a newline, otherwise lines join with a space.
      text = collected.reduce((acc, cur, idx) => {
        if (idx === 0) return cur;
        if (cur === '' || collected[idx - 1] === '') return `${acc}\n${cur}`;
        return `${acc} ${cur}`;
      }, '');
    }
    if (chomp !== '-' && collected.length) text += '\n';
    return [text, i];
  }
}

/* -------------------------------- entry -------------------------------- */

export function parseYaml(source) {
  if (typeof source !== 'string') throw new YamlError('Expected a string');

  const scanned = source.replace(/\r\n?/g, '\n').split('\n').map((raw, idx) => {
    const withoutComment = stripComment(raw);
    const content = withoutComment.trim();
    return {
      indent: withoutComment.length - withoutComment.trimStart().length,
      content,
      blank: content === '',
      line: idx + 1,
    };
  });

  // Multiple documents: keep the first that has content.
  const docs = [[]];
  for (const line of scanned) {
    if (line.indent === 0 && (line.content === '---' || line.content === '...')) docs.push([]);
    else docs.at(-1).push(line);
  }
  const doc = docs.find((d) => d.some((l) => !l.blank));
  if (!doc) return null;

  const parser = new BlockParser(doc);
  const first = parser.next(0);
  return parser.parseNode(first, doc[first].indent)[0];
}

export { YamlError };
