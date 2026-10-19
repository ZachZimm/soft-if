# soft-if

Typed model decisions for TypeScript. Ask a binary question, choose an option, or
score a rubric. Apply named policy thresholds, keep the distributions in SQLite,
and replay decisions against another backend.

The package has no runtime dependencies. The root entry works in browsers.
`soft-if/node` adds SQLite, file policies, the HTTP debugger, and replay.
Node 26 and pnpm 9 are required for development and Node tools.

## Install and run

```bash
git clone https://github.com/ZachZimm/soft-if.git
cd soft-if
pnpm install --frozen-lockfile
pnpm build
pnpm softif ask --backend fake --state 'Find budget.pdf' \
  --noul 'local=Is the user searching for a local file?' \
  --choice 'action=file:Local file,web:Web search,other:Neither'
pnpm example
pnpm test
```

The commands above use offline fake backends. For a running Ollama server with
System One support, omit `--backend fake`. The default endpoint is
`http://127.0.0.1:11434/v1/systemone` and the default model is
`clef-flash-q8:latest`. This is a deployment-specific alias, so pass `--model`
with a model installed on your server. For llama.cpp, use `--backend llamacpp`
and optionally `--url http://localhost:8080`.

The build emits ESM JavaScript, declarations, and source maps into `dist/`.
Build before installing this package into another project. With `soft-launcher`
cloned alongside `soft-if`, run this in the launcher directory:

```bash
pnpm add 'soft-if@file:../soft-if'
```

Its `package.json` dependency should read `"soft-if": "file:../soft-if"`.
The same layout works for another consumer. Both repositories can remain
independent; no parent workspace configuration is needed. Rebuild `soft-if` and
refresh the consumer's file dependency after library changes. In a shared pnpm
workspace, `"soft-if": "workspace:*"` is also supported.

To create a tarball for a separate consumer, run `pnpm pack`, then install the
resulting `.tgz` file there. Packing builds the package first.

## Browser core

```ts
import { SoftIf, Policy, ollama, noul, choice, score } from "soft-if";

const policy = new Policy({
  bands: { act: 0.85, confirm: 0.6 },
  branches: {
    "launcher.file": { threshold: 0.8, timeoutMs: 400, fallback: false },
    "launcher.action": { fallback: "other" },
  },
});
const soft = new SoftIf({ backend: ollama(), policy, defaultTimeoutMs: 400 });
const result = await soft.decide(
  "Find the quarterly budget document",
  {
    action: choice("What does the user want?", {
      open_file: "A local file",
      web_search: "Information online",
      other: "Neither",
    }),
    file: noul("Is this a local file search?"),
    urgency: score("How urgent?", ["later", "soon", "now"]),
  },
  {
    name: "launcher.keystroke",
    tick: 42,
    branches: { file: "launcher.file", action: "launcher.action" },
  },
);

if (soft.when(result.file, "launcher.file")) {
  // Search the local index.
}
const action = soft.pick(result.action, "launcher.action");
soft.outcome(result.id, {
  accepted: true,
  key: "action",
  branch: "launcher.action",
  chosen: action,
});
await soft.flush();
```

Builders produce the native System One wire shape with `instructions` and
`criteria`. Choice keys remain typed in the answer. Noul exposes `p`, choice exposes
`choice`, and score exposes `score`. Native score is a fractional expected level,
not an integer. Native explicit confidence is preserved; it can differ from the
largest probability. Noul confidence defaults to `max(p, 1-p)`.

`soft.band(answer, branch?)` returns `act`, `confirm`, or `fallback` using confidence.
`when` compares noul `p` to the branch threshold and uses a configured boolean
default on failure or fallback band. `pick` uses a valid configured fallback choice
or returns `undefined` in the fallback band. Confirm-band choices are returned so
the app can request confirmation. Always inspect the band before taking actions
that require act confidence. An emulated noul cannot activate `when` without
`allowEmulated: true`; emulated answers can never get act band by default.

`decide` returns the answers alongside `id`, timestamps, backend, tier, attempts,
latency, `error`, and `stale`. Network errors, malformed replies, cancellation, and
timeouts return fallback answers with an error. Invalid input and token-budget
violations reject before sending a request. Pass `signal` to cancel immediately.
Explicit request `timeoutMs` wins; otherwise the minimum mapped branch timeout
wins, then the instance default. Branch names default to `${name}.${questionKey}`
or the bare question key. Explicit mappings keep policy names stable across calls.

