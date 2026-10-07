"""Build the boot intro: an ORIGINAL Iron-Man-style suit-up (arc reactor ignition, armour assembling, impact)
that lands on a gritty hard-rock riff. No film audio is used.

  python3 gen_intro.py            # generate SFX + 3 music candidates, mix, rate each with Gemini, install the best
  python3 gen_intro.py --remix    # re-mix and re-rate from the stems already on disk

Outputs: web/assets/sfx/intro.mp3 (chosen), intro_b.mp3, intro_c.mp3 (alternates, audition with ?intro=b / ?intro=c),
         tools/.stems/ (raw stems and ratings, git-ignored). Needs ELEVENLABS_API_KEY (+ GEMINI_API_KEY for the rating step).
"""
import base64, json, os, subprocess, sys, urllib.request, urllib.error
from _keys import get_key, ROOT

HERE = os.path.dirname(os.path.abspath(__file__))
SFX = os.path.join(ROOT, "web", "assets", "sfx")
STEMS = os.path.join(HERE, ".stems")
EL = "https://api.elevenlabs.io/v1"

NEG_GLOBAL = ["orchestra", "strings", "brass", "horns", "news theme", "news jingle", "corporate", "synth pads", "synthesizer",
              "electronic", "piano", "choir", "vocals", "ticking clock", "trailer percussion", "lo-fi"]

BUILD = ("Suit-up build", ["music starts immediately", "low pulsing bass drone", "rising distorted guitar feedback swell",
          "building tom-tom rolls", "tension rising to a peak", "medium volume"], 3000)
PLANS = {
  "a": {"positive_global_styles": ["hard rock", "bluesy stadium rock riff", "crunchy overdriven electric guitar", "open power chords with swagger",
                                   "driving rock drums", "punchy bass guitar", "1980s arena hard rock", "instrumental", "triumphant", "cocky confidence"],
        "sections": [BUILD,
                     ("Riff lands", ["big distorted guitar riff slams in", "power chords with swagger", "kick and snare"], 4000),
                     ("Full band", ["full band at maximum energy", "riff doubled with bass", "crash cymbals"], 4000),
                     ("Big finish", ["stop-time hits", "final huge ringing power chord", "feedback tail"], 3000)]},
  "b": {"positive_global_styles": ["modern hard rock", "heavy chugging guitar riff", "drop-tuned overdriven guitars", "tight aggressive drums",
                                   "growling bass", "high-tech action", "instrumental", "powerful", "swagger"],
        "sections": [BUILD,
                     ("Riff lands", ["heavy main riff hits hard", "full drums", "bass locked to the riff"], 4000),
                     ("Groove", ["headbanging groove", "riff variation", "driving energy"], 4000),
                     ("Slam", ["three unison band hits", "final power chord ringing out", "crash cymbals"], 3000)]},
  "c": {"positive_global_styles": ["classic hard rock", "swaggering bluesy guitar riff", "Marshall-stack crunch", "groovy rock drums",
                                   "bass guitar", "rebellious billionaire energy", "instrumental", "fun", "loud"],
        "sections": [BUILD,
                     ("Riff lands", ["catchy crunchy guitar riff explodes in", "drums and bass slam in"], 4000),
                     ("Full band", ["riff repeats with full band", "driving rock feel", "guitar fills"], 4000),
                     ("Ending", ["guitar lick flourish", "final stab and ringing chord", "crash"], 3000)]},
}

SFX_PROMPTS = {
  "boot":  ("Arc reactor ignition: a deep electrical hum rising in pitch, crackling energy and a bright high-tech power-up whine, cinematic, clean, no music", 3.5),
  "suit":  ("A robotic armour suit assembling around a person: fast servo motors whirring, metal plates sliding and locking with sharp clanks, hydraulic hiss, ending in one heavy metallic lock, cinematic, no music", 3.0),
  "hit":   ("A powerful cinematic energy impact: a repulsor blast discharge with a deep sub boom, short and punchy, no music", 1.5),
}

def el_post(path, body, timeout=240):
    req = urllib.request.Request(EL + path, data=json.dumps(body).encode(), method="POST",
                                 headers={"xi-api-key": get_key("elevenlabs"), "Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout).read()

def dur(p):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", p],
                                capture_output=True, text=True).stdout.strip())

def gen_stems():
    os.makedirs(STEMS, exist_ok=True)
    for name, (text, d) in SFX_PROMPTS.items():
        p = os.path.join(STEMS, f"sfx_{name}.mp3")
        if os.path.exists(p): continue
        open(p, "wb").write(el_post("/sound-generation", {"text": text, "duration_seconds": d, "prompt_influence": 0.55}))
        print(f"  sfx {name}: {dur(p):.1f}s")
    for key, plan in PLANS.items():
        p = os.path.join(STEMS, f"music_{key}.mp3")
        if os.path.exists(p): continue
        comp = {"positive_global_styles": plan["positive_global_styles"], "negative_global_styles": NEG_GLOBAL,
                "sections": [{"section_name": n, "positive_local_styles": pos, "negative_local_styles": ["vocals", "orchestra", "brass"],
                              "duration_ms": ms, "lines": []} for n, pos, ms in plan["sections"]]}
        try:
            audio = el_post("/music", {"composition_plan": comp})
        except urllib.error.HTTPError as e:
            print(f"  music {key}: HTTP {e.code} {e.read()[:240].decode(errors='replace')}"); continue
        open(p, "wb").write(audio)
        print(f"  music {key}: {dur(p):.1f}s")

