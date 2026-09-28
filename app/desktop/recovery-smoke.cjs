// Run against an unpacked Linux Electron build, not the Vite browser preview.
// Usage: node desktop/recovery-smoke.cjs release/0.1.0/linux-unpacked/@workspacethinkpink
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const executable = path.resolve(process.argv[2] || "");
if (!process.argv[2] || !fs.existsSync(executable)) {
  throw new Error("Pass the executable from an unpacked Linux ThinkPink package.");
}
if (process.platform !== "linux") {
  throw new Error("This automated smoke check uses Linux's xdg-open. Check macOS/Windows packages manually.");
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function port() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const number = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return number;
}

async function connect(debugPort) {
  let target;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      target = pages.find((page) => page.type === "page" && page.url.startsWith("thinkpink://app/"));
      if (target) break;
    } catch {}
    await delay(250);
  }
  assert.ok(target, "Packaged ThinkPink did not open its native page");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  });
  function send(method, params = {}) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
  return {
    send, evaluate, close: () => socket.close(),
  };
}

async function waitFor(check, description) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "thinkpink-recovery-"));
  const debugPort = await port();
  const opener = path.join(temporary, "xdg-open");
  const openedUrl = path.join(temporary, "opened-url");
  // No network/browser launch; record the URL passed to the OS by shell.openExternal.
  fs.writeFileSync(opener, `#!/bin/sh\nprintf '%s' "$1" > "${openedUrl}"\n`, { mode: 0o755 });
  const child = spawn(executable, [`--remote-debugging-port=${debugPort}`, "--no-sandbox"], {
    env: {
      ...process.env,
      PATH: `${temporary}:${process.env.PATH}`,
      XDG_CURRENT_DESKTOP: "test",
      // Keep this check separate from the user's real ThinkPink profile.
      XDG_CONFIG_HOME: temporary,
    },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString().slice(0, 1000); });
  let client;
  try {
    client = await connect(debugPort);
    await waitFor(async () => client.evaluate(`Boolean(
      window.thinkPink &&
      document.querySelector('[data-testid="button-retry-connection"]') &&
      document.body.textContent.includes('Ollama is not responding')
    )`), "native Ollama-unavailable recovery panel");

    let windowId;
    await waitFor(() => {
      try {
        windowId = execFileSync("xdotool", ["search", "--pid", String(child.pid), "--onlyvisible"], { encoding: "utf8" }).trim().split("\n")[0];
        return Boolean(windowId);
      } catch { return false; }
    }, "visible Electron window");
    for (const [label, width, height] of [["narrow", 920, 660], ["desktop", 1200, 820]]) {
      execFileSync("xdotool", ["windowsize", "--sync", windowId, String(width), String(height)]);
      await delay(500);
      const top = await client.evaluate(`(() => {
        const main = document.querySelector('main');
        const panel = document.querySelector('.recovery-glass');
        const title = panel?.querySelector('p');
        const explanation = title?.nextElementSibling;
        const area = main?.getBoundingClientRect();
        const visible = (element) => {
          if (!element) return false;
          const rect = element.getBoundingClientRect();
          const center = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return rect.width > 0 && rect.height > 0 &&
            rect.left >= area.left && rect.right <= area.right + 1 &&
            rect.top >= 0 && rect.bottom <= innerHeight &&
            (center === element || element.contains(center));
        };
        return {
          width: innerWidth, height: innerHeight,
          nativeBridge: Boolean(window.thinkPink),
          previewCopy: document.body.textContent.includes('browser preview cannot reach'),
          titleVisible: visible(title), explanationVisible: visible(explanation),
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
          textClipped: [title, explanation].some(el => el && el.scrollWidth > el.clientWidth + 2),
        };
      })()`);
      assert.equal(top.nativeBridge, true, `${label}: missing desktop bridge`);
      assert.equal(top.previewCopy, false, `${label}: showed browser-preview message`);
      assert.ok(top.width >= width - 30 && top.height >= height - 100, `${label}: wrong window dimensions ${JSON.stringify(top)}`);
      assert.ok(top.titleVisible && top.explanationVisible, `${label}: recovery text obscured ${JSON.stringify(top)}`);
      assert.equal(top.horizontalOverflow || top.textClipped, false, `${label}: clipped content`);
      await client.evaluate(`document.querySelector('[data-testid="button-open-ollama-download"]').scrollIntoView({ block: 'center' })`);
      await delay(300);
      const controls = await client.evaluate(`(() => {
        const buttons = [
          document.querySelector('[data-testid="button-retry-connection"]'),
          document.querySelector('[data-testid="button-open-ollama-download"]')
        ];
        return buttons.map(button => {
          const rect = button.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return rect.top >= 0 && rect.bottom <= innerHeight &&
            rect.left >= 0 && rect.right <= innerWidth &&
            (hit === button || button.contains(hit)) &&
            button.scrollWidth <= button.clientWidth + 2;
        });
      })()`);
      assert.deepEqual(controls, [true, true], `${label}: recovery controls clipped or obscured after scrolling`);
      const image = await client.send("Page.captureScreenshot", { format: "png" });
      const screenshot = path.join(temporary, `recovery-${label}.png`);
      fs.writeFileSync(screenshot, Buffer.from(image.data, "base64"));
      console.log(`${label}: recovery text readable and controls reachable (${top.width}x${top.height}); ${screenshot}`);
    }

    await client.evaluate(`(() => {
      window.__recoverySawChecking = false;
      const observer = new MutationObserver(() => {
        if (document.body.textContent.includes('Checking only your local Ollama service')) {
          window.__recoverySawChecking = true;
          observer.disconnect();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      document.querySelector('[data-testid="button-retry-connection"]').click();
    })()`);
    await waitFor(async () => client.evaluate(`Boolean(
      window.__recoverySawChecking &&
      document.querySelector('[data-testid="button-retry-connection"]') &&
      document.body.textContent.includes('Ollama is not responding')
    )`), "retry to return to recovery");
    await client.evaluate(`document.querySelector('[data-testid="button-open-ollama-download"]').click()`);
    await waitFor(async () => fs.existsSync(openedUrl), "official download link handed to the OS");
    assert.equal(fs.readFileSync(openedUrl, "utf8"), "https://ollama.com/download");
    console.log("Retry returned to recovery; official download URL was passed to the OS.");
  } catch (error) {
    console.error(`Packaged smoke check failed: ${error.message}\n${stderr.slice(-2000)}`);
    throw error;
  } finally {
    client?.close();
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    // Leave screenshots in the printed temporary directory for inspection.
  }
}

main().catch(() => { process.exitCode = 1; });