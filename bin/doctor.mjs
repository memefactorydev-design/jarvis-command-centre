#!/usr/bin/env node
// `npm run doctor` — checks everything the command centre needs and says how to fix what's missing.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { P, ROOT, loadConfig, loadEnv, readJSON, expandHome, mask } from "./lib/common.mjs";

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m, fix) => console.log(`  \x1b[31m✗\x1b[0m ${m}${fix ? `\n      → ${fix}` : ""}`);
const info = (m, fix) => console.log(`  \x1b[33m·\x1b[0m ${m}${fix ? `\n      → ${fix}` : ""}`);

const cfg = loadConfig();
loadEnv();
console.log("\n  Command centre check\n");

const major = Number(process.versions.node.split(".")[0]);
major >= 20 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} is too old`, "install Node 20 or newer (https://nodejs.org)");
fs.existsSync(path.join(ROOT, "node_modules", "@anthropic-ai", "sdk")) ? ok("dependencies installed") : bad("dependencies missing", "npm install");
fs.existsSync(P.config) ? ok("jarvis.config.json present") : info("no jarvis.config.json yet (defaults in use)", "npm run setup");

const dir = expandHome(cfg.agentsDir);
if (!cfg.agentsDir) info("agents folder not set — showing the demo roster", "npm run setup   (or npm run scan -- --dir /path/to/agents)");
else fs.existsSync(dir) ? ok(`agents folder: ${dir}`) : bad(`agents folder not found: ${dir}`, "npm run scan -- --dir /correct/path");

const roster = readJSON(P.data, null);
if (roster) {
  const n = roster.depts.reduce((a, d) => a + d.agents.length, 0);
  const auto = roster.depts.reduce((a, d) => a + d.agents.filter((x) => x.auto).length, 0);
  ok(`roster: ${n} agents in ${roster.depts.length} departments (scanned ${roster.last_scan})`);
  if (auto) info(`${auto} card(s) still use auto-generated descriptions`, "open this folder in Claude Code and run /jarvis-scan to enrich them");
} else info("no roster yet — the demo roster is shown", "npm run scan");

process.env.ANTHROPIC_API_KEY ? ok(`Claude key set (${mask(process.env.ANTHROPIC_API_KEY)}) · model ${cfg.model}`) : info("Claude not connected — live conversation is off", "dashboard → ⚙ Connections, or npm run setup");
process.env.ELEVENLABS_API_KEY ? ok(`ElevenLabs key set (${mask(process.env.ELEVENLABS_API_KEY)}) · voice ${cfg.voiceName || cfg.voiceId}`) : info("ElevenLabs not connected — the browser's built-in voice is used", "dashboard → ⚙ Connections, or npm run setup");
const man = readJSON(path.join(P.voice, "manifest.json"), null);
man && Object.keys(man.clips || {}).length ? ok(`${Object.keys(man.clips).length} recorded voice clips`) : info("no recorded clips for your roster yet", "npm run voice   (after connecting ElevenLabs)");
if (fs.existsSync(P.env)) {
  const mode = (fs.statSync(P.env).mode & 0o777).toString(8);
  mode === "600" ? ok(".env permissions 600") : bad(`.env permissions are ${mode}`, "chmod 600 .env");
}

const v = spawnSync("vercel", ["--version"], { encoding: "utf8" });
v.status === 0 ? ok(`Vercel CLI ${String(v.stdout).trim().split("\n").pop()} (for npm run deploy)`) : info("Vercel CLI not installed (only needed to publish)", "npm i -g vercel");

await new Promise((resolve) => {
  const s = net.createServer().once("error", () => { info(`port ${cfg.port} is in use (is the server already running?)`, `npm start -- --port ${cfg.port + 1}`); resolve(); })
    .once("listening", () => { s.close(); ok(`port ${cfg.port} free`); resolve(); }).listen(cfg.port, "127.0.0.1");
});
console.log("");
