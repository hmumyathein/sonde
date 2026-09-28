/**
 * Script runner for pre-request and test scripts.
 *
 * Scripts run via `new Function` in the page realm. That is not a security
 * boundary — it is the user's own code running in the user's own browser,
 * exactly like a devtools snippet. It exists to give scripts a Postman-shaped
 * `pm` API, not to contain them.
 */

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

function stringify(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Error) return value.message;
  try {
    const out = JSON.stringify(value);
    return out === undefined ? String(value) : out;
  } catch {
    return String(value);
  }
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

/** A small chai-flavoured assertion object covering the common Postman idioms. */
class Assertion {
  constructor(actual, negated = false) {
    this.__actual = actual;
    this.__negated = negated;
  }

  // Chainers — no-ops that read well.
  get to() { return this; }
  get be() { return this; }
  get been() { return this; }
  get is() { return this; }
  get that() { return this; }
  get and() { return this; }
  get has() { return this; }
  get have() { return this; }
  get with() { return this; }
  get which() { return this; }
  get deep() { return this; }
  get an() { return this; }
  get a() { return this; }

  get not() { return new Assertion(this.__actual, !this.__negated); }

  __assert(pass, message, negatedMessage) {
    if (this.__negated ? !pass : pass) return this;
    throw new AssertionError(this.__negated ? negatedMessage : message);
  }

  equal(expected) {
    return this.__assert(
      Object.is(this.__actual, expected) || this.__actual === expected,
      `expected ${stringify(this.__actual)} to equal ${stringify(expected)}`,
      `expected ${stringify(this.__actual)} not to equal ${stringify(expected)}`
    );
  }
  equals(expected) { return this.equal(expected); }
  eq(expected) { return this.equal(expected); }

  eql(expected) {
    return this.__assert(
      deepEqual(this.__actual, expected),
      `expected ${stringify(this.__actual)} to deeply equal ${stringify(expected)}`,
      `expected ${stringify(this.__actual)} not to deeply equal ${stringify(expected)}`
    );
  }
  deepEqual(expected) { return this.eql(expected); }

  include(needle) {
    const actual = this.__actual;
    let pass = false;
    if (typeof actual === 'string') pass = actual.includes(needle);
    else if (Array.isArray(actual)) pass = actual.some((v) => deepEqual(v, needle));
    else if (actual && typeof actual === 'object') {
      pass = Object.entries(needle ?? {}).every(([k, v]) => deepEqual(actual[k], v));
    }
    return this.__assert(
      pass,
      `expected ${stringify(actual)} to include ${stringify(needle)}`,
      `expected ${stringify(actual)} not to include ${stringify(needle)}`
    );
  }
  contain(needle) { return this.include(needle); }
  contains(needle) { return this.include(needle); }
  includes(needle) { return this.include(needle); }

  property(name, value) {
    const actual = this.__actual;
    const exists = actual != null && Object.prototype.hasOwnProperty.call(Object(actual), name);
    this.__assert(
      exists,
      `expected ${stringify(actual)} to have property "${name}"`,
      `expected ${stringify(actual)} not to have property "${name}"`
    );
    if (arguments.length > 1 && exists && !this.__negated) {
      new Assertion(actual[name]).eql(value);
    }
    return this;
  }

  type(expected) {
    const actual = this.__actual;
    const kind = Array.isArray(actual) ? 'array' : actual === null ? 'null' : typeof actual;
    return this.__assert(
      kind === expected,
      `expected ${stringify(actual)} to be a ${expected} but got ${kind}`,
      `expected ${stringify(actual)} not to be a ${expected}`
    );
  }

  above(n) {
    return this.__assert(this.__actual > n,
      `expected ${stringify(this.__actual)} to be above ${n}`,
      `expected ${stringify(this.__actual)} not to be above ${n}`);
  }
  greaterThan(n) { return this.above(n); }

  below(n) {
    return this.__assert(this.__actual < n,
      `expected ${stringify(this.__actual)} to be below ${n}`,
      `expected ${stringify(this.__actual)} not to be below ${n}`);
  }
  lessThan(n) { return this.below(n); }

  least(n) {
    return this.__assert(this.__actual >= n,
      `expected ${stringify(this.__actual)} to be at least ${n}`,
      `expected ${stringify(this.__actual)} to be below ${n}`);
  }
  most(n) {
    return this.__assert(this.__actual <= n,
      `expected ${stringify(this.__actual)} to be at most ${n}`,
      `expected ${stringify(this.__actual)} to be above ${n}`);
  }

