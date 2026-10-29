// Regenerates the interface captures in docs/assets/ from a running studio in mock mode.
// Drives headless Chrome over the DevTools protocol with Node built-ins only (no Playwright).
//
//   AGENT_PROVIDER=mock ... node .next/standalone/server.js        # or `pnpm dev`
//   CHROME_PATH=/path/to/chrome-headless-shell node scripts/capture-showcase.mjs [base-url]
//
// CHROME_PATH must be a classic headless build (e.g. Playwright's chrome-headless-shell);
// a full Chrome in --headless=new mode stalls on navigation over CDP.
//
// Captures:
//   docs/assets/studio-preview.png       chat streaming a React artifact, live highlighted code
//   docs/assets/studio-live-preview.png  a finished HTML artifact running in the sandbox
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:3000";
const OUT_DIR = path.resolve(import.meta.dirname, "../docs/assets");
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 };

const chromePath = process.env.CHROME_PATH;
if (chromePath === undefined || chromePath === "") {
  console.error("Set CHROME_PATH to a Chrome or Chromium binary.");
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launch() {
  const profile = await mkdtemp(path.join(tmpdir(), "studio-capture-"));
  const chrome = spawn(
    chromePath,
    [
      "--headless",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await new Promise((resolve, reject) => {
    let output = "";
    chrome.stderr.on("data", (chunk) => {
      output += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match) resolve(match[1]);
    });
    chrome.on("exit", (code) => reject(new Error(`Chrome exited early (${code}): ${output}`)));
  });
  const close = async () => {
    chrome.kill();
    await rm(profile, { recursive: true, force: true });
  };
  return { endpoint, close };
}

/** Minimal CDP session over one page target. */
async function connect(browserEndpoint) {
  const { port } = new URL(browserEndpoint);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((target) => target.type === "page");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("DevTools connection refused")), {
      once: true,
    });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value;
  };
  const waitFor = async (expression, label, timeoutMs = 30_000) => {
    process.stdout.write(`… waiting for ${label}\n`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await sleep(50);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  return { send, evaluate, waitFor, close: () => socket.close() };
}

async function ask(page, prompt) {
  await page.evaluate(`document.getElementById("chat-input").focus()`);
  await page.send("Input.insertText", { text: prompt });
  for (const type of ["keyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      ...(type === "keyDown" ? { text: "\r" } : {}),
    });
  }
}

async function capture(page, file) {
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  await writeFile(path.join(OUT_DIR, file), Buffer.from(data, "base64"));
  process.stdout.write(`✔ docs/assets/${file}\n`);
}

const idle = `!!document.querySelector('button[aria-label="Send message"]')`;
const tab = (title) =>
  `[...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent.includes(${JSON.stringify(title)}))`;

const browser = await launch();
try {
  const page = await connect(browser.endpoint);
  await page.send("Page.enable");
  await page.send("Network.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, mobile: false });
  await page.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  await page.send("Page.navigate", { url: BASE_URL });
  await page.waitFor(`document.readyState === "complete" && ${idle}`, "the studio to load");

  // Turn 1: three artifacts dock as tabs; show the HTML one running in the sandbox.
  await ask(
    page,
    "Build an HTML landing page with a counter, a mermaid flow chart and a python script",
  );
  await page.waitFor(
    `${idle} && document.querySelectorAll('[role="tab"][id^="tab-"]').length === 3`,
    "turn 1",
  );
  await page.evaluate(`${tab("Counter page")}.click()`);
  await page.waitFor(
    `!!document.querySelector('iframe[title="Counter page preview"]')`,
    "the sandbox",
  );
  await sleep(1_000);
  await capture(page, "studio-live-preview.png");

  // Turn 2, throttled so the capture lands mid-stream: chat streaming on the left, the
  // React artifact's source arriving with live highlighting on the right.
  await page.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 40,
    downloadThroughput: 1_500,
    uploadThroughput: 1_000_000,
  });
  await ask(page, "Now add a React todo list component");
  await page.waitFor(
    `!!${tab("Todo list")}?.querySelector('[aria-label="Generating"]') &&
      document.querySelector('#artifact-viewport pre')?.textContent.length > 150`,
    "the React artifact to stream",
    60_000,
  );
  await capture(page, "studio-preview.png");
  await page.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  page.close();
} finally {
  await browser.close();
}
