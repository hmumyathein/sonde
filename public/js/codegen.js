/** Turn a built request spec into a runnable snippet. */
import { base64ToBytes } from './utils.js';

function bodyText(spec) {
  if (!spec.body?.data) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(base64ToBytes(spec.body.data));
  } catch {
    return null; // binary payload — snippets get a placeholder instead
  }
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function curl(spec) {
  const lines = [`curl --location --request ${spec.method} ${shellQuote(spec.url)}`];
  for (const [k, v] of spec.headers) lines.push(`  --header ${shellQuote(`${k}: ${v}`)}`);
  const body = bodyText(spec);
  if (body != null) lines.push(`  --data-raw ${shellQuote(body)}`);
  else if (spec.body) lines.push(`  --data-binary @/path/to/file`);
  if (!spec.followRedirects) lines[0] = lines[0].replace('--location ', '');
  if (!spec.verifySsl) lines.push('  --insecure');
  return lines.join(' \\\n');
}

function jsFetch(spec) {
  const headers = Object.fromEntries(spec.headers);
  const body = bodyText(spec);
  const opts = [`  method: ${JSON.stringify(spec.method)}`];
  if (Object.keys(headers).length) opts.push(`  headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ')}`);
  if (body != null) opts.push(`  body: ${JSON.stringify(body)}`);
  return [
    `const res = await fetch(${JSON.stringify(spec.url)}, {`,
    opts.join(',\n'),
    `});`,
    ``,
    `console.log(res.status, await res.text());`,
  ].join('\n');
}

function python(spec) {
  const headers = Object.fromEntries(spec.headers);
  const body = bodyText(spec);
  const lines = ['import requests', ''];
  lines.push(`url = ${JSON.stringify(spec.url)}`);
  if (Object.keys(headers).length) {
    lines.push('headers = {');
    for (const [k, v] of Object.entries(headers)) lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
    lines.push('}');
  }
  if (body != null) lines.push(`payload = ${JSON.stringify(body)}`);
  lines.push('');
  const args = ['url'];
  if (Object.keys(headers).length) args.push('headers=headers');
  if (body != null) args.push('data=payload');
  if (!spec.verifySsl) args.push('verify=False');
  lines.push(`response = requests.request(${JSON.stringify(spec.method)}, ${args.join(', ')})`);
  lines.push('print(response.status_code, response.text)');
  return lines.join('\n');
}

function httpie(spec) {
  const parts = ['http', spec.method];
  if (!spec.verifySsl) parts.push('--verify=no');
  parts.push(shellQuote(spec.url));
  for (const [k, v] of spec.headers) parts.push(shellQuote(`${k}:${v}`));
  const body = bodyText(spec);
  const cmd = parts.join(' ');
  return body != null ? `echo ${shellQuote(body)} | ${cmd}` : cmd;
}

function goSnippet(spec) {
  const body = bodyText(spec);
  const lines = [
    'package main',
    '',
    'import (',
    '\t"fmt"',
    '\t"io"',
    body != null ? '\t"strings"' : null,
    '\t"net/http"',
    ')',
    '',
    'func main() {',
    body != null
      ? `\tbody := strings.NewReader(${JSON.stringify(body)})`
      : null,
    `\treq, err := http.NewRequest(${JSON.stringify(spec.method)}, ${JSON.stringify(spec.url)}, ${body != null ? 'body' : 'nil'})`,
    '\tif err != nil {\n\t\tpanic(err)\n\t}',
  ].filter(Boolean);
  for (const [k, v] of spec.headers) lines.push(`\treq.Header.Set(${JSON.stringify(k)}, ${JSON.stringify(v)})`);
  lines.push(
    '',
    '\tres, err := http.DefaultClient.Do(req)',
    '\tif err != nil {\n\t\tpanic(err)\n\t}',
    '\tdefer res.Body.Close()',
    '',
    '\tout, _ := io.ReadAll(res.Body)',
    '\tfmt.Println(res.Status, string(out))',
    '}'
  );
  return lines.join('\n');
}

export const GENERATORS = [
  { id: 'curl', label: 'cURL', language: 'text', gen: curl },
  { id: 'fetch', label: 'JavaScript — fetch', language: 'javascript', gen: jsFetch },
  { id: 'python', label: 'Python — requests', language: 'text', gen: python },
  { id: 'go', label: 'Go — net/http', language: 'text', gen: goSnippet },
  { id: 'httpie', label: 'HTTPie', language: 'text', gen: httpie },
];

export function generate(id, spec) {
  return (GENERATORS.find((g) => g.id === id) ?? GENERATORS[0]).gen(spec);
}