  match(re) {
    return this.__assert(re.test(String(this.__actual)),
      `expected ${stringify(this.__actual)} to match ${re}`,
      `expected ${stringify(this.__actual)} not to match ${re}`);
  }

  lengthOf(n) {
    const len = this.__actual?.length;
    return this.__assert(len === n,
      `expected length ${len} to be ${n}`,
      `expected length not to be ${n}`);
  }

  oneOf(list) {
    return this.__assert(list.some((v) => deepEqual(v, this.__actual)),
      `expected ${stringify(this.__actual)} to be one of ${stringify(list)}`,
      `expected ${stringify(this.__actual)} not to be one of ${stringify(list)}`);
  }

  // Terminal getters.
  get ok() { return this.__assert(!!this.__actual, `expected ${stringify(this.__actual)} to be truthy`, `expected ${stringify(this.__actual)} to be falsy`); }
  get true() { return this.__assert(this.__actual === true, `expected ${stringify(this.__actual)} to be true`, `expected value not to be true`); }
  get false() { return this.__assert(this.__actual === false, `expected ${stringify(this.__actual)} to be false`, `expected value not to be false`); }
  get null() { return this.__assert(this.__actual === null, `expected ${stringify(this.__actual)} to be null`, `expected value not to be null`); }
  get undefined() { return this.__assert(this.__actual === undefined, `expected ${stringify(this.__actual)} to be undefined`, `expected value not to be undefined`); }
  get empty() {
    const a = this.__actual;
    const isEmpty = a == null || a.length === 0 || (typeof a === 'object' && Object.keys(a).length === 0);
    return this.__assert(isEmpty, `expected ${stringify(a)} to be empty`, `expected ${stringify(a)} not to be empty`);
  }
  get exist() { return this.__assert(this.__actual != null, `expected value to exist`, `expected value not to exist`); }
}

/** Read-only-ish view of a response for scripts. */
function makeResponseApi(response) {
  if (!response) return null;

  const headerFor = (name) =>
    response.headers.find(([k]) => k.toLowerCase() === String(name).toLowerCase())?.[1];

  const api = {
    code: response.status,
    status: response.statusText,
    responseTime: response.timeMs,
    responseSize: response.size?.body ?? 0,
    text: () => response.bodyText ?? '',
    json: () => {
      try {
        return JSON.parse(response.bodyText ?? '');
      } catch (err) {
        throw new Error(`Response is not valid JSON: ${err.message}`);
      }
    },
    headers: {
      get: headerFor,
      has: (name) => headerFor(name) !== undefined,
      all: () => Object.fromEntries(response.headers),
    },
  };

  api.to = {
    have: {
      status(expected) {
        if (typeof expected === 'string') {
          if (response.statusText !== expected) {
            throw new AssertionError(`expected status text "${response.statusText}" to be "${expected}"`);
          }
        } else if (response.status !== expected) {
          throw new AssertionError(`expected status ${response.status} to be ${expected}`);
        }
      },
      header(name, value) {
        const actual = headerFor(name);
        if (actual === undefined) throw new AssertionError(`expected response to have header "${name}"`);
        if (arguments.length > 1 && actual !== value) {
          throw new AssertionError(`expected header "${name}" to be "${value}" but got "${actual}"`);
        }
      },
      body(expected) {
        const body = response.bodyText ?? '';
        if (expected === undefined) {
          if (!body) throw new AssertionError('expected response to have a body');
        } else if (expected instanceof RegExp) {
          if (!expected.test(body)) throw new AssertionError(`expected body to match ${expected}`);
        } else if (!body.includes(expected)) {
          throw new AssertionError(`expected body to contain ${stringify(expected)}`);
        }
      },
      jsonBody() {
        try { JSON.parse(response.bodyText ?? ''); }
        catch { throw new AssertionError('expected response body to be valid JSON'); }
      },
    },
    be: {
      get ok() {
        if (response.status < 200 || response.status > 299) {
          throw new AssertionError(`expected a 2xx status but got ${response.status}`);
        }
        return true;
      },
      get success() { return this.ok; },
      get error() {
        if (response.status < 400) throw new AssertionError(`expected an error status but got ${response.status}`);
        return true;
      },
    },
  };

  return api;
}

