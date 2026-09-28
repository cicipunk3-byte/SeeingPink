const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const EMBED_VERSION = "0.10.1";
const PROFILE_NAME = "thinkpink";
const BANK_NAME = "thinkpink-local";
const OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
const MAX_SOURCE_CHARACTERS = 2_000_000;
const MAX_CHUNK_CHARACTERS = 6_000;
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 3 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const EMPTY_STATE = Object.freeze({
  version: 1,
  enabled: false,
  modelName: null,
  indexedSources: {},
  pendingCreates: [],
  pendingDeletes: [],
});

function isSafeModelName(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 180
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !/(?:^|[:/])cloud(?:$|[/:.-])/i.test(value.trim());
}

function isSafeSourceKind(value) {
  return value === "thread" || value === "wiki";
}

function hash(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function sourceKey(kind, id) {
  if (!isSafeSourceKind(kind) || typeof id !== "string" || !id || id.length > 128) {
    throw new TypeError("The Hindsight source is not valid.");
  }
  return `${kind}:${id}`;
}

function splitText(text, maxCharacters = MAX_CHUNK_CHARACTERS) {
  if (typeof text !== "string" || !text.trim()) {
    throw new TypeError("There is no content to add to local memory.");
  }
  if (text.length > MAX_SOURCE_CHARACTERS) {
    throw new RangeError("This source is too large to add to Hindsight. Shorten it and try again.");
  }
  const characters = Array.from(text.trim());
  const chunks = [];
  let offset = 0;
  while (offset < characters.length) {
    let end = offset;
    let codeUnits = 0;
    while (end < characters.length && codeUnits + characters[end].length <= maxCharacters) {
      codeUnits += characters[end].length;
      end += 1;
    }
    if (end === characters.length) {
      const remainder = characters.slice(offset).join("").trim();
      if (remainder) chunks.push(remainder);
      break;
    }
    const candidate = characters.slice(offset, end);
    let splitAt = candidate.lastIndexOf("\n");
    if (splitAt < Math.floor(candidate.length * 0.6)) {
      splitAt = candidate.lastIndexOf(" ");
    }
    if (splitAt < Math.floor(candidate.length * 0.6)) splitAt = candidate.length;
    const chunk = characters.slice(offset, offset + splitAt).join("").trim();
    offset += splitAt;
    if (characters[offset] === "\n" || characters[offset] === " ") offset += 1;
    if (!chunk) throw new Error("Hindsight could not split this source safely.");
    chunks.push(chunk);
  }
  return chunks;
}

function makeScopedEnvironment(baseEnvironment, paths, modelName = null) {
  const environment = { ...baseEnvironment };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("HINDSIGHT_") || /(?:^|_)API_KEY$/i.test(key)) {
      delete environment[key];
    }
  }

  environment.HOME = paths.homeDirectory;
  environment.USERPROFILE = paths.homeDirectory;
  environment.HINDSIGHT_EMBED_PROFILE = PROFILE_NAME;
  environment.HINDSIGHT_API_HOST = "127.0.0.1";
  environment.HINDSIGHT_API_LLM_PROVIDER = "ollama";
  environment.HINDSIGHT_API_LLM_BASE_URL = OLLAMA_BASE_URL;
  environment.HINDSIGHT_API_DATABASE_URL = "pg0://hindsight-embed";
  environment.HINDSIGHT_EMBED_API_DATABASE_URL = "pg0://hindsight-embed";
  if (modelName) environment.HINDSIGHT_API_LLM_MODEL = modelName;
  else delete environment.HINDSIGHT_API_LLM_MODEL;
  return environment;
}

function parseRecallOutput(output) {
  let parsed;
  try {
    parsed = JSON.parse(output.trim());
  } catch {
    throw new Error("Hindsight returned an unreadable local memory result.");
  }
  const results = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.results)
      ? parsed.results
      : Array.isArray(parsed?.data?.results)
        ? parsed.data.results
        : null;
  if (!results) throw new Error("Hindsight returned an unsupported local memory result.");

  return results.flatMap((result) => {
    if (!result || typeof result !== "object") return [];
    const text = typeof result.text === "string"
      ? result.text.trim()
      : typeof result.content === "string"
        ? result.content.trim()
        : "";
    const context = typeof result.context === "string"
      ? result.context
      : typeof result.metadata?.context === "string"
        ? result.metadata.context
        : "";
    if (!text || !context) return [];
    return [{
      text,
      context,
      score: Number.isFinite(result.score) ? result.score : null,
    }];
  });
}

