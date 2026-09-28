const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const typescript = require("typescript");

const sourceDirectory = path.resolve(__dirname);
const chromiumExecutable =
  process.env.CHROMIUM_BIN || process.env.CHROME_BIN || "chromium";

function transpileSource(filename) {
  const source = fs.readFileSync(path.join(sourceDirectory, filename), "utf8");
  return typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.ES2022,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText;
}

const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Local persistence regression test</title></head>
<body data-status="running"><pre id="result">Running</pre>
<script type="module">
import { DEFAULT_LOCAL_SETTINGS, localKnowledgeStore } from "/localKnowledge.js";
import { buildChatContext, resolveThreadWikiMode } from "/chatContext.js";

document.body.dataset.status = "modules-loaded";
const result = document.querySelector("#result");
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};
const equal = (actual, expected, message) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
};
const phase = sessionStorage.getItem("phase") || "write";
const timestamp = "2026-09-27T12:00:00.000Z";
const makeThread = (id, wikiContextMode, wikiPageIds, content) => ({
  id,
  title: id,
  summary: "Carry this note across reloads.",
  messages: [{ id: id + "-message", role: "user", content, createdAt: timestamp }],
  wikiContextMode,
  wikiPageIds,
  archived: false,
  createdAt: timestamp,
  updatedAt: timestamp,
});

