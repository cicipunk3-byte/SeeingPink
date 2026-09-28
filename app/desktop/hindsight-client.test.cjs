const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const {
  createHindsightService,
  makeScopedEnvironment,
  parsePythonVersion,
  parseRecallOutput,
  pythonCandidates,
  splitText,
} = require("./hindsight-client.cjs");

function cliArgs(args) {
  return args[0] === "--profile" ? args.slice(2) : args;
}

test("scopes Hindsight to app data, pg0 and loopback Ollama", () => {
  const environment = makeScopedEnvironment(
    {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "must-not-be-forwarded",
      HINDSIGHT_EMBED_API_URL: "https://remote.example",
      HINDSIGHT_API_DATABASE_URL: "postgres://remote.example",
      HINDSIGHT_API_HOST: "0.0.0.0",
    },
    { homeDirectory: "/thinkpink/user-data/hindsight/home" },
    "llama3.2:3b",
  );

  assert.equal(environment.HOME, "/thinkpink/user-data/hindsight/home");
  assert.equal(environment.USERPROFILE, environment.HOME);
  assert.equal(environment.HINDSIGHT_API_HOST, "127.0.0.1");
  assert.equal(environment.HINDSIGHT_EMBED_PROFILE, "thinkpink");
  assert.equal(environment.HINDSIGHT_API_LLM_PROVIDER, "ollama");
  assert.equal(environment.HINDSIGHT_API_LLM_BASE_URL, "http://127.0.0.1:11434/v1");
  assert.equal(environment.HINDSIGHT_API_DATABASE_URL, "pg0://hindsight-embed");
  assert.equal(environment.HINDSIGHT_EMBED_API_DATABASE_URL, "pg0://hindsight-embed");
  assert.equal(environment.HINDSIGHT_API_LLM_MODEL, "llama3.2:3b");
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.HINDSIGHT_EMBED_API_URL, undefined);
});

test("accepts only Python 3.11 or newer and selects platform launchers", () => {
  assert.equal(parsePythonVersion("3.10.14"), null);
  assert.deepEqual(parsePythonVersion("3.11.8"), { major: 3, minor: 11, patch: 8 });
  assert.deepEqual(parsePythonVersion("Python 3.12.1"), { major: 3, minor: 12, patch: 1 });
  assert.deepEqual(pythonCandidates("win32")[0], { command: "py", prefix: ["-3.11"] });
  assert.deepEqual(pythonCandidates("win32")[1], { command: "py", prefix: ["-3"] });
  assert.deepEqual(pythonCandidates("darwin")[0], { command: "python3.11", prefix: [] });
});

function createInstallProcess({
  service,
  calls,
  failFirstPip = false,
  pythonAvailable = true,
  unavailablePythonCommands = [],
}) {
  let pipAttempts = 0;
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => setImmediate(() => child.emit("close", 1));
    setImmediate(async () => {
      let code = 0;
      let stdout = "";
      const pythonVersionCheck = args.includes("-c");
      const pipInstall = args[args.indexOf("-m") + 1] === "pip";

      if (pythonVersionCheck) {
        if (
          !pythonAvailable
          || (command === "py" && args[0] === "-3.11")
          || unavailablePythonCommands.includes(command)
        ) code = 1;
        else stdout = "3.12.1\n";
      } else if (args.includes("venv")) {
        await fs.mkdir(service.paths.runtimeDirectory, { recursive: true });
      } else if (pipInstall) {
        pipAttempts += 1;
        await fs.mkdir(path.dirname(service.paths.cliPath), { recursive: true });
        await fs.writeFile(service.paths.cliPath, "mock Hindsight executable");
        if (failFirstPip && pipAttempts === 1) code = 1;
      } else if (cliArgs(args)[0] === "memory" && cliArgs(args)[1] === "recall") {
        stdout = JSON.stringify({ results: [] });
      }

      child.stdout.end(stdout);
      child.stderr.end();
      child.emit("close", code);
    });
    return child;
  };
}

