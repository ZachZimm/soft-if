import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  Policy,
  SQLiteLog,
  SoftIf,
  fake,
  noul,
  parseSystemOne,
  startDebugger,
  createBrowserBridge,
  ollama,
} from "soft-if/node";
const exec = promisify(execFile);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

test("recorded Clef response retains native confidence and fractional expectation", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("./fixtures/clef-flash-response.json", import.meta.url),
    ),
  );
  const request = JSON.parse(
    await readFile(
      new URL("./fixtures/clef-flash-request.json", import.meta.url),
    ),
  );
  const parsed = parseSystemOne(fixture, request.questions);
  assert.equal(parsed.answers.team.confidence, 0.8855037289520584);
  assert.notEqual(
    parsed.answers.team.confidence,
    Math.max(...Object.values(parsed.answers.team.probabilities)),
  );
  assert.equal(parsed.answers.severity.score, 2.791866416025877);
  assert.equal(parsed.answers.severity.confidence, 0.7918664160258775);
});

test("branch timeout uses minimum mapped deadline, explicit request timeout wins", async () => {
  const policy = new Policy({
    branches: {
      "app.quick": { timeoutMs: 5, fallback: true },
      "app.slow": { timeoutMs: 80 },
    },
  });
  const soft = new SoftIf({
    policy,
    backend: fake({ delayMs: 25 }),
    defaultTimeoutMs: 100,
  });
  try {
    const r = await soft.decide(
      "s",
      { q: noul("Q?"), other: noul("Other?") },
      { branches: { q: "app.quick", other: "app.slow" } },
    );
    assert.match(r.error, /timeout/);
    assert.equal(r.q.p, 1);
    assert.equal(soft.when(r.q, "app.quick"), true);
    const passed = await soft.decide(
      "s",
      { q: noul("Q?") },
      { branches: { q: "app.quick" }, timeoutMs: 100 },
    );
    assert.equal(passed.error, undefined);
    assert.equal(passed.q.fallback, undefined);
  } finally {
    await soft.close();
  }
});

test("caller cancellation bounds even an abort-ignoring backend", async () => {
  const controller = new AbortController();
  const soft = new SoftIf({
    backend: {
      name: "hang",
      capabilities: () => ({ images: false }),
      decide: () => new Promise(() => {}),
    },
    defaultTimeoutMs: 1000,
  });
  const promise = soft.decide(
    "s",
    { q: noul("Q?") },
    { signal: controller.signal },
  );
  controller.abort(new Error("replaced input"));
  const r = await promise;
  assert.equal(r.q.fallback, true);
  assert.match(r.error, /replaced input/);
  await soft.close();
});

test("Node file policy persists HTTP updates once and restores them across reopen", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "softif-durable-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "policy.json"),
    db = join(dir, "log.db");
  await writeFile(
    path,
    JSON.stringify({ branches: { "app.q": { threshold: 0.8 } } }),
  );
  const policy = Policy.fromFile(path, { watch: true, intervalMs: 15 });
  const log = new SQLiteLog(db);
  const server = await startDebugger({ policy, log, port: 0 });
  try {
    const res = await fetch(`${server.url}/policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branches: { "app.q": { threshold: 0.95 } } }),
    });
    assert.equal(res.status, 200);
    await delay(80);
    assert.equal(log.policyChanges().length, 1);
    assert.equal(
      JSON.parse(await readFile(path)).branches["app.q"].threshold,
      0.95,
    );
    const invalid = await fetch(`${server.url}/policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bands: { act: 0.2, confirm: 0.9 } }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(
      JSON.parse(await readFile(path)).branches["app.q"].threshold,
      0.95,
    );
  } finally {
    await server.close();
    policy.close();
    log.close();
  }
  const reopened = new SQLiteLog(db);
  try {
    assert.equal(reopened.snapshot().policy.branches["app.q"].threshold, 0.95);
  } finally {
    reopened.close();
  }
});

