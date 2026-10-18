// CONTRACT acceptance: public browser bridge against an actual loopback HTTP/SSE
// service and a temporary on-disk SQLite database. No model endpoint is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { SoftIf, Policy, noul, createBrowserBridge } from 'soft-if';
import { SQLiteLog, startDebugger, Policy as NodePolicy } from 'soft-if/node';

async function eventually(predicate, message = 'condition was not observed', timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

// Small EventSource-compatible adapter using real fetch streaming. It gives Node
// consumers the browser injection hook without mocking transport or SSE payloads.
class HttpEventSource {
  listeners = new Map();
  controller = new AbortController();
  received = [];
  readyState = 0;
  onopen = null;
  onerror = null;
  closed = false;
  constructor(url) {
    this.url = String(url);
    this.done = this.consume().catch(error => {
      if (!this.closed) { this.onerror?.(error); this.emit('error', error); }
    });
  }
  addEventListener(name, fn) { const list = this.listeners.get(name) ?? new Set(); list.add(fn); this.listeners.set(name, list); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  emit(name, event) { for (const fn of this.listeners.get(name) ?? []) fn(event); }
  async consume() {
    const response = await fetch(this.url, { signal: this.controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    this.readyState = 1;
    this.onopen?.({ type: 'open' });
    this.emit('open', { type: 'open' });
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const lines = frame.split('\n');
        const name = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? 'message';
        const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        this.received.push({ name, data: JSON.parse(data) });
        this.emit(name, { type: name, data });
      }
    }
  }
  close() { this.closed = true; this.readyState = 2; this.controller.abort(); }
}

const answer = p => ({ type: 'noul', p, confidence: Math.max(p, 1 - p), probabilities: { yes: p, no: 1 - p } });
const model = { name: 'acceptance-local', capabilities: () => ({ images: false }), decide: async () => ({ answers: { file: answer(0.82) } }) };
const record = id => ({ id, ts: Date.now(), backend: 'acceptance-local', tier: 1, emulated: false, latency_ms: 1, state: 'find notes', questions: { file: noul('Local file?') }, answers: { file: answer(0.82) }, stale: false, attempts: [{ backend: 'acceptance-local', tier: 1, latency_ms: 1 }] });

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'softif-acceptance-'));
  const path = join(dir, 'decisions.sqlite');
  const log = new SQLiteLog(path);
  const policy = new NodePolicy({ branches: { 'launcher.file': { threshold: 0.8, fallback: false } } });
  const server = await startDebugger({ policy, log, port: 0, ...options });
  const streams = [];
  const bridges = [];
  let logClosed = false;
  t.after(async () => {
    for (const bridge of bridges) bridge.close();
    for (const stream of streams) stream.close();
    await Promise.all(streams.map(stream => stream.done));
    await server.close();
    if (!logClosed) log.close();
    policy.close();
    await rm(dir, { recursive: true, force: true });
  });
  const makeBridge = extra => {
    const clientPolicy = new Policy();
    const bridge = createBrowserBridge({ url: server.url, policy: clientPolicy, eventSourceFactory: url => { const source = new HttpEventSource(url); streams.push(source); return source; }, ...extra });
    bridges.push(bridge);
    return { bridge, policy: clientPolicy };
  };
  return { dir, path, log, policy, server, streams, makeBridge, closeLog: () => { log.close(); logClosed = true; } };
}

