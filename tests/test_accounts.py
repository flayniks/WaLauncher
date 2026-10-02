import json
import os
import shutil
import tempfile
import threading
import time
import unittest
import urllib.request

from litecast import accounts as A

CREDS = {"TWITCH_CLIENT_ID": "tw", "YOUTUBE_CLIENT_ID": "yt", "YOUTUBE_CLIENT_SECRET": "ys",
         "KICK_CLIENT_ID": "kc", "KICK_CLIENT_SECRET": "ks", "KICK_REDIRECT_PORT": 0}


class FakeHttp:
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def __call__(self, method, url, form=None, body=None, headers=None, timeout=20):
        self.calls.append((method, url, form, body, headers))
        for key, resp in self.routes:
            if key in url:
                return resp(form, body, headers) if callable(resp) else resp
        return 404, {"message": "unrouted " + url}


class AccountsTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "accounts.json")

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_twitch_device_flow_and_go_live(self):
        polls = {"n": 0}

        def token(form, body, headers):
            if form.get("grant_type") == "refresh_token":
                return 200, {"access_token": "new", "refresh_token": "r2", "expires_in": 100}
            polls["n"] += 1
            if polls["n"] < 2:
                return 400, {"status": 400, "message": "authorization_pending"}
            return 200, {"access_token": "at", "refresh_token": "rt", "expires_in": 14000}

        http = FakeHttp([
            ("oauth2/device", (200, {"device_code": "dc", "user_code": "ABCD", "interval": 0, "expires_in": 30,
                                     "verification_uri": "https://twitch.tv/activate?x"})),
            ("oauth2/token", token),
            ("helix/users", (200, {"data": [{"id": "9", "login": "p", "display_name": "P", "profile_image_url": "a"}]})),
            ("helix/channels", (204, {})),
            ("helix/streams/key", (200, {"data": [{"stream_key": "live_9_x"}]})),
        ])
        opened, progress = [], []
        acc = A.Accounts(self.path, CREDS, http=http, open_url=opened.append)
        prof = acc.login("twitch", progress.append)
        self.assertEqual(prof["name"], "P")
        self.assertEqual(progress[0]["code"], "ABCD")
        self.assertEqual(opened, ["https://twitch.tv/activate?x"])
        self.assertEqual(acc.summary()["twitch"]["user"]["name"], "P")
        url, key, warn = acc.go_live("twitch", "My title")
        self.assertEqual((url, key, warn), ("rtmp://live.twitch.tv/app", "live_9_x", ""))
        patch = next(c for c in http.calls if c[0] == "PATCH")
        self.assertEqual(patch[3], {"title": "My title"})
        self.assertIn("broadcaster_id=9", patch[1])
        # persisted
        self.assertTrue(A.Accounts(self.path, CREDS, http=http).summary()["twitch"]["user"])

    def test_expired_token_refreshes(self):
        http = FakeHttp([
            ("oauth2/token", (200, {"access_token": "fresh", "refresh_token": "r2", "expires_in": 100})),
            ("helix/streams/key", lambda f, b, h: (200, {"data": [{"stream_key": h["Authorization"]}]})),
        ])
        with open(self.path, "w") as f:
            json.dump({"twitch": {"token": {"access_token": "old", "refresh_token": "r", "expires_at": 0},
                                  "profile": {"id": "1", "name": "x"}}}, f)
        acc = A.Accounts(self.path, CREDS, http=http)
        self.assertEqual(acc.go_live("twitch")[1], "Bearer fresh")

    def test_revoked_refresh_logs_out(self):
        http = FakeHttp([("oauth2/token", (400, {"message": "Invalid refresh token"}))])
        with open(self.path, "w") as f:
            json.dump({"twitch": {"token": {"access_token": "old", "refresh_token": "r", "expires_at": 0},
                                  "profile": {"id": "1"}}}, f)
        acc = A.Accounts(self.path, CREDS, http=http)
        with self.assertRaises(A.AuthError):
            acc.go_live("twitch")
        self.assertIsNone(acc.summary()["twitch"]["user"])

    def test_not_configured(self):
        acc = A.Accounts(self.path, {}, http=FakeHttp([]))
        self.assertFalse(acc.summary()["youtube"]["configured"])
        with self.assertRaises(A.AuthError):
            acc.login("youtube")

    def test_youtube_browser_flow_and_broadcast(self):
        def fake_browser(url):
            q = dict(p.split("=", 1) for p in url.split("?", 1)[1].split("&"))
            redirect = urllib.request.unquote(q["redirect_uri"])

            def hit():
                time.sleep(0.3)
                urllib.request.urlopen("%s?code=C0DE&state=%s" % (redirect, q["state"])).read()
            threading.Thread(target=hit, daemon=True).start()

        http = FakeHttp([
            ("oauth2.googleapis.com/token", lambda f, b, h: (200 if f["code"] == "C0DE" and f["code_verifier"] else 400,
                                                              {"access_token": "at", "refresh_token": "rt", "expires_in": 3600})),
            ("youtube/v3/channels", (200, {"items": [{"id": "UC1", "snippet": {"title": "Chan", "thumbnails": {"default": {"url": "u"}}}}]})),
            ("youtube/v3/liveStreams?part=id,snippet,cdn&mine", (200, {"items": []})),
            ("youtube/v3/liveStreams?part", (200, {"id": "S1", "cdn": {"ingestionInfo": {
                "ingestionAddress": "rtmp://a.rtmp.youtube.com/live2", "streamName": "yt-key"}}})),
            ("liveBroadcasts/bind", (200, {})),
            ("liveBroadcasts?part", (200, {"id": "B1"})),
        ])
        acc = A.Accounts(self.path, CREDS, http=http, open_url=fake_browser)
        self.assertEqual(acc.login("youtube")["name"], "Chan")
        url, key, _ = acc.go_live("youtube", "hi", "unlisted")
        self.assertEqual((url, key), ("rtmp://a.rtmp.youtube.com/live2", "yt-key"))
        bc = next(c for c in http.calls if "liveBroadcasts?part" in c[1])
        self.assertEqual(bc[3]["status"]["privacyStatus"], "unlisted")
        self.assertTrue(bc[3]["contentDetails"]["enableAutoStart"])
        self.assertTrue(any("bind?id=B1" in c[1] and "streamId=S1" in c[1] for c in http.calls))

    def test_youtube_live_not_enabled_message(self):
        http = FakeHttp([("liveStreams", (403, {"error": {"errors": [{"reason": "liveStreamingNotEnabled"}]}}))])
        yt = A.YouTube(CREDS, http)
        with self.assertRaises(A.AuthError) as cm:
            yt.go_live({"access_token": "a"}, {}, "", "public")
        self.assertIn("youtube.com/features", str(cm.exception))

    def test_kick_stream_key(self):
        http = FakeHttp([("public/v1/channels", lambda f, b, h: (204, {}) if b else
                          (200, {"data": [{"stream": {"url": "rtmps://k.example/app/", "key": "sk_1"}}]}))])
        url, key, warn = A.Kick(CREDS, http).go_live({"access_token": "a"}, {}, "title!", "")
        self.assertEqual((url, key, warn), ("rtmps://k.example/app/", "sk_1", ""))

    def test_loopback_rejects_wrong_state(self):
        catcher = A.LoopbackCatcher(0)

        def hit():
            time.sleep(0.2)
            try:
                urllib.request.urlopen("http://127.0.0.1:%d/?code=x&state=evil" % catcher.port).read()
            except Exception:
                pass
        threading.Thread(target=hit, daemon=True).start()
        with self.assertRaises(A.AuthError):
            catcher.wait("good", threading.Event(), timeout=5)

    def test_pkce(self):
        v, c = A.pkce_pair()
        self.assertGreaterEqual(len(v), 43)
        self.assertNotIn("=", c)


if __name__ == "__main__":
    unittest.main()
