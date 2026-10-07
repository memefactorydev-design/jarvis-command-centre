// Shared paths, config, .env handling and small helpers for every bin/ script and the local server.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const P = {
  config: path.join(ROOT, "jarvis.config.json"),
  env: path.join(ROOT, ".env"),
  data: path.join(ROOT, "data", "roster.json"),
  example: path.join(ROOT, "data", "example-roster.json"),
  inventory: path.join(ROOT, "data", "inventory.json"),
  changes: path.join(ROOT, "data", "CHANGES.md"),
  voice: path.join(ROOT, "data", "voice"),            // your generated clips (git-ignored)
  demoVoice: path.join(ROOT, "data", "demo-voice"),   // clips for the demo roster (committed)
  template: path.join(ROOT, "web", "template.html"),
  assets: path.join(ROOT, "web", "assets"),
  public: path.join(ROOT, "public"),                  // build output (git-ignored)
  ctx: path.join(ROOT, "api", "_lib", "roster-context.js"),
};

export const DEFAULTS = {
  assistantName: "JARVIS",
  honorific: "sir",
  orgName: "My AI Workforce",
  owner: {
    name: "Your Name",
    label: "Owner · sole authority on agent behaviour",
    line: "Approves every policy change and every agent that goes live.",
  },
  tagline: "",
  agentsDir: "",
  extraDirs: [],
  includeUserAgents: true,
  includeScheduledTasks: true,
  model: "claude-sonnet-5-5",
  voiceId: "onwK4e9ZLuTAKqWW03F9",
  voiceName: "Daniel",
  ttsModel: "eleven_flash_v2_5",
  port: 7777,
  autoRescanHours: 24,
  vercelProject: "",
};

export const MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 — fast, best for voice (recommended)" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 — deepest answers, slower" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — cheapest" },
];

export function expandHome(p) {
  if (!p) return p;
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

export function loadConfig(roster = null) {
  const file = readJSON(P.config, null);
  // the demo roster brings its own fictional identity until you run setup
  const demo = !file && roster && roster.demo && roster.identity ? roster.identity : {};
  const f = file || {};
  return { ...DEFAULTS, ...demo, ...f, owner: { ...DEFAULTS.owner, ...(demo.owner || {}), ...(f.owner || {}) } };
}

export function saveConfig(cfg) {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) if (cfg[k] !== undefined) out[k] = cfg[k];
  writeJSON(P.config, out);
}

// ---------- .env (secrets live only here, mode 600, never printed) ----------
export function parseEnv(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function loadEnv() {
  let vals = {};
  try { vals = parseEnv(fs.readFileSync(P.env, "utf8")); } catch {}
  for (const [k, v] of Object.entries(vals)) if (v) process.env[k] = v;
  return vals;
}

export function writeEnv(updates) {
  let lines = [];
  try { lines = fs.readFileSync(P.env, "utf8").split(/\r?\n/); } catch {}
  const seen = new Set();
  lines = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (m && m[1] in updates) { seen.add(m[1]); return `${m[1]}=${updates[m[1]] ?? ""}`; }
    return line;
  });
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) lines.push(`${k}=${v ?? ""}`);
  const text = lines.filter((l, i, a) => !(l === "" && i === a.length - 1)).join("\n") + "\n";
  fs.writeFileSync(P.env, text, { mode: 0o600 });
  try { fs.chmodSync(P.env, 0o600); } catch {}
  for (const [k, v] of Object.entries(updates)) { if (v) process.env[k] = v; else delete process.env[k]; }
}

export function mask(key) {
  if (!key) return "";
  return key.length <= 12 ? "•••" : `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Anything that looks like a credential is removed from text the scanner extracts.
export function redact(text) {
  return String(text || "")
    .replace(/\b(sk-ant-[A-Za-z0-9_-]{8,}|sk_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, "Bearer [redacted]")
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, "[redacted]");
}

// "0 7,12,16 * * 1-5" → "07:00, 12:00, 16:00 Mon–Fri"; 6-field (seconds-first) Azure/Quartz crons accepted.
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function cronToText(expr) {
  let f = String(expr || "").trim().split(/\s+/);
  if (f.length === 6) f = f.slice(1);
  if (f.length !== 5) return String(expr || "");
  const [mi, h, dom, , dow] = f;
  const pad = (n) => String(n).padStart(2, "0");
  let when;
  if (/^\*\/\d+$/.test(mi) && h === "*") when = `every ${mi.slice(2)} min`;
  else if (/^\d+$/.test(mi) && h === "*") when = `hourly at :${pad(mi)}`;
  else if (/^\d+$/.test(mi) && /^[\d,]+$/.test(h)) when = h.split(",").map((x) => `${pad(x)}:${pad(mi)}`).join(", ");
  else if (/^\d+$/.test(mi) && /^\d+-\d+$/.test(h)) { const [a, b] = h.split("-"); when = `hourly ${pad(a)}:${pad(mi)}–${pad(b)}:${pad(mi)}`; }
  else if (/^[\d,]+$/.test(mi) && /^\d+$/.test(h)) when = mi.split(",").map((m) => `${pad(h)}:${pad(m)}`).join(", ");
  else return String(expr);
  let days;
  if (dow === "*") days = dom === "*" ? "daily" : `on day ${dom}`;
  else if (dow === "1-5") days = "Mon–Fri";
  else if (dow === "1-6") days = "Mon–Sat";
  else if (/^[\d,]+$/.test(dow)) days = dow.split(",").map((d) => DAYS[+d % 7]).join(", ");
  else days = `days ${dow}`;
  if (dom !== "*" && dow !== "*") days = `day ${dom}, ${days}`;
  return `${when} ${days}`.trim();
}

export function assistantDotted(name) {
  const n = String(name || "JARVIS").trim();
  return /^[A-Za-z]{2,8}$/.test(n) ? n.toUpperCase().split("").join(".") + "." : n;
}

export function log(...a) { if (!process.argv.includes("--quiet")) console.log(...a); }
