#!/usr/bin/env node
// One-command onboarding: `npm run setup`
//
// Asks where your agents live, who you are and (optionally) for your Claude and ElevenLabs keys, then scans,
// builds, optionally records the voice clips, and starts the dashboard. Keys can also be added later in the
// dashboard's ⚙ Connections panel. Keys are typed hidden, validated, and stored only in .env (mode 600).
//
// Non-interactive (used by Claude Code's /jarvis-setup):
//   node bin/setup.mjs --yes --dir ~/Projects/Agents --name "Alex Morgan" --org "Helix Studio" [--assistant JARVIS] [--honorific sir] [--no-start]
//   Keys are taken from ANTHROPIC_API_KEY / ELEVENLABS_API_KEY in the environment if present (never printed).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnSync, spawn } from "node:child_process";
import { P, ROOT, MODELS, loadConfig, saveConfig, loadEnv, writeEnv, expandHome, mask } from "./lib/common.mjs";

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const YES = args.includes("--yes");
const C = { cyan: (s) => `\x1b[36m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, ok: (s) => `\x1b[32m${s}\x1b[0m`, warn: (s) => `\x1b[33m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const ask = (q, def = "") => YES ? Promise.resolve(def) : new Promise((r) => rl.question(`${q}${def ? C.dim(` [${def}]`) : ""}: `, (a) => r(a.trim() || def)));

function askHidden(q) {
  if (YES || !process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    process.stdout.write(`${q}: `);
    const stdin = process.stdin; let buf = "";
    rl.pause(); stdin.setRawMode(true); stdin.resume();
    const onData = (d) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") { stdin.setRawMode(false); stdin.removeListener("data", onData); process.stdout.write("\n"); rl.resume(); return resolve(buf.trim()); }
        if (ch === "\u0003") { process.stdout.write("\n"); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") { if (buf.length) { buf = buf.slice(0, -1); process.stdout.write("\b \b"); } continue; }
        buf += ch; process.stdout.write("•");
      }
    };
    stdin.on("data", onData);
  });
}

function guessAgentsDir() {
  const cands = [path.dirname(ROOT), path.join(os.homedir(), "Projects", "Agents"), path.join(os.homedir(), "agents"), path.join(os.homedir(), "Projects")];
  for (const c of cands) {
    try {
      const subs = fs.readdirSync(c, { withFileTypes: true }).filter((e) => e.isDirectory());
      if (subs.some((s) => fs.existsSync(path.join(c, s.name, ".claude")) || fs.existsSync(path.join(c, s.name, "CLAUDE.md")) || fs.existsSync(path.join(c, s.name, "AGENTS.md")))) return c;
    } catch {}
  }
  return path.dirname(ROOT);
}

async function testAnthropic(key, model) {
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const m = await new Anthropic({ apiKey: key, maxRetries: 0, timeout: 20000 }).models.retrieve(model);
    return { ok: true, msg: m.display_name || model };
  } catch (e) { return { ok: false, msg: e.status === 401 ? "rejected (401)" : e.status === 404 ? `model ${model} not available to this key` : String(e.message || e).slice(0, 100) }; }
}
async function testEleven(key) {
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/voices?page_size=1", { headers: { "xi-api-key": key } });
    if (r.ok) return { ok: true, msg: "ok" };
    const t = await r.text();
    if (r.status === 401 && /missing_permissions/.test(t)) return { ok: true, msg: "restricted key (text-to-speech assumed)" };
    return { ok: false, msg: `HTTP ${r.status}` };
  } catch (e) { return { ok: false, msg: String(e.message || e).slice(0, 100) }; }
}

function run(script, extra = []) {
  return spawnSync(process.execPath, [path.join(ROOT, "bin", script), ...extra], { cwd: ROOT, stdio: "inherit", env: process.env }).status;
}

