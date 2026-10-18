# soft-if v1 contract

This is the integration contract for the launcher, debugger page, and Node service.
The package root is browser safe. `soft-if/node` adds filesystem, SQLite, and HTTP.
No free-text generation API is provided. Rust owns launcher free-text Bonsai calls.

## Core API

```ts
import {
  SoftIf,
  Policy,
  noul,
  choice,
  score,
  ollama,
  createBrowserBridge,
} from "soft-if";
const policy = new Policy({
  bands: { act: 0.85, confirm: 0.6 },
  branches: {
    "launcher.file": { threshold: 0.8, fallback: false },
  },
});
const bridge = createBrowserBridge({ url: "http://localhost:7331", policy });
await bridge.connect();
const soft = new SoftIf({
  backend: ollama({
    url: "http://127.0.0.1:11434",
    model: "clef-flash-q8:latest",
  }),
  policy,
  log: bridge.log,
  defaultTimeoutMs: 400,
});
const r = await soft.decide(
  "state",
  { file: noul("Looking for a local file?") },
  { name: "launcher.keystroke", tick: 42 },
);
soft.when(r.file, "launcher.file");
soft.outcome(r.id, { accepted: true, chosen: "file" });
await bridge.flush();
bridge.close();
```

Question builders emit native `{type,instructions,criteria?}`. Choice criteria is a
record, score criteria is an array with 2..10 labels. Noul answers expose `p`,
choice answers `choice`, score answers `score` (fractional native expectation).
Every answer has `type`, `confidence`, `probabilities`, `emulated?`, `fallback?`.
Native explicit confidence is preserved. Noul confidence is `max(p,1-p)`.
`decide` returns `{id,ts,name?,tick?,stale,error?,backend,tier,emulated,latency_ms,
usage?,attempts, ...answers}`. Reserved metadata names cannot be question keys.
`soft.latest(name)` returns only the newest completed nonstale decision, or undefined
while a newer tick is pending. `when` returns boolean, `pick` returns choice key or
undefined in the fallback band, `band(answer, branch?)` returns act/confirm/fallback.
Emulated answers are capped at confirm unless policy `allowEmulated: true`.

Policy JSON: `{bands?:{act:number,confirm:number},branches?:Record<string,
{threshold?:number,act?:number,confirm?:number,fallback?:boolean|string|number}>,
allowEmulated?:boolean}`. `policy.update(partial)` merges branches and bands;
`policy.replace(full)` replaces all settings. `policy.snapshot()` returns full data;
`policy.subscribe(change=>...)` returns unsubscribe. Change is
`{ts,branch,before,after,policy}` with branch `'*'` for a global update.
Node `Policy.fromFile(path,{watch:true})` is synchronous; `policy.close()` stops watch.
Invalid reloads keep last good data and notify `policy.onError(listener)`.

## Log records and HTTP/SSE

`DecisionRecord = {id,ts,name?,tick?,backend,tier,emulated,latency_ms,state:string,
questions:Record<string,Question>,answers:Record<string,Answer>,stale:boolean,
error?:string,usage?,attempts:TierAttempt[]}`.
`TierAttempt = {backend,tier,latency_ms,error?:string}`. Tier numbers start at 1.
`BranchRecord = {request_id,key,branch,band,ts,value:boolean|string|number|null}`.
`OutcomeRecord = {request_id,ts,payload:Record<string,unknown>}`.
`LogEvent` is `{type:'decision',data:DecisionRecord}` or
`{type:'branch',data:BranchRecord}` or `{type:'outcome',data:OutcomeRecord}` or
`{type:'policy',data:PolicyChange}`.
`LogSink` methods: `decision(record)`, `branch(record)`, `outcome(record)`,
`policy(change)`; synchronous or promise-returning. Core exposes logging errors via
`soft.onError(listener)`; `await soft.flush()` observes queued writes.

All endpoints use JSON except HTML and SSE. Errors are `{error:string}`.

- `GET /` serves the Opus-owned page.
- `GET /health` -> `{ok:true,version:1}`.
- `GET /snapshot?limit=200` -> `{policy,decisions:DecisionRecord[],branches:BranchRecord[],outcomes:OutcomeRecord[]}`. Arrays are oldest first, bounded to 2000.
- `GET /events` -> SSE, named events `decision`, `branch`, `outcome`, `policy`;
  each `data:` is the corresponding record, not an envelope. First event is named
  `snapshot` with the same object as `/snapshot`. Heartbeats are SSE comments.
- `POST /policy` accepts the partial policy JSON above; returns `{policy}`. Changes
  persist in SQLite `policy_changes`, update server policy, and broadcast `policy`.
- `POST /policy/reset` accepts exactly `{branch:string}` and returns `{policy}`.
  It removes `threshold`, `act`, and `confirm` overrides from the named branch,
  preserving `fallback`, `timeoutMs`, and all other policy settings. The branch
  inherits global bands afterward, including subsequent global edits. It uses
  `Policy.replace` and persists/broadcasts the normal `policy` change event. A
  missing/invalid branch field returns HTTP 400 `{error:string}`. An unknown branch
  leaves values unchanged and records a normal replacement event.
- `POST /events` accepts `{events:LogEvent[]}` (1..100) from browser clients;
  persists each decision/branch/outcome/policy in order then broadcasts each.
  Returns `{ok:true,count:number}`. Browser policy events are rejected: use /policy.

