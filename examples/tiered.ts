import {
  SoftIf,
  Policy,
  ollama,
  openaiEmulated,
  fake,
  tiered,
  noul,
} from "soft-if/node";
const live = process.env.SOFTIF_LIVE === "1";
const policy = new Policy();
const first = live
  ? ollama()
  : fake({
      name: "offline-clef",
      answers: {
        local: {
          type: "noul",
          p: 0.7,
          confidence: 0.7,
          probabilities: { true: 0.7, false: 0.3 },
        },
      },
    });
const second = live
  ? openaiEmulated({
      url: process.env.BONSAI_URL ?? "http://127.0.0.1:9090/v1",
      model: "bonsai-2-27b",
      apiKeyFile: process.env.BONSAI_API_KEY_FILE,
      thinking: false,
    })
  : fake({
      name: "offline-emulated",
      respond: async () => ({
        emulated: true,
        answers: {
          local: {
            type: "noul",
            p: 0.95,
            confidence: 0.95,
            probabilities: { true: 0.95, false: 0.05 },
            emulated: true,
          },
        },
      }),
    });
const soft = new SoftIf({
  backend: tiered([first, second], {
    policy,
    escalateBelow: "confirm",
    tierTimeoutMs: live ? 5000 : 100,
  }),
  policy,
  defaultTimeoutMs: live ? 10_000 : 400,
});
try {
  const result = await soft.decide("Find the budget document.", {
    local: noul("Local file search?"),
  });
  console.log({
    answer: result.local,
    band: soft.band(result.local),
    tier: result.tier,
    attempts: result.attempts,
    error: result.error,
  });
} finally {
  await soft.close();
}