function normalizeState(value) {
  if (value === undefined || value === null) return { ...EMPTY_STATE };
  if (
    typeof value !== "object"
    || value.version !== 1
    || typeof value.enabled !== "boolean"
    || !(value.modelName === null || isSafeModelName(value.modelName))
    || !value.indexedSources
    || typeof value.indexedSources !== "object"
    || Array.isArray(value.indexedSources)
    || !Array.isArray(value.pendingCreates)
    || !value.pendingCreates.every((item) => typeof item === "string")
    || !Array.isArray(value.pendingDeletes)
    || !value.pendingDeletes.every((item) => typeof item === "string")
  ) {
    throw new Error("ThinkPink found unreadable Hindsight settings and left them unchanged.");
  }

  const indexedSources = {};
  for (const [key, source] of Object.entries(value.indexedSources)) {
    if (
      typeof source !== "object"
      || !isSafeSourceKind(source.kind)
      || typeof source.id !== "string"
      || sourceKey(source.kind, source.id) !== key
      || typeof source.title !== "string"
      || typeof source.contentHash !== "string"
      || typeof source.context !== "string"
      || !Array.isArray(source.documentIds)
      || !source.documentIds.every((documentId) => typeof documentId === "string")
    ) {
      throw new Error("ThinkPink found unreadable Hindsight source settings and left them unchanged.");
    }
    indexedSources[key] = {
      kind: source.kind,
      id: source.id,
      title: source.title,
      contentHash: source.contentHash,
      context: source.context,
      documentIds: [...source.documentIds],
    };
  }
  return {
    version: 1,
    enabled: value.enabled,
    modelName: value.modelName,
    indexedSources,
    pendingCreates: [...new Set(value.pendingCreates)],
    pendingDeletes: [...new Set(value.pendingDeletes)],
  };
}

function pythonCandidates(platform) {
  if (platform === "win32") {
    return [
      { command: "py", prefix: ["-3.11"] },
      { command: "py", prefix: ["-3"] },
      { command: "python3.11", prefix: [] },
      { command: "python", prefix: [] },
    ];
  }
  return [
    { command: "python3.11", prefix: [] },
    { command: "python3", prefix: [] },
    { command: "python", prefix: [] },
  ];
}

