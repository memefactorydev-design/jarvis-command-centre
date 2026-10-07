# Studio tools (optional)

The artwork, portal animation and intro music already ship in `web/assets/`. Use these only to make your own.

| Tool | Makes | Needs |
|---|---|---|
| `python3 tools/gen_assets.py` | ring, orb, background and emblem art with Google's Gemini image models ("Nano Banana"), then the rotating portal GIF + MP4 | `GEMINI_API_KEY`, Pillow, ffmpeg |
| `python3 tools/gen_assets.py anim` | only rebuild the portal GIF/MP4 from the existing images | Pillow, ffmpeg |
| `python3 tools/gen_intro.py` | an original suit-up intro: arc-reactor ignition, servos, impact and a hard-rock riff — three candidates from the ElevenLabs Music API, mixed with ffmpeg, rated by Gemini listening to the audio; the best becomes `intro.mp3`, the others `intro_b.mp3` / `intro_c.mp3` (audition with `?intro=b`) | `ELEVENLABS_API_KEY`, `GEMINI_API_KEY`, ffmpeg |

Keys are read from your environment or `.env` and never printed. Edit the prompts at the top of each script to change the look or the sound, then run `npm run build`.
