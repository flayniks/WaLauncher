"""Dev harness: serve the real UI in a normal browser, backed by the real Api over HTTP.

    python tools/devserver.py [--port 8765] [--fake-logins OUTDIR]

--fake-logins wires up pretend Twitch/YouTube/Kick servers so the login and
go-live flows can be clicked through without real accounts (streams go to
OUTDIR/<platform>.flv).
"""

import argparse
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from litecast import accounts as A  # noqa: E402
from litecast import engine as E  # noqa: E402
from litecast.api import Api  # noqa: E402

SHIM = ("<script>window.pywebview={api:new Proxy({},{get:(_,n)=>(...a)=>fetch('/api/'+n,"
        "{method:'POST',body:JSON.stringify(a)}).then(r=>r.json())})};</script>")


def fake_http(outdir):
    polls = {"n": 0}

    def http(method, url, form=None, body=None, headers=None, timeout=20):
        if "id.twitch.tv/oauth2/device" in url:
            return 200, {"device_code": "dev", "user_code": "WXYZ-1234", "interval": 1, "expires_in": 60,
                         "verification_uri": "https://www.twitch.tv/activate?device-code=WXYZ1234"}
        if "oauth2/token" in url or "oauth/token" in url:
            polls["n"] += 1
            if "twitch" in url and polls["n"] % 3:
                return 400, {"status": 400, "message": "authorization_pending"}
            return 200, {"access_token": "tok", "refresh_token": "ref", "expires_in": 14000}
        if "helix/users" in url:
            return 200, {"data": [{"id": "42", "login": "potatostreamer", "display_name": "PotatoStreamer",
                                   "profile_image_url": ""}]}
        if "helix/channels" in url:
            return 204, {}
        if "helix/streams/key" in url:
            return 200, {"data": [{"stream_key": "live_fake"}]}
        if "youtube/v3/channels" in url:
            return 200, {"items": [{"id": "UC1", "snippet": {"title": "Potato Gaming", "thumbnails": {}}}]}
        if "api.kick.com/public/v1/users" in url:
            return 200, {"data": [{"name": "kickpotato", "profile_picture": "", "user_id": 7}]}
        return 404, {"message": "not faked: " + url}

    class FakeTwitch(A.Twitch):
        def go_live(self, tok, prof, title, privacy):
            return outdir, "twitch.flv", ""

    class FakeYouTube(A.YouTube):
        def login(self, progress, cancel, open_url):
            progress({"stage": "browser", "url": "https://accounts.google.com/"})
            time.sleep(1.5)
            return A._expiry({"access_token": "tok", "refresh_token": "ref", "expires_in": 3600})

        def go_live(self, tok, prof, title, privacy):
            return outdir, "youtube.flv", ""

    class FakeKick(A.Kick):
        login = FakeYouTube.login

        def go_live(self, tok, prof, title, privacy):
            return outdir, "kick.flv", ""

    return http, (FakeTwitch, FakeYouTube, FakeKick)


def make_api(args):
    if not args.fake_logins:
        return Api()
    os.makedirs(args.fake_logins, exist_ok=True)
    http, classes = fake_http(args.fake_logins)
    A.PLATFORM_CLASSES = classes
    creds = {"TWITCH_CLIENT_ID": "x", "YOUTUBE_CLIENT_ID": "x", "YOUTUBE_CLIENT_SECRET": "x",
             "KICK_CLIENT_ID": "x", "KICK_CLIENT_SECRET": "x", "KICK_REDIRECT_PORT": 17563}
    acc = A.Accounts(os.path.join(E.data_dir(), "accounts.json"), creds, http=http, open_url=lambda u: None)
    api = Api(accounts=acc)
    if args.fake_windows:
        _fake_windows(api)
    return api


def _fake_windows(api):
    """Pretend we're on Windows with a few apps open (for UI work on Linux)."""
    from litecast import winapi as W

    def img(w, h, c1, c2):
        px = bytearray()
        for y in range(h):
            for x in range(w):
                t = (x + y) / float(w + h)
                px += bytes(int(a + (b - a) * t) for a, b in zip(c1, c2))
        return W.data_url(W.png_bytes(w, h, px, 3))

    apps = [("Minecraft* 1.21 - Singleplayer", "javaw.exe", (40, 120, 60), (120, 200, 255)),
            ("Fortnite", "FortniteClient-Win64-Shipping.exe", (90, 40, 160), (250, 120, 60)),
            ("YouTube - Google Chrome", "chrome.exe", (30, 30, 40), (200, 40, 40)),
            ("Discord", "Discord.exe", (60, 70, 200), (30, 30, 60)),
            ("Roblox", "RobloxPlayerBeta.exe", (20, 20, 20), (220, 220, 220))]
    thumbs = {1000 + i: img(256, 144, a, b) for i, (_, _, a, b) in enumerate(apps)}
    wins = [{"hwnd": 1000 + i, "title": t, "exe": e, "path": "C:/" + e, "minimized": i == 3}
            for i, (t, e, _, _) in enumerate(apps)]
    real_init, real_thumb = api.init, api.thumb
    api.init = lambda: dict(real_init(), can_pick_windows=True)
    api.sources = lambda: {"screens": [{"id": 0, "name": "Screen 1 (main)", "w": 1920, "h": 1080},
                                       {"id": 1, "name": "Screen 2", "w": 1366, "h": 768}], "windows": wins}
    api.thumb = lambda kind, ident: thumbs.get(int(ident)) if kind == "window" else img(256, 144, (20, 30, 60), (90, 60, 140))
    api.icon = lambda path: None if "Roblox" in path else img(32, 32, (255, 200, 0), (255, 60, 120))
    W.find_window = lambda hwnd=0, exe="", title="": next((w for w in wins if w["hwnd"] == hwnd), None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--fake-logins")
    ap.add_argument("--fake-windows", action="store_true")
    args = ap.parse_args()
    api = make_api(args)
    page = open(os.path.join(ROOT, "litecast", "ui", "index.html"), encoding="utf-8").read()
    page = page.replace("<head>", "<head>" + SHIM, 1).encode()

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(page)

        def do_POST(self):
            name = self.path[len("/api/"):]
            body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            fn = getattr(api, name, None) if not name.startswith("_") else None
            if not callable(fn):
                self.send_response(404)
                self.end_headers()
                return
            try:
                res = fn(*json.loads(body or b"[]"))
                code = 200
            except Exception as e:
                res, code = {"error": repr(e)}, 500
            out = json.dumps(res).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *a):
            pass

    print("serving on http://127.0.0.1:%d" % args.port, flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), H).serve_forever()


if __name__ == "__main__":
    main()
