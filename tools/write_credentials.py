"""CI helper: bake OAuth app IDs from environment (GitHub secrets) into litecast/credentials.py."""
import os
import re

PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "litecast", "credentials.py")
KEYS = ("TWITCH_CLIENT_ID", "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "KICK_CLIENT_ID", "KICK_CLIENT_SECRET")

src = open(PATH, encoding="utf-8").read()
for key in KEYS:
    val = os.environ.get(key, "").strip()
    if val:
        src = re.sub(r'^%s = ".*"' % key, '%s = %r' % (key, val), src, flags=re.M)
    print("%-22s %s" % (key, "set" if val else "not set (login button hidden)"))
open(PATH, "w", encoding="utf-8").write(src)