test("batched ingest rolls back all earlier records when a later link is invalid", async () => {
  const log = new SQLiteLog(":memory:");
  const soft = new SoftIf({ backend: fake() });
  try {
    const r = await soft.decide("s", { q: noul("Q?") });
    const record = soft.log.get(r.id);
    assert.throws(() =>
      log.ingest([
        { type: "decision", data: record },
        {
          type: "branch",
          data: {
            request_id: "missing",
            key: "q",
            branch: "q",
            band: "act",
            ts: 1,
            value: true,
          },
        },
      ]),
    );
    assert.equal(log.get(r.id), undefined);
  } finally {
    await soft.close();
    log.close();
  }
});

test("ring stays bounded and sqlite preserves complete distributions", async () => {
  const log = new SQLiteLog(":memory:");
  const soft = new SoftIf({ backend: fake(), log });
  try {
    for (let i = 0; i < 1000; i++)
      await soft.decide("state", { q: noul("Q?") });
    assert.equal(log.decisions().length, 1000);
    const record = log.decisions()[123];
    assert.deepEqual(log.get(record.id).answers.q.probabilities, {
      true: 0.9,
      false: 0.1,
    });
    assert.equal(
      log.db
        .prepare("select confidence,band from answers where request_id=?")
        .get(record.id).band,
      "act",
    );
  } finally {
    await soft.close();
    log.close();
  }
});

test("CLI ask, calibration and replay run offline and expose failures", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "softif-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = join(dir, "test.db");
  const command = new URL("../dist/src/cli.js", import.meta.url).pathname;
  const asked = await exec(process.execPath, [
    command,
    "ask",
    "--backend",
    "fake",
    "--state",
    "local",
    "--noul",
    "q=Local file?",
    "--db",
    db,
  ]);
  assert.equal(JSON.parse(asked.stdout).q.p, 0.9);
  const replayed = await exec(process.execPath, [
    command,
    "replay",
    "--backend",
    "fake",
    "--db",
    db,
    "--json",
  ]);
  assert.equal(JSON.parse(replayed.stdout).agreementRate, 1);
  const calibrated = await exec(process.execPath, [
    command,
    "calib",
    "--db",
    db,
    "--json",
  ]);
  assert.equal(JSON.parse(calibrated.stdout).count, 0);
  await assert.rejects(
    exec(process.execPath, [
      command,
      "ask",
      "--backend",
      "fake",
      "--state",
      "s",
      "--noul",
      "id=Reserved?",
    ]),
    (e) => /Reserved/.test(e.stderr),
  );
});

