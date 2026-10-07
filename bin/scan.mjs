#!/usr/bin/env node
// Scan your agents folder and build data/roster.json — no AI needed, nothing leaves your machine.
//
//   npm run scan                 scan config.agentsDir (+ ~/.claude user agents, skills, commands, routines)
//   npm run scan -- --dir <path> scan a specific folder (and remember it)
//   npm run scan -- --dry        print what would change, write nothing
//
// What it detects, per top-level folder ("unit") of your agents directory:
//   Claude Code subagents (.claude/agents/*.md) · slash commands (.claude/commands) · skills (SKILL.md)
//   Codex agents (AGENTS.md) · project agents (CLAUDE.md) · schedules: Azure timers, Vercel crons,
//   GitHub Actions crons, crontab, launchd, Claude desktop routines · MCP servers (.mcp.json, names only)
//
// Cards it writes carry "auto": true. Cards you (or Claude Code via /jarvis-scan) edit get "auto": false and are
// never overwritten — only removed if their source folder disappears. Secrets are never read: .env files, keys and
// .mcp.json values are skipped, and anything key-shaped in extracted text is redacted.
//
// Exit code: 0 = no changes, 3 = roster changed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { P, ROOT, loadConfig, saveConfig, readJSON, writeJSON, expandHome, slug, stamp, redact, cronToText, log } from "./lib/common.mjs";

const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const DRY = args.includes("--dry");

const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".vercel", ".cache",
  "site-packages", ".python_packages", "logs", "state", ".deploy", "public", "coverage", "target", ".idea", ".vscode"]);
const SECRET_FILE = /(^\.env)|(\.pem$)|(\.key$)|(secret)|(credential)|(api.?keys?)|(token)/i;
const MAX_BYTES = 512 * 1024;

// ---------------------------------------------------------------- file helpers
function safeRead(file, limit = MAX_BYTES) {
  try {
    if (SECRET_FILE.test(path.basename(file))) return "";
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > limit * 4) return "";
    return fs.readFileSync(file, "utf8").slice(0, limit);
  } catch { return ""; }
}

