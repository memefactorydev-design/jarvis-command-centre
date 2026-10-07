// Speak one sentence in the configured ElevenLabs voice (streamed MP3). The ElevenLabs key stays server-side.
// POST {text} → audio/mpeg
import { ctx } from "./_lib/context.js";
import { checkAccess, json, rateLimit } from "./_lib/guard.js";

export async function POST(request) {
  const denied = checkAccess(request);
  if (denied) return denied;
  const limited = rateLimit(request, "tts", 200, 10 * 60 * 1000);
  if (limited) return limited;
  if (!process.env.ELEVENLABS_API_KEY) return json({ error: "voice_not_connected" }, 503);

  let payload;
  try { payload = await request.json(); } catch { return json({ error: "bad_json" }, 400); }
  const text = String((payload && payload.text) || "").trim().slice(0, 600);
  if (!text) return json({ error: "no_text" }, 400);

  const c = ctx();
  const voiceId = process.env.JARVIS_VOICE_ID || c.VOICE_ID;
  const model = process.env.JARVIS_TTS_MODEL || c.TTS_MODEL || "eleven_flash_v2_5";
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=mp3_44100_64`, {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true } }),
  });
  if (!r.ok || !r.body) {
    console.error("tts upstream", r.status);
    return json({ error: "tts_upstream", status: r.status }, 502);
  }
  return new Response(r.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
}
