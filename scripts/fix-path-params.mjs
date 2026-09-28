#!/usr/bin/env node
/**
 * Repair collections imported before path variables existed.
 *
 * Early OpenAPI imports turned `/orders/{id}` into `/orders/{{id}}`, which made
 * every endpoint with an `{id}` share one collection variable — setting it for
 * one request silently changed all the others. This rewrites those into
 * per-request `:id` path variables and drops the collection variables that
 * existed only to serve them.
 *
 *   node scripts/fix-path-params.mjs <workspace.json> [--dry-run]
 *
 * Writes a .bak beside the file before changing anything.
 */
import fs from 'node:fs';
import path from 'node:path';

const [, , target, ...flags] = process.argv;
const dryRun = flags.includes('--dry-run');

if (!target) {
  console.error('usage: node scripts/fix-path-params.mjs <workspace.json> [--dry-run]');
  process.exit(1);
}

const workspace = JSON.parse(fs.readFileSync(target, 'utf8'));

// A whole path segment written as {{name}} — `/{{id}}`. Anchoring on the
// leading slash is what keeps `{{baseUrl}}` (which starts the URL) safe.
const SEGMENT = /\/\{\{\s*([A-Za-z_][\w-]*)\s*\}\}/g;

let uid = 0;
const nextId = () => `kv-fix-${Date.now().toString(36)}-${uid++}`;

const converted = [];

function fixRequest(request, collection, requestName) {
  if (!request?.url) return;
  const queryAt = request.url.indexOf('?');
  const pathPart = queryAt === -1 ? request.url : request.url.slice(0, queryAt);
  const rest = queryAt === -1 ? '' : request.url.slice(queryAt);

  const names = [...pathPart.matchAll(SEGMENT)].map((m) => m[1]);
  if (!names.length) return;

  const newPath = pathPart.replace(SEGMENT, (_, name) => `/:${name}`);
  const existing = request.pathParams ?? [];

  request.pathParams = [...new Set(names)].map((name) => {
    const already = existing.find((p) => p.key === name);
    // Seed from the collection variable it used to read, so the request keeps
    // whatever value it was actually resolving to.
    const seeded = (collection.variables ?? []).find((v) => v.key === name);
    return already ?? {
      id: nextId(),
      key: name,
      value: seeded?.value ?? '',
      description: 'Path parameter',
      enabled: true,
    };
  });

  converted.push({ request: requestName, from: request.url, to: newPath + rest });
  request.url = newPath + rest;
}

function walk(items, collection) {
  for (const item of items ?? []) {
    if (item.type === 'folder') walk(item.items, collection);
    else fixRequest(item.request, collection, item.name);
  }
}

for (const collection of workspace.collections ?? []) {
  walk(collection.items, collection);

  // Drop collection variables nothing references any more. baseUrl always stays.
  const stillUsed = new Set(['baseUrl']);
  const scan = (items) => {
    for (const item of items ?? []) {
      if (item.type === 'folder') { scan(item.items); continue; }
      const text = JSON.stringify(item.request ?? {});
      for (const [, name] of text.matchAll(/\{\{\s*([A-Za-z_$][\w-]*)\s*\}\}/g)) stillUsed.add(name);
    }
  };
  scan(collection.items);

  const before = collection.variables?.length ?? 0;
  collection.variables = (collection.variables ?? []).filter((v) => stillUsed.has(v.key));
  const removed = before - collection.variables.length;
  if (removed) console.log(`  ${collection.name}: removed ${removed} unused collection variable(s)`);
}

// Open tabs hold their own copies of the request.
for (const tab of workspace.tabs ?? []) {
  fixRequest(tab.request, { variables: [] }, tab.name);
}

console.log(`\n${converted.length} request(s) converted to :path variables`);
for (const entry of converted.slice(0, 10)) console.log(`  ${entry.to}`);
if (converted.length > 10) console.log(`  … and ${converted.length - 10} more`);

if (dryRun) {
  console.log('\n--dry-run: nothing written');
} else if (converted.length) {
  const backup = `${target}.bak`;
  fs.copyFileSync(target, backup);
  fs.writeFileSync(target, JSON.stringify(workspace, null, 2));
  console.log(`\nwritten. backup at ${path.basename(backup)}`);
} else {
  console.log('\nnothing to change');
}
