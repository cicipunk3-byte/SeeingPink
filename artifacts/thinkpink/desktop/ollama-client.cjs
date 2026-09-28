const http = require("node:http");
const net = require("node:net");
const catalog = require("../shared/model-catalog.json");

const OLLAMA_HOST = "127.0.0.1";
const OLLAMA_PORT = 11434;
const MINIMUM_VERSION = "0.5.0";
const REQUEST_PATHS = new Set([
  "/api/version",
  "/api/tags",
  "/api/pull",
  "/api/chat",
]);
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_MESSAGES = 100;
const MAX_MESSAGE_BYTES = 50_000;
const MAX_TOTAL_MESSAGE_BYTES = 300_000;

class OllamaRequestError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "OllamaRequestError";
    this.code = options.code;
    this.statusCode = options.statusCode;
  }
}

function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

function isCloudModel(name) {
  return typeof name === "string" &&
    /(?:^|[:/])cloud(?:$|[/:.-])/i.test(name.trim());
}

function toInstalledModel(item) {
  if (!item || typeof item !== "object") return null;
  const name = typeof item.name === "string" ? item.name : "";
  const model = typeof item.model === "string" ? item.model : name;
  const sizeBytes = Number(item.size);
  if (
    !name ||
    !model ||
    !Number.isFinite(sizeBytes) ||
    sizeBytes <= 0 ||
    isCloudModel(name) ||
    isCloudModel(model) ||
    item.remote === true ||
    item.isRemote === true
  ) {
    return null;
  }

  const details =
    item.details && typeof item.details === "object" ? item.details : {};
  return {
    name,
    model,
    sizeBytes,
    digest: typeof item.digest === "string" ? item.digest : "",
    modifiedAt: typeof item.modified_at === "string" ? item.modified_at : "",
    details: {
      family: typeof details.family === "string" ? details.family : null,
      parameterSize:
        typeof details.parameter_size === "string"
          ? details.parameter_size
          : null,
      quantizationLevel:
        typeof details.quantization_level === "string"
          ? details.quantization_level
          : null,
    },
  };
}

function safeHttpError(statusCode, endpoint) {
  return new OllamaRequestError(
    `Ollama returned HTTP ${statusCode} for ${endpoint}.`,
    { statusCode, code: "OLLAMA_HTTP_ERROR" },
  );
}