function frontmatter(text) {
  const m = String(text).match(/^---\s*\n([\s\S]*?)\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

function firstHeading(text) {
  const m = String(text).replace(/^---[\s\S]*?\n---\s*/, "").match(/^#{1,2}\s+(.+)$/m);
  return m ? m[1].replace(/[*_`#]/g, "").trim() : "";
}

function firstParagraph(text) {
  const body = String(text).replace(/^---[\s\S]*?\n---\s*/, "");
  for (const block of body.split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t || t.startsWith("#") || t.startsWith("|") || t.startsWith("```") || t.startsWith("<") || t.startsWith("-") || t.startsWith(">")) continue;
    return t.replace(/\s+/g, " ").replace(/[*_`]/g, "");
  }
  return "";
}

function sentence(s, max = 240) {
  s = redact(String(s || "").replace(/\s+/g, " ").trim());
  if (!s) return "";
  const m = s.match(/^(.{20,}?[.!?])(\s|$)/);
  let out = m ? m[1] : s;
  if (out.length > max) out = out.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
  return out;
}

function walk(dir, depth, maxDepth, onFile) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || full === ROOT) continue;
      if (depth < maxDepth) walk(full, depth + 1, maxDepth, onFile);
    } else if (e.isFile()) onFile(full, depth);
  }
}

// ---------------------------------------------------------------- schedules
function schedulesFromCrontab() {
  try {
    return execFileSync("crontab", ["-l"], { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  } catch { return []; }
}

function launchdJobs() {
  if (process.platform !== "darwin") return [];
  const dir = path.join(os.homedir(), "Library", "LaunchAgents");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".plist")); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const raw = execFileSync("plutil", ["-convert", "json", "-o", "-", path.join(dir, f)], { encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
      const j = JSON.parse(raw);
      const args = [...(j.ProgramArguments || []), j.Program || "", j.WorkingDirectory || ""].join(" ");
      let when = "";
      const ci = j.StartCalendarInterval;
      const fmt = (c) => `${String(c.Hour ?? "*").padStart(2, "0")}:${String(c.Minute ?? 0).padStart(2, "0")}${c.Weekday !== undefined ? ` (day ${c.Weekday})` : ""}`;
      if (Array.isArray(ci)) when = ci.map(fmt).join(", ");
      else if (ci) when = fmt(ci);
      else if (j.StartInterval) when = `every ${Math.round(j.StartInterval / 60)} min`;
      out.push({ label: j.Label || f, args, when });
    } catch {}
  }
  return out;
}

function desktopRoutines() {
  const dir = path.join(os.homedir(), ".claude", "scheduled-tasks");
  const out = [];
  let ids = [];
  try { ids = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return out; }
  // optional cron hints from any routine-definition JSON kept next to the tasks
  const cronHints = {};
  try {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      const j = readJSON(path.join(dir, f), null);
      const visit = (o) => {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) return o.forEach(visit);
        const id = o.taskId || o.id; const cron = o.cronExpression || o.cron || o.schedule;
        if (id && typeof cron === "string") cronHints[id] = cron;
        Object.values(o).forEach(visit);
      };
      visit(j);
    }
  } catch {}
  for (const id of ids) {
    const text = safeRead(path.join(dir, id, "SKILL.md"), 64 * 1024);
    if (!text) continue;
    const fm = frontmatter(text);
    out.push({ id, name: fm.name || id, description: fm.description || firstParagraph(text), body: text, cron: cronHints[id] || "" });
  }
  return out;
}

function azureTimers(text) {
  const out = [];
  const re = /@app\.function_name\(name="([^"]+)"\)\s*@app\.timer_trigger\(schedule="([^"]+)"/g;
  let m; while ((m = re.exec(text))) out.push({ name: m[1], cron: m[2] });
  return out;
}

// ---------------------------------------------------------------- classification
const DEPTS = [
  ["sales", "Sales", "Pipeline, leads and follow-ups", /\b(sales|lead|leads|crm|prospect|outreach|deal|pipeline|nurture|booking|consultation)\b/i],
  ["support", "Customer Support", "Customers, tickets and complaints", /\b(support|ticket|helpdesk|complaint|customer service|concierge)\b/i],
  ["finance", "Finance", "Money in, money out, the books", /\b(finance|invoice|invoices|accounting|accounts|bookkeep\w*|payment|payments|cash ?flow|payroll|tax|vat|quickbooks|xero|ledger|reconcil\w*)\b/i],
  ["marketing", "Marketing", "Campaigns, content and ads", /\b(marketing|ads|ad|advert\w*|seo|social|content|campaign|newsletter|brand|meta|facebook|instagram|tiktok)\b/i],
  ["mail", "Mailboxes", "Inboxes and correspondence", /\b(email|e-mail|inbox|mailbox|gmail|outlook|mail)\b/i],
  ["engineering", "Engineering", "Code, builds and reviews", /\b(code|coding|developer|deploy|github|pull request|review|test|bug|refactor|repo)\b/i],
  ["research", "Research", "Research, reports and analysis", /\b(research|analyst|analysis|report|insight|intelligence|brief)\b/i],
  ["ops", "Operations", "Projects, scheduling and coordination", /\b(ops|operations|project|logistics|slack|kanban|install\w*|delivery|channel|scheduling)\b/i],
  ["trading", "Trading", "Markets and positions", /\b(trading|trade|stock|crypto|portfolio|market)\b/i],
  ["personal", "Personal", "Your own assistants", /\b(personal|daily|meeting|calendar|assistant|diary|prep)\b/i],
];
const DEPT_META = Object.fromEntries(DEPTS.map(([id, name, blurb]) => [id, { name, blurb }]));
DEPT_META.routines = { name: "Routines", blurb: "Scheduled routines in the Claude desktop app" };
DEPT_META.general = { name: "General", blurb: "Everything else" };

// Weighted: an agent's own name and description outweigh its folder's README.
function classify(parts) {
  let best = "general", bestScore = 0;
  for (const [id, , , re] of DEPTS) {
    const g = new RegExp(re.source, "gi");
    let score = 0;
    for (const { text, w } of parts) { const m = String(text || "").match(g); if (m) score += Math.min(m.length, 5) * w; }
    if (score > bestScore) { best = id; bestScore = score; }
  }
  return best;
}

const KNOWN_CONNECTORS = [
  ["Slack", /\bslack\b/i], ["Gmail", /\bgmail\b/i], ["Outlook / Microsoft 365", /\b(outlook|microsoft graph|m365|office 365)\b/i],
  ["Google Calendar", /google calendar|gcal/i], ["Google Drive", /google drive|gdrive/i], ["Google Sheets", /google sheets?/i],
  ["Notion", /\bnotion\b/i], ["HubSpot", /\bhubspot\b/i], ["Salesforce", /\bsalesforce\b/i], ["Stripe", /\bstripe\b/i],
  ["Shopify", /\bshopify\b/i], ["QuickBooks", /quickbooks/i], ["Xero", /\bxero\b/i], ["Meta Ads", /meta (ads|marketing api)|facebook ads/i],
  ["Supabase", /\bsupabase\b/i], ["Vercel", /\bvercel\b/i], ["Azure", /\bazure\b/i], ["AWS", /\baws\b|amazon web services/i],
  ["GitHub", /\bgithub\b/i], ["Linear", /\blinear\b/i], ["Jira", /\bjira\b/i], ["Asana", /\basana\b/i], ["Telegram", /\btelegram\b/i],
  ["WhatsApp", /whatsapp/i], ["Twilio", /\btwilio\b/i], ["ElevenLabs", /elevenlabs|eleven labs/i], ["OpenAI", /\bopenai\b/i],
  ["Anthropic API", /anthropic api|claude api|@anthropic-ai\/sdk/i], ["Gemini", /\bgemini\b/i], ["Airtable", /\bairtable\b/i],
  ["Zapier", /\bzapier\b/i], ["n8n", /\bn8n\b/i], ["Calendly", /\bcalendly\b/i], ["Zoom", /\bzoom\b/i], ["Discord", /\bdiscord\b/i],
];

function connectsFrom({ tools, mcpNames, text }) {
  const out = new Set();
  for (const t of tools) {
    const m = t.match(/^mcp__([^_]+(?:_[^_]+)*?)__/);
    if (m) {
      const server = m[1];
      out.add(/^[0-9a-f]{8}-/.test(server) ? "claude.ai connector" : `MCP: ${server}`);
    }
  }
  for (const n of mcpNames) out.add(`MCP: ${n}`);
  if (tools.some((t) => /^(Bash)$/.test(t))) out.add("Shell");
  if (tools.some((t) => /^(Write|Edit)$/.test(t))) out.add("Local files");
  if (tools.some((t) => /^(WebFetch|WebSearch)$/.test(t))) out.add("Web");
  for (const [label, re] of KNOWN_CONNECTORS) if (re.test(text)) out.add(label);
  return [...out].slice(0, 9);
}

function modelLabel(m) {
  const s = String(m || "").toLowerCase();
  if (!s || s === "inherit") return "Claude Code (default model)";
  if (s.startsWith("claude-")) return s;
  if (["opus", "sonnet", "haiku", "fable"].includes(s)) return `Claude ${s[0].toUpperCase()}${s.slice(1)}`;
  return m;
}

function blockedSignals(text) {
  const lines = String(text).split("\n");
  const hits = [];
  for (const l of lines) {
    if (/\[YOUR INPUT NEEDED\]|\bstatus\s*[:|]\s*\**blocked\b/i.test(l)) {
      const clean = sentence(l.replace(/^[\s>*\-|#]+/, "").replace(/\|/g, " "), 150);
      if (clean && !hits.includes(clean)) hits.push(clean);
    }
    if (hits.length >= 3) break;
  }
  return hits;
}

// ---------------------------------------------------------------- unit discovery
function discoverUnits(baseDirs) {
  const units = [];
  for (const base of baseDirs) {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const dir = path.join(base, e.name);
      if (dir === ROOT) continue;
      units.push({ base, dir, name: e.name });
    }
  }
  return units;
}

function inspectUnit(unit, ctx) {
  const u = { ...unit, agents: [], commands: [], skills: [], codex: null, claudeMd: "", readme: "", texts: [], mcpNames: new Set(), schedules: [], files: [] };
  walk(unit.dir, 0, 5, (file, depth) => {
    const rel = path.relative(unit.dir, file);
    const base = path.basename(file);
    if (SECRET_FILE.test(base)) return;
    if (/(backup|\.bak|[-_ ]old\b|copy|archive)/i.test(base)) return;
    if (/(^|\/)\.claude\/agents\/[^/]+\.md$/.test(rel)) {
      const t = safeRead(file); const fm = frontmatter(t);
      u.agents.push({ file: rel, name: fm.name || base.replace(/\.md$/, ""), description: fm.description || firstParagraph(t), model: fm.model || "",
        tools: (fm.tools || "").split(",").map((s) => s.trim()).filter(Boolean), body: t.slice(0, 20000) });
      u.files.push(rel);
    } else if (/(^|\/)\.claude\/commands\/[^/]+\.md$/.test(rel)) {
      const t = safeRead(file, 8000); const fm = frontmatter(t);
      u.commands.push({ name: "/" + base.replace(/\.md$/, ""), description: fm.description || "" }); u.files.push(rel);
    } else if (base === "SKILL.md") {
      const t = safeRead(file, 20000); const fm = frontmatter(t);
      u.skills.push({ name: fm.name || path.basename(path.dirname(file)), description: fm.description || firstParagraph(t) }); u.files.push(rel);
      u.texts.push(t.slice(0, 6000));
    } else if (base === "AGENTS.md" && depth <= 1) {
      const t = safeRead(file, 30000); u.codex = { heading: firstHeading(t), paragraph: firstParagraph(t) }; u.texts.push(t.slice(0, 8000)); u.files.push(rel);
    } else if (base === "CLAUDE.md" && depth <= 1) {
      const t = safeRead(file, 30000); u.claudeMd = t; u.texts.push(t.slice(0, 10000)); u.files.push(rel);
    } else if (/^README\.md$/i.test(base) && depth === 0) {
      const t = safeRead(file, 40000); u.readme = t; u.texts.push(t.slice(0, 12000));
    } else if (/^(INSTALL|SCHEDULE)\.md$/i.test(base) && depth === 0) {
      u.texts.push(safeRead(file, 12000));
    } else if (base === ".mcp.json" && depth <= 1) {
      const j = readJSON(file, {}) || {};
      for (const name of Object.keys(j.mcpServers || {})) u.mcpNames.add(name);   // names only, never values
    } else if (base === "vercel.json" && depth <= 3) {
      const j = readJSON(file, {}) || {};
      for (const c of j.crons || []) u.schedules.push({ runner: "Vercel cron", name: c.path, cron: c.schedule, state: "on" });
    } else if (base === "function_app.py" && depth <= 3) {
      for (const t of azureTimers(safeRead(file))) u.schedules.push({ runner: "Azure timer", name: t.name, cron: t.cron, state: "on" });
    } else if (/\.github\/workflows\/[^/]+\.ya?ml$/.test(rel)) {
      const t = safeRead(file, 40000);
      for (const m of t.matchAll(/cron:\s*['"]([^'"]+)['"]/g)) u.schedules.push({ runner: "GitHub Actions", name: base, cron: m[1], state: "on" });
    } else if (/(^|\/)config\/[^/]+\.ya?ml$/.test(rel) && depth <= 2) {
      u.texts.push(safeRead(file, 20000));
    }
  });
  // schedules that live outside the folder but point at it
  for (const line of ctx.crontab) if (line.includes(unit.dir)) {
    const f = line.trim().split(/\s+/); u.schedules.push({ runner: "crontab", name: f.slice(5).join(" ").slice(0, 60), cron: f.slice(0, 5).join(" "), state: "on" });
  }
  for (const job of ctx.launchd) if (job.args.includes(unit.dir)) u.schedules.push({ runner: "launchd", name: job.label, text: job.when, state: "on" });
  for (const r of ctx.routines) {
    if (r.body.includes(unit.dir) || (unit.name.length > 6 && r.body.toLowerCase().includes(unit.name.toLowerCase()))) {
      r.claimed = true;
      u.schedules.push({ runner: "Claude desktop routine", name: r.name, cron: r.cron, state: "unknown" });
    }
  }
  return u;
}

function scheduleText(s) {
  const when = s.text || (s.cron ? cronToText(s.cron) : "schedule set in the Claude app");
  return `${s.runner} ${s.name ? `“${s.name}” ` : ""}· ${when}`;
}

function cardsForUnit(u, cfg) {
  if (/template|boilerplate|example|sample/i.test(u.name) && !u.agents.length) return [];
  const isAgent = u.agents.length || u.commands.length || u.skills.length || u.codex || u.claudeMd || u.schedules.length;
  if (!isAgent) return [];
  const relPath = path.relative(u.base, u.dir) + "/";
  const unitText = [u.name, u.readme.slice(0, 4000), u.claudeMd.slice(0, 4000), ...u.texts.slice(0, 3)].join("\n");
  const blocked = blockedSignals(u.texts.join("\n"));
  const activeSched = u.schedules.filter((s) => s.state === "on");
  const shadow = /\bshadow mode\b/i.test(unitText);

  const base = (over) => {
    const parts = [{ text: over.name, w: 6 }, { text: u.name, w: 5 }, { text: over.job, w: 3 },
      { text: [...u.skills.map((s) => s.name), ...u.commands.map((c) => c.name)].join(" "), w: 2 }, { text: unitText.slice(0, 6000), w: 0.5 }];
    const text = [over.name, over.job, unitText].join("\n");
    let status = activeSched.length ? "live" : "testing";
    if (blocked.length && !activeSched.length) status = "blocked";
    const evidence = activeSched.length
      ? `Runs on ${activeSched.length} schedule${activeSched.length > 1 ? "s" : ""} found in its folder${shadow ? " (shadow mode mentioned in its docs)" : ""}.`
      : blocked.length ? "Setup markers found in its docs; it looks unfinished."
      : u.schedules.length ? "Has a Claude desktop routine; check whether it is switched on in the app's Scheduled sidebar."
      : "Built and runnable on demand; no schedule found.";
    const trigger = [];
    for (const s of u.schedules.slice(0, 4)) trigger.push(["Schedule", scheduleText(s)]);
    if (u.commands.length) trigger.push(["Manual", u.commands.map((c) => c.name).slice(0, 6).join(", ")]);
    if (!trigger.length) trigger.push(["Manual", `Open ${relPath} in Claude Code${over.agentName ? ` and ask for the ${over.agentName} agent` : ""}`]);
    return {
      id: slug(`${relPath}-${over.name}`),
      auto: true,
      tag: over.tag,
      name: over.name,
      job: over.job || "Purpose not described yet.",
      dept: classify(parts),
      trigger,
      connects: connectsFrom({ tools: over.tools || [], mcpNames: [...u.mcpNames], text }),
      model: over.model,
      status,
      statusNote: evidence,
      waiting: status === "blocked" ? blocked : [],
      handoff: [],
      skills: [...u.skills.map((s) => s.name), ...u.commands.map((c) => c.name)].slice(0, 10),
      path: relPath,
      source: u.dir,
    };
  };

  const cards = [];
  const tmpl = (s) => /\{\{[A-Z_]+\}\}/.test(String(s || ""));
  if (u.codex && tmpl(u.codex.heading)) u.codex = null;
  if (u.agents.length) {
    for (const a of u.agents) {
      cards.push(base({ tag: "Claude Code agent", name: a.name, agentName: a.name, job: sentence(a.description) || sentence(firstParagraph(u.claudeMd)),
        model: modelLabel(a.model), tools: a.tools }));
    }
  } else if (u.codex) {
    cards.push(base({ tag: "Codex agent", name: u.codex.heading || u.name, job: sentence(u.codex.paragraph) || sentence(firstParagraph(u.readme)), model: "Codex" }));
  } else if (u.claudeMd) {
    cards.push(base({ tag: "Claude Code project", name: firstHeading(u.claudeMd).replace(/^.*?—\s*/, "") || u.name, job: sentence(firstParagraph(u.claudeMd)) || sentence(firstParagraph(u.readme)), model: "Claude Code (default model)" }));
  } else if (u.skills.length) {
    const s = u.skills[0];
    cards.push(base({ tag: "Skill", name: s.name, job: sentence(s.description), model: "Any Claude model" }));
  } else {
    cards.push(base({ tag: "Automation", name: firstHeading(u.readme) || u.name, job: sentence(firstParagraph(u.readme)), model: "—" }));
  }
  return cards;
}

function userLevelCards(cfg, existingNames) {
  const cards = [];
  const home = path.join(os.homedir(), ".claude");
  // user-wide subagents
  try {
    for (const f of fs.readdirSync(path.join(home, "agents")).filter((x) => x.endsWith(".md"))) {
      const t = safeRead(path.join(home, "agents", f)); const fm = frontmatter(t);
      const name = fm.name || f.replace(/\.md$/, "");
      if (!fm.name || existingNames.has(name)) continue;
      const tools = (fm.tools || "").split(",").map((s) => s.trim()).filter(Boolean);
      const job = sentence(fm.description || firstParagraph(t));
      cards.push({ id: slug(`user-agent-${name}`), auto: true, tag: "Claude Code agent · user-wide", name, job, dept: classify([{ text: name, w: 6 }, { text: job, w: 3 }]),
        trigger: [["Manual", `Available in every Claude Code session as the ${name} agent`]], connects: connectsFrom({ tools, mcpNames: [], text: t.slice(0, 6000) }),
        model: modelLabel(fm.model), status: "testing", statusNote: "Installed user-wide in ~/.claude/agents; runs when Claude Code delegates to it.",
        waiting: [], handoff: [], path: `~/.claude/agents/${f}`, source: path.join(home, "agents", f) });
    }
  } catch {}
  // user-wide skills
  try {
    for (const d of fs.readdirSync(path.join(home, "skills"), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const t = safeRead(path.join(home, "skills", d.name, "SKILL.md"), 20000); if (!t) continue;
      const fm = frontmatter(t); const name = fm.name || d.name;
      if (existingNames.has(name)) continue;
      const job = sentence(fm.description || firstParagraph(t));
      cards.push({ id: slug(`user-skill-${name}`), auto: true, tag: "Skill · user-wide", name, job, dept: classify([{ text: name, w: 6 }, { text: job, w: 3 }]),
        trigger: [["Manual", "Claude picks it up when a request matches its description"]], connects: connectsFrom({ tools: [], mcpNames: [], text: t.slice(0, 6000) }),
        model: "Any Claude model", status: "live", statusNote: "Installed in ~/.claude/skills, so it is available in every Claude Code session.",
        waiting: [], handoff: [], skills: [name], path: `~/.claude/skills/${d.name}/`, source: path.join(home, "skills", d.name) });
    }
  } catch {}
  // user-wide slash commands, one card
  try {
    const cmds = fs.readdirSync(path.join(home, "commands")).filter((x) => x.endsWith(".md")).map((x) => "/" + x.replace(/\.md$/, ""));
    if (cmds.length) cards.push({ id: "user-commands", auto: true, tag: "Slash commands · user-wide", name: "Personal slash commands", job: `${cmds.length} custom commands available in every Claude Code session.`,
      dept: "personal", trigger: [["Manual", cmds.slice(0, 8).join(", ")]], connects: [], model: "Claude Code", status: "live",
      statusNote: "Installed in ~/.claude/commands.", waiting: [], handoff: [], skills: cmds.slice(0, 12), path: "~/.claude/commands/", source: path.join(home, "commands") });
  } catch {}
  return cards;
}

function routineCards(routines) {
  return routines.filter((r) => !r.claimed).map((r) => ({
    id: slug(`routine-${r.id}`), auto: true, tag: "Claude desktop routine", name: r.name, job: sentence(r.description) || "Scheduled prompt in the Claude desktop app.",
    dept: "routines", trigger: [["Schedule", r.cron ? cronToText(r.cron) : "Set in the Claude app's Scheduled sidebar"]],
    connects: connectsFrom({ tools: [], mcpNames: [], text: r.body.slice(0, 6000) }), model: "Claude (desktop app)", status: "testing",
    statusNote: "Registered as a desktop routine; whether it is switched on is only visible in the app (runs while the app is open).",
    waiting: [], handoff: [], path: `~/.claude/scheduled-tasks/${r.id}/`, source: path.join(os.homedir(), ".claude", "scheduled-tasks", r.id),
  }));
}

// ---------------------------------------------------------------- merge
function merge(prev, fresh, cfg) {
  const data = prev && !prev.demo ? prev : { team: [], planned: [], aliases: {}, depts: [], schedManual: [] };
  const freshById = new Map(fresh.cards.map((c) => [c.id, c]));
  const notes = [];
  const placed = new Set();
  for (const d of data.depts) {
    d.agents = d.agents.filter((a) => {
      if (a.auto) {
        const f = freshById.get(a.id);
        if (!f) { notes.push(`removed ${a.name} (no longer found)`); return false; }
        return true;
      }
      if (a.external || !a.source) return true;
      if (!fs.existsSync(a.source)) { notes.push(`removed ${a.name} (folder ${a.path} is gone)`); return false; }
      placed.add(a.id);
      return true;
    }).map((a) => {
      if (!a.auto) return a;
      const f = freshById.get(a.id); placed.add(a.id);
      const { dept, ...rest } = f;
      return { ...rest, dept: d.id };
    });
  }
  for (const c of fresh.cards) {
    if (placed.has(c.id)) continue;
    let d = data.depts.find((x) => x.id === c.dept);
    if (!d) { d = { id: c.dept, name: DEPT_META[c.dept]?.name || c.dept, blurb: DEPT_META[c.dept]?.blurb || "", who: "", agents: [] }; data.depts.push(d); }
    d.agents.push(c);
    notes.push(`added ${c.name} → ${d.name}`);
  }
  data.depts = data.depts.filter((d) => d.agents.length || d.keep);
  for (const d of data.depts) for (const a of d.agents) delete a.dept;
  // hand-maintained rows (schedManual) override discovered rows for the same task + runner
  const manual = data.schedManual || [];
  const key = (r) => `${r[1]}|${r[2]}`;
  const mk = new Set(manual.map(key));
  data.sched = [...fresh.sched.filter((r) => !mk.has(key(r))), ...manual];
  data.demo = false;
  data.last_scan = stamp().slice(0, 10);
  data.generated = stamp();
  data.sources = fresh.sources;
  return { data, notes };
}

// ---------------------------------------------------------------- main
function main() {
  const cfg = loadConfig();
  const dirArg = argVal("--dir");
  if (dirArg) { cfg.agentsDir = dirArg; if (!DRY) saveConfig(cfg); }
  const agentsDir = expandHome(cfg.agentsDir);
  if (!agentsDir || !fs.existsSync(agentsDir)) {
    console.error(`No agents folder configured or found${agentsDir ? ` (${agentsDir})` : ""}.\nRun:  npm run scan -- --dir /path/to/your/agents   (or npm run setup)`);
    process.exit(2);
  }
  const bases = [agentsDir, ...(cfg.extraDirs || []).map(expandHome).filter((d) => d && fs.existsSync(d))];
  const ctx = { crontab: schedulesFromCrontab(), launchd: launchdJobs(), routines: cfg.includeScheduledTasks ? desktopRoutines() : [] };

  const units = discoverUnits(bases).map((u) => inspectUnit(u, ctx));
  let cards = units.flatMap((u) => cardsForUnit(u, cfg));
  const names = new Set(cards.map((c) => c.name));
  if (cfg.includeUserAgents) cards = cards.concat(userLevelCards(cfg, names));
  if (cfg.includeScheduledTasks) cards = cards.concat(routineCards(ctx.routines));

  const sched = [];
  for (const u of units) for (const s of u.schedules) {
    sched.push([s.text || (s.cron ? cronToText(s.cron) : "set in the Claude app"), `${s.name || u.name} (${u.name})`, s.runner, s.state === "on" ? "on" : "unknown"]);
  }
  for (const r of ctx.routines.filter((r) => !r.claimed)) sched.push([r.cron ? cronToText(r.cron) : "set in the Claude app", r.name, "Claude desktop routine", "unknown"]);

  const prev = readJSON(P.data, null);
  const { data, notes } = merge(prev, { cards, sched, sources: bases.map((b) => path.basename(b)) }, cfg);

  // inventory diff (what files define the workforce) for CHANGES.md
  const inv = {};
  for (const u of units) for (const f of u.files) inv[`${u.name}/${f}`] = 1;
  for (const r of ctx.routines) inv[`routine:${r.id}`] = 1;
  const old = readJSON(P.inventory, null);
  const added = Object.keys(inv).filter((k) => !old || !(k in old));
  const removed = old ? Object.keys(old).filter((k) => !(k in inv)) : [];
  const changed = !old || added.length || removed.length || notes.length;

  const total = data.depts.reduce((n, d) => n + d.agents.length, 0);
  const lines = [`# Roster scan ${stamp()}`, "", `Scanned: ${bases.join(", ")}`, `Roster: ${total} agents in ${data.depts.length} departments`, "",
    "## Roster changes", ...(notes.length ? notes.map((n) => `- ${n}`) : ["- none"]), "",
    `## Definition files added (${added.length})`, ...added.slice(0, 80).map((k) => `- ${k}`), "",
    `## Definition files removed (${removed.length})`, ...removed.slice(0, 80).map((k) => `- ${k}`), ""];
  if (DRY) { console.log(lines.join("\n")); process.exit(changed ? 3 : 0); }
  writeJSON(P.data, data);
  writeJSON(P.inventory, inv);
  fs.writeFileSync(P.changes, lines.join("\n") + "\n");
  log(`Scanned ${units.length} folders → ${total} agents in ${data.depts.length} departments.${notes.length ? ` ${notes.length} roster change(s).` : " No roster changes."}`);
  if (notes.length) log(notes.slice(0, 15).map((n) => "  · " + n).join("\n"));
  process.exit(changed ? 3 : 0);
}

main();
