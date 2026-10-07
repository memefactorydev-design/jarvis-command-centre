#!/usr/bin/env node
// Run your command centre locally: http://localhost:7777
//
//   npm start               serve the dashboard + live voice chat
//   npm run dev             same, and open the browser
//   npm start -- --port 8080
//
// The server listens on 127.0.0.1 only. It runs the same /api/jarvis and /api/tts functions as a Vercel
// deployment, plus local-only endpoints for the dashboard's ⚙ Connections panel (keys are written to .env,
// mode 600, and never sent back to the browser), rescanning your agents folder and generating voice clips.
// It also rescans automatically every `autoRescanHours` (default 24) while it runs.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { P, ROOT, MODELS, loadConfig, saveConfig, loadEnv, writeEnv, mask, readJSON, expandHome } from "./lib/common.mjs";
import { build } from "./build.mjs";

process.env.JARVIS_LOCAL = "1";
loadEnv();
const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
let cfg = loadConfig();
const PORT = Number(argVal("--port") || process.env.PORT || cfg.port || 7777);
const HOST = "127.0.0.1";
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".ico": "image/x-icon" };

// ---------------------------------------------------------------- build + live context
let lastBuild = null;
async function rebuild() {
  lastBuild = build({ quiet: true });
  globalThis.__JARVIS_CTX__ = await import(pathToFileURL(P.ctx).href + "?t=" + Date.now());
  return lastBuild;
}
await rebuild();
const jarvis = await import(pathToFileURL(path.join(ROOT, "api", "jarvis.js")).href);
const tts = await import(pathToFileURL(path.join(ROOT, "api", "tts.js")).href);

// ---------------------------------------------------------------- helpers
function runScript(script, extra = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, "bin", script), ...extra], { cwd: ROOT, timeout: 10 * 60 * 1000, env: process.env },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: (stdout + stderr).trim().slice(-4000) }));
  });
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error("body too large"); chunks.push(c); }
  return Buffer.concat(chunks);
}

function send(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

async function toWebRequest(req) {
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
  const headers = {};
  for (const k of ["content-type", "accept", "x-jarvis-code"]) if (req.headers[k]) headers[k] = String(req.headers[k]);
  headers["x-forwarded-for"] = req.socket.remoteAddress || "127.0.0.1";
  return new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body });
}

async function pipeWebResponse(webRes, res) {
  const headers = {}; webRes.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(webRes.status, headers);
  if (!webRes.body) return res.end();
  const reader = webRes.body.getReader();
  res.on("close", () => { reader.cancel().catch(() => {}); });
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; res.write(value); }
  } catch {}
  res.end();
}

function localState() {
  cfg = loadConfig();
  const roster = readJSON(P.data, null);
  const manifest = readJSON(path.join(P.voice, "manifest.json"), null);
  return {
    mode: "local",
    anthropic: { connected: Boolean(process.env.ANTHROPIC_API_KEY), masked: mask(process.env.ANTHROPIC_API_KEY) },
    elevenlabs: { connected: Boolean(process.env.ELEVENLABS_API_KEY), masked: mask(process.env.ELEVENLABS_API_KEY) },
    model: cfg.model, models: MODELS, voiceId: cfg.voiceId, voiceName: cfg.voiceName,
    assistantName: cfg.assistantName, honorific: cfg.honorific, orgName: cfg.orgName, ownerName: cfg.owner.name,
    agentsDir: cfg.agentsDir, demo: !roster, configured: fs.existsSync(P.config), lastScan: roster ? roster.last_scan : null,
    clips: manifest ? Object.keys(manifest.clips || {}).length : 0, built: lastBuild && lastBuild.built,
  };
}

async function testAnthropic(apiKey, model) {
  if (!apiKey) return { ok: false, message: "no key" };
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 20000 });
    const m = await client.models.retrieve(model);
    return { ok: true, message: `Connected · ${m.display_name || model}` };
  } catch (e) {
    const status = e && e.status;
    if (status === 401) return { ok: false, message: "Anthropic rejected this key (401)." };
    if (status === 404) return { ok: false, message: `Key works, but model ${model} is not available to it.` };
    return { ok: false, message: `Could not reach Anthropic${status ? ` (HTTP ${status})` : ""}: ${String(e.message || e).slice(0, 120)}` };
  }
}

