import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

test("installed CLI entrypoint runs through a package-manager symlink", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "softif-bin-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const command = join(dir, "softif.mjs");
  await symlink(
    fileURLToPath(new URL("../dist/src/cli.js", import.meta.url)),
    command,
  );
  const result = await exec(process.execPath, [
    command,
    "ask",
    "--backend",
    "fake",
    "--state",
    "test",
    "--noul",
    "q=Local file?",
  ]);
  assert.equal(JSON.parse(result.stdout).q.p, 0.9);
});

test("CLI Bonsai configuration uses environment, profile, then explicit flags", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "softif-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({
      url: req.url,
      auth: req.headers.authorization,
      body: JSON.parse(raw),
    });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ choices: [{ message: { content: '{"q":0.9}' } }] }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const envKey = join(dir, "environment-key.txt");
  const flagKey = join(dir, "flag-key.txt");
  const profiles = join(dir, "backends.json");
  await writeFile(envKey, "test-environment-key\n");
  await writeFile(flagKey, "test-flag-key\n");
  await writeFile(
    profiles,
    JSON.stringify({
      configured: {
        type: "bonsai",
        url: `${base}/profile/v1`,
        model: "profile-model",
      },
    }),
  );
  const env = {
    ...process.env,
    SOFTIF_LIVE: "0",
    BONSAI_URL: `${base}/environment/v1`,
    BONSAI_MODEL: "environment-model",
    BONSAI_API_KEY_FILE: envKey,
  };
  delete env.OPENAI_API_KEY;
  const command = fileURLToPath(new URL("../dist/src/cli.js", import.meta.url));
  async function ask(flags, overrides = {}) {
    const result = await exec(
      process.execPath,
      [command, "ask", "--state", "test", "--noul", "q=Local file?", ...flags],
      { env: { ...env, ...overrides } },
    );
    const answer = JSON.parse(result.stdout);
    assert.equal(answer.q.p, 0.9);
    assert.equal(answer.emulated, true);
    const request = requests.at(-1);
    assert.equal(request.body.chat_template_kwargs.enable_thinking, false);
    return request;
  }

  let request = await ask(["--backend", "bonsai"]);
  assert.equal(request.url, "/environment/v1/chat/completions");
  assert.equal(request.body.model, "environment-model");
  assert.equal(request.auth, "Bearer test-environment-key");

  request = await ask([
    "--backend",
    "configured",
    "--backend-config",
    profiles,
  ]);
  assert.equal(request.url, "/profile/v1/chat/completions");
  assert.equal(request.body.model, "profile-model");

  request = await ask([
    "--backend",
    "configured",
    "--backend-config",
    profiles,
    "--url",
    `${base}/flag/v1`,
    "--model",
    "flag-model",
    "--api-key-file",
    flagKey,
  ]);
  assert.equal(request.url, "/flag/v1/chat/completions");
  assert.equal(request.body.model, "flag-model");
  assert.equal(request.auth, "Bearer test-flag-key");

  request = await ask(["--backend", "openai"], {
    OPENAI_API_KEY: "test-direct-key",
  });
  assert.equal(request.auth, "Bearer test-direct-key");
});
