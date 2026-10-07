#!/usr/bin/env node
// ElevenLabs voice for your assistant.
//
//   npm run voice                 generate the spoken clips (briefing, answers, one status line per agent)
//   npm run voice -- --list       list the voices on your ElevenLabs account
//   npm run voice -- --use <id>   use a voice by id (premade voices work on every account)
//   npm run voice -- --design     design an ORIGINAL calm British AI-butler voice and use it
//
// Only clips whose text changed are regenerated, so re-running is cheap. Needs ELEVENLABS_API_KEY in .env
// (set it in the dashboard's ⚙ Connections panel or with `npm run setup`).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { P, loadConfig, saveConfig, loadEnv, readJSON, writeJSON, slug, stamp, log } from "./lib/common.mjs";
import { loadRoster } from "./build.mjs";

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const API = "https://api.elevenlabs.io/v1";

function key() {
  loadEnv();
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) { console.error("No ElevenLabs key yet. Add it in the dashboard (⚙ Connections) or run: npm run setup"); process.exit(2); }
  return k;
}

async function el(method, p, body, raw = false) {
  const r = await fetch(API + p, { method, headers: { "xi-api-key": key(), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`ElevenLabs ${p} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return raw ? Buffer.from(await r.arrayBuffer()) : r.json();
}

const NUM = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const num = (n) => (n >= 0 && n <= 20 ? NUM[n] : String(n));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function plain(s) {
  s = String(s || "").replace(/<[^>]+>/g, "").replace(/`/g, "");
  s = s.replace(/ · /g, ", ").replace(/·/g, ",").replace(/&/g, " and ").replace(/@/g, " at ").replace(/ \/ /g, " or ")
    .replace(/→/g, " to ").replace(/≥/g, "at least ").replace(/~/g, "about ").replace(/ \+ /g, " and ")
    .replace(/\(/g, ", ").replace(/\)/g, "").replace(/[“”"]/g, "");
  s = s.replace(/(?<=[A-Za-z])-(?=[A-Za-z])/g, " ").replace(/\s+,/g, ",").replace(/,\s*,/g, ",").replace(/\s{2,}/g, " ");
  return s.trim();
}
const firstSentence = (s) => (String(s || "").trim().split(/(?<=[.!?])\s/)[0] || "");

export function clipTexts(data, cfg) {
  const H = cfg.honorific, A = cfg.assistantName;
  const all = data.depts.flatMap((d) => d.agents.map((a) => ({ d, a })));
  const by = (s) => all.filter((x) => x.a.status === s);
  const live = by("live"), testing = by("testing"), blocked = by("blocked");
  const names = (items, limit = 6) => {
    const ns = items.map((x) => plain(x.a.name));
    if (!ns.length) return "none";
    return ns.slice(0, limit).join(", ") + (ns.length > limit ? `, and ${ns.length - limit} more` : "");
  };
  // blocked items grouped by department so the briefing stays short
  const groups = {};
  for (const x of blocked) (groups[x.d.name] = groups[x.d.name] || []).push(x);
  const gate = Object.entries(groups).map(([dept, items]) => {
    if (items.length >= 3) return `${num(items.length)} ${plain(dept)} agents are blocked`;
    return items.map((x) => (x.a.waiting && x.a.waiting.length ? `${plain(x.a.name)} is waiting on ${plain(x.a.waiting[0]).replace(/\.$/, "")}` : `${plain(x.a.name)} is blocked`)).join("; ");
  });
  const gateText = gate.length ? cap(gate.join("; ")) + "." : "Nothing is blocked.";
  const t = {
    briefing: `Good day, ${H}. Workforce briefing for ${plain(cfg.orgName)}. ${cap(num(all.length))} agents are on the roster: ${num(live.length)} live, ${num(testing.length)} in testing, and ${num(blocked.length)} blocked. ` +
      `Live: ${names(live)}. In testing: ${names(testing, 5)}. Blocked: ${gateText} That concludes the briefing.`,
    greeting: `Welcome back, ${H}. ${A} online, and the workforce roster is loaded. Press Live and simply talk to me, or ask about any agent by name.`,
    summary: `${cap(num(all.length))} agents: ${num(live.length)} live, ${num(testing.length)} in testing, ${num(blocked.length)} blocked. Shall I go through the blocked items?`,
    live: `${cap(num(live.length))} agent${live.length === 1 ? " is" : "s are"} live: ${names(live, 8)}.`,
    testing: `${cap(num(testing.length))} agent${testing.length === 1 ? " is" : "s are"} in testing or shadow mode: ${names(testing, 8)}.`,
    blocked: `${cap(num(blocked.length))} agent${blocked.length === 1 ? " is" : "s are"} blocked. ${blocked.length ? gateText : ""}`.trim(),
    departments: `The roster has ${num(data.depts.length)} departments: ` + data.depts.map((d) => `${plain(d.name)} with ${num(d.agents.length)}`).join(", ") + ".",
    help: "You can ask: give me the briefing; what is live; what is blocked; what is in testing; list the departments; or how is, followed by an agent's name.",
    unknown: `I did not catch an agent or a topic in that, ${H}. Try: what is blocked, or name an agent.`,
    bye: `Very good, ${H}. I shall keep watch.`,
  };
  for (const { d, a } of all) {
    let line = `${plain(a.name)}, in ${plain(d.name)}, is ${a.status === "testing" ? "in testing" : a.status}. ${plain(firstSentence(a.statusNote))}`;
    if (a.waiting && a.waiting.length) line += ` Waiting on: ${plain(a.waiting[0]).replace(/\.$/, "")}.`;
    if (a.handoff && a.handoff.length) line += ` Hand-off: ${plain(a.handoff[0]).replace(/\.$/, "")}.`;
    t["agent-" + slug(a.name)] = line;
  }
  return t;
}

async function generate({ demo = false } = {}) {
  const data = loadRoster({ forceDemo: demo });
  const cfg = loadConfig(data);
  const outDir = demo ? P.demoVoice : P.voice;
  const manifestPath = path.join(outDir, "manifest.json");
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = readJSON(manifestPath, { clips: {} }) || { clips: {} };
  manifest.clips = manifest.clips || {};
  const texts = clipTexts(data, cfg);
  const todo = [];
  for (const [k, text] of Object.entries(texts)) {
    const hash = crypto.createHash("sha256").update(`${cfg.voiceId}|${text}`).digest("hex").slice(0, 16);
    const cur = manifest.clips[k];
    if (cur && cur.hash === hash && fs.existsSync(path.join(outDir, cur.file))) { cur.text = text; continue; }
    todo.push({ k, text, hash });
  }
  for (const k of Object.keys(manifest.clips)) if (!(k in texts)) {
    try { fs.unlinkSync(path.join(outDir, manifest.clips[k].file)); } catch {}
    delete manifest.clips[k];
  }
  const chars = todo.reduce((n, x) => n + x.text.length, 0);
  log(`${todo.length} clip(s) to generate (${chars} characters) in voice ${cfg.voiceName || cfg.voiceId}`);
  for (const { k, text, hash } of todo) {
    const model = k === "briefing" ? "eleven_multilingual_v2" : (cfg.ttsModel || "eleven_flash_v2_5");
    try {
      const audio = await el("POST", `/text-to-speech/${encodeURIComponent(cfg.voiceId)}?output_format=mp3_44100_96`,
        { text, model_id: model, voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true } }, true);
      fs.writeFileSync(path.join(outDir, `${k}.mp3`), audio);
      manifest.clips[k] = { hash, file: `${k}.mp3`, text };
      log(`  ✓ ${k}`);
    } catch (e) { console.error(`  ✗ ${k}: ${e.message}`); }
  }
  manifest.voice_id = cfg.voiceId;
  manifest.voice_name = cfg.voiceName || cfg.voiceId;
  manifest.generated = stamp();
  writeJSON(manifestPath, manifest);
  log(`Voice clips ready: ${Object.keys(manifest.clips).length}. Run npm run build (the server does it for you).`);
}

async function listVoices() {
  const d = await el("GET", "/voices");
  for (const v of d.voices || []) {
    const l = v.labels || {};
    console.log(`${v.voice_id}  ${v.name}  [${v.category}] ${[l.accent, l.gender, l.age].filter(Boolean).join(" ")}`);
  }
}

async function design() {
  const description = "A calm, impeccably composed British artificial-intelligence butler voice: mature male, Received Pronunciation, measured unhurried pace, crisp consonants, quiet dry wit, warm but precise, with a faint high-end intercom smoothness.";
  const sample = "Good evening. All systems are online and the workforce roster is current. Shall I begin the briefing, or would you prefer the short version? I have taken the liberty of flagging two agents that are waiting on you.";
  log("Designing an original voice on ElevenLabs …");
  const d = await el("POST", "/text-to-voice/design", { voice_description: description, text: sample });
  const preview = (d.previews || [])[0];
  if (!preview) throw new Error("no preview returned");
  const created = await el("POST", "/text-to-voice", { voice_name: "Command Centre Butler", voice_description: description, generated_voice_id: preview.generated_voice_id });
  const cfg = loadConfig(); cfg.voiceId = created.voice_id; cfg.voiceName = "Command Centre Butler (designed)"; saveConfig(cfg);
  log(`Voice created and selected: ${created.voice_id}. Now run: npm run voice`);
}

if (process.argv[1]?.endsWith("voice.mjs")) {
  (async () => {
    try {
      if (args.includes("--list")) return await listVoices();
      if (args.includes("--design")) return await design();
      const use = argVal("--use");
      if (use) { const cfg = loadConfig(); cfg.voiceId = use; cfg.voiceName = argVal("--name") || use; saveConfig(cfg); return log(`Voice set to ${use}. Run: npm run voice`); }
      await generate({ demo: args.includes("--demo") });
    } catch (e) { console.error(e.message); process.exit(1); }
  })();
}

export { generate };
