// PLAN M5 acceptance: canned records with independently calculated results.
import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrate, calibration, Policy, noul, choice, score } from 'soft-if';
import { replay } from 'soft-if/node';

const binary = p => ({ type: 'noul', p, confidence: Math.max(p, 1 - p), probabilities: { true: p, false: 1 - p } });
const decision = (id, answers, questions = { file: noul('Local?') }) => ({ id, ts: 1, backend: 'recorded', tier: 1, emulated: false, latency_ms: 1, state: `state-${id}`, questions, answers, stale: false, attempts: [{ backend: 'recorded', tier: 1, latency_ms: 1 }] });
const outcome = (id, accepted, extra = {}) => ({ request_id: id, ts: 2, payload: { accepted, ...extra } });
const backend = decide => ({ name: 'replay-acceptance', capabilities: () => ({ images: false }), decide });
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `expected ${expected}, got ${actual}`);

test('calibration calculates weighted ECE and bins from known outcomes', () => {
  const records = [0.95, 0.95, 0.65, 0.65].map((p, i) => decision(`r${i}`, { file: binary(p) }));
  const outcomes = [true, false, true, true].map((accepted, i) => outcome(`r${i}`, accepted));
  const result = calibrate(records, outcomes, [], { bins: 10 });
  assert.equal(result.count, 4);
  // The .95 bin has accuracy .5, the .65 bin has accuracy 1.
  closeTo(result.ece, (2 * Math.abs(0.95 - 0.5) + 2 * Math.abs(0.65 - 1)) / 4);
  const occupied = result.bins.filter(b => b.count);
  assert.equal(occupied.length, 2);
  assert.deepEqual(occupied.map(b => b.count), [2, 2]);
  closeTo(occupied[0].confidence, 0.65);
  closeTo(occupied[0].accuracy, 1);
  closeTo(occupied[1].confidence, 0.95);
  closeTo(occupied[1].accuracy, 0.5);
  assert.deepEqual(calibration(records, outcomes, [], { bins: 10 }), result);
});

test('calibration selects linked branches and skips missing or ambiguous feedback', () => {
  const questions = { file: noul('Local?'), other: noul('Other?') };
  const records = [decision('selected', { file: binary(0.95), other: binary(0.65) }, questions), decision('ambiguous', { file: binary(0.9), other: binary(0.6) }, questions), decision('no-feedback', { file: binary(0.9) })];
  const branches = [{ request_id: 'selected', key: 'other', branch: 'launcher.other', band: 'confirm', ts: 1, value: false }];
  const outcomes = [outcome('selected', true, { branch: 'launcher.other' }), outcome('ambiguous', false), { request_id: 'no-feedback', ts: 2, payload: { chosen: 'file' } }, outcome('missing', true)];
  const result = calibrate(records, outcomes, branches, { branch: 'launcher.other', bins: 10 });
  assert.equal(result.count, 1);
  closeTo(result.ece, 0.35);
  assert.equal(result.branches['launcher.other'].count, 1);
  const ambiguous = calibrate([records[1]], [outcomes[1]], [], { bins: 10 });
  assert.equal(ambiguous.count, 0);
});

test('replay compares noul truth, choice keys, and rounded score expectations', async () => {
  const questions = { file: noul('Local?'), action: choice('Intent?', { file: 'File', web: 'Web' }), urgency: score('Urgency?', ['later', 'soon', 'now']) };
  const original = decision('replay-1', {
    file: binary(0.9),
    action: { type: 'choice', choice: 'file', confidence: 0.9, probabilities: { file: 0.9, web: 0.1 } },
    urgency: { type: 'score', score: 1.2, confidence: 0.8, probabilities: { 0: 0, 1: 0.8, 2: 0.2 } },
  }, questions);
  const frozen = JSON.stringify(original);
  const requests = [];
  const result = await replay([original], backend(async req => { requests.push(req); return { answers: {
    file: binary(0.1),
    action: { type: 'choice', choice: 'web', confidence: 0.9, probabilities: { file: 0.1, web: 0.9 } },
    urgency: { type: 'score', score: 1.4, confidence: 0.6, probabilities: { 0: 0, 1: 0.6, 2: 0.4 } },
  } }; }), {});
  assert.equal(result.total, 1);
  assert.equal(result.comparisons, 3);
  assert.equal(result.agreements, 1);
  closeTo(result.agreementRate, 1 / 3);
  assert.deepEqual(new Set(result.flips.map(f => f.key)), new Set(['file', 'action']));
  assert.equal(result.errors.length, 0);
  assert.equal(requests[0].state, original.state);
  assert.deepEqual(requests[0].questions, questions);
  assert.equal(JSON.stringify(original), frozen, 'replay must preserve original recorded evidence');
});

test('replay uses saved branch values and the supplied branch policy', async () => {
  const original = decision('branch-replay', { file: binary(0.9) });
  const branches = [{ request_id: original.id, key: 'file', branch: 'launcher.file', band: 'act', ts: 1, value: false }];
  const policy = new Policy({ branches: { 'launcher.file': { threshold: 0.95 } } });
  const result = await replay([original], backend(async () => ({ answers: { file: binary(0.96) } })), { branches, policy });
  assert.equal(result.comparisons, 1);
  assert.equal(result.agreements, 0);
  assert.deepEqual(result.flips.map(f => [f.request_id, f.key, f.branch, f.before, f.after]), [[original.id, 'file', 'launcher.file', false, true]]);
});

test('replay counts failed requests instead of reporting backend failure as agreement', async () => {
  const result = await replay([decision('failed-replay', { file: binary(0.9) })], backend(async () => { throw new Error('acceptance replay unavailable'); }), {});
  assert.equal(result.total, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].request_id, 'failed-replay');
  assert.match(result.errors[0].error, /acceptance replay unavailable/);
});
