# soft-if — implementation plan

Status: plan only, nothing implemented. Written 17 Oct 2026.
Sibling consumer: `../soft-launcher`.

## 1. Goal

A small TypeScript library that makes a decision model a first-class control-flow
primitive: `if` becomes a noul with a threshold, `switch` becomes a choice, a graded
rubric becomes a score. Every soft branch is logged with its full distribution, can be
replayed against a different backend, and can be watched live in a browser with the
thresholds exposed as dials. It is the substrate the launcher and later experiments
(Living Board, Paperless Reflex, Lab Nervous System) are built on, so it must stay
thin, dependency-light and boring to embed.

## 2. Non-goals

- Not an agent framework. No tool calling, no planning, no prompt templates beyond
  what a typed question needs.
- Not a model server. It only talks to servers that already exist (Ollama, llama.cpp,
  Kev, Strands, an OpenAI-compatible LLM endpoint).
- No Python port in v1. The wire format is trivial; a port can come later if a
  Python-first experiment needs it.
- No UI beyond the debugger page.

## 3. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| Language / runtime | TypeScript on Node 26 (present on the development host), ESM only | Shared with the launcher's web frontend; no Bun installed |
| Package manager | pnpm 9 (present) | Workspace linking to `soft-launcher` without publishing |
| Persistence | `node:sqlite` (built into Node 22.5+) | Zero native deps; the launcher reads the same file |
| Debugger transport | `node:http` + Server-Sent Events for live data, `fetch` POST for edits | No `ws` dependency; one-way push is all the page needs |
| Tests | `node --test` + `node:assert` | Built in |
| Build | `tsc` to `dist/`, `exports` map, no bundler | Library, not an app |
| Config format | JSON for policies and rubrics (TOML optional later via a tiny parser) | `JSON.parse` is free; the launcher's TOML catalogue is its own concern |
| Primary backend for development | Ollama System One on the development host: `http://127.0.0.1:11434/v1/systemone`, model `clef-flash:9b-q8_0` (see `../clef-flash-server`) | Already being provisioned on this machine; 4,096-token context by default |
| Secondary backend | llama.cpp `/v1/systemone` on lab once a stock build with the `clef` architecture is running | Same wire shape; different host |
| LLM fallback backend | Bonsai-2 27B on lab, OpenAI-compatible chat at `http://127.0.0.1:9090/v1` with `response_format: json_schema`, key from `~/.config/soft-if/api-key.txt` | Tier 1.5 for the medium confidence band |

## 4. Public API (target shape)

```ts
import { SoftIf, noul, choice, score, ollama, openaiEmulated, tiered, Policy } from "soft-if";

const s1 = ollama({ url: "http://127.0.0.1:11434", model: "clef-flash:9b-q8_0" });
const s15 = openaiEmulated({ url: "http://127.0.0.1:9090/v1", model: "bonsai-2-27b", apiKeyFile: "~/.config/soft-if/api-key.txt", thinking: false });

const policy = Policy.fromFile("./policy.json", { watch: true }); // bands + per-branch overrides, hot reload

const soft = new SoftIf({
  backend: tiered([s1, s15], { escalateBelow: "confirm" }),
  policy,
  log: { sqlite: "./soft-if.db", ring: 2000 },
  debugger: { port: 7331 },            // optional
  defaultTimeoutMs: 400,
});

// One request, many questions (speculative fan-out). `tick` tags the request.
const r = await soft.decide(state, {
  action: choice("What does the user want?", { open_file: "...", web_search: "...", other: "none of these" }),
  is_file_search: noul("Is the user looking for a file on disk?"),
  urgency: score("How urgent?", ["not", "soon", "now"]),
}, { tick: 42, name: "launcher.keystroke" });

// Typed answers
r.action.choice; r.action.confidence; r.action.probabilities;
r.is_file_search.p;                     // 0..1
r.urgency.score; r.urgency.probabilities;

// Soft control flow with policy-resolved thresholds
if (soft.when(r.is_file_search, "launcher.is_file_search")) { ... }   // band lookup -> boolean + logged branch
switch (soft.pick(r.action, "launcher.action")) { case "open_file": ... }
soft.band(r.action)                     // "act" | "confirm" | "fallback"

// Outcome feedback for calibration (joins on request id)
soft.outcome(r.id, { chosen: "open_file", accepted: true });

// Staleness
const latest = soft.latest("launcher.keystroke");   // helper that drops answers older than the newest tick
```

