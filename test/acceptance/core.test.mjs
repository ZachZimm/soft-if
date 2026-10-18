/**
 * Independent acceptance plan, PLAN M0-M3/M6 and accepted CONTRACT.md:
 * - Import only public package exports, use consumer-owned Backend/LogSink doubles.
 * - Check typed questions/answers, policy updates, branch/outcome association,
 *   deadlines, stale completion races, logging error visibility, and tier safety.
 * - bridge.test.mjs covers real HTTP/SSE and durable SQLite round trips.
 * - browser-graph.test.mjs checks every runtime import reachable from the root.
 * - Replay/calibration use canned records once their public API is documented.
 * Live model smoke tests, latency benchmarks, and UI acceptance belong to the lead.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SoftIf, Policy, noul, choice, score, tiered } from 'soft-if';

const binary = (p, extra = {}) => ({ type: 'noul', p, confidence: Math.max(p, 1 - p), probabilities: { yes: p, no: 1 - p }, ...extra });
const backend = (decide, name = 'acceptance') => ({ name, capabilities: () => ({ images: false }), decide });
const fixed = (answers) => backend(async () => ({ answers }));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const memoryLog = () => {
  const events = [];
  return { events, ...Object.fromEntries(['decision', 'branch', 'outcome', 'policy'].map(type => [type, data => { events.push({ type, data }); }])) };
};

test('builders emit native wire questions and enforce option/level limits', () => {
  assert.deepEqual(noul('Local file?'), { type: 'noul', instructions: 'Local file?' });
  assert.deepEqual(choice('Intent?', { file: 'A file', web: 'A web page' }), { type: 'choice', instructions: 'Intent?', criteria: { file: 'A file', web: 'A web page' } });
  assert.deepEqual(score('Urgency?', ['later', 'soon', 'now']), { type: 'score', instructions: 'Urgency?', criteria: ['later', 'soon', 'now'] });
  assert.throws(() => score('Urgency?', ['one']));
  assert.throws(() => score('Urgency?', Array.from({ length: 11 }, (_, i) => String(i))));
  assert.throws(() => choice('Intent?', Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`k${i}`, `Option ${i}`]))));
});

test('consumer decides three questions and logs decision, named branches, and outcome', async () => {
  const log = memoryLog();
  const answers = {
    file: binary(0.9),
    action: { type: 'choice', choice: 'file', confidence: 0.93, probabilities: { file: 0.8, web: 0.2 } },
    urgency: { type: 'score', score: 1.25, confidence: 0.88, probabilities: { 0: 0.1, 1: 0.55, 2: 0.35 } },
  };
  const soft = new SoftIf({ backend: fixed(answers), policy: new Policy(), log });
  const r = await soft.decide('find notes', { file: noul('Local?'), action: choice('Intent?', { file: 'File', web: 'Web' }), urgency: score('Urgency?', ['later', 'soon', 'now']) }, { name: 'acceptance.input', tick: 42 });
  assert.equal(r.file.p, 0.9);
  assert.equal(r.action.confidence, 0.93, 'native explicit confidence must survive');
  assert.equal(r.urgency.score, 1.25, 'native score expectation must stay fractional');
  assert.equal(soft.when(r.file, 'launcher.file'), true);
  assert.equal(soft.pick(r.action, 'launcher.action'), 'file');
  soft.outcome(r.id, { chosen: 'file', accepted: true });
  await soft.flush();
  const decision = log.events.find(e => e.type === 'decision').data;
  assert.equal(decision.id, r.id);
  assert.equal(decision.state, 'find notes');
  assert.equal(decision.tick, 42);
  assert.deepEqual(decision.answers.action.probabilities, answers.action.probabilities);
  assert.equal(decision.tier, 1);
  assert.equal(decision.attempts[0].backend, 'acceptance');
  const branches = log.events.filter(e => e.type === 'branch').map(e => e.data);
  assert.deepEqual(branches.map(b => [b.request_id, b.key, b.branch, b.value]), [[r.id, 'file', 'launcher.file', true], [r.id, 'action', 'launcher.action', 'file']]);
  assert.equal(log.events.find(e => e.type === 'outcome').data.request_id, r.id);
});

test('reserved metadata cannot be supplied as question keys', async () => {
  let calls = 0;
  const soft = new SoftIf({ backend: backend(async () => { calls++; return { answers: {} }; }) });
  for (const key of ['id', 'ts', 'name', 'tick', 'backend', 'tier', 'emulated', 'latency_ms', 'stale', 'error', 'usage', 'attempts']) {
    await assert.rejects(async () => soft.decide('state', { [key]: noul('Question?') }), /reserved/i);
  }
  assert.equal(calls, 0);
});

test('policy updates change an existing answer without constructing another SoftIf', async () => {
  const policy = new Policy({ branches: { 'launcher.file': { threshold: 0.8 }, keep: { fallback: true } } });
  const changes = [];
  const unsubscribe = policy.subscribe(c => changes.push(c));
  const soft = new SoftIf({ backend: fixed({ file: binary(0.82) }), policy });
  const r = await soft.decide('state', { file: noul('Local?') });
  assert.equal(soft.when(r.file, 'launcher.file'), true);
  policy.update({ branches: { 'launcher.file': { threshold: 0.9 } }, bands: { act: 0.95 } });
  assert.equal(soft.when(r.file, 'launcher.file'), false);
  assert.equal(policy.snapshot().bands.confirm, 0.6);
  assert.equal(policy.snapshot().branches.keep.fallback, true);
  assert.equal(changes[0].branch, '*');
  const snapshot = policy.snapshot();
  snapshot.bands.act = 0;
  assert.equal(policy.snapshot().bands.act, 0.95, 'snapshot must not expose mutable policy state');
  assert.throws(() => policy.update({ bands: { act: 0.2, confirm: 0.8 } }));
  assert.equal(policy.snapshot().bands.act, 0.95);
  policy.replace({ bands: { act: 0.9, confirm: 0.7 } });
  assert.equal(Object.keys(policy.snapshot().branches).length, 0);
  unsubscribe();
});

test('latest hides a completed answer while a newer tick is pending and flags late completion', async () => {
  const pending = new Map([['old', deferred()], ['new', deferred()], ['next', deferred()]]);
  const log = memoryLog();
  const soft = new SoftIf({ backend: backend(req => pending.get(req.state).promise), log, defaultTimeoutMs: 5000 });
  const oldPromise = soft.decide('old', { file: noul('Local?') }, { name: 'launcher.input', tick: 1 });
  const newPromise = soft.decide('new', { file: noul('Local?') }, { name: 'launcher.input', tick: 2 });
  assert.equal(soft.latest('launcher.input'), undefined);
  pending.get('new').resolve({ answers: { file: binary(0.9) } });
  const newest = await newPromise;
  assert.equal(newest.stale, false);
  assert.equal(soft.latest('launcher.input').id, newest.id);
  pending.get('old').resolve({ answers: { file: binary(0.1) } });
  const old = await oldPromise;
  assert.equal(old.stale, true);
  assert.equal(soft.latest('launcher.input').id, newest.id);
  const nextPromise = soft.decide('next', { file: noul('Local?') }, { name: 'launcher.input', tick: 3 });
  assert.equal(soft.latest('launcher.input'), undefined);
  pending.get('next').resolve({ answers: { file: binary(0.95) } });
  await nextPromise;
  await soft.flush();
  assert.equal(log.events.find(e => e.type === 'decision' && e.data.id === old.id).data.stale, true, 'late answers must remain in the log');
});

test('timeout returns an observable fallback even if a backend ignores AbortSignal', { timeout: 2000 }, async () => {
  const log = memoryLog();
  let signal;
  const soft = new SoftIf({ backend: backend((_req, opts) => { signal = opts.signal; return new Promise(() => {}); }), log, defaultTimeoutMs: 20, policy: new Policy({ branches: { 'launcher.file': { fallback: false } } }) });
  const r = await soft.decide('state', { file: noul('Local?') });
  assert.match(r.error, /time|abort/i);
  assert.equal(r.file.fallback, true);
  assert.equal(soft.band(r.file), 'fallback');
  assert.equal(soft.when(r.file, 'launcher.file'), false);
  assert.equal(signal.aborted, true);
  await soft.flush();
  assert.ok(log.events.find(e => e.type === 'decision').data.error);
});

test('log failures reach onError and do not turn a successful decision into silent data loss', async () => {
  const errors = [];
  const log = { ...memoryLog(), decision: async () => { throw new Error('acceptance disk write failed'); } };
  const soft = new SoftIf({ backend: fixed({ file: binary(0.9) }), log });
  const off = soft.onError(e => errors.push(e));
  const r = await soft.decide('state', { file: noul('Local?') });
  await soft.flush().catch(() => {});
  assert.equal(r.file.p, 0.9);
  assert.ok(errors.some(e => /acceptance disk write failed/.test(String(e))), 'a failed LogSink write must be observable');
  off();
});

test('emulated one-hot answers stay confirm unless the application opts in', async () => {
  const policy = new Policy();
  const soft = new SoftIf({ backend: fixed({ file: binary(1, { emulated: true }) }), policy });
  const r = await soft.decide('state', { file: noul('Local?') });
  assert.equal(soft.band(r.file), 'confirm');
  assert.equal(soft.when(r.file, 'launcher.file'), false, 'a synthetic one-hot must not authorize automatic action');
  policy.update({ allowEmulated: true });
  assert.equal(soft.band(r.file), 'act');
  assert.equal(soft.when(r.file, 'launcher.file'), true);
});

test('pick suppresses a native choice in the fallback band', async () => {
  const soft = new SoftIf({ backend: fixed({ action: { type: 'choice', choice: 'file', confidence: 0.5, probabilities: { file: 0.5, web: 0.5 } } }) });
  const r = await soft.decide('state', { action: choice('Intent?', { file: 'File', web: 'Web' }) });
  assert.equal(soft.band(r.action), 'fallback');
  assert.equal(soft.pick(r.action, 'launcher.action'), undefined);
});

test('failed escalation retains the usable tier-one answer and records the failed attempt', async () => {
  let secondCalls = 0;
  const first = backend(async () => ({ answers: { file: binary(0.7) } }), 'first');
  const second = backend(async () => { secondCalls++; throw new Error('acceptance tier two unavailable'); }, 'second');
  const log = memoryLog();
  const soft = new SoftIf({ backend: tiered([first, second], { escalateBelow: 'confirm' }), policy: new Policy(), log });
  const r = await soft.decide('state', { file: noul('Local?') });
  assert.equal(secondCalls, 1, 'PLAN M3 requires confirm-band escalation');
  assert.equal(r.file.p, 0.7);
  assert.equal(r.file.fallback, undefined);
  assert.equal(r.tier, 1);
  assert.equal(r.backend, 'first');
  assert.match(r.error, /acceptance tier two unavailable/);
  assert.equal(r.attempts.length, 2);
  assert.match(r.attempts[1].error, /acceptance tier two unavailable/);
  await soft.flush();
  assert.match(log.events.find(e => e.type === 'decision').data.error, /acceptance tier two unavailable/);
});

test('successful escalation records tier two and keeps emulated safety', async () => {
  const log = memoryLog();
  const first = backend(async () => ({ answers: { file: binary(0.7) } }), 'first');
  const second = backend(async () => ({ answers: { file: binary(1, { emulated: true }) }, emulated: true }), 'second');
  const soft = new SoftIf({ backend: tiered([first, second], { escalateBelow: 'confirm' }), log });
  const r = await soft.decide('state', { file: noul('Local?') });
  assert.equal(r.tier, 2);
  assert.equal(r.backend, 'second');
  assert.equal(r.emulated, true);
  assert.equal(soft.band(r.file), 'confirm');
  await soft.flush();
  assert.equal(log.events.find(e => e.type === 'decision').data.emulated, true);
});

test('overall timeout during escalation retains tier one and reports the abandoned tier', { timeout: 2000 }, async () => {
  let secondCalls = 0;
  const log = memoryLog();
  const first = backend(async () => ({ answers: { file: binary(0.7) } }), 'first');
  const second = backend(async () => { secondCalls++; return new Promise(() => {}); }, 'hung-second');
  const soft = new SoftIf({ backend: tiered([first, second], { escalateBelow: 'confirm' }), log, defaultTimeoutMs: 30 });
  const r = await soft.decide('state', { file: noul('Local?') });
  assert.equal(secondCalls, 1);
  assert.equal(r.file.p, 0.7, 'an escalation deadline must retain the successful native answer');
  assert.notEqual(r.file.fallback, true);
  assert.equal(r.backend, 'first');
  assert.equal(r.tier, 1);
  assert.match(r.error, /time|abort/i);
  assert.equal(r.attempts.length, 2);
  assert.match(r.attempts[1].error, /time|abort/i);
  await soft.flush();
  const saved = log.events.find(e => e.type === 'decision').data;
  assert.equal(saved.answers.file.p, 0.7);
  assert.ok(saved.attempts[1].error);
});