async function main() {
  console.log(C.cyan(`
     ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗
     ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝
     ██║███████║██████╔╝██║   ██║██║███████╗
██   ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║
╚█████╔╝██║  ██║██║  ██║ ╚████╔╝ ██║███████║
 ╚════╝ ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝`) + C.dim("   AI workforce command centre — setup\n"));

  const cfg = loadConfig();
  loadEnv();

  // 1. agents folder
  let dir = argVal("--dir") || cfg.agentsDir || guessAgentsDir();
  for (;;) {
    dir = await ask(C.bold("1/5  Where do your agents live?") + C.dim(" (a folder whose sub-folders are agents, skills or Claude Code projects)"), dir);
    if (fs.existsSync(expandHome(dir))) break;
    console.log(C.warn(`     Not found: ${expandHome(dir)}`));
    if (YES) process.exit(2);
  }
  cfg.agentsDir = dir;

  // 2. identity
  cfg.owner = { ...cfg.owner, name: argVal("--name") || await ask(C.bold("2/5  Your name") + C.dim(" (shown as the owner node)"), cfg.owner.name === "Your Name" ? os.userInfo().username : cfg.owner.name) };
  cfg.orgName = argVal("--org") || await ask("     Organisation / team name", cfg.orgName);
  cfg.assistantName = argVal("--assistant") || await ask("     Assistant name", cfg.assistantName);
  cfg.honorific = argVal("--honorific") || await ask("     How should it address you? (sir, ma'am, boss, your first name…)", cfg.honorific);
  saveConfig(cfg);

  // 3. Claude
  console.log(C.bold("\n3/5  Brain — Claude (Anthropic API)") + C.dim("  powers live conversation · https://console.anthropic.com/settings/keys"));
  if (!YES) {
    const pick = await ask(`     Model ${MODELS.map((m, i) => `\n       ${i + 1}) ${m.label}`).join("")}\n     Choose`, String(MODELS.findIndex((m) => m.id === cfg.model) + 1 || 1));
    const chosen = MODELS[Number(pick) - 1]; if (chosen) cfg.model = chosen.id;
    saveConfig(cfg);
  }
  let aKey = process.env.ANTHROPIC_API_KEY || "";
  if (aKey) console.log(`     Using the key already configured (${mask(aKey)}).`);
  else aKey = await askHidden("     Paste your Anthropic API key (Enter to skip — add it later in ⚙ Connections)");
  if (aKey) {
    const t = await testAnthropic(aKey, cfg.model);
    if (t.ok) { writeEnv({ ANTHROPIC_API_KEY: aKey }); console.log(C.ok(`     ✓ Claude connected · ${t.msg}`)); }
    else console.log(C.warn(`     ✗ Claude key not saved: ${t.msg}`));
  }

  // 4. ElevenLabs
  console.log(C.bold("\n4/5  Voice — ElevenLabs") + C.dim("  speaks every answer · https://elevenlabs.io/app/settings/api-keys"));
  let eKey = process.env.ELEVENLABS_API_KEY || "";
  if (eKey) console.log(`     Using the key already configured (${mask(eKey)}).`);
  else eKey = await askHidden("     Paste your ElevenLabs API key (Enter to skip — the browser's own voice is used meanwhile)");
  let voiceOk = false;
  if (eKey) {
    const t = await testEleven(eKey);
    if (t.ok) { writeEnv({ ELEVENLABS_API_KEY: eKey }); voiceOk = true; console.log(C.ok(`     ✓ ElevenLabs connected${t.msg !== "ok" ? ` · ${t.msg}` : ""}`)); }
    else console.log(C.warn(`     ✗ ElevenLabs key not saved: ${t.msg}`));
  }
  if (voiceOk && !YES) {
    const v = await ask("     Voice: 1) Daniel — calm British (premade)  2) George — warm British (premade)  3) design an original AI-butler voice", "1");
    if (v === "2") { cfg.voiceId = "JBFqnCBsd6RMkjVDRZzb"; cfg.voiceName = "George"; saveConfig(cfg); }
    else if (v === "3") run("voice.mjs", ["--design"]);
    else { cfg.voiceId = "onwK4e9ZLuTAKqWW03F9"; cfg.voiceName = "Daniel"; saveConfig(cfg); }
  }

  // 5. scan, build, voice, start
  console.log(C.bold("\n5/5  Scanning your agents and building the command centre…"));
  const sc = run("scan.mjs");
  if (sc === 2) process.exit(2);
  run("build.mjs");
  if (voiceOk) {
    const go = YES ? "y" : await ask("     Record the spoken briefing and answers now? (uses a few thousand ElevenLabs characters)", "y");
    if (/^y/i.test(go)) { run("voice.mjs"); run("build.mjs"); }
  }
  console.log(C.ok("\n  ✓ Setup complete.") + `  Next time just run ${C.cyan("npm start")}.`);
  console.log(C.dim("    Tip: open the project in Claude Code and run /jarvis-scan to have Claude write rich descriptions for every agent.\n"));
  rl.close();
  if (args.includes("--no-start")) return;
  const start = YES ? "y" : await new Promise((r) => { const r2 = readline.createInterface({ input: process.stdin, output: process.stdout }); r2.question("  Start the dashboard now? [Y/n]: ", (a) => { r2.close(); r(a.trim() || "y"); }); });
  if (/^y/i.test(start)) spawn(process.execPath, [path.join(ROOT, "bin", "serve.mjs"), "--open"], { cwd: ROOT, stdio: "inherit" });
}

main().catch((e) => { console.error(e); process.exit(1); });
