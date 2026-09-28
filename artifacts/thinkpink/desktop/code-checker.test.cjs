const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const { createCodeChecker } = require("./code-checker.cjs");

function fakeSpawn({ code = 0, stdout = "", stderr = "", error, hold = false } = {}) {
  const calls = [];
  let child;
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.killed = true;
      if (!hold) return true;
      setImmediate(() => child.emit("close", null, "SIGKILL"));
      return true;
    };
    setImmediate(() => {
      if (error) {
        child.emit("error", error);
        return;
      }
      if (hold) return;
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      child.emit("close", code, null);
    });
    return child;
  };

  return { calls, spawnProcess, getChild: () => child };
}

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "thinkpink-code-check-test-"));
}

function assertTempFilesRemoved(tempRoot, calls) {
  for (const call of calls) {
    assert.equal(fs.existsSync(call.options.cwd), false);
  }
  assert.deepEqual(fs.readdirSync(tempRoot), []);
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

test("Java checks compile into a temporary directory without running code", async () => {
  const fake = fakeSpawn();
  const tempRoot = createTempRoot();
  const checker = createCodeChecker({
    spawnProcess: fake.spawnProcess,
    platform: "darwin",
    parentEnv: { PATH: "/test/bin" },
    tempRoot,
  });

  const checked = await checker.checkCode("java", "class Main {}");

  assert.equal(checked.status, "passed");
  assert.match(checked.message, /does not run your program/);
  assert.equal(fake.calls[0].command, "javac");
  assert.deepEqual(fake.calls[0].args.slice(0, 2), ["-proc:none", "-d"]);
  assert.equal(fake.calls[0].args[2], fake.calls[0].options.cwd);
  assert.equal(fake.calls[0].args[3], "Main.java");
  assert.equal(fake.calls[0].options.shell, false);
  assert.deepEqual(Object.keys(fake.calls[0].options.env).sort(), ["HOME", "LANG", "PATH", "TMPDIR"]);
  assert.equal(fs.existsSync(fake.calls[0].options.cwd), false);
  assertTempFilesRemoved(tempRoot, fake.calls);
});

test("Python checks syntax in isolated mode and writes only in a temporary folder", async () => {
  const fake = fakeSpawn();
  const tempRoot = createTempRoot();
  const checker = createCodeChecker({
    spawnProcess: fake.spawnProcess,
    platform: "linux",
    parentEnv: { PATH: "/test/bin", PYTHONPATH: "/private/path" },
    tempRoot,
  });

  const checked = await checker.checkCode("python", "print('hello')");

  assert.equal(checked.status, "passed");
  assert.equal(fake.calls[0].command, "python3");
  assert.deepEqual(fake.calls[0].args, ["-I", "-m", "py_compile", "main.py"]);
  assert.equal(fake.calls[0].options.env.PYTHONPATH, undefined);
  assert.equal(fake.calls[0].options.shell, false);
  assert.equal(fs.existsSync(fake.calls[0].options.cwd), false);
  assertTempFilesRemoved(tempRoot, fake.calls);
});

test("Windows Python falls back from the launcher to python", async () => {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      if (command === "py") {
        const error = new Error("missing launcher");
        error.code = "ENOENT";
        child.emit("error", error);
      } else {
        child.emit("close", 0, null);
      }
    });
    return child;
  };
  const checker = createCodeChecker({
    spawnProcess,
    platform: "win32",
    parentEnv: { PATH: "C:\\tools", SYSTEMROOT: "C:\\Windows" },
  });

  const checked = await checker.checkCode("python", "print('hello')");

  assert.equal(checked.status, "passed");
  assert.deepEqual(calls.map((call) => call.command), ["py", "python"]);
  assert.deepEqual(calls[0].args, ["-3", "-I", "-m", "py_compile", "main.py"]);
});

