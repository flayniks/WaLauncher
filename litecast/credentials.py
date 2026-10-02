"""OAuth app IDs for "Log in with Twitch / YouTube / Kick".

Every streaming site needs the app to be registered once (free, ~5 min each):
see LOGIN_SETUP.md. Put the IDs here, or set them as GitHub Actions secrets
(the build writes them in), or drop an oauth.json next to settings.json.
Without them the app still works; you just paste your stream key instead.
"""

import json
import os

TWITCH_CLIENT_ID = ""

YOUTUBE_CLIENT_ID = ""
YOUTUBE_CLIENT_SECRET = ""  # Google "Desktop app" secrets aren't actually secret

KICK_CLIENT_ID = ""
KICK_CLIENT_SECRET = ""
KICK_REDIRECT_PORT = 17563  # register http://localhost:17563/callback on kick.com

_KEYS = ("TWITCH_CLIENT_ID", "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "KICK_CLIENT_ID", "KICK_CLIENT_SECRET")


def load(data_dir=None):
    """Constants, overridden by oauth.json in the data dir, overridden by LITECAST_* env vars."""
    creds = {k: globals()[k] for k in _KEYS}
    creds["KICK_REDIRECT_PORT"] = KICK_REDIRECT_PORT
    if data_dir:
        try:
            with open(os.path.join(data_dir, "oauth.json"), encoding="utf-8") as f:
                extra = json.load(f)
            creds.update({k: v for k, v in extra.items() if k in creds and v})
        except (OSError, ValueError, AttributeError):
            pass
    for k in _KEYS:
        if os.environ.get("LITECAST_" + k):
            creds[k] = os.environ["LITECAST_" + k]
    return creds