/**
 * Execute a script.
 *
 * @param {string} code
 * @param {object} ctx
 *   ctx.request   – the resolved request being sent (mutable by pre-request scripts)
 *   ctx.response  – the response, for test scripts (null otherwise)
 *   ctx.vars      – resolved variable map
 *   ctx.env       – { get, set, unset }
 *   ctx.globals   – { get, set, unset }
 * @returns {Promise<{tests: Array, logs: Array, error: string|null}>}
 */
export async function runScript(code, ctx) {
  const tests = [];
  const logs = [];
  const pending = [];

  if (!code || !code.trim()) return { tests, logs, error: null };

  const log = (level) => (...args) => {
    logs.push({ level, text: args.map((a) => (typeof a === 'string' ? a : stringify(a))).join(' ') });
  };
  const consoleShim = { log: log('log'), info: log('log'), warn: log('warn'), error: log('error'), debug: log('log') };

  const pm = {
    test(name, fn) {
      pending.push({ name, fn });
    },
    expect(value) { return new Assertion(value); },
    variables: {
      get: (k) => ctx.vars[k],
      has: (k) => k in ctx.vars,
      set: (k, v) => { ctx.vars[k] = String(v); },
      replaceIn: (str) => String(str).replace(/\{\{\s*([^{}\s][^{}]*?)\s*\}\}/g, (m, n) => (n in ctx.vars ? ctx.vars[n] : m)),
      toObject: () => ({ ...ctx.vars }),
    },
    environment: {
      get: (k) => ctx.vars[k],
      has: (k) => k in ctx.vars,
      set: (k, v) => { ctx.vars[k] = String(v); ctx.env.set(k, v); },
      unset: (k) => { delete ctx.vars[k]; ctx.env.unset(k); },
      name: ctx.envName ?? null,
    },
    globals: {
      get: (k) => ctx.vars[k],
      set: (k, v) => { ctx.vars[k] = String(v); ctx.globals.set(k, v); },
      unset: (k) => { delete ctx.vars[k]; ctx.globals.unset(k); },
    },
    collectionVariables: {
      get: (k) => ctx.vars[k],
      set: (k, v) => { ctx.vars[k] = String(v); },
    },
    request: {
      get method() { return ctx.request.method; },
      set method(v) { ctx.request.method = String(v).toUpperCase(); },
      get url() { return ctx.request.url; },
      set url(v) { ctx.request.url = String(v); },
      get body() { return ctx.request.body; },
      set body(v) { ctx.request.body = v; },
      headers: {
        add: ({ key, value }) => { ctx.request.headers.push([key, String(value)]); },
        upsert: ({ key, value }) => {
          const hit = ctx.request.headers.find(([k]) => k.toLowerCase() === key.toLowerCase());
          if (hit) hit[1] = String(value);
          else ctx.request.headers.push([key, String(value)]);
        },
        get: (name) => ctx.request.headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1],
        remove: (name) => {
          ctx.request.headers = ctx.request.headers.filter(([k]) => k.toLowerCase() !== name.toLowerCase());
        },
        all: () => ctx.request.headers.map(([key, value]) => ({ key, value })),
      },
    },
    response: makeResponseApi(ctx.response),
    info: { requestName: ctx.requestName ?? '', eventName: ctx.response ? 'test' : 'prerequest' },
    sendRequest() {
      throw new Error('pm.sendRequest() is not supported in this client.');
    },
  };

  let error = null;
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('pm', 'console', 'responseBody', 'responseCode', `"use strict";\n${code}\n`);
    const result = fn(
      pm,
      consoleShim,
      ctx.response?.bodyText ?? '',
      ctx.response ? { code: ctx.response.status, name: ctx.response.statusText } : undefined
    );
    if (result && typeof result.then === 'function') await result;
  } catch (err) {
    error = `${err.name}: ${err.message}`;
    logs.push({ level: 'error', text: error });
  }

  // Run registered tests after the body, so async ones can be awaited.
  for (const { name, fn } of pending) {
    try {
      const out = fn();
      if (out && typeof out.then === 'function') await out;
      tests.push({ name, passed: true, error: null });
    } catch (err) {
      tests.push({ name, passed: false, error: err.message || String(err) });
    }
  }

  return { tests, logs, error };
}