Backends implement one interface:

```ts
interface Backend {
  name: string;
  decide(req: WireRequest, opts: { signal: AbortSignal }): Promise<WireResponse>;
  capabilities(): { images: boolean; maxStateTokens?: number };
}
```

`WireRequest` is exactly the System One body (`model`, `state`, `questions`, optional
`images`). `WireResponse` is the `answers` map plus `usage` and `latency_ms`. The
`openaiEmulated` backend converts questions to a strict JSON schema with enums for
choice, integer level for score and a 0..1 number for noul, then normalises the reply
into the same `answers` shape with a synthetic distribution (one-hot for choice and
score, the number as-is for noul) and `emulated: true` so the log can tell them apart.

## 5. Modules

```
src/
  types.ts        question/answer/wire types, Zod-free hand validation
  questions.ts    noul(), choice(), score() builders with limits (255 options, 2..10 levels)
  backends/
    ollama.ts     POST /v1/systemone (Ollama requires `model` in body)
    llamacpp.ts   POST /v1/systemone (no model field required; same parsing)
    systemone.ts  shared parser; also covers Kev, Strands, TypeSafe-compatible servers
    openai.ts     chat + json_schema emulation
    tiered.ts     ordered backends, escalate on band, record which tier answered
    fake.ts       deterministic backend for tests and offline UI work
  policy.ts       bands {act, confirm, fallback}, per-branch overrides, file watch
  softif.ts       SoftIf class: decide / when / pick / band / outcome / latest
  ticks.ts        monotonic tick source + stale-drop bookkeeping
  log/
    ring.ts       in-memory ring buffer
    sqlite.ts     schema + writer + query helpers
  replay.ts       re-run logged requests against another backend, diff branches
  calibration.ts  reliability bins, ECE, per-branch acceptance vs confidence
  debugger/
    server.ts     http + SSE + POST /policy
    page.html     single-file UI (no build step)
  cli.ts          `softif ask`, `softif replay`, `softif calib`, `softif debug`
```

## 6. SQLite schema (v1)

```sql
CREATE TABLE requests(
  id TEXT PRIMARY KEY, ts INTEGER, name TEXT, tick INTEGER,
  backend TEXT, tier INTEGER, emulated INTEGER, latency_ms REAL,
  state TEXT, questions TEXT,           -- JSON, state may be truncated by config
  stale INTEGER DEFAULT 0, error TEXT
);
CREATE TABLE answers(
  request_id TEXT, key TEXT, type TEXT,
  choice TEXT, score REAL, p REAL, confidence REAL,
  probabilities TEXT,                   -- JSON
  band TEXT, branch TEXT,               -- resolved by policy at decision time
  PRIMARY KEY(request_id, key)
);
CREATE TABLE outcomes(
  request_id TEXT PRIMARY KEY, ts INTEGER, payload TEXT  -- JSON, app-defined
);
CREATE TABLE policy_changes(ts INTEGER, branch TEXT, before TEXT, after TEXT);
```

## 7. Milestones and acceptance criteria

M0 — Scaffold and first decision (half a day)
- pnpm project, tsconfig (NodeNext, strict), `node --test` wired, `dist/` build.
- `questions.ts`, `types.ts`, `backends/ollama.ts`, `cli.ts ask`.
- Accept: `pnpm softif ask --state "..." --noul "q=..." --choice "k=a:desc,b:desc"` prints
  answers from the local Clef-flash server; a unit test parses a recorded response.