Every named request records its tick at start. `latest(name)` returns undefined
while a newer tick is pending. A late completion is marked stale and remains in the
log. Apps should also guard their own rendering against stale results.

The prompt token estimate uses characters divided by four, including questions and
128 tokens of framing. It is an estimate, not a tokenizer. Oversized input is
refused by default. `stateOverflow: 'truncate'` explicitly permits state truncation;
question text is never truncated. Image strings pass through to native backends;
base64 encoding and image-token accounting belong to the caller.

## Node policies, logging, and debugger

```ts
import { SoftIf, Policy, ollama } from "soft-if/node";

const policy = Policy.fromFile("./examples/policy.json", { watch: true });
const soft = new SoftIf({
  backend: ollama(),
  policy,
  log: { sqlite: "./soft-if.db", ring: 2000 },
  debugger: { port: 7331 },
});
await soft.ready();
// Use decide / when / pick / outcome here.
await soft.close();
policy.close();
```

File reloads retain the last valid policy and report malformed updates through
`policy.onError`. Valid `update` and `replace` calls atomically write JSON back to
the source file. Watch reloads do not create duplicate policy events. Bands and
branches merge on `update`; `replace` replaces the whole policy.

SQLite stores requests, answers, full probability distributions, outcomes, policy
changes, and explicit branch calls. Requests include state and question text. Set
`logStateMaxChars` to limit retained state; replay then uses only that retained
text. Logs may contain sensitive application data, so choose the database location
accordingly. The default ring holds 2000 events. `SQLiteLog` exposes `get`,
`decisions`, `branches`, `outcomes`, `policyChanges`, `snapshot`, and `subscribe`.
Time-range queries accept epoch milliseconds and an optional limit, default 100000.
SQLite enables WAL and foreign keys. Batch ingestion commits before broadcasting.
Retries do not insert duplicate requests or branch records.

Log writes do not change the model answer. Register `soft.onError` and await
`soft.flush()` to observe failed persistence. `soft.close()` flushes and closes
resources it owns. A caller-supplied SQLiteLog and Policy remain caller-owned.

```bash
pnpm softif debug --db ./soft-if.db --policy ./examples/policy.json --demo
```

Open `http://localhost:7331`. `--demo` emits fake decisions without contacting a
model. Policy edits persist in the JSON file when `--policy` is given. Otherwise
the debugger restores the latest SQLite policy. The service binds to loopback;
it accepts bounded local Vite/Tauri origins, limits JSON bodies to 1 MiB, and caps
SSE clients and snapshot size. Exact endpoints and payloads are in [CONTRACT.md](./CONTRACT.md).

## Browser logging bridge

```ts
import { createBrowserBridge, Policy, SoftIf, ollama, noul } from "soft-if";

const policy = new Policy();
const bridge = createBrowserBridge({ policy }); // http://localhost:7331
bridge.onError((error) => console.error("Debugger connection:", error));
bridge.onStatus((status) => console.log(status));
await bridge.connect();
const soft = new SoftIf({ backend: ollama(), policy, log: bridge.log });
const r = await soft.decide("Find budget.pdf", { file: noul("Local file?") });
soft.when(r.file, "launcher.file");
soft.outcome(r.id, { accepted: true });
await soft.flush();
await bridge.flush();
bridge.close();
await soft.close();
```

The browser calls the model directly. The bridge only sends logs and receives
policy updates. It uses native EventSource, with an injectable factory for other
runtimes. Connect fetches the current policy, then opens SSE. Status stays
`connecting` until SSE opens. `flush` sends queued events; failed posts reject and
retain the queue for retry. The queue is bounded and overflow is observable. Flush
before closing. The model server must separately allow the browser origin.

## Backends and escalation

`ollama`, `llamacpp`, and `systemone` share one validated native response parser.
`llamacpp` defaults to `http://127.0.0.1:8080`, with no invented model name.
`openaiEmulated` uses chat completions with strict JSON schema, validates every
answer, and marks synthetic distributions `emulated: true`. It provides typed
decisions only. There is no text-generation API; launcher Rust code owns free-text
Bonsai generation.

