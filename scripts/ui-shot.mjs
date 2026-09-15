// 界面截图与调试工具（开发用）：通过 WebView2 远程调试端口驱动运行中的窗口
//
// 用法：
//   1) 以调试端口启动应用：
//      set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
//      src-tauri\target\debug\oberon.exe
//   2) node scripts/ui-shot.mjs eval:"js代码" wait:1500 shot:out.png ...
//
// 命令序列（可任意组合，按顺序执行）：
//   eval:<JavaScript>  在页面中执行表达式
//   wait:<毫秒>        等待
//   shot:<文件路径>    截图保存为 PNG
//   click:<选择器>     点击匹配的第一个元素
//   text:<选择器>      读取元素文本并打印
import fs from "node:fs";
import WebSocket from "ws";

const PORT = process.env.CDP_PORT || "9333";

async function findTarget() {
  const res = await fetch("http://127.0.0.1:" + PORT + "/json/list");
  const targets = await res.json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("未找到页面目标，应用是否以调试端口启动？");
  return page;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

let messageId = 0;
const pending = new Map();
const consoleLogs = [];

function send(ws, method, params = {}) {
  const id = ++messageId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("CDP 超时: " + method));
      }
    }, 30000);
  });
}

const target = await findTarget();
const ws = await connect(target.webSocketDebuggerUrl);

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
    return;
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args || [])
      .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
      .join(" ");
    consoleLogs.push("[" + msg.params.type + "] " + text);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails;
    consoleLogs.push("[exception] " + (d.exception?.description || d.text));
  }
});

await send(ws, "Runtime.enable");
await send(ws, "Page.enable");
await send(ws, "Log.enable");
await send(ws, "Emulation.setDeviceMetricsOverride", {
  width: 1056,
  height: 752,
  deviceScaleFactor: 2,
  mobile: false,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(expression) {
  const result = await send(ws, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const d = result.exceptionDetails;
    return { error: d.exception?.description || d.text };
  }
  return { value: result.result?.value };
}

let commands = process.argv.slice(2);
const fileIndex = commands.indexOf("--file");
if (fileIndex >= 0) {
  const file = commands[fileIndex + 1];
  commands = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log("步骤文件: " + file + "（" + commands.length + " 步）");
}
if (commands.length === 0) {
  console.log("用法: node scripts/ui-shot.mjs --file steps.json 或 eval:... wait:1000 shot:out.png");
  process.exit(1);
}

for (const cmd of commands) {
  const idx = cmd.indexOf(":");
  const kind = idx < 0 ? cmd : cmd.slice(0, idx);
  const arg = idx < 0 ? "" : cmd.slice(idx + 1);

  if (kind === "wait") {
    await sleep(Number(arg) || 500);
    console.log("wait " + arg + "ms");
  } else if (kind === "eval") {
    const r = await evaluate(arg);
    console.log("eval => " + JSON.stringify(r).slice(0, 600));
  } else if (kind === "click") {
    const r = await evaluate(
      "(function(){var el=document.querySelector(" + JSON.stringify(arg) + ");if(!el)return 'NOT_FOUND';el.click();return 'clicked';})()"
    );
    console.log("click " + arg + " => " + JSON.stringify(r));
    await sleep(400);
  } else if (kind === "text") {
    const r = await evaluate(
      "(function(){var el=document.querySelector(" + JSON.stringify(arg) + ");return el?el.innerText:null;})()"
    );
    console.log("text " + arg + " => " + JSON.stringify(r).slice(0, 800));
  } else if (kind === "shot") {
    const shot = await send(ws, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.mkdirSync(arg.split("\\").slice(0, -1).join("\\") || ".", { recursive: true });
    fs.writeFileSync(arg, Buffer.from(shot.data, "base64"));
    console.log("shot saved: " + arg);
  } else {
    console.log("未知命令: " + cmd);
  }
}

if (consoleLogs.length > 0) {
  console.log("--- 页面控制台 ---");
  consoleLogs.slice(-40).forEach((l) => console.log(l.slice(0, 400)));
} else {
  console.log("--- 页面控制台：无输出 ---");
}

ws.close();
process.exit(0);