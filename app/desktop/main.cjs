const { app, BrowserWindow, net, protocol, shell, ipcMain, session } =
  require("electron");
const crypto = require("node:crypto");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const catalog = require("../shared/model-catalog.json");
const {
  createOllamaClient,
  isAbortError,
  isCloudModel,
} = require("./ollama-client.cjs");
const { createHindsightService } = require("./hindsight-client.cjs");
const codeChecker = require("./code-checker.cjs").createCodeChecker();

const MIN_WINDOW = { width: 920, height: 660 };
const activeRequests = new Map();
const ollama = createOllamaClient();
let hindsightService = null;
let hindsightActiveSenderId = null;
let allowQuitAfterHindsightShutdown = false;
let hindsightShutdownPromise = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "thinkpink",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

function isTrustedAppUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "thinkpink:" && url.hostname === "app";
  } catch {
    return false;
  }
}

function isExternalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      (url.hostname === "ollama.com" || url.hostname === "www.ollama.com")
    );
  } catch {
    return false;
  }
}

function abortRequestsFor(senderId) {
  for (const [requestId, request] of activeRequests) {
    if (request.sender.id === senderId) {
      request.controller.abort();
      activeRequests.delete(requestId);
    }
  }
}

function emit(sender, channel, payload) {
  if (!sender.isDestroyed()) sender.send(channel, payload);
}

function beginRequest(sender, kind, run) {
  const hasActiveKind = [...activeRequests.values()].some(
    (request) => request.sender.id === sender.id && request.kind === kind,
  );
  if (hasActiveKind) {
    throw new Error(
      kind === "pull"
        ? "A model download is already in progress."
        : "A local response is already being generated.",
    );
  }

  const requestId = crypto.randomUUID();
  const controller = new AbortController();
  const request = { sender, controller, kind };
  activeRequests.set(requestId, request);
  setImmediate(() => {
    void Promise.resolve()
      .then(() => run(controller.signal, requestId))
      .then(() => {
        emit(
          sender,
          kind === "pull" ? "thinkpink:pull-event" : "thinkpink:chat-event",
          { requestId, status: "success" },
        );
      })
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) {
          emit(
            sender,
            kind === "pull" ? "thinkpink:pull-event" : "thinkpink:chat-event",
            { requestId, status: "cancelled" },
          );
        } else {
          emit(
            sender,
            kind === "pull" ? "thinkpink:pull-event" : "thinkpink:chat-event",
            {
              requestId,
              status: "error",
              message:
                typeof error?.message === "string"
                  ? error.message.slice(0, 240)
                  : "The local Ollama request failed.",
            },
          );
        }
      })
      .finally(() => activeRequests.delete(requestId));
  });
  return { requestId };
}

function requireTrustedSender(event) {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (!isTrustedAppUrl(senderUrl)) {
    throw new TypeError("Local memory is available only in ThinkPink.");
  }
}

async function requireInstalledLocalModel(modelName) {
  if (typeof modelName !== "string" || isCloudModel(modelName)) {
    throw new TypeError("Choose an installed local Ollama model for Hindsight.");
  }
  const connection = await ollama.checkConnection();
  if (
    connection.status !== "ready"
    || !connection.models.some((model) => model.name === modelName)
  ) {
    throw new Error("Connect Ollama and choose one of its installed local models before using Hindsight.");
  }
  return modelName;
}

async function runHindsightOperation(event, operation) {
  requireTrustedSender(event);
  if (!hindsightService) throw new Error("Local Hindsight memory is not ready yet.");
  if (hindsightActiveSenderId !== null) {
    throw new Error("Another Hindsight operation is already running.");
  }
  hindsightActiveSenderId = event.sender.id;
  const onProgress = (stage) =>
    emit(event.sender, "thinkpink:hindsight-progress", { stage });
  try {
    return await operation(onProgress);
  } finally {
    if (hindsightActiveSenderId === event.sender.id) hindsightActiveSenderId = null;
  }
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 100) {
    throw new TypeError("The chat history is not valid.");
  }
  for (const message of messages) {
    if (
      !message ||
      !["system", "user", "assistant"].includes(message.role) ||
      typeof message.content !== "string" ||
      message.content.length > 50_000
    ) {
      throw new TypeError("The chat history is not valid.");
    }
  }
}