test('browser consumer persists decisions, branches, and outcomes over HTTP, then reopens SQLite', async t => {
  const f = await fixture(t);
  const { bridge, policy } = f.makeBridge();
  await bridge.connect();
  await eventually(() => f.streams[0]?.received[0]?.name === 'snapshot', 'SSE must begin with snapshot');
  assert.deepEqual(f.streams[0].received[0].data.policy, policy.snapshot());
  const soft = new SoftIf({ backend: model, policy, log: bridge.log });
  const r = await soft.decide('find notes', { file: noul('Local file?') }, { name: 'launcher.input', tick: 7 });
  assert.equal(soft.when(r.file, 'launcher.file'), true);
  soft.outcome(r.id, { accepted: true, chosen: 'file' });
  // This is the exact flush sequence shown in CONTRACT's browser example.
  await bridge.flush();
  const response = await fetch(`${f.server.url}/snapshot?limit=10`);
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.decisions.length, 1);
  assert.equal(snapshot.decisions[0].id, r.id);
  assert.equal(snapshot.decisions[0].tick, 7);
  assert.deepEqual(snapshot.decisions[0].answers.file.probabilities, answer(0.82).probabilities);
  assert.equal(snapshot.branches.find(b => b.request_id === r.id).branch, 'launcher.file');
  assert.deepEqual(snapshot.outcomes.find(o => o.request_id === r.id).payload, { accepted: true, chosen: 'file' });
  await eventually(() => ['decision', 'branch', 'outcome'].every(name => f.streams[0].received.some(e => e.name === name)), 'persisted events must reach SSE');
  assert.equal(f.streams[0].received.find(e => e.name === 'decision').data.id, r.id, 'SSE data must be a record, not an event envelope');
  bridge.close();
  f.closeLog();
  const reopened = new SQLiteLog(f.path);
  try {
    assert.equal(reopened.get(r.id).state, 'find notes');
    assert.equal(reopened.branches({ branch: 'launcher.file' })[0].request_id, r.id);
    assert.equal(reopened.outcomes()[0].request_id, r.id);
  } finally { reopened.close(); }
});

