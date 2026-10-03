import os
import shutil
import tempfile
import time
import unittest
from unittest import mock

from litecast import accounts as A
from litecast import api as API
from litecast import engine as E
from litecast import winapi as W


class FakeAccounts(A.Accounts):
    def __init__(self):
        self.data, self.cancel_event, self.platforms = {}, None, {}

    def summary(self):
        return {}

    def cancel(self):
        pass


def wait_for(fn, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return True
        time.sleep(0.1)
    return False


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
class ApiFlowTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.env = mock.patch.dict(os.environ, {"APPDATA": self.dir, "XDG_CONFIG_HOME": self.dir})
        self.env.start()
        test_plan = E.Plan("test", "cpu", "libx264")
        self.p = [mock.patch.object(E, "candidates", lambda caps, s: [test_plan]),
                  mock.patch.object(E, "list_audio_devices", lambda ff: ["Mic A"])]
        for p in self.p:
            p.start()
        self.api = API.Api(settings=E.Settings(out_dir=self.dir, height=480), accounts=FakeAccounts(),
                           ffmpeg=shutil.which("ffmpeg"))

    def tearDown(self):
        sess = self.api._session
        if sess and sess.running:
            sess.stop()
            wait_for(lambda: self.api.status()["phase"] == "ready", 15)
        for p in self.p:
            p.stop()
        self.env.stop()
        shutil.rmtree(self.dir)

    def test_boot_tune_record_stop(self):
        info = self.api.init()
        self.assertEqual(info["app"], "LiteCast")
        self.assertTrue(wait_for(lambda: self.api.status()["phase"] == "ready", 60), self.api.status())
        st = self.api.status()
        self.assertEqual(st["audio"], ["Mic A"])
        self.assertIn("CPU", st["plan"])
        self.assertTrue(self.api.start()["ok"])
        self.assertTrue(wait_for(lambda: (self.api.status()["live"] or {}).get("elapsed", 0) > 2.5))
        self.assertGreater(self.api.status()["live"]["fps"], 20)
        self.assertTrue(self.api.stop())
        self.assertTrue(wait_for(lambda: self.api.status()["phase"] == "ready"))
        st = self.api.status()
        self.assertTrue(st["note"].startswith("Saved: LiteCast"), st)
        files = [f for f in os.listdir(self.dir) if f.endswith(".mkv")]
        self.assertEqual(len(files), 1)

    def test_frozen_app_capture_switches_to_screen(self):
        self.api.init()
        self.assertTrue(wait_for(lambda: self.api.status()["phase"] == "ready", 60))
        self.assertTrue(self.api.start()["ok"])
        self.assertTrue(wait_for(lambda: (self.api.status()["live"] or {}).get("elapsed", 0) > 1))
        first = self.api._session
        # Pretend we were capturing a game window that stopped sending frames.
        self.api._run["target"] = E.Target(kind="window", hwnd=1234, title="Game")
        self.api._s.window_exe = self.api._run["settings"].window_exe = "game.exe"
        real_stall, real_elapsed = E.Session.stalled_for, E.Session.elapsed
        with mock.patch.object(E.Session, "stalled_for", lambda sess: 10.0 if sess is first else real_stall(sess)), \
                mock.patch.object(E.Session, "elapsed", lambda sess: 10.0 if sess is first else real_elapsed(sess)):
            self.assertTrue(wait_for(lambda: self.api._session is not first, 20))
        self.assertTrue(wait_for(lambda: self.api.status()["phase"] == "live" and self.api._session.running, 20))
        st = self.api.status()
        self.assertIn("game.exe stopped sending frames", st["warn"])
        self.assertEqual(self.api._run["target"].kind, "screen")
        self.assertTrue(self.api.stop())
        self.assertTrue(wait_for(lambda: self.api.status()["phase"] == "ready", 20))
        self.assertEqual(len([f for f in os.listdir(self.dir) if f.endswith(".mkv")]), 2)  # before + after switch

    def test_frozen_screen_capture_warns(self):
        self.api.init()
        self.assertTrue(wait_for(lambda: self.api.status()["phase"] == "ready", 60))
        self.assertTrue(self.api.start()["ok"])
        self.assertTrue(wait_for(lambda: (self.api.status()["live"] or {}).get("elapsed", 0) > 1))
        with mock.patch.object(E.Session, "stalled_for", lambda sess: 9.0), \
                mock.patch.object(E.Session, "elapsed", lambda sess: 10.0):
            self.assertTrue(wait_for(lambda: self.api.status()["warn"].startswith("Capture is frozen"), 10))
        self.assertIn("cap your game's FPS", self.api.status()["warn"])
        self.assertIn("OS: ", self.api.diagnostics())
        self.api.stop()
        self.assertTrue(wait_for(lambda: self.api.status()["phase"] == "ready", 20))

    def test_stream_needs_key(self):
        self.api.init()
        self.assertTrue(wait_for(lambda: self.api.status()["phase"] == "ready", 60))
        self.api.save({"mode": "stream", "platform": "twitch"})
        res = self.api.start()
        self.assertFalse(res["ok"])
        self.assertIn("stream key", res["error"])

    def test_stream_info_save_and_push(self):
        pushed = []
        self.api._accounts.data = {"twitch": {"profile": {"id": "1", "name": "P"}}}
        self.api._accounts.update_info = lambda pid, info: pushed.append((pid, info))
        self.api._accounts.channel_info = lambda pid: {"title": "On Twitch", "tags": ["Remote"], "category": None}
        res = self.api.apply_stream_info("twitch", {"title": "New", "tags": ["a b", "c"], "labels": ["Gambling"]})
        self.assertTrue(res["ok"] and res["pushed"])
        self.assertEqual(pushed[0][1]["tags"], ["ab", "c"])
        self.assertEqual(self.api.settings()["stream_info"]["twitch"]["title"], "New")
        self.assertEqual(self.api.stream_info("twitch")["info"]["title"], "On Twitch")  # platform wins on reload
        # YouTube is only pushed while live
        self.api._accounts.data["youtube"] = {"profile": {"id": "y"}}
        res = self.api.apply_stream_info("youtube", {"title": "Later", "privacy": "unlisted"})
        self.assertEqual((res["ok"], res["pushed"], res["info"]["privacy"]), (True, False, "unlisted"))
        self.assertEqual(len(pushed), 1)

    def test_login_setup_saves_and_enables_login(self):
        acc = A.Accounts(os.path.join(self.dir, "accounts.json"), {}, http=lambda *a, **k: (500, {}))
        api = API.Api(settings=E.Settings(out_dir=self.dir), accounts=acc, ffmpeg="ffmpeg", auto_boot=False)
        self.assertFalse(acc.summary()["twitch"]["configured"])
        self.assertFalse(api.login_setup("twitch", {"TWITCH_CLIENT_ID": "short"})["ok"])
        self.assertFalse(api.login_setup("youtube", {"YOUTUBE_CLIENT_ID": "x", "YOUTUBE_CLIENT_SECRET": "y"})["ok"])
        self.assertTrue(api.login_setup("twitch", {"TWITCH_CLIENT_ID": "abcdefghij0123456789abcdefghij"})["ok"])
        self.assertTrue(acc.summary()["twitch"]["configured"])
        self.assertTrue(api.login_setup("kick", {"KICK_CLIENT_ID": "k", "KICK_CLIENT_SECRET": "s"})["ok"])
        from litecast import credentials
        creds = credentials.load(E.data_dir())
        self.assertEqual((creds["TWITCH_CLIENT_ID"], creds["KICK_CLIENT_SECRET"]), ("abcdefghij0123456789abcdefghij", "s"))

    def test_save_validates(self):
        s = self.api.save({"fps": 500, "bitrate": 1, "height": 123, "mode": "nope", "tuned": {"x": 1}, "bogus": 2})
        self.assertEqual((s["fps"], s["bitrate"], s["height"], s["mode"]), (60, 300, 720, "record"))
        self.assertNotIn("tuned", s)

    def test_window_source_requires_pick(self):
        self.api.init()
        self.assertTrue(wait_for(lambda: self.api.status()["phase"] == "ready", 60))
        self.api.save({"source": "window"})
        self.assertIn("Pick an app", self.api.start()["error"])

    def test_missing_window_is_friendly(self):
        self.api.init()
        self.assertTrue(wait_for(lambda: self.api.status()["phase"] == "ready", 60))
        self.api.save({"source": "window", "window_exe": "game.exe", "window_hwnd": 5})
        with mock.patch.object(W, "find_window", lambda *a, **k: None):
            self.assertTrue(self.api.start()["ok"])
            self.assertTrue(wait_for(lambda: self.api.status()["phase"] == "ready"))
        self.assertIn("Can't find game.exe", self.api.status()["error"])


class PngTests(unittest.TestCase):
    def test_png_roundtrip_with_ffmpeg(self):
        px = bytes([255, 0, 0] * 4 + [0, 0, 255] * 4)
        png = W.png_bytes(4, 2, px, 3)
        self.assertTrue(png.startswith(b"\x89PNG"))
        self.assertTrue(W.data_url(png).startswith("data:image/png;base64,"))
        if shutil.which("ffmpeg"):
            d = tempfile.mkdtemp()
            try:
                p = os.path.join(d, "x.png")
                with open(p, "wb") as f:
                    f.write(png)
                import subprocess
                out = subprocess.run(["ffmpeg", "-v", "error", "-i", p, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                                     capture_output=True).stdout
                self.assertEqual(out, px)
            finally:
                shutil.rmtree(d)

    def test_bgra_helpers(self):
        self.assertEqual(bytes(W.bgra_to_rgb(bytes([1, 2, 3, 4]))), bytes([3, 2, 1]))
        self.assertEqual(bytes(W.bgra_to_rgba(bytes([1, 2, 3, 4]))), bytes([3, 2, 1, 4]))
        self.assertEqual(W.fit(1920, 1080, 320, 180), (320, 180))
        self.assertEqual(W.fit(100, 50, 320, 180), (100, 50))

    def test_non_windows_is_empty(self):
        if not W.IS_WIN:
            self.assertEqual(W.list_windows(), [])
            self.assertIsNone(W.window_thumb(1))


if __name__ == "__main__":
    unittest.main()