async function testElevenLabs(apiKey) {
  if (!apiKey) return { ok: false, message: "no key" };
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/voices?page_size=1", { headers: { "xi-api-key": apiKey } });
    if (r.ok) return { ok: true, message: "Connected" };
    const t = await r.text();
    if (r.status === 401 && /missing_permissions/.test(t)) {
      // restricted keys may lack voices_read; text-to-speech is what matters
      const s = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}`, {
        method: "POST", headers: { "xi-api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({ text: "Online.", model_id: cfg.ttsModel || "eleven_flash_v2_5" }) });
      return s.ok ? { ok: true, message: "Connected (restricted key: text-to-speech allowed)" } : { ok: false, message: `ElevenLabs refused text-to-speech (HTTP ${s.status}).` };
    }
    return { ok: false, message: r.status === 401 ? "ElevenLabs rejected this key (401)." : `ElevenLabs HTTP ${r.status}` };
  } catch (e) { return { ok: false, message: `Could not reach ElevenLabs: ${String(e.message || e).slice(0, 120)}` }; }
}

// ---------------------------------------------------------------- local-only API
async function handleLocal(req, res, url) {
  // CSRF + DNS-rebinding protection: custom header (forces a CORS preflight we never answer) and same-origin only.
  const origin = req.headers.origin;
  if (req.headers["x-jarvis-local"] !== "1" || (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, "")))) return send(res, 403, { error: "forbidden" });
  const route = url.pathname.replace("/api/local/", "");
  if (route === "state" && req.method === "GET") return send(res, 200, localState());

  if (route === "connect" && req.method === "POST") {
    let b = {};
    try { b = JSON.parse((await readBody(req)).toString() || "{}"); } catch { return send(res, 400, { error: "bad_json" }); }
    cfg = loadConfig();
    const results = {};
    const envUpdates = {};
    if (typeof b.model === "string" && b.model.trim()) cfg.model = b.model.trim();
    if (typeof b.anthropicKey === "string" && b.anthropicKey.trim()) {
      const k = b.anthropicKey.trim();
      results.anthropic = await testAnthropic(k, cfg.model);
      if (results.anthropic.ok) envUpdates.ANTHROPIC_API_KEY = k;
    }
    if (typeof b.voiceId === "string" && b.voiceId.trim()) { cfg.voiceId = b.voiceId.trim(); cfg.voiceName = (b.voiceName || cfg.voiceName || "").toString().slice(0, 80); }
    if (typeof b.elevenlabsKey === "string" && b.elevenlabsKey.trim()) {
      const k = b.elevenlabsKey.trim();
      results.elevenlabs = await testElevenLabs(k);
      if (results.elevenlabs.ok) envUpdates.ELEVENLABS_API_KEY = k;
    }
    for (const [field, key] of [["assistantName", "assistantName"], ["honorific", "honorific"], ["orgName", "orgName"]]) {
      if (typeof b[field] === "string" && b[field].trim()) cfg[key] = b[field].trim().slice(0, 60);
    }
    if (typeof b.ownerName === "string" && b.ownerName.trim()) cfg.owner = { ...cfg.owner, name: b.ownerName.trim().slice(0, 80) };
    let dirChanged = false;
    if (typeof b.agentsDir === "string" && b.agentsDir.trim() && b.agentsDir.trim() !== cfg.agentsDir) {
      const d = expandHome(b.agentsDir.trim());
      if (!fs.existsSync(d)) results.agentsDir = { ok: false, message: `Folder not found: ${d}` };
      else { cfg.agentsDir = b.agentsDir.trim(); dirChanged = true; results.agentsDir = { ok: true, message: "Folder saved — rescanning" }; }
    }
    if (b.disconnect === "anthropic") envUpdates.ANTHROPIC_API_KEY = "";
    if (b.disconnect === "elevenlabs") envUpdates.ELEVENLABS_API_KEY = "";
    saveConfig(cfg);
    if (Object.keys(envUpdates).length) writeEnv(envUpdates);
    if (dirChanged) results.scan = await runScript("scan.mjs");
    await rebuild();
    return send(res, 200, { results, state: localState() });
  }

  if (route === "test" && req.method === "POST") {
    cfg = loadConfig();
    return send(res, 200, { anthropic: await testAnthropic(process.env.ANTHROPIC_API_KEY, cfg.model), elevenlabs: await testElevenLabs(process.env.ELEVENLABS_API_KEY) });
  }

  if (route === "voices" && req.method === "GET") {
    if (!process.env.ELEVENLABS_API_KEY) return send(res, 200, { voices: [] });
    try {
      const r = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } });
      if (!r.ok) return send(res, 200, { voices: [], note: `HTTP ${r.status}` });
      const d = await r.json();
      return send(res, 200, { voices: (d.voices || []).map((v) => ({ id: v.voice_id, name: v.name, category: v.category, accent: v.labels && v.labels.accent, gender: v.labels && v.labels.gender })) });
    } catch (e) { return send(res, 200, { voices: [], note: String(e.message || e) }); }
  }

  if (route === "rescan" && req.method === "POST") {
    const r = await runScript("scan.mjs");
    await rebuild();
    return send(res, r.code === 2 ? 400 : 200, { code: r.code, log: r.out, state: localState() });
  }

  if (route === "voice" && req.method === "POST") {
    if (!process.env.ELEVENLABS_API_KEY) return send(res, 400, { error: "voice_not_connected" });
    const r = await runScript("voice.mjs");
    await rebuild();
    return send(res, r.code ? 500 : 200, { code: r.code, log: r.out, state: localState() });
  }
  return send(res, 404, { error: "not_found" });
}

// ---------------------------------------------------------------- static files
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.normalize(path.join(P.public, rel));
  if (!file.startsWith(P.public + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not found"); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "content-type": TYPES[ext] || "application/octet-stream", "content-length": st.size,
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=3600" });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host || "")) { res.writeHead(421); return res.end("Misdirected request"); }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/local/")) return await handleLocal(req, res, url);
    if (url.pathname === "/api/jarvis") {
      const r = req.method === "GET" ? jarvis.GET() : req.method === "POST" ? await jarvis.POST(await toWebRequest(req)) : null;
      if (!r) { res.writeHead(405); return res.end(); }
      return await pipeWebResponse(r, res);
    }
    if (url.pathname === "/api/tts" && req.method === "POST") return await pipeWebResponse(await tts.POST(await toWebRequest(req)), res);
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url);
  } catch (e) {
    console.error("request error:", e.message);
    if (!res.headersSent) send(res, 500, { error: "server_error" }); else res.end();
  }
});

// ---------------------------------------------------------------- auto-rescan
async function autoRescan() {
  if (!loadConfig().agentsDir) return;
  const r = await runScript("scan.mjs", ["--quiet"]);
  if (r.code === 3) { await rebuild(); console.log(`[${new Date().toLocaleTimeString()}] roster updated from your agents folder`); }
}
const hours = Number(cfg.autoRescanHours || 0);
if (hours > 0) setInterval(autoRescan, hours * 3600 * 1000).unref();

server.listen(PORT, HOST, () => {
  const s = localState();
  const url = `http://localhost:${PORT}`;
  console.log(`\n  ◉ ${cfg.assistantName} online → ${url}\n`);
  console.log(`    roster   ${s.demo ? "DEMO (run npm run setup to load your agents)" : `${lastBuild.counts.all} agents · scanned ${s.lastScan}`}`);
  console.log(`    brain    ${s.anthropic.connected ? `Claude · ${s.model}` : "not connected — open ⚙ Connections in the dashboard"}`);
  console.log(`    voice    ${s.elevenlabs.connected ? `ElevenLabs · ${s.voiceName}` : "not connected — browser voice until you add ElevenLabs"}`);
  console.log(`    clips    ${s.clips} recorded answers\n    stop     Ctrl+C\n`);
  if (args.includes("--open")) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const a = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    spawn(cmd, a, { stdio: "ignore", detached: true }).unref();
  }
});
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`Port ${PORT} is busy. Try: npm start -- --port ${PORT + 1}`);
  else console.error(e.message);
  process.exit(1);
});
