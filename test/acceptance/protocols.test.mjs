// PLAN M0/M3 and risk acceptance. These are local recorded-wire HTTP fixtures,
// never live model requests. Only documented package exports are exercised.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { SoftIf, Policy, noul, choice, score, ollama, llamacpp, openaiEmulated } from 'soft-if';

async function endpoint(t, responder) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: req.url, method: req.method, headers: req.headers, body });
    res.setHeader('content-type', 'application/json');
    const result = responder(body);
    res.end(typeof result === 'string' ? result : JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

const questions = { file: noul('Local file?'), action: choice('Intent?', { file: 'File', web: 'Web' }), urgency: score('Urgency?', ['later', 'soon', 'now']) };
const native = { answers: {
  file: { noul: 0.9 },
  action: { choice: 'file', confidence: 0.93, probabilities: { file: 0.8, web: 0.2 } },
  urgency: { score: 1.25, confidence: 0.77, probabilities: { 0: 0.1, 1: 0.55, 2: 0.35 } },
}, usage: { input_tokens: 99, output_tokens: 3 }, latency_ms: 12 };

test('Ollama sends the native request and parses recorded native answers', async t => {
  const f = await endpoint(t, () => native);
  const backend = ollama({ url: f.url, model: 'acceptance-model' });
  const result = await backend.decide({ state: 'find notes', questions, images: ['base64-fixture'] }, { signal: new AbortController().signal });
  assert.equal(f.requests[0].path, '/v1/systemone');
  assert.equal(f.requests[0].method, 'POST');
  assert.equal(f.requests[0].body.model, 'acceptance-model');
  assert.equal(f.requests[0].body.state, 'find notes');
  assert.deepEqual(f.requests[0].body.questions, questions);
  assert.deepEqual(f.requests[0].body.images, ['base64-fixture']);
  assert.equal(result.answers.file.p, 0.9);
  assert.equal(result.answers.file.confidence, 0.9);
  assert.equal(result.answers.action.confidence, 0.93);
  assert.equal(result.answers.urgency.score, 1.25);
  assert.deepEqual(result.answers.action.probabilities, native.answers.action.probabilities);
  assert.equal(result.usage.input_tokens, 99);
  assert.equal(result.latency_ms, 12);
});

test('llama.cpp accepts an explicit endpoint and does not invent an Ollama model', async t => {
  const f = await endpoint(t, () => ({ ...native, latency_ms: undefined, duration_ms: 15 }));
  const result = await llamacpp({ url: `${f.url}/v1/systemone` }).decide({ state: 'find notes', questions }, { signal: new AbortController().signal });
  assert.equal(f.requests[0].path, '/v1/systemone');
  assert.equal(Object.hasOwn(f.requests[0].body, 'model'), false);
  assert.equal(result.answers.urgency.score, 1.25);
  assert.equal(result.latency_ms, 15);
});

test('OpenAI emulation requests constrained JSON and marks synthetic distributions', async t => {
  const f = await endpoint(t, () => ({ choices: [{ message: { content: JSON.stringify({ file: 0.8, action: 'web', urgency: 2 }) } }], usage: { prompt_tokens: 100, completion_tokens: 8 } }));
  const backend = openaiEmulated({ url: `${f.url}/v1`, model: 'acceptance-chat', thinking: false });
  const soft = new SoftIf({ backend, policy: new Policy() });
  const r = await soft.decide('find notes', questions);
  assert.equal(f.requests[0].path, '/v1/chat/completions');
  const format = f.requests[0].body.response_format;
  assert.equal(format.type, 'json_schema');
  assert.equal(format.json_schema.strict, true);
  assert.deepEqual(format.json_schema.schema.properties.action.enum, ['file', 'web']);
  assert.equal(format.json_schema.schema.properties.urgency.type, 'integer');
  assert.equal(format.json_schema.schema.properties.file.minimum, 0);
  assert.equal(format.json_schema.schema.properties.file.maximum, 1);
  assert.equal(r.file.p, 0.8);
  assert.equal(r.action.choice, 'web');
  assert.deepEqual(r.action.probabilities, { file: 0, web: 1 });
  assert.equal(r.urgency.score, 2);
  assert.deepEqual(r.urgency.probabilities, { 0: 0, 1: 0, 2: 1 });
  assert.equal(r.emulated, true);
  for (const key of Object.keys(questions)) assert.equal(r[key].emulated, true);
  assert.equal(soft.band(r.action), 'confirm');
  assert.equal(r.usage.input_tokens, 100);
});

test('malformed native replies retain raw evidence in the observable decision error', async t => {
  const f = await endpoint(t, () => 'acceptance-corrupt-response');
  const soft = new SoftIf({ backend: ollama({ url: f.url }) });
  const result = await soft.decide('state', { file: noul('Local?') });
  assert.match(result.error, /acceptance-corrupt-response/);
  assert.equal(result.file.fallback, true);
});

test('out-of-range emulated answers become an observable fallback', async t => {
  const f = await endpoint(t, () => ({ choices: [{ message: { content: JSON.stringify({ file: 2 }) } }] }));
  const soft = new SoftIf({ backend: openaiEmulated({ url: `${f.url}/v1`, model: 'acceptance-chat' }) });
  const result = await soft.decide('state', { file: noul('Local?') });
  assert.ok(result.error);
  assert.equal(result.file.fallback, true);
});

test('oversized state is refused before calling a limited backend', async () => {
  let calls = 0;
  const limited = { name: 'limited', capabilities: () => ({ images: false, maxStateTokens: 256 }), decide: async () => { calls++; return { answers: {} }; } };
  const soft = new SoftIf({ backend: limited });
  await assert.rejects(async () => soft.decide('x'.repeat(5000), { file: noul('Local?') }), /token|budget|state|context/i);
  assert.equal(calls, 0, 'silent server truncation must not be relied upon');
});