test(
  "live Ollama native protocol smoke",
  { skip: process.env.SOFTIF_LIVE !== "1" },
  async (t) => {
    const url = process.env.SOFTIF_URL ?? "http://127.0.0.1:11434";
    let res;
    try {
      res = await fetch(`${url}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      t.skip("Ollama is unavailable");
      return;
    }
    if (!res.ok) {
      t.skip(`Ollama health HTTP ${res.status}`);
      return;
    }
    const tags = await res.json();
    const model = process.env.SOFTIF_MODEL ?? "clef-flash-q8:latest";
    if (!tags.models?.some((m) => m.name === model)) {
      t.skip(`Model ${model} unavailable`);
      return;
    }
    const soft = new SoftIf({
      backend: ollama({ url, model }),
      defaultTimeoutMs: 30_000,
    });
    try {
      const r = await soft.decide(
        "A user wants to find a file stored on their laptop.",
        { local: noul("Is this a local file search?") },
      );
      assert.equal(r.error, undefined);
      assert.ok(r.local.p > 0.5);
      assert.ok(r.usage.input_tokens > 0);
    } finally {
      await soft.close();
    }
  },
);

test("calibration accepts prototype-like branch names as ordinary data", async () => {
  const { calibrate } = await import("soft-if");
  const log = new SQLiteLog(":memory:");
  const soft = new SoftIf({ backend: fake(), log });
  try {
    for (const branch of ["__proto__", "constructor", "prototype"]) {
      const r = await soft.decide("s", { q: noul("Q?") });
      soft.when(r.q, branch);
      soft.outcome(r.id, { accepted: true, branch });
    }
    const report = calibrate(log.decisions(), log.outcomes(), log.branches());
    assert.equal(report.count, 3);
    for (const b of ["__proto__", "constructor", "prototype"])
      assert.equal(report.branches[b].count, 1);
  } finally {
    await soft.close();
    log.close();
  }
});

test("automatic ticks continue above an explicit tick", async () => {
  const soft = new SoftIf({ backend: fake() });
  try {
    await soft.decide("s", { q: noul("Q?") }, { name: "search", tick: 42 });
    const next = await soft.decide("s", { q: noul("Q?") }, { name: "search" });
    assert.ok(next.tick > 42);
    assert.equal(next.stale, false);
    assert.equal(soft.latest("search").id, next.id);
  } finally {
    await soft.close();
  }
});

test("async log sinks preserve decision, branch, outcome order", async () => {
  const events = [];
  const sink = {
    async decision() {
      await delay(20);
      events.push("decision");
    },
    branch() {
      events.push("branch");
    },
    outcome() {
      events.push("outcome");
    },
    policy() {},
  };
  const soft = new SoftIf({ backend: fake(), log: sink });
  const r = await soft.decide("s", { q: noul("Q?") });
  soft.when(r.q, "q");
  soft.outcome(r.id, { accepted: true });
  await soft.flush();
  assert.deepEqual(events, ["decision", "branch", "outcome"]);
  await soft.close();
});

test("close aborts and drains active requests before returning", async () => {
  const soft = new SoftIf({ backend: fake({ delayMs: 200 }) });
  const pending = soft.decide("s", { q: noul("Q?") });
  await soft.close();
  const result = await pending;
  assert.match(result.error, /closed/);
  assert.equal(soft.log.get(result.id).answers.q.fallback, true);
  await assert.rejects(soft.decide("s", { q: noul("Q?") }), /closed/);
});

test("policy patches retain branch defaults and reject null sections", () => {
  const policy = new Policy({
    branches: { q: { threshold: 0.8, timeoutMs: 50, fallback: true } },
  });
  policy.update({ branches: { q: { threshold: 0.9 } } });
  assert.deepEqual(policy.branch("q"), {
    threshold: 0.9,
    timeoutMs: 50,
    fallback: true,
  });
  assert.throws(() => policy.update({ bands: null }));
  assert.throws(() => policy.update({ branches: null }));
});

test("invalid later tier retains valid native answer, all-tier failures keep attempts", async () => {
  const { tiered } = await import("soft-if");
  const native = fake({
    name: "native",
    answers: {
      q: {
        type: "noul",
        p: 0.7,
        confidence: 0.7,
        probabilities: { true: 0.7, false: 0.3 },
      },
    },
  });
  const invalid = fake({
    name: "malformed",
    answers: {
      q: {
        type: "noul",
        p: 9,
        confidence: 1,
        probabilities: { true: 9, false: -8 },
      },
    },
  });
  const soft = new SoftIf({ backend: tiered([native, invalid]) });
  try {
    const result = await soft.decide("s", { q: noul("Q?") });
    assert.equal(result.q.p, 0.7);
    assert.equal(result.attempts.length, 2);
    assert.match(result.attempts[1].error, /finite|probabil/);
  } finally {
    await soft.close();
  }
  const failed = new SoftIf({
    backend: tiered([
      fake({ name: "first", error: "first error" }),
      fake({ name: "second", error: "second error" }),
    ]),
  });
  try {
    const result = await failed.decide("s", { q: noul("Q?") });
    assert.equal(result.q.fallback, true);
    assert.equal(result.attempts.length, 2);
    assert.match(result.attempts[0].error, /first error/);
    assert.match(result.attempts[1].error, /second error/);
  } finally {
    await failed.close();
  }
});

test("synchronous bridge fetch failure is retryable and flush cannot fake SSE open", async () => {
  const producer = new SoftIf({ backend: fake() });
  const r = await producer.decide("s", { q: noul("Q?") });
  const record = producer.log.get(r.id);
  await producer.close();
  let fail = true;
  const listeners = new Map();
  const bridge = createBrowserBridge({
    policy: new Policy(),
    eventSourceFactory: () => ({
      addEventListener: (type, fn) => listeners.set(type, fn),
      close() {},
    }),
    fetch: (url, init) => {
      if (init?.method === "POST") {
        if (fail) {
          fail = false;
          throw new Error("sync offline");
        }
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, count: 1 }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ policy: new Policy().snapshot() }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    },
  });
  try {
    await bridge.connect();
    assert.equal(bridge.status().state, "connecting");
    bridge.log.decision(record);
    await assert.rejects(bridge.flush(), /sync offline/);
    await bridge.flush();
    assert.equal(bridge.status().pending, 0);
    assert.notEqual(bridge.status().state, "connected");
    listeners.get("open")({});
    assert.equal(bridge.status().state, "connected");
  } finally {
    bridge.close();
  }
});

test("policy reset removes overrides, preserves defaults, and inherits later global bands", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "softif-policy-reset-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "policy.json");
  await writeFile(
    path,
    JSON.stringify({
      bands: { act: 0.85, confirm: 0.6 },
      branches: {
        "app.q": {
          threshold: 0.99,
          act: 0.92,
          confirm: 0.75,
          fallback: false,
          timeoutMs: 123,
        },
      },
    }),
  );
  const policy = Policy.fromFile(path, { watch: true, intervalMs: 15 });
  const log = new SQLiteLog(join(dir, "log.db"));
  const soft = new SoftIf({ backend: fake(), policy, log });
  const server = await startDebugger({ policy, log, port: 0 });
  const events = [];
  const unsubscribe = log.subscribe((event) => {
    if (event.type === "policy") events.push(event);
  });
  try {
    const result = await soft.decide("state", { q: noul("Question?") });
    assert.equal(soft.when(result.q, "app.q"), false);
    const response = await fetch(`${server.url}/policy/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "app.q" }),
    });
    assert.equal(response.status, 200);
    const snapshot = (await response.json()).policy;
    assert.deepEqual(snapshot.branches["app.q"], {
      fallback: false,
      timeoutMs: 123,
    });
    assert.deepEqual(snapshot.bands, { act: 0.85, confirm: 0.6 });
    assert.equal(soft.when(result.q, "app.q"), true);
    assert.deepEqual(
      JSON.parse(await readFile(path, "utf8")).branches["app.q"],
      { fallback: false, timeoutMs: 123 },
    );
    await delay(60);
    await soft.flush();
    assert.equal(
      log.policyChanges().length,
      1,
      "shared subscribers and file watch persist one reset",
    );
    assert.equal(events.length, 1, "one event reaches the SSE publisher");
    assert.deepEqual(log.snapshot().policy, snapshot);
    const global = await fetch(`${server.url}/policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bands: { act: 0.95 } }),
    });
    assert.equal(global.status, 200);
    assert.equal(policy.threshold("app.q"), 0.95);
    assert.equal(soft.when(result.q, "app.q"), false);
    await soft.flush();
    assert.equal(log.policyChanges().length, 2);
    for (const invalid of [
      {},
      { branch: "" },
      { branch: 42 },
      { branch: "app.q", threshold: 0.1 },
    ]) {
      const rejected = await fetch(`${server.url}/policy/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(invalid),
      });
      assert.equal(rejected.status, 400);
      assert.equal(typeof (await rejected.json()).error, "string");
    }
  } finally {
    unsubscribe();
    await server.close();
    await soft.close();
    policy.close();
    log.close();
  }
});

test("shared standalone SoftIf and debugger persist and broadcast each policy change exactly once", async () => {
  const policy = new Policy();
  const log = new SQLiteLog(":memory:");
  const soft = new SoftIf({ backend: fake(), policy, log });
  const server = await startDebugger({ policy, log, port: 0 });
  const events = [];
  const unsubscribe = log.subscribe((event) => {
    if (event.type === "policy") events.push(event);
  });
  try {
    const response = await fetch(`${server.url}/policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bands: { act: 0.9 } }),
    });
    assert.equal(response.status, 200);
    await soft.flush();
    assert.equal(log.policyChanges().length, 1);
    assert.equal(events.length, 1);
    policy.update({ bands: { confirm: 0.7 } });
    await soft.flush();
    assert.equal(log.policyChanges().length, 2);
    assert.equal(events.length, 2);
  } finally {
    unsubscribe();
    await server.close();
    await soft.close();
    log.close();
  }
});