test("Windows setup recovers a partial download after restart and restores selected local memory", async (t) => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "thinkpink-hindsight-win-"));
  t.after(() => fs.rm(userDataPath, { recursive: true, force: true }));
  const globalHome = path.join(userDataPath, "unrelated-user-home");
  const globalProfileFile = path.join(globalHome, ".hindsight", "profile.json");
  const workspaceFile = path.join(userDataPath, "local-workspace.json");
  await fs.mkdir(path.dirname(globalProfileFile), { recursive: true });
  await fs.writeFile(globalProfileFile, "leave the user's existing profile alone");
  await fs.writeFile(workspaceFile, "keep local workspace data");

  const calls = [];
  let service;
  service = createHindsightService({
    userDataPath,
    platform: "win32",
    baseEnvironment: { PATH: process.env.PATH, HOME: globalHome, USERPROFILE: globalHome },
    spawnProcess: (...args) => installProcess(...args),
  });
  const installProcess = createInstallProcess({ service, calls, failFirstPip: true });
  const appMemoryFile = path.join(service.paths.homeDirectory, "existing-pg0-data.marker");
  await fs.mkdir(service.paths.homeDirectory, { recursive: true });
  await fs.writeFile(appMemoryFile, "preserve ThinkPink's local Hindsight data");

  await assert.rejects(
    service.setup({ modelName: "llama3.2:3b" }),
    /could not install Hindsight Embed/i,
  );
  assert.equal(await fs.readFile(appMemoryFile, "utf8"), "preserve ThinkPink's local Hindsight data");

  const retryCalls = [];
  let retryService;
  const retryProcess = createInstallProcess({
    service: { paths: service.paths },
    calls: retryCalls,
  });
  retryService = createHindsightService({
    userDataPath,
    platform: "win32",
    baseEnvironment: { PATH: process.env.PATH, HOME: globalHome, USERPROFILE: globalHome },
    spawnProcess: (...args) => retryProcess(...args),
  });
  service = retryService;
  const setupStatus = await service.setup({ modelName: "llama3.2:3b" });
  assert.equal(setupStatus.runtimeInstalled, true);
  assert.equal(setupStatus.enabled, true);
  assert.ok(calls.some(({ command, args }) => command === "py" && args[0] === "-3"));
  assert.equal(retryCalls.filter(({ args }) => args[args.indexOf("-m") + 1] === "pip").length, 1);

  const selectedSource = {
    kind: "wiki",
    id: "only-selected-page",
    title: "Selected local page",
    content: "Only this selected page is added to local memory.",
  };
  await service.indexSource(selectedSource);
  const restartCalls = [];
  const restartedService = createHindsightService({
    userDataPath,
    platform: "win32",
    baseEnvironment: { PATH: process.env.PATH, HOME: globalHome, USERPROFILE: globalHome },
    spawnProcess: createInstallProcess({
      service: { paths: service.paths },
      calls: restartCalls,
    }),
  });
  const restoredStatus = await restartedService.getStatus();
  assert.equal(restoredStatus.enabled, true);
  assert.deepEqual(restoredStatus.indexedSources.map(({ id }) => id), ["only-selected-page"]);
  await restartedService.recall("selected local page");
  assert.ok(restartCalls.some(({ args }) => args[0] === "--profile" && args[1] === "thinkpink"));
  assert.ok(restartCalls.some(({ args }) => args.includes("daemon") && args.includes("start")));

  for (const { options } of [...calls, ...retryCalls, ...restartCalls]) {
    assert.equal(options.env.HOME, service.paths.homeDirectory);
    assert.equal(options.env.USERPROFILE, service.paths.homeDirectory);
    assert.equal(options.env.HINDSIGHT_API_HOST, "127.0.0.1");
    assert.equal(options.env.HINDSIGHT_API_LLM_PROVIDER, "ollama");
    assert.equal(options.env.HINDSIGHT_API_LLM_BASE_URL, "http://127.0.0.1:11434/v1");
    assert.equal(options.env.HINDSIGHT_API_DATABASE_URL, "pg0://hindsight-embed");
  }
  assert.equal(await fs.readFile(appMemoryFile, "utf8"), "preserve ThinkPink's local Hindsight data");
  assert.equal(await fs.readFile(globalProfileFile, "utf8"), "leave the user's existing profile alone");
  assert.equal(await fs.readFile(workspaceFile, "utf8"), "keep local workspace data");
});