function registerHandlers() {
  ipcMain.handle("thinkpink:check-connection", () =>
    ollama.checkConnection(),
  );
  ipcMain.handle("thinkpink:reload-models", () =>
    ollama.checkConnection(),
  );
  ipcMain.handle("thinkpink:start-model-pull", (event, modelName) => {
    if (typeof modelName !== "string" || !catalog.some((item) => item.name === modelName)) {
      throw new TypeError("Choose a model from ThinkPink's reviewed catalog.");
    }
    return beginRequest(event.sender, "pull", async (signal, requestId) => {
      await ollama.pullModel(modelName, {
        signal,
        onProgress: (progress) =>
          emit(event.sender, "thinkpink:pull-event", {
            requestId,
            status: "progress",
            ...progress,
          }),
      });
    });
  });
  ipcMain.handle("thinkpink:start-chat", (event, payload) => {
    if (
      !payload ||
      typeof payload.modelName !== "string" ||
      !Array.isArray(payload.messages)
    ) {
      throw new TypeError("Choose an installed model and provide a chat message.");
    }
    validateMessages(payload.messages);
    const contextWindowTokens = payload.contextWindowTokens ?? 4096;
    if (![2048, 4096, 8192].includes(contextWindowTokens)) {
      throw new TypeError("Choose a supported local context window.");
    }
    return beginRequest(event.sender, "chat", async (signal, requestId) => {
      await ollama.chat(payload.modelName, payload.messages, {
        signal,
        contextWindowTokens,
        onToken: (content) =>
          emit(event.sender, "thinkpink:chat-event", {
            requestId,
            status: "token",
            content,
          }),
      });
    });
  });
  ipcMain.handle("thinkpink:cancel-request", (event, requestId) => {
    if (typeof requestId !== "string" || requestId.length > 80) return;
    const request = activeRequests.get(requestId);
    if (request?.sender.id === event.sender.id) {
      request.controller.abort();
    }
  });
  ipcMain.handle("thinkpink:check-code", (event, payload) => {
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    if (!isTrustedAppUrl(senderUrl)) {
      throw new TypeError("Code checks are available only in ThinkPink.");
    }
    return codeChecker.checkCode(payload?.language, payload?.source);
  });
  ipcMain.handle("thinkpink:cancel-code-check", (event) => {
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    if (!isTrustedAppUrl(senderUrl)) {
      throw new TypeError("Code checks are available only in ThinkPink.");
    }
    codeChecker.cancelActive();
  });
  ipcMain.handle("thinkpink:hindsight-status", async (event) => {
    requireTrustedSender(event);
    if (!hindsightService) throw new Error("Local Hindsight memory is not ready yet.");
    return hindsightService.getStatus();
  });
  ipcMain.handle("thinkpink:hindsight-setup", (event, payload) =>
    runHindsightOperation(event, async (onProgress) => {
      const modelName = await requireInstalledLocalModel(payload?.modelName);
      return hindsightService.setup({ modelName, onProgress });
    }),
  );
  ipcMain.handle("thinkpink:hindsight-enable", (event, payload) =>
    runHindsightOperation(event, async (onProgress) => {
      const enabled = payload?.enabled;
      const modelName = enabled
        ? await requireInstalledLocalModel(payload?.modelName)
        : undefined;
      return hindsightService.setEnabled(enabled, { modelName, onProgress });
    }),
  );
  ipcMain.handle("thinkpink:hindsight-index-source", (event, source) =>
    runHindsightOperation(event, (onProgress) =>
      hindsightService.indexSource(source, { onProgress }),
    ),
  );
  ipcMain.handle("thinkpink:hindsight-forget-source", (event, payload) =>
    runHindsightOperation(event, () =>
      hindsightService.forgetSource(payload?.kind, payload?.id),
    ),
  );
  ipcMain.handle("thinkpink:hindsight-forget-all", (event) =>
    runHindsightOperation(event, () => hindsightService.forgetAll()),
  );
  ipcMain.handle("thinkpink:hindsight-sync-source", (event, source) =>
    runHindsightOperation(event, () => hindsightService.syncIfIndexed(source)),
  );
  ipcMain.handle("thinkpink:hindsight-recall", (event, payload) =>
    runHindsightOperation(event, (onProgress) =>
      hindsightService.recall(payload?.query, {
        limit: payload?.limit,
        onProgress,
      }),
    ),
  );
  ipcMain.handle("thinkpink:hindsight-generate-draft", (event, payload) =>
    runHindsightOperation(event, async (onProgress) => {
      const modelName = payload?.modelName
        ? await requireInstalledLocalModel(payload.modelName)
        : undefined;
      return hindsightService.generateDraft(payload?.source, { modelName, onProgress });
    }),
  );
  ipcMain.handle("thinkpink:hindsight-cancel", (event) => {
    requireTrustedSender(event);
    if (hindsightActiveSenderId === event.sender.id) {
      hindsightService?.cancelActiveOperation();
    }
  });
  ipcMain.handle("thinkpink:open-official-page", async (_event, payload) => {
    const page = payload?.page;
    let url;
    if (page === "download" || page === "update") {
      url = "https://ollama.com/download";
    } else if (page === "library") {
      url = "https://ollama.com/library";
    } else if (page === "model") {
      const item = catalog.find(
        (model) => model.name === payload?.modelName,
      );
      if (!item || !isExternalUrl(item.modelPage)) {
        throw new TypeError("Choose a model from ThinkPink's reviewed catalog.");
      }
      url = item.modelPage;
    } else {
      throw new TypeError("Only official Ollama pages can be opened.");
    }
    if (!isExternalUrl(url)) {
      throw new TypeError("Only official Ollama pages can be opened.");
    }
    await shell.openExternal(url);
  });
}

