# JARVIS Command Centre — guide for Claude Code

This repo turns a folder of AI agents into a holographic, voice-controlled dashboard. A local Node server
(`npm start`) serves the page and two API functions: `/api/jarvis` (live answers from Claude) and `/api/tts`
(ElevenLabs speech). The same functions deploy unchanged to Vercel (`npm run deploy`).

## Slash commands in this repo
- `/jarvis-setup` — first-time onboarding: install, point at the agents folder, scan, enrich, start.
- `/jarvis-scan` — rescan the agents folder and write rich descriptions for every auto-detected card.
- `/jarvis-deploy` — publish to Vercel with an access code.

## How it fits together
| Path | Role |
|---|---|
| `bin/scan.mjs` | Deterministic scanner → `data/roster.json`. Cards it writes have `"auto": true`. |
| `bin/build.mjs` | `web/template.html` + roster + config → `public/index.html` and `api/_lib/roster-context.js` (the assistant's knowledge). |
| `bin/serve.mjs` | Local server on 127.0.0.1 with the ⚙ Connections endpoints (`/api/local/*`). |
| `bin/voice.mjs` | ElevenLabs clips (briefing, answers, one status line per agent) → `data/voice/`. |
| `bin/setup.mjs` | Interactive wizard; `--yes --dir … --name … --org …` for non-interactive use. |
| `api/jarvis.js`, `api/tts.js` | Live endpoints (Anthropic SDK, `claude-sonnet-5-5` by default; ElevenLabs Flash). |
| `jarvis.config.json` | Identity, agents folder, model, voice (git-ignored; created by setup). |
| `.env` | `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `JARVIS_ACCESS_CODE` (git-ignored, mode 600). |

## Roster card schema (`data/roster.json → depts[].agents[]`)
```json
{
  "id": "stable-slug", "auto": false, "tag": "Claude Code agent", "name": "Lead Qualifier",
  "job": "One plain sentence: what it does for the business.",
  "trigger": [["Schedule", "Azure timer · 10:00, 18:00 daily"], ["Manual", "/qualify"]],
  "connects": ["HubSpot", "Gmail", "MCP: crm"],
  "model": "Claude Sonnet 5.5",
  "status": "live | testing | blocked",
  "statusNote": "One or two sentences of evidence for the status.",
  "waitingLabel": "Waiting on | Before going live",
  "waiting": ["each named prerequisite"],
  "handoff": ["<b>Next agent or person</b> when …"],
  "skills": ["skill-name", "/command"],
  "path": "folder/relative/to/agents/dir/",
  "source": "/absolute/path/to/the/folder"
}
```
Top level also holds `team` (`[{av, name, role}]`), `planned` (`[["Agent 9", "Name"]]`), `aliases`
(`{"spoken phrase": "Agent name"}`) and `schedManual` (extra schedule rows `[when, task, runner, "on|off|na|unknown"]`).

Status rules: **live** = runs on its own schedule or trigger; **testing** = built but shadow mode or manual only;
**blocked** = a named, unmet prerequisite (missing key, app registration, approval, go-live gate).

## Rules for any session in this repo
- **Never ask the user to paste API keys into chat, and never print, `cat` or grep `.env`.** Keys go in through the
  dashboard's ⚙ Connections panel (`http://localhost:7777/?connect=1`) or the hidden prompt in `npm run setup`.
- The scanner never reads secrets; when you enrich cards, don't open `.env*`, key files, or credential stores,
  and never copy credential-looking strings, client personal data or phone numbers into `data/roster.json`.
- Setting `"auto": false` on a card protects your edits from the next scan. Keep `id`, `path` and `source`.
- After editing the roster run `npm run build`; if ElevenLabs is connected, `npm run voice` re-records only the
  clips whose text changed.
- Don't edit `public/` or `api/_lib/roster-context.js` — both are generated.