test("missing compilers return a clear setup message", async () => {
  const fake = fakeSpawn({ error: Object.assign(new Error("missing"), { code: "ENOENT" }) });
  const tempRoot = createTempRoot();
  const checker = createCodeChecker({
    spawnProcess: fake.spawnProcess,
    platform: "linux",
    parentEnv: { PATH: "/empty" },
    tempRoot,
  });

  const checked = await checker.checkCode("java", "class Main {}");

  assert.equal(checked.status, "runtime-missing");
  assert.match(checked.message, /Java JDK with javac was not found/);
  assert.match(checked.message, /Install it to enable this check/);
  assertTempFilesRemoved(tempRoot, fake.calls);
});

test("missing Python 3 gives setup guidance and removes temporary files", async () => {
  const fake = fakeSpawn({ error: Object.assign(new Error("missing"), { code: "ENOENT" }) });
  const tempRoot = createTempRoot();
  const checker = createCodeChecker({
    spawnProcess: fake.spawnProcess,
    platform: "linux",
    parentEnv: { PATH: "/empty" },
    tempRoot,
  });

  const checked = await checker.checkCode("python", "print('hello')");

  assert.equal(checked.status, "runtime-missing");
  assert.match(checked.message, /Python 3 was not found/);
  assert.match(checked.message, /Install it to enable this check/);
  assert.deepEqual(fake.calls.map((call) => call.command), ["python3", "python"]);
  assertTempFilesRemoved(tempRoot, fake.calls);
});

test("compiler errors are shown without temporary file paths", async () => {
  const fake = fakeSpawn({ code: 1, stderr: "Main.java:1: error: missing symbol" });
  const tempRoot = createTempRoot();
  const checker = createCodeChecker({
    spawnProcess: fake.spawnProcess,
    platform: "linux",
    parentEnv: { PATH: "/test/bin" },
    tempRoot,
  });

  const checked = await checker.checkCode("java", "class Main { Missing value; }");

  assert.equal(checked.status, "compile-error");
  assert.match(checked.output, /missing symbol/);
  assert.doesNotMatch(checked.output, /thinkpink-code-check-/);
  assertTempFilesRemoved(tempRoot, fake.calls);
});

test("oversized source is rejected before starting a compiler", async () => {
  const fake = fakeSpawn();
  const checker = createCodeChecker({
    spawnProcess: fake.spawnProcess,
    maxSourceBytes: 4,
  });

  const checked = await checker.checkCode("python", "print('large')");

  assert.equal(checked.status, "error");
  assert.equal(fake.calls.length, 0);
});

test("a check can be stopped and a timed out check is reported", async () => {
  const fake = fakeSpawn({ hold: true });
  const tempRoot = createTempRoot();
  const checker = createCodeChecker({
    spawnProcess: fake.spawnProcess,
    timeoutMs: 10,
    tempRoot,
  });
  const pending = checker.checkCode("java", "class Main {}");

  const checked = await pending;

  assert.equal(checked.status, "timed-out");
  assert.equal(fake.getChild().killed, true);
  assertTempFilesRemoved(tempRoot, fake.calls);
});

test("a user can cancel the active compiler check", async () => {
  const fake = fakeSpawn({ hold: true });
  const tempRoot = createTempRoot();
  const checker = createCodeChecker({
    spawnProcess: fake.spawnProcess,
    timeoutMs: 500,
    tempRoot,
  });
  const pending = checker.checkCode("java", "class Main {}");
  await new Promise((resolve) => setImmediate(resolve));
  checker.cancelActive();

  const checked = await pending;

  assert.equal(checked.status, "cancelled");
  assertTempFilesRemoved(tempRoot, fake.calls);
});

test("excessive compiler output is capped and stops the process", async () => {
  const fake = fakeSpawn({ stderr: "too much output" });
  const checker = createCodeChecker({
    spawnProcess: fake.spawnProcess,
    outputLimit: 4,
  });

  const checked = await checker.checkCode("java", "class Main {}");

  assert.equal(checked.status, "output-limit");
  assert.ok(checked.output.length <= 4);
});