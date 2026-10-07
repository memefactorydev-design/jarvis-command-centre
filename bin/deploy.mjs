#!/usr/bin/env node
// Publish your command centre to Vercel: `npm run deploy`
//
// Builds, stages a clean folder (.deploy/<project>/ — the page, assets, voice clips and the two API functions only),
// uploads your keys from .env as encrypted Vercel environment variables, and deploys to production.
// Hosted mode needs an access code for the live (paid) endpoints: one is generated into .env if you don't have one,
// and the unlock link (site URL + #code=…) is printed so you can open it on any device.
//
//   npm run deploy                 build + env + deploy
//   npm run deploy -- --no-env     deploy without touching Vercel environment variables (demo / static showcase)
//   npm run deploy -- --project my-jarvis
//
// Requires the Vercel CLI (npm i -g vercel) and `vercel login` once.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { P, ROOT, loadConfig, saveConfig, loadEnv, writeEnv, slug } from "./lib/common.mjs";
import { build } from "./build.mjs";

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

function vercel(cmdArgs, opts = {}) {
  return spawnSync("vercel", cmdArgs, { encoding: "utf8", timeout: 15 * 60 * 1000, ...opts });
}

function copy(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) { fs.mkdirSync(dst, { recursive: true }); for (const f of fs.readdirSync(src)) if (!f.startsWith(".")) copy(path.join(src, f), path.join(dst, f)); }
  else fs.copyFileSync(src, dst);
}

function main() {
  if (vercel(["--version"]).status !== 0) { console.error("The Vercel CLI is not installed. Run: npm i -g vercel && vercel login"); process.exit(2); }
  const cfg = loadConfig();
  const env = loadEnv();
  const project = argVal("--project") || cfg.vercelProject || `${slug(cfg.orgName || "my")}-command-centre`.slice(0, 52);
  if (cfg.vercelProject !== project) { cfg.vercelProject = project; saveConfig(cfg); }
  const noEnv = args.includes("--no-env");

  build({ quiet: false });

  // stage: keep .vercel (project link) between runs, refresh everything else
  const stage = path.join(ROOT, ".deploy", project);
  fs.mkdirSync(stage, { recursive: true });
  for (const f of fs.readdirSync(stage)) if (f !== ".vercel") fs.rmSync(path.join(stage, f), { recursive: true, force: true });
  copy(P.public, stage);                                  // index.html, assets/, voice/
  copy(path.join(ROOT, "api"), path.join(stage, "api"));  // jarvis.js, tts.js, _lib/
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify({ name: project, private: true, type: "module", dependencies: pkg.dependencies }, null, 2));
  fs.writeFileSync(path.join(stage, "vercel.json"), JSON.stringify({
    $schema: "https://openapi.vercel.sh/vercel.json", cleanUrls: true,
    functions: { "api/*.js": { maxDuration: 60 } },
    headers: [{ source: "/assets/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=3600" }] }],
  }, null, 2));

  if (!fs.existsSync(path.join(stage, ".vercel", "project.json"))) {
    const l = vercel(["link", "--yes", "--project", project], { cwd: stage, stdio: "inherit" });
    if (l.status !== 0) { console.error("vercel link failed — run `vercel login` and try again."); process.exit(1); }
  }

  if (!noEnv) {
    let code = env.JARVIS_ACCESS_CODE || process.env.JARVIS_ACCESS_CODE;
    if (!code) { code = crypto.randomBytes(9).toString("base64url"); writeEnv({ JARVIS_ACCESS_CODE: code }); }
    const vars = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY, JARVIS_ACCESS_CODE: code };
    for (const [name, value] of Object.entries(vars)) {
      if (!value) { console.log(`  · ${name} not set locally — skipped (add it in ⚙ Connections, then deploy again)`); continue; }
      const r = vercel(["env", "add", name, "production", "--sensitive", "--force", "--yes"], { cwd: stage, input: value });
      console.log(r.status === 0 ? `  ✓ ${name} uploaded (encrypted)` : `  ✗ ${name}: ${(r.stderr || "").split("\n").filter(Boolean).pop()}`);
    }
  }

  const d = vercel(["deploy", "--prod", "--yes"], { cwd: stage });
  const out = `${d.stdout}\n${d.stderr}`;
  const alias = (out.match(/Aliased\s+(https:\/\/[\w.-]+\.vercel\.app)/) || [])[1];
  const url = alias || (out.match(/https:\/\/[\w.-]+\.vercel\.app/) || [])[0];
  if (d.status !== 0 || !url) { console.error(out.slice(-1500)); process.exit(1); }
  fs.writeFileSync(path.join(ROOT, ".deploy", "last.json"), JSON.stringify({ url, project, at: new Date().toISOString() }, null, 2));
  console.log(`\n  ◉ Deployed → ${url}`);
  if (!noEnv) console.log(`    Unlock live voice on any device with: ${url}/#code=<JARVIS_ACCESS_CODE from your .env>\n    (the code stays in .env — share that link only with people you trust)\n`);
  else console.log("    Deployed without keys: the dashboard and recorded clips work; live chat stays offline.\n");
}

main();
