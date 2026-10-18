import {
  SoftIf,
  Policy,
  fake,
  ollama,
  noul,
  choice,
  score,
} from "soft-if/node";
const live = process.env.SOFTIF_LIVE === "1";
const policy = new Policy({
  bands: { act: 0.85, confirm: 0.6 },
  branches: {
    "launcher.file": { threshold: 0.8, fallback: false },
    "launcher.action": { fallback: "other" },
  },
});
const soft = new SoftIf({
  backend: live ? ollama() : fake(),
  policy,
  log: { sqlite: process.env.SOFTIF_DB ?? ":memory:", ring: 2000 },
  debugger: process.env.SOFTIF_DEBUG === "1" ? { port: 7331 } : undefined,
  defaultTimeoutMs: live ? 30_000 : 400,
});
try {
  await soft.ready();
  for (const [tick, input] of ["b", "bu", "budget"].entries()) {
    const r = await soft.decide(
      { input, available: ["budget-2026.pdf", "meeting-notes.md"] },
      {
        action: choice("What does the user want?", {
          open_file: "A local file",
          web_search: "Information on the web",
          other: "Neither",
        }),
        file: noul("Looking for a local file?"),
        urgency: score("How urgent?", ["later", "soon", "now"]),
      },
      {
        name: "launcher.keystroke",
        tick,
        branches: { file: "launcher.file", action: "launcher.action" },
      },
    );
    console.log({
      tick,
      action: soft.pick(r.action, "launcher.action"),
      file: soft.when(r.file, "launcher.file"),
      urgency: r.urgency.score,
      band: soft.band(r.action),
      stale: r.stale,
      error: r.error,
    });
    soft.outcome(r.id, {
      accepted: tick === 2,
      key: "action",
      branch: "launcher.action",
      chosen: r.action.choice,
    });
  }
  console.log("Latest decision:", soft.latest("launcher.keystroke")?.id);
} finally {
  await soft.close();
  policy.close();
}
