const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const test = require("node:test");
const {
  createOllamaClient,
  compareVersions,
  isAbortError,
  isCloudModel,
  parseVersion,
} = require("./ollama-client.cjs");

const installedLlama = {
  name: "llama3.2:1b",
  model: "llama3.2:1b",
  size: 1_300_000_000,
  digest: "a".repeat(64),
  modified_at: "2026-09-27T12:00:00Z",
  details: {
    family: "llama",
    parameter_size: "1B",
    quantization_level: "Q4_K_M",
  },
};

async function withMockOllama(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return {
    server,
    client: createOllamaClient({ port: server.address().port }),
  };
}

function json(response, payload, statusCode = 200) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function ndjson(response, events) {
  response.writeHead(200, { "content-type": "application/x-ndjson" });
  for (const event of events) response.write(`${JSON.stringify(event)}\n`);
  response.end();
}

test("version parsing and comparison reject malformed values", () => {
  assert.deepEqual(parseVersion("0.12.6"), [0, 12, 6]);
  assert.deepEqual(parseVersion("0.12.6-rc1"), [0, 12, 6]);
  assert.equal(parseVersion("0.12"), null);
  assert.equal(compareVersions("0.4.99", "0.5.0"), -1);
  assert.equal(compareVersions("0.5.0", "0.5.0"), 0);
  assert.equal(compareVersions("0.12.0", "0.5.0"), 1);
});

test("model discovery keeps local installed models and filters cloud entries", async (t) => {
  const { client } = await withMockOllama(t, (request, response) => {
    if (request.url === "/api/version") return json(response, { version: "0.12.6" });
    if (request.url === "/api/tags") {
      return json(response, {
        models: [
          installedLlama,
          {
            name: "gemma4:cloud",
            model: "gemma4:cloud",
            size: 0,
            digest: "",
            details: {},
          },
          {
            name: "remote-alias",
            model: "remote-alias",
            size: 100,
            remote: true,
            details: {},
          },
        ],
      });
    }
    json(response, { error: "not found" }, 404);
  });

  const result = await client.checkConnection();
  assert.equal(result.status, "ready");
  assert.equal(result.version, "0.12.6");
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].name, "llama3.2:1b");
  assert.equal(result.models[0].details.parameterSize, "1B");
});

test("old Ollama versions are reported as unsupported before model discovery", async (t) => {
  let tagsRequested = false;
  const { client } = await withMockOllama(t, (request, response) => {
    if (request.url === "/api/version") return json(response, { version: "0.4.9" });
    if (request.url === "/api/tags") tagsRequested = true;
    json(response, { models: [] });
  });

  const result = await client.checkConnection();
  assert.deepEqual(
    { status: result.status, version: result.version, minimumVersion: result.minimumVersion },
    { status: "unsupported", version: "0.4.9", minimumVersion: "0.5.0" },
  );
  assert.equal(tagsRequested, false);
});

test("invalid version or tags responses are not presented as ready", async (t) => {
  const { client } = await withMockOllama(t, (request, response) => {
    if (request.url === "/api/version") return json(response, { version: "future" });
    if (request.url === "/api/tags") return json(response, { models: "not-an-array" });
    json(response, {}, 404);
  });
  const result = await client.checkConnection();
  assert.equal(result.status, "unsupported");
  assert.match(result.reason, /version response/i);
});

test("pull streams progress and reports success only after the model appears in tags", async (t) => {
  const models = [];
  const { client } = await withMockOllama(t, (request, response) => {
    if (request.url === "/api/version") return json(response, { version: "0.12.6" });
    if (request.url === "/api/tags") return json(response, { models });
    if (request.url === "/api/pull") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        assert.deepEqual(JSON.parse(body), {
          model: "llama3.2:1b",
          stream: true,
          insecure: false,
        });
        ndjson(response, [
          { status: "pulling manifest" },
          { status: "downloading", total: 1_000, completed: 500 },
          { status: "success" },
        ]);
        models.push(installedLlama);
      });
      return;
    }
    json(response, {}, 404);
  });

  const progress = [];
  await client.pullModel("llama3.2:1b", {
    onProgress: (event) => progress.push(event),
  });
  assert.deepEqual(progress, [
    { phase: "pulling manifest" },
    { phase: "downloading", completed: 500, total: 1_000 },
  ]);
});