test('HTTP policy edits persist and update a connected browser policy through SSE', async t => {
  const f = await fixture(t);
  const { bridge, policy } = f.makeBridge();
  await bridge.connect();
  await eventually(() => f.streams[0]?.received.some(e => e.name === 'snapshot'));
  const soft = new SoftIf({ backend: model, policy, log: bridge.log });
  const before = await soft.decide('state', { file: noul('Local?') });
  assert.equal(soft.when(before.file, 'launcher.file'), true);
  const response = await fetch(`${f.server.url}/policy`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' }, body: JSON.stringify({ branches: { 'launcher.file': { threshold: 0.9, fallback: false } } }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal((await response.json()).policy.branches['launcher.file'].threshold, 0.9);
  await eventually(() => policy.snapshot().branches['launcher.file']?.threshold === 0.9, 'SSE policy edit did not reach the browser');
  const after = await soft.decide('state', { file: noul('Local?') });
  assert.equal(soft.when(after.file, 'launcher.file'), false);
  await soft.flush();
  await bridge.flush();
  const changes = f.log.policyChanges();
  assert.ok(changes.some(c => c.branch === 'launcher.file' && c.after.threshold === 0.9));
  assert.equal(f.policy.snapshot().branches['launcher.file'].threshold, 0.9);
});

test('failed bridge POST retains queued events, reports failure, and retries successfully', async t => {
  const f = await fixture(t);
  let offline = true;
  const { bridge } = f.makeBridge({ fetch: (url, init) => {
    if (offline && init?.method === 'POST') return Promise.reject(new Error('acceptance offline'));
    return fetch(url, init);
  } });
  const errors = [];
  const statuses = [];
  bridge.onError(error => errors.push(error));
  bridge.onStatus(status => statuses.push(status));
  await bridge.connect();
  await bridge.log.decision(record('retry-once'));
  await assert.rejects(bridge.flush(), /acceptance offline/);
  assert.equal(bridge.status().pending, 1);
  assert.equal(bridge.status().state, 'error');
  assert.ok(errors.some(e => /acceptance offline/.test(String(e))));
  assert.ok(statuses.some(s => s.state === 'error'));
  assert.equal(f.log.decisions({}).length, 0);
  offline = false;
  await bridge.flush();
  assert.equal(bridge.status().pending, 0);
  assert.equal(f.log.decisions({}).length, 1);
  assert.equal(f.log.get('retry-once').id, 'retry-once');
});

test('an empty flush cannot prevent a later enqueue and flush from persisting', async t => {
  const f = await fixture(t);
  const { bridge } = f.makeBridge();
  await bridge.connect();
  await bridge.flush();
  await bridge.log.decision(record('after-empty-flush'));
  await bridge.flush();
  assert.equal(bridge.status().pending, 0);
  assert.equal(f.log.get('after-empty-flush')?.id, 'after-empty-flush');
});

test('bridge queue overflow is observable and preserves already queued records', async t => {
  const f = await fixture(t);
  const { bridge } = f.makeBridge({ maxQueue: 2, fetch: (url, init) => init?.method === 'POST' ? Promise.reject(new Error('acceptance offline')) : fetch(url, init) });
  const errors = [];
  bridge.onError(error => errors.push(error));
  await bridge.log.decision(record('queued-1'));
  await bridge.log.decision(record('queued-2'));
  await assert.rejects(async () => bridge.log.decision(record('overflow')), /queue|overflow|full/i);
  assert.equal(bridge.status().pending, 2);
  assert.ok(errors.some(e => /queue|overflow|full/i.test(String(e))));
});

test('HTTP routes enforce local origins, body and batch bounds, and JSON errors', async t => {
  const f = await fixture(t, { maxBodyBytes: 4096 });
  assert.deepEqual(await (await fetch(`${f.server.url}/health`)).json(), { ok: true, version: 1 });
  for (const origin of ['http://localhost:1420', 'http://127.0.0.1:5183', 'tauri://localhost', 'http://tauri.localhost']) {
    const response = await fetch(`${f.server.url}/health`, { headers: { origin } });
    assert.equal(response.status, 200, origin);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
  }
  for (const headers of [{ origin: 'https://evil.example' }, { origin: 'http://localhost:5184' }]) {
    const response = await fetch(`${f.server.url}/health`, { headers });
    assert.ok(response.status >= 400, JSON.stringify(headers));
    assert.equal(typeof (await response.json()).error, 'string');
  }
  // Node 26 fetch rewrites Host. node:http sends the actual hostile header.
  const hostileHost = await new Promise((resolve, reject) => {
    const req = request(`${f.server.url}/health`, { headers: { host: 'evil.example' } }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(hostileHost.status, 403);
  assert.match(hostileHost.body.error, /host|localhost/i);
  for (const body of [JSON.stringify({ events: [] }), JSON.stringify({ events: Array.from({ length: 101 }, () => ({ type: 'outcome', data: { request_id: 'id', ts: 1, payload: {} } })) }), 'x'.repeat(5000), '{bad']) {
    const response = await fetch(`${f.server.url}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.ok(response.status >= 400);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  const response = await fetch(`${f.server.url}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [{ type: 'policy', data: { ts: 1, branch: '*', before: {}, after: {}, policy: {} } }] }) });
  assert.ok(response.status >= 400, 'browser policy log events must use /policy instead');
});

test('snapshot returns the requested bounded window in chronological order', async t => {
  const f = await fixture(t);
  for (let i = 1; i <= 3; i++) f.log.decision({ ...record(`window-${i}`), ts: i });
  const response = await fetch(`${f.server.url}/snapshot?limit=2`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).decisions.map(d => d.id), ['window-2', 'window-3']);
});

test('file policy hot reload flips a branch and invalid reload preserves the last good value', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'softif-policy-acceptance-'));
  const path = join(dir, 'policy.json');
  await writeFile(path, JSON.stringify({ branches: { 'launcher.file': { threshold: 0.8 } } }));
  const policy = NodePolicy.fromFile(path, { watch: true });
  t.after(async () => { policy.close(); await rm(dir, { recursive: true, force: true }); });
  const errors = [];
  policy.onError(error => errors.push(error));
  const soft = new SoftIf({ backend: model, policy });
  const r = await soft.decide('state', { file: noul('Local?') });
  assert.equal(soft.when(r.file, 'launcher.file'), true);
  await writeFile(path, JSON.stringify({ branches: { 'launcher.file': { threshold: 0.9 } } }));
  await eventually(() => policy.snapshot().branches['launcher.file'].threshold === 0.9);
  assert.equal(soft.when(r.file, 'launcher.file'), false);
  await writeFile(path, '{invalid policy');
  await eventually(() => errors.length > 0, 'invalid reload must notify policy.onError');
  assert.equal(policy.snapshot().branches['launcher.file'].threshold, 0.9);
});