Server defaults `127.0.0.1:7331`, accepts only loopback Host and Origin; no-Origin
Node tools are allowed. Allowed browser origins are http(s) localhost/127.0.0.1/
[::1] on ports 1420, 5173..5183, 7331, plus `tauri://localhost` and
`http://tauri.localhost`. Explicit `allowedOrigins` supports additional exact origins.
JSON body limit defaults 1 MiB. Batch and snapshot limits are bounded.

`createBrowserBridge({url?,policy,fetch?,eventSourceFactory?,maxQueue?})` returns
`{log,connect():Promise<void>,flush():Promise<void>,close():void,
status():{state:'idle'|'connecting'|'connected'|'error'|'closed',pending:number,error?:string},
onError(listener):()=>void,onStatus(listener):()=>void}`.
Default URL is http://localhost:7331. Connect loads policy from `/snapshot` then
opens SSE; policy/snapshot events update the passed Policy. Failed POSTs preserve
queued logs for retry; flush rejects and status/error listeners fire. Queue overflow
throws and reports an error. There is no silent loss. `close` closes SSE; flush
before closing to drain logs. Connections use native EventSource or injected factory.
Browser model calls remain direct, never proxied through the debugger server.

## Node convenience

`import { SoftIf, Policy, SQLiteLog, startDebugger, openaiEmulated } from 'soft-if/node'`.
Node SoftIf accepts core options plus `log:{sqlite:string,ring?:number}` and
`debugger:{port?:number}`. `await soft.ready()` waits for its debugger, `await
soft.close()` closes owned resources. Alternatively `startDebugger({policy,log,
port?,host?,allowedOrigins?,maxBodyBytes?})` returns a promise of
`{url,port,close():Promise<void>}`. `SQLiteLog` implements LogSink and exposes
`decisions({from?,to?,limit?})`, `get(id)`, `branches({from?,to?,branch?})`,
`outcomes()`, `policyChanges()`, `snapshot(limit?)`, `subscribe(listener)`, `close()`.
Node openaiEmulated additionally accepts apiKeyFile and expands ~/.

## Browser SSE factory and analysis

`eventSourceFactory(url)` returns an object with `addEventListener(type, listener)`,
optional `removeEventListener(type, listener)`, and `close()`. It emits `open`,
`error`, `policy`, and `snapshot`. Data events have `.data` containing a JSON string.
The bridge attaches listeners through `addEventListener`, not `.onopen/.onerror`.

Node exports `replay(records, backend, {policy?,branches?,timeoutMs?})` ->
`Promise<{total,comparisons,agreements,agreementRate,flips,errors}>`.
`records` is `DecisionRecord[]`; optional `branches` is `BranchRecord[]` from the
same log. `flips` is `{request_id,key,branch?,before,after}[]`; comparisons count
noul boolean, choice key, and rounded score level, or saved branch values when
branches are supplied. Failures increment `errors` and remain in report.
Node and browser export `calibrate(decisions, outcomes, branches?, {branch?,bins?})`
-> `{count,ece,bins:[{lower,upper,count,confidence,accuracy}],branches:Record<string,
{count,ece,bins}>}`. Outcomes require boolean `payload.accepted`; optional
`payload.branch` and `payload.key` select the answer. Without a selector, linked
branch events select answers; with no branch events only a one-answer decision is
unambiguous. Missing/ambiguous outcomes are skipped. `calibration` aliases `calibrate`.

Branch policy also accepts `timeoutMs` (1..300000). `decide` accepts `signal`,
`timeoutMs`, `images`, and `branches:Record<questionKey,branchName>`. Explicit
`timeoutMs` wins; otherwise the minimum configured timeout of applicable branches
wins; otherwise the SoftIf default (400ms). Without an explicit mapping, policy
branch lookup uses `${name}.${questionKey}` or just the question key without name.
The backend receives cancellation immediately. Tiered backends may return their
retained first-tier answer after escalation cancellation; its failed attempt stays
in `attempts`. A backend ignoring abort cannot keep the decision pending.
Bridge `connect` resolves after snapshot and SSE construction; `status().state`
remains `connecting` until the SSE `open` event. Replay `errors` is an array of
`{request_id,error}`. Optional answer fields `band` and `branch` save the policy
resolution at decision time; branch records save later explicit when/pick calls.

Node `Policy.fromFile` persists valid `update`/`replace` edits by atomically renaming
JSON beside the original file. File watch reloads do not rewrite the file or emit
feedback duplicates. Invalid edits leave both file and active policy unchanged.
Explicit policy files win at CLI startup; without `--policy`, `softif debug` loads
the last SQLite policy. SQLite snapshot restores its last persisted policy on reopen.

`Policy.update` merges each named branch's settings, retaining existing fallback
and timeout when a slider changes only threshold. Use `replace` to remove settings.
Async log sinks receive records in invocation order. `soft.close()` aborts and
waits for active decisions, then flushes logs before owned Node resources close.
All-tier failures retain each attempt, and malformed later-tier answers cannot
replace a valid earlier answer.

Sharing the same Policy and SQLiteLog between a standalone SoftIf and
startDebugger requires no subscription options. SQLiteLog deduplicates repeated
observations of the same PolicyChange object after commit, emitting one persisted
change and one log/SSE event. Separate policy updates remain separate events.