test("missing Python leaves setup disabled and reports the required version", async (t) => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "thinkpink-hindsight-no-python-"));
  t.after(() => fs.rm(userDataPath, { recursive: true, force: true }));
  const calls = [];
  const service = createHindsightService({
    userDataPath,
    platform: "win32",
    spawnProcess: createInstallProcess({
      service: { paths: { runtimeDirectory: path.join(userDataPath, "hindsight", "runtime") } },
      calls,
      pythonAvailable: false,
    }),
  });

  await assert.rejects(
    service.setup({ modelName: "llama3.2:3b" }),
    /Python 3\.11 or newer.*will not install a system-wide runtime/i,
  );
  assert.equal((await service.getStatus()).enabled, false);
  assert.equal(await fs.stat(service.paths.runtimeDirectory).then(() => true, () => false), false);
});

test("macOS setup uses its private runtime paths and finds Python 3.12", async (t) => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "thinkpink-hindsight-mac-"));
  t.after(() => fs.rm(userDataPath, { recursive: true, force: true }));
  const calls = [];
  let service;
  service = createHindsightService({
    userDataPath,
    platform: "darwin",
    baseEnvironment: { PATH: process.env.PATH },
    spawnProcess: (...args) => installProcess(...args),
  });
  const installProcess = createInstallProcess({
    service,
    calls,
    unavailablePythonCommands: ["python3.11"],
  });

  const status = await service.setup({ modelName: "llama3.2:3b" });
  assert.equal(status.runtimeInstalled, true);
  assert.equal(status.enabled, true);
  assert.match(service.paths.pythonPath, /hindsight\/runtime\/bin\/python$/);
  assert.match(service.paths.cliPath, /hindsight\/runtime\/bin\/hindsight-embed$/);
  assert.ok(calls.some(({ command }) => command === "python3.11"));
  assert.ok(calls.some(({ command }) => command === "python3"));
  assert.ok(calls.some(({ args }) =>
    args[0] === "configure" && args.some((value) => value.includes("pg0://hindsight-embed")),
  ));
});

test("splits large text without losing Unicode characters", () => {
  const text = `${"🧠a".repeat(4_000)}\nFinal line.`;
  const parts = splitText(text, 1_000);
  assert.ok(parts.length > 1);
  assert.equal(parts.join("").replaceAll("\n", ""), text.replaceAll("\n", ""));
  assert.ok(parts.every((part) => part.length <= 1_000));
  assert.throws(() => splitText(" \n "), /no content/i);
});

test("parses recall results and rejects an unknown response shape", () => {
  assert.deepEqual(parseRecallOutput(JSON.stringify({
    results: [
      { text: "A local fact", context: "thinkpink/wiki/page/1", score: 0.8 },
      { text: "No source information" },
    ],
  })), [{
    text: "A local fact",
    context: "thinkpink/wiki/page/1",
    score: 0.8,
  }]);
  assert.throws(() => parseRecallOutput("{not json}"), /unreadable/i);
  assert.throws(() => parseRecallOutput(JSON.stringify({ result: [] })), /unsupported/i);
});

