---
description: First-time setup — point JARVIS at your agents folder, describe every agent, and start the command centre
argument-hint: "[path to your agents folder]"
---
Set up the JARVIS Command Centre for me. Work through these steps in order and keep me posted in one line per step.

1. **Install.** If `node_modules/` is missing, run `npm install`. Check `node --version` is 20 or newer; if not, stop and tell me how to install Node.
2. **Find my agents.** Use "$ARGUMENTS" as the agents folder if I gave one. Otherwise look for a folder whose sub-folders contain `.claude/agents`, `CLAUDE.md`, `AGENTS.md` or `SKILL.md` (start with this repo's parent folder, then `~/Projects/Agents`, `~/agents`, `~/Projects`) and confirm your pick with me in one short question. Also ask my name, my organisation's name, what the assistant should call me (default "sir") and whether to keep the name JARVIS — one combined question, with sensible defaults so I can just say "go".
3. **Configure without keys.** Run `node bin/setup.mjs --yes --no-start --dir "<folder>" --name "<my name>" --org "<organisation>" --assistant "<name>" --honorific "<honorific>"`. This scans the folder and builds the dashboard.
4. **Describe every agent.** Follow `.claude/commands/jarvis-scan.md` from step 2 onwards, so each card gets a real job description, triggers, connections, status, blockers and hand-offs.
5. **Start it.** Run `npm start` in the background, then tell me to open **http://localhost:7777/?connect=1** — that opens the ⚙ Connections panel where I paste my Anthropic and ElevenLabs keys myself.
   **Never ask me to paste keys into this chat, and never read or print `.env`.**
6. **Finish.** Tell me: how many agents were found per department, how many are live / testing / blocked, and that once ElevenLabs is connected the "♪ Record voice clips" button in Connections records the spoken briefing. Mention `/jarvis-deploy` if I want it online.