test("pull refuses an unlisted or cloud model before making a request", async (t) => {
  let pullRequested = false;
  const { client } = await withMockOllama(t, (request, response) => {
    if (request.url === "/api/version") return json(response, { version: "0.12.6" });
    if (request.url === "/api/tags") return json(response, { models: [] });
    if (request.url === "/api/pull") pullRequested = true;
    json(response, {}, 404);
  });

  await assert.rejects(client.pullModel("gemma4:cloud"), /reviewed catalog/i);
  assert.equal(pullRequested, false);
  assert.equal(isCloudModel("gemma4:cloud"), true);
  assert.equal(isCloudModel("llama3.2:1b"), false);
});

test("cancelling a model pull aborts its streaming request", async (t) => {
  const { client } = await withMockOllama(t, (request, response) => {
    if (request.url === "/api/version") return json(response, { version: "0.12.6" });
    if (request.url === "/api/tags") return json(response, { models: [] });
    if (request.url === "/api/pull") {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.write('{"status":"pulling manifest"}\n');
      return;
    }
    json(response, {}, 404);
  });

  const controller = new AbortController();
  let aborted = false;
  const pull = client.pullModel("llama3.2:1b", {
    signal: controller.signal,
    onProgress: () => {
      aborted = true;
      controller.abort();
    },
  });
  await assert.rejects(pull, (error) => isAbortError(error));
  assert.equal(aborted, true);
});

test("chat streams text only to an installed local model", async (t) => {
  let chatBody;
  const requests = [];
  const { client } = await withMockOllama(t, (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === "/api/version") return json(response, { version: "0.12.6" });
    if (request.url === "/api/tags") return json(response, { models: [installedLlama] });
    if (request.url === "/api/chat") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        chatBody = JSON.parse(body);
        ndjson(response, [
          { message: { role: "assistant", content: "Local " }, done: false },
          { message: { role: "assistant", content: "reply." }, done: false },
          { message: { role: "assistant", content: "" }, done: true },
        ]);
      });
      return;
    }
    json(response, {}, 404);
  });

  const tokens = [];
  await client.chat(
    "llama3.2:1b",
    [{ role: "user", content: "Hello" }],
    { onToken: (token) => tokens.push(token), contextWindowTokens: 8192 },
  );
  assert.deepEqual(requests, [
    "GET /api/version",
    "GET /api/tags",
    "POST /api/chat",
  ]);
  assert.equal(chatBody.model, "llama3.2:1b");
  assert.equal(chatBody.stream, true);
  assert.deepEqual(chatBody.messages, [{ role: "user", content: "Hello" }]);
  assert.deepEqual(chatBody.options, { num_ctx: 8192 });
  assert.equal("tools" in chatBody, false);
  assert.deepEqual(tokens, ["Local ", "reply."]);
});

test("chat rejects a cloud model and tool-role payloads", async (t) => {
  const { client } = await withMockOllama(t, (request, response) => {
    if (request.url === "/api/version") return json(response, { version: "0.12.6" });
    if (request.url === "/api/tags") {
      return json(response, {
        models: [
          installedLlama,
          { ...installedLlama, name: "gemma4:cloud", model: "gemma4:cloud" },
        ],
      });
    }
    json(response, {}, 404);
  });

  await assert.rejects(
    client.chat("gemma4:cloud", [{ role: "user", content: "Hello" }]),
    /Cloud models are not supported/i,
  );
  await assert.rejects(
    client.chat("llama3.2:1b", [{ role: "tool", content: "shell command" }]),
    /chat history is not valid/i,
  );
  await assert.rejects(
    client.chat("llama3.2:1b", [{ role: "user", content: "Hello" }], { contextWindowTokens: 999 }),
    /supported local context window/i,
  );
});

test("the Ollama client cannot be redirected to a non-loopback host", () => {
  assert.throws(
    () => createOllamaClient({ host: "example.com" }),
    /IPv4 loopback/i,
  );
  assert.throws(
    () => createOllamaClient({ host: "127.0.0.2" }),
    /IPv4 loopback/i,
  );
});