def mix(key):
    m = os.path.join(STEMS, f"music_{key}.mp3")
    if not os.path.exists(m): return None
    out = os.path.join(STEMS, f"mix_{key}.mp3")
    land = 3.0                      # where the riff lands in the music (end of the build section)
    total = dur(m)
    fc = (f"[0:a]volume=1.0,afade=t=out:st=2.7:d=0.9[a0];"
          f"[1:a]adelay=800|800,volume=0.95,afade=t=out:st=3.4:d=0.5[a1];"
          f"[2:a]volume='if(lt(t,{land}),0.8,1.0)':eval=frame[a2];"
          f"[3:a]adelay={int((land-0.12)*1000)}|{int((land-0.12)*1000)},volume=0.8[a3];"
          f"[a0][a1][a2][a3]amix=inputs=4:normalize=0:duration=longest,"
          f"afade=t=out:st={total-1.6:.2f}:d=1.6,loudnorm=I=-14:TP=-1.0:LRA=11[out]")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error",
                    "-i", os.path.join(STEMS, "sfx_boot.mp3"), "-i", os.path.join(STEMS, "sfx_suit.mp3"),
                    "-i", m, "-i", os.path.join(STEMS, "sfx_hit.mp3"),
                    "-filter_complex", fc, "-map", "[out]", "-ar", "44100", "-b:a", "192k", out], check=True)
    return out

RATE_PROMPT = ("You are a film music supervisor. Listen to this short intro clip, meant to play as a web dashboard boots up: "
               "music should play from the first second underneath the sound effects, and it should feel like a billionaire superhero's armoured suit powering up and his AI butler coming online, landing on a "
               "gritty, swaggering hard-rock guitar riff. It must NOT feel like a TV news jingle, corporate ident or orchestral trailer. "
               "Return JSON with keys: genre (string), instruments (array of strings), suit_up_sfx_heard (bool), hard_rock_guitar_heard (bool), "
               "music_under_sfx_from_start (bool: is music audible underneath the opening sound effects, not silence or effects alone), "
               "sounds_like_news_jingle (bool), orchestral_or_brass_heard (bool), energy (1-10), fit_for_brief (1-10), notes (one sentence).")

def rate(path):
    key = get_key("gemini")
    data = base64.b64encode(open(path, "rb").read()).decode()
    body = {"contents": [{"parts": [{"inline_data": {"mime_type": "audio/mpeg", "data": data}}, {"text": RATE_PROMPT}]}],
            "generationConfig": {"responseMimeType": "application/json"}}
    for model in ("gemini-2.5-flash", "gemini-2.5-pro"):
        req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}",
                                     data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        try:
            d = json.load(urllib.request.urlopen(req, timeout=180))
            txt = d["candidates"][0]["content"]["parts"][0]["text"]
            r = json.loads(txt); r["rater"] = model; return r
        except (urllib.error.HTTPError, KeyError, json.JSONDecodeError) as e:
            print(f"  rate via {model} failed: {getattr(e, 'code', '')} {str(e)[:120]}")
    return {"fit_for_brief": 0, "notes": "rating failed"}

def score(r):
    s = r.get("fit_for_brief", 0) * 2 + r.get("energy", 0)
    s += 3 if r.get("hard_rock_guitar_heard") else -5
    s += 2 if r.get("suit_up_sfx_heard") else 0
    s += 3 if r.get("music_under_sfx_from_start") else -4
    s -= 8 if r.get("sounds_like_news_jingle") else 0
    s -= 4 if r.get("orchestral_or_brass_heard") else 0
    return s

if __name__ == "__main__":
    if "--remix" not in sys.argv:
        print("generating stems …"); gen_stems()
    ratings = {}
    for k in PLANS:
        p = mix(k)
        if not p: continue
        r = rate(p); r["score"] = score(r); r["seconds"] = round(dur(p), 1); ratings[k] = r
        print(f"  mix {k}: {r['seconds']}s score {r['score']} | {r.get('genre')} | news={r.get('sounds_like_news_jingle')} "
              f"rock={r.get('hard_rock_guitar_heard')} sfx={r.get('suit_up_sfx_heard')} fit={r.get('fit_for_brief')} | {r.get('notes')}")
    order = sorted(ratings, key=lambda k: ratings[k]["score"], reverse=True)
    if not order: raise SystemExit("no intro candidates were produced")
    os.makedirs(SFX, exist_ok=True)
    import shutil
    for i, k in enumerate(order):
        dst = "intro.mp3" if i == 0 else f"intro_{'bc'[i-1]}.mp3"
        shutil.copy(os.path.join(STEMS, f"mix_{k}.mp3"), os.path.join(SFX, dst))
        ratings[k]["installed_as"] = dst
    json.dump(ratings, open(os.path.join(STEMS, "ratings.json"), "w"), indent=2)
    print("installed:", {ratings[k]["installed_as"]: k for k in order})
