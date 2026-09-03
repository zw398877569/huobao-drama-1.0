#!/usr/bin/env node
/**
 * codex-cdp-browser — 通过 Codex debug 端口(9229)操控它内嵌的 Chrome
 *
 * 用法:
 *   node codex-cdp-browser.cjs navigate <url>          # 打开 URL
 *   node codex-cdp-browser.cjs shot <name.png>          # 截图到我的 workspace
 *   node codex-cdp-browser.cjs errors                   # 打印错误/网络失败(从打开到现在)
 *   node codex-cdp-browser.cjs click <selector>         # 点 selector 元素
 *   node codex-cdp-browser.cjs eval "<js>"              # 跑任意 JS,返回 JSON
 *
 * 同一个会话里,console + network 持续累积直到进程退出。
 */
const { createRequire } = require("node:module");
const fs = require("node:fs");
const WS_PATH = "/usr/local/nodejs/lib/npm/lib/node_modules/openclaw/dist/extensions/discord/node_modules/ws/";
const r = createRequire(WS_PATH);
const WebSocket = r(WS_PATH + "index.js");

const WORKSPACE = "/Users/mac/Documents/aicg-dev";

(async () => {
  const cmd = process.argv[2];
  const arg = process.argv[3];

  const v = await fetch("http://127.0.0.1:9229/json/version").then(r => r.json());
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const consoleLogs = [];
  const networkLog = [];
  let sessionId = null;

  ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
      return;
    }
    if (!m.method || m.sessionId !== sessionId) return;
    if (m.method === "Runtime.consoleAPICalled") {
      const text = (m.params.args || []).map(a => a.value ?? a.description ?? "").join(" ");
      consoleLogs.push({ type: m.params.type, text: text.slice(0, 800) });
    } else if (m.method === "Network.responseReceived") {
      networkLog.push({ url: m.params.response.url, status: m.params.response.status, method: m.params.response.requestMethod });
    } else if (m.method === "Network.loadingFailed") {
      networkLog.push({ failed: true, error: m.params.errorText });
    }
  });
  await new Promise(r => ws.on("open", r));

  function call(method, params, sid) {
    return new Promise((res, rej) => {
      const cid = ++id;
      pending.set(cid, { resolve: res, reject: rej });
      const msg = { id: cid, method, params };
      if (sid) msg.sessionId = sid;
      ws.send(JSON.stringify(msg));
      setTimeout(() => { if (pending.has(cid)) { pending.delete(cid); rej(new Error(`timeout: ${method}`)); } }, 30000);
    });
  }
  async function ev(expr, sid) {
    const r = await call("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sid);
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result?.value;
  }
  async function ensureTab() {
    if (sessionId) return sessionId;
    const created = await call("Target.createTarget", { url: "about:blank" });
    const attach = await call("Target.attachToTarget", { targetId: created.targetId, flatten: true });
    sessionId = attach.sessionId;
    await call("Page.enable", {}, sessionId);
    await call("Runtime.enable", {}, sessionId);
    await call("Network.enable", {}, sessionId);
    return sessionId;
  }

  try {
    switch (cmd) {
      case "navigate": {
        await ensureTab();
        await call("Page.navigate", { url: arg }, sessionId);
        await new Promise(r => setTimeout(r, 3000));
        console.log("OK navigated to:", arg);
        break;
      }
      case "shot": {
        await ensureTab();
        const name = arg || `codex-shot-${Date.now()}.png`;
        const ss = await call("Page.captureScreenshot", { format: "png" }, sessionId);
        const path = `${WORKSPACE}/${name}`;
        fs.writeFileSync(path, Buffer.from(ss.data, "base64"));
        console.log(`OK saved ${path} (${Buffer.from(ss.data,'base64').length} bytes)`);
        break;
      }
      case "click": {
        await ensureTab();
        const result = await ev(`(function(){
          const el = document.querySelector(${JSON.stringify(arg)});
          if (!el) return { ok: false, reason: 'not found' };
          el.click();
          return { ok: true, tag: el.tagName, text: (el.textContent||'').slice(0, 50) };
        })()`, sessionId);
        console.log(JSON.stringify(result));
        break;
      }
      case "eval": {
        await ensureTab();
        const result = await ev(arg, sessionId);
        console.log(JSON.stringify(result, null, 2));
        break;
      }
      case "errors": {
        console.log("=== console errors/warnings ===");
        for (const l of consoleLogs.filter(l => ['error','warning'].includes(l.type))) {
          console.log(`[${l.type}] ${l.text.slice(0, 600)}`);
        }
        console.log("\n=== network (last 30) ===");
        for (const n of networkLog.slice(-30)) {
          console.log(JSON.stringify(n));
        }
        break;
      }
      case "console": {
        for (const l of consoleLogs.slice(-30)) {
          console.log(`[${l.type}] ${l.text.slice(0, 300)}`);
        }
        break;
      }
      default:
        console.error("Usage: node codex-cdp-browser.cjs <navigate|shot|errors|console|click|eval> [arg]");
        process.exit(2);
    }
  } finally {
    ws.close();
  }
  process.exit(0);
})().catch(e => { console.log("ERR:", e.message); process.exit(1); });