test("indexes, replaces, recalls and forgets only app-selected sources", async (t) => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "thinkpink-hindsight-test-"));
  t.after(() => fs.rm(userDataPath, { recursive: true, force: true }));
  const calls = [];
  let latestContext = "";
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => setImmediate(() => child.emit("close", 1));
    setImmediate(() => {
      const commandArgs = cliArgs(args);
      if (commandArgs[0] === "memory" && commandArgs[1] === "retain") {
        const contextIndex = commandArgs.indexOf("--context");
        if (contextIndex >= 0) latestContext = commandArgs[contextIndex + 1];
      }
      const output = commandArgs[0] === "memory" && commandArgs[1] === "recall"
        ? JSON.stringify({ results: [{ text: "A saved fact", context: latestContext, score: 0.9 }] })
        : "";
      child.stdout.end(output);
      child.stderr.end();
      child.emit("close", 0);
    });
    return child;
  };
  const service = createHindsightService({
    userDataPath,
    platform: "linux",
    baseEnvironment: {
      PATH: process.env.PATH,
      OPENAI_API_KEY: "must-not-be-forwarded",
      HINDSIGHT_EMBED_API_URL: "https://remote.invalid",
    },
    spawnProcess,
  });
  await fs.mkdir(path.dirname(service.paths.cliPath), { recursive: true });
  await fs.writeFile(service.paths.cliPath, "test-only");
  await fs.writeFile(service.paths.runtimeMarkerPath, "0.10.1\n");

  const configured = await service.setEnabled(true, { modelName: "llama3.2:3b" });
  assert.equal(configured.enabled, true);
  assert.ok(calls.some(({ args }) => cliArgs(args)[0] === "configure"));
  assert.ok(calls.some(({ args }) => cliArgs(args)[0] === "daemon" && cliArgs(args)[1] === "start"));

  const source = {
    kind: "wiki",
    id: "page-1",
    title: "Local notes",
    content: `${"A local-only fact. ".repeat(500)}`,
  };
  await service.indexSource(source);
  const firstStatus = await service.getStatus();
  assert.equal(firstStatus.indexedSources.length, 1);
  assert.equal(firstStatus.indexedSources[0].id, "page-1");
  const firstDocumentIds = calls
    .filter(({ args }) => cliArgs(args)[0] === "memory" && cliArgs(args)[1] === "retain")
    .map(({ args }) => cliArgs(args)[cliArgs(args).indexOf("--doc-id") + 1]);
  assert.ok(firstDocumentIds.length > 1);
  assert.ok(firstDocumentIds.every((id) => id.startsWith("tp-wiki-")));

  const recalled = await service.recall("local notes");
  assert.deepEqual(recalled.results, [{
    text: "A saved fact",
    context: latestContext,
    score: 0.9,
    kind: "wiki",
    sourceId: "page-1",
    title: "Local notes",
  }]);
  const latestEnvironment = calls.at(-1).options.env;
  assert.equal(latestEnvironment.HINDSIGHT_API_HOST, "127.0.0.1");
  assert.equal(latestEnvironment.HINDSIGHT_API_LLM_PROVIDER, "ollama");
  assert.equal(latestEnvironment.OPENAI_API_KEY, undefined);
  assert.equal(latestEnvironment.HINDSIGHT_EMBED_API_URL, undefined);

  await service.indexSource({ ...source, content: "Updated local note." });
  const secondDocumentIds = calls
    .filter(({ args }) => cliArgs(args)[0] === "memory" && cliArgs(args)[1] === "retain")
    .map(({ args }) => cliArgs(args)[cliArgs(args).indexOf("--doc-id") + 1]);
  assert.notEqual(secondDocumentIds.at(-1), firstDocumentIds[0]);
  assert.ok(calls.some(({ args }) =>
    cliArgs(args)[0] === "document" && cliArgs(args)[1] === "delete" && firstDocumentIds.includes(cliArgs(args)[3]),
  ));

  await service.setEnabled(false);
  const pausedStatus = await service.getStatus();
  assert.equal(pausedStatus.enabled, false);
  assert.equal(pausedStatus.indexedSources.length, 1);
  const disabledEdit = await service.syncIfIndexed({ ...source, content: "Changed while paused." });
  assert.equal(disabledEdit.synced, false);
  assert.equal(disabledEdit.status.indexedSources.length, 0);

  await service.setEnabled(true, { modelName: "llama3.2:3b" });
  await service.forgetSource("wiki", "page-1");
  assert.equal((await service.getStatus()).indexedSources.length, 0);
  assert.ok(calls.some(({ args }) =>
    cliArgs(args)[0] === "document" && cliArgs(args)[1] === "delete" && secondDocumentIds.includes(cliArgs(args)[3]),
  ));

  await service.shutdown();
  assert.ok(calls.some(({ args }) => cliArgs(args)[0] === "daemon" && cliArgs(args)[1] === "stop"));
});