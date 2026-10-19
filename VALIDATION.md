# Validation

Implementation and available-environment validation are complete. This file separates measured results from checks that still need another service or real usage data.

## Environment

- Date: 2026-10-17.
- Node v26.11.1 and pnpm 9.15.0.
- The projects are independent Git repositories. No shared root package configuration is required.

## Integration decisions

- The package root is browser-safe. Node persistence, policy file watching, CLI, and the debugger server are available through `soft-if/node`.
- The launcher calls the decision backend directly from its webview. It sends logs and outcomes to the localhost debugger bridge, which owns SQLite, and receives policy updates from that bridge.
- The default bridge port is 7331. The launcher database is `~/.local/share/soft-launcher/soft-if.db`.
- Free-text Bonsai generation belongs to the launcher's Rust executor. The library's OpenAI emulation returns typed decisions only.
- The local model alias is `clef-flash-q8:latest`, configured for a 4,096-token context on the measured server. This replaces the upstream model name in operational examples.

## Service observations

A direct request using the recorded request in `test/fixtures/clef-flash-request.json` succeeded against `http://127.0.0.1:11434/v1/systemone`.

- `urgent.noul`: 0.9462759244930722.
- `team.choice`: `technical`, winning probability 0.9236691526347057, reported confidence 0.8855037289520584.
- `severity.score`: 2.791866416025877, reported confidence 0.7918664160258775.
- Usage: 352 input tokens, zero output tokens.

The native score is fractional and confidence is distinct from the largest probability. These fields must be preserved by parsing.

The Bonsai endpoint initially refused connections. The user subsequently started it and supplied verified runtime configuration. Live validation then succeeded as recorded below.

## Measured library performance

The built library completed 200 sequential local Ollama decisions at each question count. Each group used the same 1,200-character state and excluded one warmup request. These are repeated-state library timings, not launcher keystroke-to-render timings or a varied-state workload. No launcher benchmark ran concurrently.

| Questions | p50 | p95 | Input tokens including questions |
| --- | --- | --- | --- |
| 1 | 65.57 ms | 70.99 ms | 378 |
| 4 | 100.61 ms | 105.63 ms | 632 |
| 12 | 206.63 ms | 214.77 ms | 1,301 |

Raw samples and method are in `benchmark-local.json`. All 600 measured calls succeeded. The twelve-question result exceeds 200 ms before launcher debounce or rendering, so the launcher must measure its own actual question set before claiming its latency target.

A separate test wrote 1,000 fake decisions through SoftIf to a temporary on-disk SQLite database in 87.15 ms. A query returned all 1,000 records and the final distribution. This meets the plan's under-two-second target on this machine.

The independent consumer acceptance suite passed 32 tests after reconciling the replay error-array contract and using a raw HTTP request to test hostile Host headers. Coverage includes browser-only imports, bridge retries, HTTP/SSE persistence, policy reloads, stale races, emulated confidence safety, replay, and calibration.

## Live Bonsai validation

The library read the API key from an external file at runtime and sent
`chat_template_kwargs.enable_thinking=false` to a remote OpenAI-compatible
Bonsai endpoint using model `bonsai-2-27b`. The private endpoint address and key
file path are omitted; no credential is stored in the artifacts. New deployments
configure `BONSAI_URL` and `BONSAI_API_KEY_FILE`.

A mixed noul, choice, and score request passed parsing. It chose `open_file`, returned p=1 and score=2, and retained the emulated `confirm` cap. A separate fake confirm-band tier-one answer escalated to live Bonsai and persisted tier=2 and emulated=true in SQLite. This checks live second-tier transport and persistence; it is not a real Clef/Bonsai agreement measurement.

Ten sequential measured requests per count followed one warmup on the same 1,200-character state. The launcher reserved the Bonsai slot for this run. No Clef calls were made during it.

| Questions | p50 | p95 |
| --- | --- | --- |
| 1 | 260.86 ms | 266.82 ms |
| 4 | 602.89 ms | 605.98 ms |
| 12 | 1,562.50 ms | 1,567.55 ms |

With only ten samples, nearest-rank p95 is the maximum. These numbers describe a bounded smoke benchmark, not a stable production percentile. Raw samples are in `benchmark-bonsai.json`. Bonsai needs a longer deadline than the default 400 ms for multi-question escalation.

## Launcher and debugger integration

The launcher integration run reported successful real HTTP/SSE/SQLite/calibration integration: three decisions, two outcomes, one policy change, explicit confidence 0.94 distinct from probability mass 0.7, a live act-to-confirm change, and three queued records retained through a simulated HTTP 507 then flushed. No library contract failures remained.

Opus validated the debugger in a real browser against a fake decision loop using the actual server. A keyboard slider edit changed the confirm threshold to 0.3, recorded the change in SQLite, and changed the following branch from fallback/other to confirm/open_file. SSE updates, failed-save rollback, disconnect/reconnect, keyboard operation, and layouts at 1280 and 390 pixels passed. Regression tests now verify reset-to-global removes only threshold overrides, preserves fallback and timeout, persists to disk, and inherits later global bands. Shared observers persist and broadcast each policy change once. The final browser reset check passed against the real server. Reset removed the overrides and preserved fallback=false; raising global act to 0.87 then changed the inherited act and threshold sliders to 0.87. SQLite contained exactly one row each for edit, reset, and global change. The UI test server is stopped.

## Build and command checks

The lead reran the final `pnpm test`: 48 passed, zero failed, one gated live test skipped, 49 total. Both `pnpm example` and `node dist/examples/tiered.js` completed successfully with offline backends. `pnpm pack` produced a package containing browser and Node entries, declarations, CLI, examples, and the debugger HTML.

Offline CLI checks passed for `ask`, `replay`, `calib`, and `bench`. Replay of the three-answer fake decision reported three agreements out of three. Empty calibration data produced zero samples rather than invented outcomes.

The implementation agent separately enabled the gated native smoke and reported one pass out of one. A live CLI ask returned p=0.9622337560862066 with 153 input tokens. Its approximately 53 ms single-call latency is a functional observation, not another benchmark. These calls completed before the launcher took its benchmark slot; no further inference calls are planned here.

## Remaining deployment measurements

- Live remote Clef llama.cpp measurements require a supplied running endpoint. Bonsai emulation is verified separately above.
- Cross-backend agreement on 100 real launcher states and per-branch calibration once user outcomes exist. Synthetic fixtures cannot establish these metrics.

## Public source cleanup checks, 2026-10-19

On Node v26.11.1 and pnpm 9.15.0, `SOFTIF_LIVE=0 pnpm test` passed
50 tests with zero failures and one gated live test skipped, 51 total. New offline
tests cover CLI environment/profile/flag precedence, key-file authentication, and
invocation through a package-manager symlink. The installed CLI entrypoint now
resolves that symlink before deciding whether to run.

A temporary source copy without `node_modules` or `dist` passed frozen-lockfile
installation, build, both offline examples, and `pnpm pack`. Independent consumers
installed both a sibling `file:../soft-if` dependency and the packed tarball.
Both passed browser/Node imports, a fake decision with SQLite persistence, and
installed CLI calls whose JSON answer was checked. The tarball contained 76
entries, including declarations, CLI, and debugger HTML, and passed the private
path/address string check. Current source passed the private-detail scan and
`git diff --check`. Both benchmark JSON files remain byte-for-byte unchanged.

No live inference ran during this cleanup. The GitHub Actions workflow has been
added; its commands passed locally, but the hosted workflow has not run yet.
No license has been selected or added. History review and publication are separate
from these current-source checks.