```ts
import { tiered, ollama, openaiEmulated, Policy } from "soft-if/node";
const policy = new Policy();
const backend = tiered(
  [
    ollama(),
    openaiEmulated({
      url: process.env.BONSAI_URL ?? "http://localhost:9090/v1",
      model: process.env.BONSAI_MODEL ?? "bonsai-2-27b",
      apiKeyFile: process.env.BONSAI_API_KEY_FILE,
      thinking: false,
    }),
  ],
  { policy, escalateBelow: "confirm", tierTimeoutMs: 5000 },
);
```

Set `BONSAI_URL` to the OpenAI-compatible base URL, including `/v1`, and
`BONSAI_API_KEY_FILE` to a key file outside the checkout if authentication is
required. The example defaults to `http://localhost:9090/v1`; it does not start a
server. `BONSAI_MODEL` overrides the model. `examples/tiered.ts` uses fake backends
unless `SOFTIF_LIVE=1` is set.

The CLI accepts the same environment variables for `--backend bonsai` or
`--backend openai`. `--url`, `--model`, and `--api-key-file` override their
respective environment settings. It also accepts `OPENAI_API_KEY`, which takes
precedence over a key file. Named backend profile URL/model values override the
environment and are overridden by explicit flags. Keep credentials out of tracked
profiles.

Use the same policy in `tiered` and `SoftIf`. Confirm or fallback answers trigger
escalation. Every attempt records backend, tier, latency, and any error. If a later
tier fails or the deadline expires, the last usable answer is retained and the
failed attempt is logged. The overall SoftIf deadline includes all tiers.
`apiKeyFile` is available only from `soft-if/node`; browser callers supply `apiKey`
when appropriate. Credentials are never logged by the library.

One-hot emulation distributions do not measure calibration. They stay capped at
confirm unless the application opts in. Thresholds do not transfer reliably
between models, quantizations, prompts, or backends. Measure acceptance and tune
each deployment. Input-injection screening is outside v1; state is untrusted data,
and policy confidence is not an authorization boundary.

## Replay and calibration

```bash
pnpm softif replay --db ./soft-if.db --from 0 --backend ollama
pnpm softif replay --db ./soft-if.db --from 2026-10-17T00:00:00Z \
  --backend llamacpp --url http://localhost:8080
pnpm softif calib --db ./soft-if.db --branch launcher.action --json
```

`replay(records, backend, { policy, branches, timeoutMs })` compares saved branch
values with new decisions. Without branch records it compares noul truth under
the supplied policy, choice keys, and rounded score levels. It returns agreement,
flips, and an errors array, without mutating original evidence. The CLI supports
named backend JSON profiles through `--backend-config`; remote endpoints must be
specified explicitly. The legacy `lab-clef27b` CLI alias still requires `--url`,
`SOFTIF_LAB_URL`, or a backend profile.

`calibrate(decisions, outcomes, branches, { branch, bins })` returns reliability
bins and expected calibration error, weighted by sample count. Outcomes need
boolean `accepted`; use `key` and `branch` to disambiguate multiple questions.
Missing, ambiguous, stale, and fallback samples are skipped. Acceptance measures
user acceptance of the prediction, not an independently verified label.

## Tests and measurements

```bash
pnpm test
SOFTIF_LIVE=1 node --test test/regression.test.mjs
pnpm bench --backend ollama --count 200 --question-counts 1,4,12
pnpm bench --backend llamacpp --url http://localhost:8080
```

The default suite is offline. It covers recorded Clef wire data, local HTTP test
servers, emulation schemas, timeout recovery, file reload/persistence, real SSE,
SQLite, stale races, CLI commands, replay, and canned calibration. The live smoke
test requires `SOFTIF_LIVE=1`, checks server/model availability, and skips when
unavailable. It does not invent results for absent backends.

Bench runs sequential requests against a repeated 1200-character state after
warmup, reporting p50/p95 library latency for each question count and tier. Failures
are counted and excluded from latency percentiles. This is not a keystroke-to-render
benchmark. See [VALIDATION.md](./VALIDATION.md) for measured results
and deployment limitations.

## License

No license has been selected. No license grant is included with this repository.
Third-party dependencies keep their own licenses.