async function run() {
  if (phase === "write") {
    equal(await localKnowledgeStore.loadSettings(), DEFAULT_LOCAL_SETTINGS, "initial settings use defaults");
    await localKnowledgeStore.saveWikiPage({
      id: "wiki-keep",
      title: "Keep page",
      body: "A page that remains attached.",
      category: "Notes",
      tags: ["local"],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await localKnowledgeStore.saveWikiPage({
      id: "wiki-remove",
      title: "Remove page",
      body: "A page to delete.",
      category: "Notes",
      tags: ["cleanup"],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await localKnowledgeStore.saveSettings({
      id: "preferences",
      defaultWikiContextMode: "approval",
      contextWindowTokens: 8192,
    });
    await localKnowledgeStore.saveThread(
      makeThread("thread-default", "default", ["wiki-keep", "wiki-remove"], "Default mode conversation."),
    );
    await localKnowledgeStore.saveThread(
      makeThread("thread-manual", "manual", ["wiki-remove"], "Manual mode conversation."),
    );
    await localKnowledgeStore.saveThread(
      makeThread("thread-automatic", "automatic", [], "Automatic mode conversation."),
    );
    await localKnowledgeStore.saveThread(
      makeThread("thread-delete", "approval", [], "This conversation will be deleted."),
    );
    sessionStorage.setItem("phase", "verify");
    location.reload();
    return;
  }

  const settings = await localKnowledgeStore.loadSettings();
  const threads = await localKnowledgeStore.listThreads();
  const pages = await localKnowledgeStore.listWikiPages();

  if (phase === "verify") {
    equal(settings, {
      id: "preferences",
      defaultWikiContextMode: "approval",
      contextWindowTokens: 8192,
    }, "saved settings survive a page reload");
    equal(pages.map((item) => item.id), ["wiki-keep", "wiki-remove"], "wiki pages survive a page reload");

    const defaultThread = threads.find((thread) => thread.id === "thread-default");
    const manualThread = threads.find((thread) => thread.id === "thread-manual");
    const automaticThread = threads.find((thread) => thread.id === "thread-automatic");
    check(defaultThread && manualThread && automaticThread, "saved threads are present after reload");
    equal(defaultThread.messages[0].content, "Default mode conversation.", "thread messages survive reload");
    equal(defaultThread.wikiPageIds, ["wiki-keep", "wiki-remove"], "page attachments survive reload");
    equal(resolveThreadWikiMode(defaultThread, settings.defaultWikiContextMode), "approval", "default mode follows saved settings");
    equal(resolveThreadWikiMode(manualThread, settings.defaultWikiContextMode), "manual", "manual thread override survives reload");
    equal(resolveThreadWikiMode(automaticThread, settings.defaultWikiContextMode), "automatic", "automatic thread override survives reload");

    const context = buildChatContext(
      defaultThread,
      defaultThread.messages,
      [pages.find((item) => item.id === "wiki-keep")],
      settings.contextWindowTokens,
    );
    equal(context.contextWindowTokens, 8192, "reloaded context budget reaches chat context");
    equal(context.includedWikiPages.map((item) => item.id), ["wiki-keep"], "only selected context pages are prepared");

    await localKnowledgeStore.saveThread({
      ...defaultThread,
      title: "Updated after reload",
      summary: "Updated saved summary.",
      updatedAt: "2026-09-27T12:01:00.000Z",
    });
    await localKnowledgeStore.deleteWikiPage("wiki-remove");
    await localKnowledgeStore.deleteThread("thread-delete");
    sessionStorage.setItem("phase", "verify-deletes");
    location.reload();
    return;
  }

  if (phase === "verify-deletes") {
    equal(pages.map((item) => item.id), ["wiki-keep"], "deleted wiki page stays deleted after reload");
    check(!threads.some((thread) => thread.id === "thread-delete"), "deleted thread stays deleted after reload");
    const defaultThread = threads.find((thread) => thread.id === "thread-default");
    const manualThread = threads.find((thread) => thread.id === "thread-manual");
    check(defaultThread && manualThread, "threads referencing the deleted page remain");
    equal(defaultThread.title, "Updated after reload", "thread edits survive a subsequent reload");
    equal(defaultThread.summary, "Updated saved summary.", "updated summary survives a subsequent reload");
    equal(defaultThread.wikiPageIds, ["wiki-keep"], "deleted page reference is cleaned from the thread");
    equal(manualThread.wikiPageIds, [], "deleted page reference is cleaned from every thread");
    equal(settings.contextWindowTokens, 8192, "context budget remains saved after deletions");
    document.body.dataset.status = "passed";
    result.textContent = "PASS: conversations, wiki, settings, attachments, and deletions persisted across reloads.";
    return;
  }

  throw new Error("Unknown persistence test phase: " + phase);
}

await run().catch((error) => {
  document.body.dataset.status = "failed";
  result.textContent = error && error.stack ? error.stack : String(error);
});
</script>
</body>
</html>`;

function connectDevTools(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let requestId = 0;
  let rejectConnection;
  const connected = new Promise((resolve, reject) => {
    rejectConnection = reject;
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not connect to Chromium DevTools.")), { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!pending.has(message.id)) return;
    const { resolve, reject, timeout } = pending.get(message.id);
    clearTimeout(timeout);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  socket.addEventListener("close", () => {
    rejectConnection(new Error("Chromium DevTools connection closed before it was ready."));
    for (const { reject, timeout } of pending.values()) {
      clearTimeout(timeout);
      reject(new Error("Chromium DevTools connection closed."));
    }
    pending.clear();
  });

  return {
    socket,
    async send(method, params = {}) {
      await connected;
      const id = ++requestId;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Chromium DevTools timed out on ${method}.`));
        }, 5_000);
        pending.set(id, { resolve, reject, timeout });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("threads, wiki pages, settings, and cleanup persist across browser reloads", { timeout: 45_000 }, async (t) => {
  const browserCheck = spawnSync(chromiumExecutable, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(
    browserCheck.status,
    0,
    `A Chromium executable is required for the IndexedDB persistence test (${chromiumExecutable}). ${browserCheck.error?.message || browserCheck.stderr || ""}`,
  );

  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "thinkpink-persistence-"),
  );
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));

  const files = new Map([
    ["/", { content: page, type: "text/html; charset=utf-8" }],
    ["/localKnowledge.js", {
      content: transpileSource("localKnowledge.ts"),
      type: "text/javascript; charset=utf-8",
    }],
    ["/chatContext.js", {
      content: transpileSource("chatContext.ts"),
      type: "text/javascript; charset=utf-8",
    }],
  ]);
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = files.get(pathname);
    if (!file) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": file.type, "cache-control": "no-store" });
    response.end(file.content);
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  const address = server.address();
  const browser = spawn(chromiumExecutable, [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--remote-allow-origins=*",
    "--remote-debugging-port=0",
    `--user-data-dir=${temporaryDirectory}`,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  browser.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
  t.after(() => browser.kill("SIGTERM"));

  let browserDevToolsPort;
  let browserWebSocketPath;
  const portFile = path.join(temporaryDirectory, "DevToolsActivePort");
  const portDeadline = Date.now() + 15_000;
  while (Date.now() < portDeadline) {
    if (browser.exitCode !== null) {
      assert.fail(`Chromium exited before DevTools started.\n${errors}`);
    }
    if (fs.existsSync(portFile)) {
      const [port, webSocketPath] = fs.readFileSync(portFile, "utf8").trim().split("\n");
      browserDevToolsPort = Number(port);
      browserWebSocketPath = webSocketPath;
      if (Number.isInteger(browserDevToolsPort) && browserDevToolsPort > 0 && browserWebSocketPath) break;
    }
    await delay(50);
  }
  assert.ok(browserDevToolsPort, `Chromium DevTools did not start.\n${errors}`);

  const browserDevTools = connectDevTools(
    `ws://127.0.0.1:${browserDevToolsPort}${browserWebSocketPath}`,
  );
  const target = await browserDevTools.send("Target.createTarget", {
    url: `http://127.0.0.1:${address.port}/`,
  });
  t.after(() => browserDevTools.socket.close());

  let pageTarget;
  const targetDeadline = Date.now() + 10_000;
  while (Date.now() < targetDeadline && !pageTarget) {
    const targets = await (await fetch(`http://127.0.0.1:${browserDevToolsPort}/json/list`)).json();
    pageTarget = targets.find((item) => item.id === target.targetId);
    if (!pageTarget) await delay(50);
  }
  assert.ok(pageTarget?.webSocketDebuggerUrl, "Chromium did not create the persistence test page.");

  const pageDevTools = connectDevTools(pageTarget.webSocketDebuggerUrl);
  await pageDevTools.send("Runtime.enable");
  t.after(() => pageDevTools.socket.close());

  const resultDeadline = Date.now() + 30_000;
  let result;
  while (Date.now() < resultDeadline) {
    if (browser.exitCode !== null) {
      assert.fail(`Chromium exited before the persistence test finished.\n${errors}`);
    }
    try {
      const evaluation = await pageDevTools.send("Runtime.evaluate", {
        expression: `({
          status: document.body?.dataset?.status ?? null,
          result: document.querySelector("#result")?.textContent ?? ""
        })`,
        returnByValue: true,
      });
      result = evaluation.result?.value;
      if (result?.status === "passed") break;
      if (result?.status === "failed") {
        assert.fail(`Browser persistence test failed:\n${result.result}\n${errors}`);
      }
    } catch (error) {
      if (Date.now() + 100 >= resultDeadline) throw error;
    }
    await delay(50);
  }

  assert.equal(
    result?.status,
    "passed",
    `Browser persistence test did not finish. ${JSON.stringify(result)}\n${errors}`,
  );
  assert.match(result.result, /PASS: conversations, wiki, settings, attachments, and deletions persisted across reloads/);
});