function readBody(response, maxBytes = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    response.on("data", (chunk) => {
      length += chunk.length;
      if (length > maxBytes) {
        response.destroy();
        reject(
          new OllamaRequestError("Ollama returned an oversized response.", {
            code: "RESPONSE_TOO_LARGE",
          }),
        );
        return;
      }
      chunks.push(chunk);
    });
    response.on("error", reject);
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function createOllamaClient({ host = OLLAMA_HOST, port = OLLAMA_PORT } = {}) {
  if (net.isIP(host) !== 4 || host !== OLLAMA_HOST) {
    throw new TypeError("ThinkPink only permits the IPv4 loopback Ollama host.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError("Invalid local Ollama port.");
  }

  function request(endpoint, { method = "GET", body, signal, timeoutMs = 0 } = {}) {
    if (!REQUEST_PATHS.has(endpoint)) {
      return Promise.reject(new TypeError("Unsupported Ollama API endpoint."));
    }
    if (!["GET", "POST"].includes(method)) {
      return Promise.reject(new TypeError("Unsupported Ollama API method."));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const req = http.request(
        {
          hostname: host,
          port,
          path: endpoint,
          method,
          headers: {
            accept: "application/json, application/x-ndjson",
            ...(body
              ? { "content-type": "application/json; charset=utf-8" }
              : {}),
          },
          ...(signal ? { signal } : {}),
        },
        (response) => {
          settled = true;
          resolve(response);
        },
      );

      req.on("error", (error) => {
        if (settled) return;
        reject(error);
      });
      if (timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => {
          req.destroy(
            new OllamaRequestError("The local Ollama request timed out.", {
              code: "ETIMEDOUT",
            }),
          );
        });
      }
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async function requestJson(endpoint, options = {}) {
    const response = await request(endpoint, options);
    const text = await readBody(response);
    if (response.statusCode !== 200) {
      throw safeHttpError(response.statusCode || 0, endpoint);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new OllamaRequestError(
        `Ollama returned invalid JSON for ${endpoint}.`,
        { code: "INVALID_JSON" },
      );
    }
  }

  async function checkConnection() {
    let versionData;
    try {
      versionData = await requestJson("/api/version", { timeoutMs: 4_000 });
    } catch (error) {
      if (error.statusCode || error.code === "INVALID_JSON") {
        return {
          status: "unsupported",
          version: null,
          minimumVersion: MINIMUM_VERSION,
          reason: "Ollama did not return a supported version response.",
        };
      }
      return {
        status: "unreachable",
        reason: error.code === "ETIMEDOUT" ? "timeout" : "not-running",
      };
    }

    const version =
      versionData && typeof versionData.version === "string"
        ? versionData.version.trim()
        : "";
    if (!parseVersion(version)) {
      return {
        status: "unsupported",
        version: version || null,
        minimumVersion: MINIMUM_VERSION,
        reason: "Ollama's version response could not be verified.",
      };
    }
    if (compareVersions(version, MINIMUM_VERSION) < 0) {
      return {
        status: "unsupported",
        version,
        minimumVersion: MINIMUM_VERSION,
        reason: `ThinkPink requires Ollama ${MINIMUM_VERSION} or newer.`,
      };
    }

    let tags;
    try {
      tags = await requestJson("/api/tags", { timeoutMs: 5_000 });
    } catch (error) {
      if (error.statusCode || error.code === "INVALID_JSON") {
        return {
          status: "unsupported",
          version,
          minimumVersion: MINIMUM_VERSION,
          reason: "This Ollama version did not return a supported model list.",
        };
      }
      return {
        status: "unreachable",
        reason: error.code === "ETIMEDOUT" ? "timeout" : "not-running",
      };
    }

    if (!tags || !Array.isArray(tags.models)) {
      return {
        status: "unsupported",
        version,
        minimumVersion: MINIMUM_VERSION,
        reason: "Ollama's model-list response could not be verified.",
      };
    }

    return {
      status: "ready",
      version,
      models: tags.models.map(toInstalledModel).filter(Boolean),
    };
  }

  async function* readNdjson(response, signal) {
    let pending = "";
    try {
      for await (const chunk of response) {
        if (signal?.aborted) throw abortError();
        pending += chunk.toString("utf8");
        if (pending.length > MAX_JSON_BYTES) {
          throw new OllamaRequestError("Ollama returned an oversized stream line.", {
            code: "RESPONSE_TOO_LARGE",
          });
        }
        let newlineIndex = pending.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = pending.slice(0, newlineIndex).trim();
          pending = pending.slice(newlineIndex + 1);
          if (line) yield parseNdjsonLine(line);
          newlineIndex = pending.indexOf("\n");
        }
      }
    } catch (error) {
      if (signal?.aborted) throw abortError();
      throw error;
    }
    const finalLine = pending.trim();
    if (finalLine) yield parseNdjsonLine(finalLine);
  }

  function parseNdjsonLine(line) {
    try {
      return JSON.parse(line);
    } catch {
      throw new OllamaRequestError("Ollama returned an invalid stream event.", {
        code: "INVALID_STREAM",
      });
    }
  }

  async function requestStream(endpoint, body, signal) {
    const response = await request(endpoint, {
      method: "POST",
      body,
      signal,
    });
    if (response.statusCode !== 200) {
      const error = safeHttpError(response.statusCode || 0, endpoint);
      response.destroy();
      throw error;
    }
    return response;
  }

  async function pullModel(modelName, { signal, onProgress = () => {} } = {}) {
    if (!catalog.some((item) => item.name === modelName)) {
      throw new OllamaRequestError("This model is not in ThinkPink's reviewed catalog.", {
        code: "MODEL_NOT_ALLOWED",
      });
    }
    if (isCloudModel(modelName)) {
      throw new OllamaRequestError("Cloud models are not supported.", {
        code: "CLOUD_MODEL_BLOCKED",
      });
    }

    const current = await checkConnection();
    if (current.status !== "ready") {
      throw new OllamaRequestError(
        current.status === "unsupported"
          ? current.reason
          : "Ollama is not responding. Open Ollama and try again.",
        { code: current.status === "unsupported" ? "UNSUPPORTED_VERSION" : "UNREACHABLE" },
      );
    }
    if (current.models.some((item) => item.name === modelName || item.model === modelName)) {
      throw new OllamaRequestError("This model is already installed.", {
        code: "MODEL_ALREADY_INSTALLED",
      });
    }

    const response = await requestStream(
      "/api/pull",
      { model: modelName, stream: true, insecure: false },
      signal,
    );
    let sawSuccess = false;
    for await (const event of readNdjson(response, signal)) {
      if (!event || typeof event !== "object") continue;
      if (typeof event.error === "string") {
        throw new OllamaRequestError("Ollama could not download the selected model.", {
          code: "PULL_FAILED",
        });
      }
      const phase = typeof event.status === "string" ? event.status.slice(0, 140) : "";
      if (phase.toLowerCase() === "success") {
        sawSuccess = true;
        continue;
      }
      if (phase) {
        onProgress({
          phase,
          ...(Number.isFinite(event.completed) && event.completed >= 0
            ? { completed: event.completed }
            : {}),
          ...(Number.isFinite(event.total) && event.total > 0
            ? { total: event.total }
            : {}),
        });
      }
    }
    if (signal?.aborted) throw abortError();
    if (!sawSuccess) {
      throw new OllamaRequestError("Ollama ended the download before confirming success.", {
        code: "PULL_INCOMPLETE",
      });
    }

    const afterPull = await checkConnection();
    if (
      afterPull.status !== "ready" ||
      !afterPull.models.some(
        (item) => item.name === modelName || item.model === modelName,
      )
    ) {
      throw new OllamaRequestError(
        "Ollama reported a completed download, but the model is not in its installed-model list.",
        { code: "PULL_NOT_INSTALLED" },
      );
    }
  }

  async function chat(modelName, messages, {
    signal,
    onToken = () => {},
    contextWindowTokens = 4096,
  } = {}) {
    if (![2048, 4096, 8192].includes(contextWindowTokens)) {
      throw new OllamaRequestError("Choose a supported local context window.", {
        code: "INVALID_CONTEXT_WINDOW",
      });
    }
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) {
      throw new OllamaRequestError("The chat history is not valid.", {
        code: "INVALID_MESSAGES",
      });
    }

    let totalBytes = 0;
    const safeMessages = messages.map((message) => {
      if (
        !message ||
        !["system", "user", "assistant"].includes(message.role) ||
        typeof message.content !== "string" ||
        message.content.length > MAX_MESSAGE_BYTES
      ) {
        throw new OllamaRequestError("The chat history is not valid.", {
          code: "INVALID_MESSAGES",
        });
      }
      totalBytes += Buffer.byteLength(message.content, "utf8");
      return { role: message.role, content: message.content };
    });
    if (totalBytes > MAX_TOTAL_MESSAGE_BYTES) {
      throw new OllamaRequestError("The chat history is too large to send.", {
        code: "MESSAGES_TOO_LARGE",
      });
    }

    const current = await checkConnection();
    if (current.status !== "ready") {
      throw new OllamaRequestError(
        current.status === "unsupported"
          ? current.reason
          : "Ollama is not responding. Open Ollama and try again.",
        { code: current.status === "unsupported" ? "UNSUPPORTED_VERSION" : "UNREACHABLE" },
      );
    }
    if (isCloudModel(modelName)) {
      throw new OllamaRequestError("Cloud models are not supported.", {
        code: "CLOUD_MODEL_BLOCKED",
      });
    }
    if (
      !current.models.some(
        (item) => item.name === modelName || item.model === modelName,
      )
    ) {
      throw new OllamaRequestError("Choose a model reported as installed by Ollama.", {
        code: "MODEL_NOT_INSTALLED",
      });
    }

    const response = await requestStream(
      "/api/chat",
      {
        model: modelName,
        messages: safeMessages,
        stream: true,
        options: { num_ctx: contextWindowTokens },
      },
      signal,
    );
    let sawDone = false;
    for await (const event of readNdjson(response, signal)) {
      if (!event || typeof event !== "object") continue;
      if (typeof event.error === "string") {
        throw new OllamaRequestError("Ollama could not complete the local chat.", {
          code: "CHAT_FAILED",
        });
      }
      const content =
        event.message && typeof event.message.content === "string"
          ? event.message.content
          : "";
      if (content) onToken(content);
      if (event.done === true) {
        sawDone = true;
        break;
      }
    }
    if (signal?.aborted) throw abortError();
    if (!sawDone) {
      throw new OllamaRequestError("Ollama ended the response before confirming completion.", {
        code: "CHAT_INCOMPLETE",
      });
    }
  }

  return { checkConnection, pullModel, chat };
}

function abortError() {
  const error = new Error("Request cancelled.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

module.exports = {
  createOllamaClient,
  compareVersions,
  isAbortError,
  isCloudModel,
  parseVersion,
  toInstalledModel,
};