function installContentSecurityPolicy() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ],
      },
    });
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false,
    title: "ThinkPink",
    backgroundColor: "#f8eef2",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedAppUrl(url)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  const webContentsId = window.webContents.id;
  window.on("closed", () => {
    abortRequestsFor(webContentsId);
    codeChecker.cancelActive();
  });
  void window.loadURL("thinkpink://app/");
  return window;
}

app.whenReady().then(() => {
  hindsightService = createHindsightService({ userDataPath: app.getPath("userData") });
  const publicRoot = path.resolve(__dirname, "..", "dist", "public");
  protocol.handle("thinkpink", (request) => {
    if (!isTrustedAppUrl(request.url) || !["GET", "HEAD"].includes(request.method)) {
      return new Response("Not found", { status: 404 });
    }

    let requestedPath;
    try {
      const url = new URL(request.url);
      requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    } catch {
      return new Response("Not found", { status: 404 });
    }

    const filePath = path.resolve(publicRoot, `.${requestedPath}`);
    if (!filePath.startsWith(`${publicRoot}${path.sep}`)) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });

  registerHandlers();
  installContentSecurityPolicy();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  for (const request of activeRequests.values()) request.controller.abort();
  activeRequests.clear();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  for (const request of activeRequests.values()) request.controller.abort();
  activeRequests.clear();
  if (hindsightService && !allowQuitAfterHindsightShutdown) {
    event.preventDefault();
    if (!hindsightShutdownPromise) {
      hindsightShutdownPromise = hindsightService.shutdown()
        .catch(() => {})
        .finally(() => {
          allowQuitAfterHindsightShutdown = true;
          app.quit();
        });
    }
  }
});

module.exports = { isExternalUrl, isTrustedAppUrl };