function parsePythonVersion(output) {
  const match = output.match(/(?:Python\s+)?(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  const [major, minor, patch] = match.slice(1).map((part) => Number(part ?? 0));
  if (major < 3 || (major === 3 && minor < 11)) return null;
  return { major, minor, patch };
}

function createHindsightService({
  userDataPath,
  platform = process.platform,
  baseEnvironment = process.env,
  spawnProcess = spawn,
} = {}) {
  if (typeof userDataPath !== "string" || !userDataPath) {
    throw new TypeError("A ThinkPink app data directory is required.");
  }

  const rootDirectory = path.join(userDataPath, "hindsight");
  const runtimeDirectory = path.join(rootDirectory, "runtime");
  const homeDirectory = path.join(rootDirectory, "home");
  const statePath = path.join(rootDirectory, "state.json");
  const runtimeMarkerPath = path.join(runtimeDirectory, ".thinkpink-hindsight-runtime");
  let activeChild = null;
  let busy = false;

  const paths = {
    rootDirectory,
    runtimeDirectory,
    homeDirectory,
    statePath,
    runtimeMarkerPath,
    pythonPath: platform === "win32"
      ? path.join(runtimeDirectory, "Scripts", "python.exe")
      : path.join(runtimeDirectory, "bin", "python"),
    cliPath: platform === "win32"
      ? path.join(runtimeDirectory, "Scripts", "hindsight-embed.exe")
      : path.join(runtimeDirectory, "bin", "hindsight-embed"),
  };

  async function exists(filePath) {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async function loadState() {
    let contents;
    try {
      contents = await fs.readFile(statePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { ...EMPTY_STATE };
      throw new Error("ThinkPink could not read its local Hindsight settings.");
    }
    try {
      return normalizeState(JSON.parse(contents));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("ThinkPink found unreadable Hindsight settings and left them unchanged.");
      }
      throw error;
    }
  }

  async function saveState(state) {
    await fs.mkdir(rootDirectory, { recursive: true });
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, statePath);
  }

  async function run(command, args, {
    timeoutMs = COMMAND_TIMEOUT_MS,
    modelName = null,
    signal,
    onProgress = () => {},
    safeFailure = "The local Hindsight operation failed.",
    allowNonZero = false,
  } = {}) {
    if (signal?.aborted) throw abortError();
    const environment = makeScopedEnvironment(baseEnvironment, paths, modelName);

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let outputBytes = 0;
      let settled = false;
      let timeout;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        activeChild = null;
        if (error) reject(error);
        else resolve(result);
      };
      const kill = () => {
        if (activeChild === child) {
          try {
            child.kill();
          } catch {
            // The process may already have exited.
          }
        }
      };
      const abort = () => {
        kill();
        finish(abortError());
      };

      let child;
      try {
        child = spawnProcess(command, args, {
          cwd: rootDirectory,
          env: environment,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        activeChild = child;
      } catch {
        finish(new Error(safeFailure));
        return;
      }

      const append = (target, chunk) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          kill();
          finish(new Error("The local Hindsight process returned too much output."));
          return;
        }
        if (target === "stdout") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };

      child.stdout?.on("data", (chunk) => append("stdout", chunk));
      child.stderr?.on("data", (chunk) => append("stderr", chunk));
      child.on("error", () => finish(new Error(safeFailure)));
      child.on("close", (code) => {
        if (code === 0 || allowNonZero) {
          finish(null, { code, stdout, stderr });
        } else {
          finish(new Error(safeFailure));
        }
      });
      if (signal) {
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }
      timeout = setTimeout(() => {
        kill();
        finish(new Error("The local Hindsight operation timed out. Try again when the local model is ready."));
      }, timeoutMs);
      timeout.unref?.();
    });
  }

  function cliArguments(args) {
    return run(paths.cliPath, args, {
      modelName: null,
      safeFailure: "ThinkPink could not communicate with the local Hindsight service.",
    });
  }

  function profileArguments(args) {
    return ["--profile", PROFILE_NAME, ...args];
  }

  async function findPython(onProgress) {
    const versionCommand = "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}')"
      + "; import venv";
    for (const candidate of pythonCandidates(platform)) {
      onProgress("Looking for Python 3.11 or newer");
      try {
        const result = await run(
          candidate.command,
          [...candidate.prefix, "-c", versionCommand],
          { timeoutMs: 10_000, safeFailure: "Python was not found." },
        );
        const version = parsePythonVersion(result.stdout);
        if (version) return { ...candidate, version };
      } catch {
        // Check the next standard Python command without changing the system.
      }
    }
    throw new Error("Hindsight needs Python 3.11 or newer. ThinkPink will not install a system-wide runtime.");
  }

  async function installRuntime({ signal, onProgress }) {
    if (await exists(paths.cliPath) && await exists(runtimeMarkerPath)) return;
    await fs.mkdir(rootDirectory, { recursive: true });
    if (await exists(runtimeDirectory)) {
      await fs.rm(runtimeDirectory, { recursive: true, force: true });
    }

    const python = await findPython(onProgress);
    onProgress("Creating an isolated Hindsight environment");
    await run(
      python.command,
      [...python.prefix, "-m", "venv", runtimeDirectory],
      {
        signal,
        timeoutMs: 60_000,
        safeFailure: "ThinkPink could not create an isolated Python environment for Hindsight.",
      },
    );

    onProgress("Downloading Hindsight Embed");
    await run(
      paths.pythonPath,
      ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", `hindsight-embed==${EMBED_VERSION}`],
      {
        signal,
        timeoutMs: INSTALL_TIMEOUT_MS,
        onProgress,
        safeFailure: "ThinkPink could not install Hindsight Embed. Check the connection and try again.",
      },
    );
    if (!(await exists(paths.cliPath))) {
      throw new Error("Hindsight Embed installed but its command could not be found in the isolated environment.");
    }
    await fs.writeFile(runtimeMarkerPath, `${EMBED_VERSION}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async function configureProfile(modelName, { signal, onProgress }) {
    if (!isSafeModelName(modelName)) {
      throw new TypeError("Choose a verified local Ollama model for Hindsight.");
    }
    const state = await loadState();
    if (state.modelName === modelName && await exists(paths.cliPath)) return state;

    if (state.modelName && await exists(paths.cliPath)) {
      await run(paths.cliPath, profileArguments(["daemon", "stop"]), {
        modelName,
        timeoutMs: 20_000,
        safeFailure: "ThinkPink could not stop the previous local Hindsight profile.",
        allowNonZero: true,
      });
    }
    onProgress("Configuring Hindsight to use local Ollama and pg0");
    const settings = [
      "HINDSIGHT_API_LLM_PROVIDER=ollama",
      `HINDSIGHT_API_LLM_MODEL=${modelName}`,
      `HINDSIGHT_API_LLM_BASE_URL=${OLLAMA_BASE_URL}`,
      "HINDSIGHT_API_HOST=127.0.0.1",
      "HINDSIGHT_API_DATABASE_URL=pg0://hindsight-embed",
      "HINDSIGHT_EMBED_API_DATABASE_URL=pg0://hindsight-embed",
    ];
    await run(
      paths.cliPath,
      ["configure", "--profile", PROFILE_NAME, ...settings.flatMap((value) => ["--env", value])],
      {
        modelName,
        signal,
        timeoutMs: COMMAND_TIMEOUT_MS,
        onProgress,
        safeFailure: "ThinkPink could not configure Hindsight for local Ollama.",
      },
    );

    const nextState = { ...state, modelName };
    await saveState(nextState);
    return nextState;
  }

  async function startDaemon(modelName, { signal, onProgress }) {
    onProgress("Starting the local Hindsight service");
    await run(paths.cliPath, profileArguments(["daemon", "start"]), {
      modelName,
      signal,
      timeoutMs: INSTALL_TIMEOUT_MS,
      onProgress,
      safeFailure: "ThinkPink could not start the local Hindsight service.",
    });
  }

  async function ensureReady({ modelName, signal, onProgress = () => {} } = {}) {
    const state = await loadState();
    if (!state.enabled) throw new Error("Enable Hindsight in Settings before using local memory.");
    const selectedModel = modelName || state.modelName;
    if (!isSafeModelName(selectedModel)) {
      throw new Error("Select a local Ollama model before using Hindsight.");
    }
    if (!(await exists(paths.cliPath))) {
      throw new Error("Hindsight Embed is not installed. Set it up in ThinkPink Settings first.");
    }
    const configuredState = await configureProfile(selectedModel, { signal, onProgress });
    await startDaemon(selectedModel, { signal, onProgress });
    return configuredState;
  }

  async function runPendingDeletes(state, modelName, signal) {
    const pending = [...new Set(state.pendingDeletes)];
    const pendingCreates = [...new Set(state.pendingCreates)];
    if (!pending.length && !pendingCreates.length) return state;
    const remainingDeletes = [];
    const remainingCreates = [];
    for (const documentId of pendingCreates) {
      try {
        await run(paths.cliPath, profileArguments(["document", "delete", BANK_NAME, documentId]), {
          modelName,
          signal,
          timeoutMs: COMMAND_TIMEOUT_MS,
          safeFailure: "ThinkPink could not remove an incomplete Hindsight record.",
        });
      } catch {
        remainingCreates.push(documentId);
      }
    }
    for (const documentId of pending) {
      try {
        await run(paths.cliPath, profileArguments(["document", "delete", BANK_NAME, documentId]), {
          modelName,
          signal,
          timeoutMs: COMMAND_TIMEOUT_MS,
          safeFailure: "ThinkPink could not remove an outdated Hindsight record.",
        });
      } catch {
        remainingDeletes.push(documentId);
      }
    }
    if (
      remainingDeletes.length !== state.pendingDeletes.length
      || remainingCreates.length !== state.pendingCreates.length
    ) {
      const nextState = {
        ...state,
        pendingCreates: remainingCreates,
        pendingDeletes: remainingDeletes,
      };
      await saveState(nextState);
      return nextState;
    }
    return state;
  }

  async function getStatus() {
    const state = await loadState();
    const runtimeInstalled = await exists(paths.cliPath) && await exists(runtimeMarkerPath);
    return {
      runtimeInstalled,
      enabled: runtimeInstalled && state.enabled,
      modelName: state.modelName,
      indexedSources: Object.values(state.indexedSources).map(({ kind, id, title, contentHash }) => ({
        kind,
        id,
        title,
        contentHash,
      })),
      pendingCleanupCount: state.pendingDeletes.length + state.pendingCreates.length,
      busy,
    };
  }

  async function setup({ modelName, signal, onProgress = () => {} } = {}) {
    if (busy) throw new Error("A Hindsight operation is already running.");
    if (!isSafeModelName(modelName)) throw new TypeError("Choose a verified local Ollama model first.");
    busy = true;
    try {
      await fs.mkdir(homeDirectory, { recursive: true });
      await installRuntime({ signal, onProgress });
      await configureProfile(modelName, { signal, onProgress });
      await startDaemon(modelName, { signal, onProgress });
      const state = await loadState();
      await saveState({ ...state, enabled: true, modelName });
      return getStatus();
    } finally {
      busy = false;
    }
  }

  async function setEnabled(enabled, { modelName, signal, onProgress = () => {} } = {}) {
    if (typeof enabled !== "boolean") throw new TypeError("Hindsight setting is not valid.");
    if (busy) throw new Error("A Hindsight operation is already running.");
    busy = true;
    try {
      const state = await loadState();
      if (!enabled) {
        await saveState({ ...state, enabled: false });
        if (await exists(paths.cliPath)) {
          try {
            await run(paths.cliPath, profileArguments(["daemon", "stop"]), {
              modelName: state.modelName,
              timeoutMs: 20_000,
              safeFailure: "ThinkPink could not stop the local Hindsight service.",
              allowNonZero: true,
            });
          } catch {
            // Hindsight has an idle shutdown; disabling stays effective even if stop fails.
          }
        }
        return getStatus();
      }
      if (!(await exists(paths.cliPath))) {
        throw new Error("Set up Hindsight first. ThinkPink will ask before downloading its local components.");
      }
      const selectedModel = modelName || state.modelName;
      if (!isSafeModelName(selectedModel)) {
        throw new Error("Select a local Ollama model before enabling Hindsight.");
      }
      await configureProfile(selectedModel, { signal, onProgress });
      await startDaemon(selectedModel, { signal, onProgress });
      const nextState = await loadState();
      await saveState({ ...nextState, enabled: true, modelName: selectedModel });
      return getStatus();
    } finally {
      busy = false;
    }
  }

  async function indexSource(source, { modelName, signal, onProgress = () => {} } = {}) {
    if (busy) throw new Error("A Hindsight operation is already running.");
    const normalized = normalizeSource(source);
    busy = true;
    try {
      let state = await ensureReady({ modelName, signal, onProgress });
      state = await runPendingDeletes(state, state.modelName, signal);
      const key = sourceKey(normalized.kind, normalized.id);
      const contentHash = hash(normalized.content);
      const previous = state.indexedSources[key];
      if (previous?.contentHash === contentHash) return getStatus();

      const chunks = splitText(normalized.content);
      const sourceHash = hash(normalized.id).slice(0, 16);
      const revision = contentHash.slice(0, 16);
      const context = `thinkpink/${normalized.kind}/${sourceHash}/${revision}`;
      const documentIds = chunks.map((_, index) =>
        `tp-${normalized.kind}-${sourceHash}-${revision}-${index}`,
      );

      const pendingCreates = [...new Set([...state.pendingCreates, ...documentIds])];
      state = { ...state, pendingCreates };
      await saveState(state);

      for (let index = 0; index < chunks.length; index += 1) {
        onProgress(`Adding local source segment ${index + 1} of ${chunks.length}`);
        await run(paths.cliPath, profileArguments([
          "memory",
          "retain",
          BANK_NAME,
          chunks[index],
          "--context",
          context,
          "--doc-id",
          documentIds[index],
        ]), {
          modelName: state.modelName,
          signal,
          timeoutMs: COMMAND_TIMEOUT_MS,
          safeFailure: "ThinkPink could not add this source to local Hindsight memory.",
        });
      }

      state = await loadState();
      const oldDocumentIds = previous?.documentIds ?? [];
      state = {
        ...state,
        pendingCreates: state.pendingCreates.filter((id) => !documentIds.includes(id)),
        pendingDeletes: [...new Set([...state.pendingDeletes, ...oldDocumentIds])],
        indexedSources: {
          ...state.indexedSources,
          [key]: {
            kind: normalized.kind,
            id: normalized.id,
            title: normalized.title,
            contentHash,
            context,
            documentIds,
          },
        },
      };
      await saveState(state);
      state = await runPendingDeletes(state, state.modelName);
      return getStatus();
    } finally {
      busy = false;
    }
  }

  async function forgetSource(kind, id, { signal } = {}) {
    const key = sourceKey(kind, id);
    if (busy) throw new Error("A Hindsight operation is already running.");
    busy = true;
    try {
      let state = await loadState();
      const source = state.indexedSources[key];
      const sourceHash = hash(id).slice(0, 16);
      const pendingSourceCreates = state.pendingCreates.filter((documentId) =>
        documentId.startsWith(`tp-${kind}-${sourceHash}-`),
      );
      if (!source && pendingSourceCreates.length === 0) return getStatus();
      state = {
        ...state,
        indexedSources: Object.fromEntries(
          Object.entries(state.indexedSources).filter(([sourceId]) => sourceId !== key),
        ),
        pendingCreates: state.pendingCreates.filter((documentId) =>
          !pendingSourceCreates.includes(documentId),
        ),
        pendingDeletes: [...new Set([
          ...state.pendingDeletes,
          ...(source?.documentIds ?? []),
          ...pendingSourceCreates,
        ])],
      };
      await saveState(state);
      if (await exists(paths.cliPath)) {
        state = await runPendingDeletes(state, state.modelName, signal);
      }
      return getStatus();
    } finally {
      busy = false;
    }
  }

  async function forgetAll({ signal } = {}) {
    if (busy) throw new Error("A Hindsight operation is already running.");
    busy = true;
    try {
      let state = await loadState();
      const allDocumentIds = [
        ...state.pendingCreates,
        ...state.pendingDeletes,
        ...Object.values(state.indexedSources).flatMap((source) => source.documentIds),
      ];
      state = {
        ...state,
        indexedSources: {},
        pendingCreates: [],
        pendingDeletes: [...new Set([...state.pendingDeletes, ...allDocumentIds])],
      };
      await saveState(state);
      if (await exists(paths.cliPath)) {
        state = await runPendingDeletes(state, state.modelName, signal);
      }
      if (state.pendingDeletes.length) {
        throw new Error("Some Hindsight records could not be deleted yet. ThinkPink will keep them marked for cleanup.");
      }
      return getStatus();
    } finally {
      busy = false;
    }
  }

  async function syncIfIndexed(source, options = {}) {
    const normalized = normalizeSource(source);
    const state = await loadState();
    const key = sourceKey(normalized.kind, normalized.id);
    const previous = state.indexedSources[key];
    if (!previous) {
      return { synced: false, status: await getStatus() };
    }
    if (previous.contentHash === hash(normalized.content)) {
      return { synced: false, status: await getStatus() };
    }
    if (busy) throw new Error("A Hindsight operation is already running.");
    if (!state.enabled) {
      return {
        synced: false,
        status: await forgetSource(normalized.kind, normalized.id, options),
      };
    }
    await saveState({
      ...state,
      indexedSources: Object.fromEntries(
        Object.entries(state.indexedSources).filter(([sourceId]) => sourceId !== key),
      ),
      pendingDeletes: [...new Set([
        ...state.pendingDeletes,
        ...previous.documentIds,
      ])],
    });
    const status = await indexSource(normalized, options);
    return { synced: true, status };
  }

  async function recall(query, { modelName, limit = 10, signal, onProgress = () => {} } = {}) {
    if (typeof query !== "string" || !query.trim() || query.length > 4_000) {
      return { results: [], status: await getStatus() };
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new TypeError("Choose a valid local memory result limit.");
    }
    if (busy) throw new Error("A Hindsight operation is already running.");
    busy = true;
    try {
      let state = await ensureReady({ modelName, signal, onProgress });
        state = await runPendingDeletes(state, state.modelName, signal);
      const result = await run(paths.cliPath, profileArguments([
        "memory",
        "recall",
        BANK_NAME,
        query.trim(),
        "--max-tokens",
        "8192",
        "-o",
        "json",
      ]), {
        modelName: state.modelName,
        signal,
        timeoutMs: COMMAND_TIMEOUT_MS,
        safeFailure: "ThinkPink could not search local Hindsight memory.",
      });
      const records = parseRecallOutput(result.stdout);
      const currentSources = new Map(
        Object.values(state.indexedSources).map((source) => [source.context, source]),
      );
      return {
        results: records
          .filter((record) => currentSources.has(record.context))
          .slice(0, limit)
          .map((record) => {
            const source = currentSources.get(record.context);
            return {
              ...record,
              kind: source.kind,
              sourceId: source.id,
              title: source.title,
            };
          }),
        status: await getStatus(),
      };
    } finally {
      busy = false;
    }
  }

  async function generateDraft(source, { modelName, signal, onProgress = () => {} } = {}) {
    const normalized = normalizeSource(source);
    if (normalized.kind !== "thread") {
      throw new TypeError("Wiki drafts can only be generated from a chat thread.");
    }
    await indexSource(normalized, { modelName, signal, onProgress });
    const recallResult = await recall(
      `Important facts, decisions, and useful explanations from this conversation: ${normalized.title}\n${normalized.content.slice(0, 1_000)}`,
      { modelName, limit: 20, signal, onProgress },
    );
    const facts = [...new Set(
      recallResult.results
        .filter((result) => result.kind === "thread" && result.sourceId === normalized.id)
        .map((result) => result.text),
    )].slice(0, 8);
    if (!facts.length) {
      throw new Error("Hindsight did not find any useful facts from this thread. Try a longer conversation or add more detail.");
    }
    return {
      title: `${normalized.title.trim() || "Conversation"} notes`.slice(0, 120),
      body: facts.map((fact) => `- ${fact}`).join("\n"),
      category: "Conversation notes",
      tags: ["hindsight"],
    };
  }

  async function shutdown() {
    if (!(await exists(paths.cliPath))) return;
    if (busy) {
      cancelActiveOperation();
      const deadline = Date.now() + 4_000;
      while (busy && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (busy) return;
    }
    try {
      const state = await loadState();
      if (state.modelName) {
        await run(paths.cliPath, profileArguments(["daemon", "stop"]), {
          modelName: state.modelName,
          timeoutMs: 15_000,
          safeFailure: "ThinkPink could not stop the local Hindsight service.",
          allowNonZero: true,
        });
      }
    } catch {
      // Hindsight's own idle shutdown remains a safe fallback.
    }
  }

  function cancelActiveOperation() {
    if (activeChild) {
      try {
        activeChild.kill();
      } catch {
        // The operation may have already exited.
      }
    }
  }

  return {
    getStatus,
    setup,
    setEnabled,
    indexSource,
    forgetSource,
    forgetAll,
    syncIfIndexed,
    recall,
    generateDraft,
    shutdown,
    cancelActiveOperation,
    paths: Object.freeze({ ...paths }),
  };
}

function normalizeSource(source) {
  if (
    !source
    || !isSafeSourceKind(source.kind)
    || typeof source.id !== "string"
    || !source.id
    || source.id.length > 128
    || typeof source.title !== "string"
    || source.title.length > 180
    || typeof source.content !== "string"
    || source.content.length > MAX_SOURCE_CHARACTERS
  ) {
    throw new TypeError("The local source is not valid for Hindsight.");
  }
  return {
    kind: source.kind,
    id: source.id,
    title: source.title.slice(0, 180),
    content: source.content,
  };
}

function abortError() {
  const error = new Error("Hindsight operation cancelled.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

module.exports = {
  BANK_NAME,
  EMBED_VERSION,
  PROFILE_NAME,
  createHindsightService,
  isSafeModelName,
  makeScopedEnvironment,
  normalizeSource,
  normalizeState,
  parsePythonVersion,
  parseRecallOutput,
  pythonCandidates,
  sourceKey,
  splitText,
};