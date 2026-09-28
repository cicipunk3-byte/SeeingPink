const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MAX_SOURCE_BYTES = 30_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_OUTPUT_LIMIT = 12_000;

function result(status, message, output = "") {
  return { status, message, output };
}

function buildEnvironment(platform, tempDir, parentEnv) {
  const env = {};
  if (parentEnv.PATH) env.PATH = parentEnv.PATH;

  if (platform === "win32") {
    for (const key of ["SYSTEMROOT", "WINDIR", "PATHEXT"]) {
      if (parentEnv[key]) env[key] = parentEnv[key];
    }
    env.TEMP = tempDir;
    env.TMP = tempDir;
    env.USERPROFILE = tempDir;
  } else {
    env.HOME = tempDir;
    env.TMPDIR = tempDir;
    env.LANG = "C";
  }

  return env;
}

function getCommands(language, platform, sourceName, outputDir) {
  if (language === "java") {
    return [
      {
        command: "javac",
        args: ["-proc:none", "-d", outputDir, sourceName],
      },
    ];
  }

  const compileArgs = ["-I", "-m", "py_compile", sourceName];
  if (platform === "win32") {
    return [
      { command: "py", args: ["-3", ...compileArgs] },
      { command: "python", args: compileArgs },
      { command: "python3", args: compileArgs },
    ];
  }

  return [
    { command: "python3", args: compileArgs },
    { command: "python", args: compileArgs },
  ];
}

function sanitizeOutput(output, tempDir) {
  if (!output) return "";
  const candidates = [
    tempDir,
    tempDir.replaceAll("\\", "/"),
    tempDir.replaceAll("/", "\\"),
  ];
  return candidates.reduce(
    (text, candidate) => text.split(candidate).join("[temporary check folder]"),
    output,
  );
}

function runCompiler(command, args, options, setActiveJob) {
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let outputLength = 0;
    let settled = false;
    let timer;
    let timedOut = false;
    let outputLimited = false;
    let cancelled = false;

    const job = {
      cancel: () => {
        if (settled) return;
        cancelled = true;
        try {
          child?.kill("SIGKILL");
        } catch {
          // The process may have exited between the check and the kill.
        }
      },
    };

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setActiveJob(null);
      resolve({ ...value, stdout, stderr });
    }

    try {
      child = options.spawnProcess(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      setActiveJob(job);
    } catch {
      finish({ kind: "error" });
      return;
    }

    const append = (stream, chunk) => {
      if (settled || timedOut || outputLimited || cancelled) return;
      const text = String(chunk);
      const remaining = Math.max(0, options.outputLimit - outputLength);
      const accepted = text.slice(0, remaining);
      outputLength += accepted.length;
      if (stream === "stdout") stdout += accepted;
      else stderr += accepted;

      if (text.length > remaining) {
        outputLimited = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // The process may already have exited.
        }
      }
    };

    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    child.once("error", (error) => {
      finish({ kind: error && error.code === "ENOENT" ? "missing" : "error" });
    });
    child.once("close", (code) => {
      if (cancelled) return finish({ kind: "cancelled" });
      if (timedOut) return finish({ kind: "timed-out" });
      if (outputLimited) return finish({ kind: "output-limit" });
      finish({ kind: "closed", code: Number.isInteger(code) ? code : 1 });
    });

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already have exited.
      }
    }, options.timeoutMs);
  });
}

function createCodeChecker({
  spawnProcess = spawn,
  platform = process.platform,
  tempRoot = os.tmpdir(),
  parentEnv = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  outputLimit = DEFAULT_OUTPUT_LIMIT,
  maxSourceBytes = MAX_SOURCE_BYTES,
} = {}) {
  let busy = false;
  let activeJob = null;

  async function checkCode(language, source) {
    if (busy) {
      return result("busy", "A code check is already in progress.");
    }
    if (!["java", "python"].includes(language)) {
      return result("error", "Choose Java or Python before checking code.");
    }
    if (typeof source !== "string") {
      return result("error", "The code must be text.");
    }
    if (Buffer.byteLength(source, "utf8") > maxSourceBytes) {
      return result("error", "The code is too large to check. Shorten it and try again.");
    }

    busy = true;
    let tempDir;
    try {
      tempDir = fs.mkdtempSync(path.join(tempRoot, "thinkpink-code-check-"));
      const sourceName = language === "java" ? "Main.java" : "main.py";
      const sourcePath = path.join(tempDir, sourceName);
      fs.writeFileSync(sourcePath, source, { encoding: "utf8", mode: 0o600, flag: "wx" });

      const commands = getCommands(language, platform, sourceName, tempDir);
      const env = buildEnvironment(platform, tempDir, parentEnv);

      for (const entry of commands) {
        const processResult = await runCompiler(entry.command, entry.args, {
          cwd: tempDir,
          env,
          spawnProcess,
          timeoutMs,
          outputLimit,
        }, (job) => {
          activeJob = job;
        });

        if (processResult.kind === "missing") continue;
        if (processResult.kind === "cancelled") {
          return result("cancelled", "The code check was cancelled.");
        }
        if (processResult.kind === "timed-out") {
          return result("timed-out", "The code check took too long and was stopped.");
        }
        if (processResult.kind === "output-limit") {
          return result(
            "output-limit",
            "The compiler produced too much output and was stopped.",
            sanitizeOutput(`${processResult.stdout}${processResult.stderr}`, tempDir),
          );
        }
        if (processResult.kind === "error") {
          return result("error", "ThinkPink could not start the local code check.");
        }
        if (processResult.kind === "closed" && processResult.code !== 0) {
          return result(
            "compile-error",
            "The compiler found issues. Review its message and update your code.",
            sanitizeOutput(`${processResult.stdout}${processResult.stderr}`, tempDir),
          );
        }

        const message = language === "java"
          ? "Java compilation passed. This checks compilation only and does not run your program."
          : "Python syntax check passed. This checks syntax only and does not run your program.";
        return result("passed", message);
      }

      const runtimeName = language === "java" ? "a Java JDK with javac" : "Python 3";
      return result(
        "runtime-missing",
        `${runtimeName} was not found on this computer. Install it to enable this check; ThinkPink does not install language runtimes.`,
      );
    } catch {
      return result("error", "ThinkPink could not complete the local code check.");
    } finally {
      activeJob = null;
      busy = false;
      if (tempDir) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // Temporary source and compiler output are best-effort cleanup.
        }
      }
    }
  }

  function cancelActive() {
    activeJob?.cancel();
  }

  return { checkCode, cancelActive };
}

module.exports = {
  DEFAULT_OUTPUT_LIMIT,
  DEFAULT_TIMEOUT_MS,
  MAX_SOURCE_BYTES,
  createCodeChecker,
};