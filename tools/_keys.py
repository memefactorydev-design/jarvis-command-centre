"""Key loading for the optional studio tools: environment variables first, then the repo's .env. Never printed."""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NAMES = {"gemini": "GEMINI_API_KEY", "elevenlabs": "ELEVENLABS_API_KEY"}


def get_key(name: str) -> str:
    var = NAMES[name]
    if os.environ.get(var):
        return os.environ[var]
    try:
        for line in open(os.path.join(ROOT, ".env"), encoding="utf-8"):
            k, _, v = line.strip().partition("=")
            if k == var and v:
                return v.strip().strip('"').strip("'")
    except OSError:
        pass
    raise SystemExit(f"Set {var} in your environment or .env to use this tool.")
