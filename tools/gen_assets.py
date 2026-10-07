"""Generate the HUD artwork with Google's Gemini image models ("Nano Banana"), then build the portal GIF/MP4.
Needs GEMINI_API_KEY (environment or .env) and Pillow + ffmpeg. Writes to web/assets/.

  python3 gen_assets.py            # all images + animation
  python3 gen_assets.py ring orb   # only those
  python3 gen_assets.py anim       # rebuild the GIF/MP4 from existing PNGs
"""
import base64, json, os, subprocess, sys, time, urllib.request, urllib.error
from _keys import get_key, ROOT

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "web", "assets")
MODELS = ["gemini-3.1-flash-image", "gemini-2.5-flash-image"]

STYLE = ("cinematic science-fiction holographic user interface, glowing cyan (#19d3ff) light with warm gold (#ffb347) accents, "
         "thin precise lines, soft light bloom, PURE BLACK background (#000000), no text, no letters, no logos, no people, no characters")

IMAGES = {
  "ring":   ("1:1",  f"Top-down view of a circular holographic portal: concentric thin rings, segmented arcs, fine tick marks and small "
                     f"rotating reticle elements around the circumference, the very centre is empty pure black. {STYLE}"),
  "orb":    ("1:1",  f"A single glowing cyan-blue energy core sphere floating in darkness: an artificial-intelligence core with fine circuit "
                     f"filaments inside, soft volumetric glow, slight gold reflections, centred, nothing else in frame. {STYLE}"),
  "hud_bg": ("16:9", f"Very dark background texture for a command-centre dashboard: near-black navy with a faint cyan hexagonal grid, a few thin "
                     f"schematic lines and tiny glowing nodes, extremely low contrast so text can sit on top, soft vignette at the edges. {STYLE}"),
  "emblem": ("1:1",  f"Minimal glowing emblem for an AI workforce command centre: a hexagon outline containing a triangle of light with a small "
                     f"core at its centre, cyan with a thin gold rim, centred, symmetrical, icon-like. {STYLE}"),
}

def gen(name, aspect, prompt):
    key = get_key("gemini")
    last = None
    for model in MODELS:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
        for cfg in ({"responseModalities": ["IMAGE"], "imageConfig": {"aspectRatio": aspect}},
                    {"responseModalities": ["IMAGE", "TEXT"]}):
            body = {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": cfg}
            req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
            try:
                d = json.load(urllib.request.urlopen(req, timeout=180))
            except urllib.error.HTTPError as e:
                last = f"{model} HTTP {e.code} {e.read()[:200].decode(errors='replace')}"
                print("  retry:", last); continue
            for part in d.get("candidates", [{}])[0].get("content", {}).get("parts", []):
                blob = part.get("inlineData") or part.get("inline_data")
                if blob:
                    ext = "png" if "png" in blob.get("mimeType", blob.get("mime_type", "png")) else "jpg"
                    path = os.path.join(OUT, f"{name}.{ext}")
                    with open(path, "wb") as f: f.write(base64.b64decode(blob["data"]))
                    print(f"  {name}: {model} -> {os.path.basename(path)} ({os.path.getsize(path)//1024} KB)")
                    return path
            last = f"{model}: no image in response: {json.dumps(d)[:200]}"
            print("  retry:", last)
    raise SystemExit(f"gen_assets: failed for {name}: {last}")

def animate():
    from PIL import Image, ImageEnhance, ImageChops
    def load(stem):
        for ext in ("png", "jpg", "jpeg"):
            p = os.path.join(OUT, f"{stem}.{ext}")
            if os.path.exists(p): return Image.open(p).convert("RGB").resize((640, 640), Image.LANCZOS)
        raise SystemExit(f"gen_assets: missing {stem} image")
    ring = load("ring"); orb = load("orb")
    frames = []
    N = 60
    for i in range(N):
        t = i / N
        r = ring.rotate(-360 * t, resample=Image.BICUBIC, fillcolor=(0, 0, 0))
        # counter-rotating faint copy for depth
        r2 = ring.rotate(360 * t * 0.5, resample=Image.BICUBIC, fillcolor=(0, 0, 0))
        r2 = ImageEnhance.Brightness(r2.resize((520, 520), Image.LANCZOS)).enhance(0.45)
        pad = Image.new("RGB", (640, 640), (0, 0, 0)); pad.paste(r2, (60, 60))
        pulse = 0.72 + 0.28 * (0.5 + 0.5 * __import__("math").sin(2 * 3.14159 * t * 2))
        o = ImageEnhance.Brightness(orb.resize((300, 300), Image.LANCZOS)).enhance(pulse)
        pad2 = Image.new("RGB", (640, 640), (0, 0, 0)); pad2.paste(o, (170, 170))
        frame = ImageChops.screen(ImageChops.screen(r, pad), pad2)
        frames.append(frame)
    gif = os.path.join(OUT, "portal.gif")
    small = [f.resize((360, 360), Image.LANCZOS).quantize(colors=128, method=Image.Quantize.FASTOCTREE) for f in frames]
    small[0].save(gif, save_all=True, append_images=small[1:], duration=50, loop=0, optimize=True)
    print(f"  portal.gif ({os.path.getsize(gif)//1024} KB, {N} frames)")
    tmp = os.path.join(OUT, "_frames"); os.makedirs(tmp, exist_ok=True)
    for i, f in enumerate(frames): f.save(os.path.join(tmp, f"f{i:03}.png"))
    mp4 = os.path.join(OUT, "portal.mp4")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", "20", "-i", os.path.join(tmp, "f%03d.png"),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22", "-movflags", "+faststart", mp4], check=True)
    for fn in os.listdir(tmp): os.remove(os.path.join(tmp, fn))
    os.rmdir(tmp)
    print(f"  portal.mp4 ({os.path.getsize(mp4)//1024} KB)")

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    want = sys.argv[1:] or list(IMAGES) + ["anim"]
    for n in want:
        if n == "anim": continue
        print(f"generating {n} …"); gen(n, *IMAGES[n]); time.sleep(1)
    if "anim" in want or not sys.argv[1:]:
        print("building animation …"); animate()
