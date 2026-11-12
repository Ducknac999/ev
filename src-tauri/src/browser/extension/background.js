/*
 * The E.V extension: connects to E.V on this Mac (127.0.0.1 only) and, when E.V asks, runs E.V's
 * page agent (page_agent.js) in one of your tabs. It does nothing on its own and sends nothing
 * anywhere else.
 */
/* global chrome, browser, importScripts */
if (typeof self.EV_BRIDGE === "undefined" && typeof importScripts === "function") importScripts("config.js");

const api = typeof browser !== "undefined" ? browser : chrome;
const BRIDGE = self.EV_BRIDGE || { ports: [], token: "" };
let socket = null;
let connecting = false;

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

async function findTab(matching) {
  const want = (matching || "").trim().toLowerCase();
  if (!want) {
    const [active] = await api.tabs.query({ active: true, lastFocusedWindow: true });
    if (active) return active;
    const [any] = await api.tabs.query({ active: true });
    return any;
  }
  const tabs = await api.tabs.query({});
  const hits = tabs.filter((t) => (t.url || "").toLowerCase().includes(want) || (t.title || "").toLowerCase().includes(want));
  if (!hits.length) {
    const open = tabs.slice(0, 30).map((t) => `${t.title} — ${t.url}`).join("\n");
    throw new Error(`NO_TAB: no open tab has "${want}" in its title or address. Open tabs:\n${open}`);
  }
  return hits.find((t) => t.active) || hits[0];
}

async function runInPage(message) {
  const tab = await findTab(message.tab);
  if (!tab) throw new Error("NO_TAB: no tab is open");
  await api.scripting.executeScript({ target: { tabId: tab.id }, files: ["page_agent.js"] });
  const [first] = await api.scripting.executeScript({
    target: { tabId: tab.id },
    func: (request) => (window.__evAgent ? window.__evAgent.run(request) : JSON.stringify({ error: "the page agent didn't load" })),
    args: [message.request],
  });
  return first ? first.result : JSON.stringify({ error: "no answer from the page" });
}

async function handle(message) {
  if (message.op !== "page") return;
  try {
    const result = await runInPage(message);
    send({ id: message.id, ok: true, result });
  } catch (err) {
    send({ id: message.id, ok: false, error: String((err && err.message) || err) });
  }
}

function tryPort(index) {
  if (index >= BRIDGE.ports.length) {
    connecting = false;
    return;
  }
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${BRIDGE.ports[index]}`);
  } catch {
    tryPort(index + 1);
    return;
  }
  let opened = false;
  ws.onopen = () => {
    opened = true;
    connecting = false;
    socket = ws;
    ws.send(JSON.stringify({ type: "hello", token: BRIDGE.token, ua: navigator.userAgent }));
  };
  ws.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "refused") {
      // Another copy of E.V (a different secret) answered on this port: try the next one.
      console.warn("E.V:", message.reason);
      if (socket === ws) socket = null;
      ws.onclose = null;
      ws.close();
      tryPort(index + 1);
      return;
    }
    handle(message);
  };
  ws.onclose = () => {
    if (socket === ws) socket = null;
    if (!opened) tryPort(index + 1);
  };
  ws.onerror = () => {};
}

function connect() {
  if (connecting || (socket && socket.readyState <= WebSocket.OPEN)) return;
  connecting = true;
  tryPort(0);
}

// Reconnects when E.V starts later than the browser, and keeps Chrome's background worker awake
// while connected (it sleeps after 30 s without messages).
api.alarms.create("ev-reconnect", { periodInMinutes: 0.5 });
api.alarms.onAlarm.addListener(() => connect());
setInterval(() => {
  if (socket && socket.readyState === WebSocket.OPEN) send({ type: "ping" });
  else connect();
}, 20000);
api.runtime.onStartup && api.runtime.onStartup.addListener(connect);
api.runtime.onInstalled && api.runtime.onInstalled.addListener(connect);
connect();