M1 — Control flow and policy (one day)
- `SoftIf.decide/when/pick/band`, `policy.ts` with hot reload, `ticks.ts`, timeouts
  with per-branch defaults, `fake.ts` backend.
- Accept: a test program with three soft branches runs against the fake backend;
  changing `policy.json` on disk flips a branch without restart; a request that
  exceeds its timeout returns the configured fallback and is marked `error`.

M2 — Logging and outcomes (half a day)
- Ring buffer, `node:sqlite` writer, `outcome()`, `latest()` stale-drop.
- Accept: 1,000 decisions against the fake backend write in under 2 s; a query
  returns the distribution for any request id; stale answers are flagged, not dropped
  from the log.

M3 — Tiers (one day)
- `openai.ts` emulation against Bonsai, `tiered.ts` escalation, `llamacpp.ts`.
- Accept: a confirm-band answer from Clef triggers one Bonsai call; the log records
  tier 2 and `emulated=1`; if Bonsai is unreachable the tier-1 answer is used and the
  error is logged. Measure and record p50/p95 per tier in `VALIDATION.md`.

M4 — Debugger (one day)
- SSE stream of decisions, a page showing each named branch as a node with its live
  distribution bar, the current band, sliders that POST policy changes, and a
  rolling latency sparkline per backend.
- Accept: run the M1 demo, open `localhost:7331`, drag a threshold, see the branch
  flip on the next tick, and see the change recorded in `policy_changes`.

M5 — Replay and calibration (one day)
- `replay.ts`: re-run a time range of logged requests against another backend,
  report branch flips and agreement rate. `calibration.ts`: reliability bins and ECE
  per branch from `outcomes`.
- Accept: `softif replay --from <ts> --backend lab-clef27b` prints a flip table;
  `softif calib --branch launcher.action` prints bins; both have tests on canned data.

M6 — Docs and examples (half a day)
- README with the API above, `examples/keystroke-loop.ts`, `examples/tiered.ts`,
  a note on threshold non-transfer between models.
- Accept: a new consumer can add soft-if as a workspace dependency and run an example
  in under ten minutes.

## 8. Testing strategy

- Unit tests use `fake.ts` and recorded JSON fixtures from the real servers.
- Integration tests are gated by `SOFTIF_LIVE=1` and skip when the server is down.
- A `bench` script measures keystroke-loop latency: 200 sequential decisions with a
  ~300-token state, reporting p50/p95 for Ollama on the development host and llama.cpp on lab.

## 9. Metrics to record in VALIDATION.md

- Per-backend p50/p95 latency for 1, 4 and 12 questions on the same state.
- Agreement rate between Clef-flash and Bonsai emulation on 100 logged launcher states.
- ECE per branch once outcomes exist (from the launcher).

## 10. Risks

- Ollama's default 4,096-token context truncates long states silently; the library
  must estimate tokens (chars/4 heuristic) and refuse or truncate explicitly.
- The System One schema differs slightly between servers (Ollama needs `model`;
  llama.cpp may name latency differently). Keep one parser with tolerant field access
  and record the raw body on parse failure.
- Emulated distributions are one-hot, so bands computed from them are meaningless;
  the policy must treat `emulated` answers as "confirm" unless the app opts in.
- `node:sqlite` is still marked experimental in some Node lines; pin Node 26 in
  `engines` and keep the writer behind an interface so `better-sqlite3` can replace it.

## 11. Open questions (decide at M1)

- Does `when()` take a branch name explicitly, or infer it from a call-site stack?
  Explicit is boring and reliable; start there.
- Should `decide()` auto-screen untrusted state with an injection noul? Probably an
  opt-in `screen: true` that prepends the question and refuses on a high score.
- Images: pass-through only in v1 (`images: string[]` base64), no encoding helpers.
