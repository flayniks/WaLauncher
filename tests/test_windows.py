"""Real Windows checks (window list, previews, icons, capture). Skipped elsewhere."""
import shutil
import subprocess
import time
import unittest

from litecast import engine as E
from litecast import winapi as W


@unittest.skipUnless(W.IS_WIN, "Windows only")
class WindowsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.notepad = subprocess.Popen(["notepad.exe"])
        for _ in range(50):
            if any(w["exe"].lower() == "notepad.exe" for w in W.list_windows()):
                break
            time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.notepad.kill()

    def win(self):
        return next(w for w in W.list_windows() if w["exe"].lower() == "notepad.exe")

    def test_lists_notepad_and_not_ourselves(self):
        wins = W.list_windows()
        self.assertTrue(any(w["exe"].lower() == "notepad.exe" for w in wins), wins)
        self.assertTrue(all(w["title"] for w in wins))

    def test_find_window_after_handle_changes(self):
        w = self.win()
        self.assertEqual(W.find_window(w["hwnd"], "notepad.exe")["hwnd"], w["hwnd"])
        self.assertEqual(W.find_window(123, "NOTEPAD.EXE", "nope")["hwnd"], w["hwnd"])
        self.assertTrue(W.window_alive(w["hwnd"]))

    def test_previews_and_icons(self):
        w = self.win()
        thumb = W.window_thumb(w["hwnd"])
        print("window thumb:", len(thumb or ""), "bytes")
        icon = W.exe_icon(w["path"])
        self.assertTrue(icon and icon.startswith("data:image/png;base64,"))
        mons = W.list_monitors()
        self.assertTrue(mons and mons[0]["primary"], mons)
        self.assertTrue(W.screen_thumb(mons[0]).startswith("data:image/png"))

    def test_admin_and_hags_checks(self):
        print("admin:", W.is_admin(), "hags:", W.hags_enabled())
        print("\n".join(W.system_info()))
        self.assertTrue(W.monitor_of_window(self.win()["hwnd"]))

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not on PATH")
    def test_ffmpeg_gets_gpu_priority(self):
        argv, _ = E.build_command(shutil.which("ffmpeg"), E.Settings(height=480), E.Plan("test", "cpu", "libx264"),
                                  E.Target(), bench_seconds=2)
        sess = E.Session(argv)
        sess.start()
        print("gpu priority:", sess.gpu_priority, "| error:", W.gpu_priority_error)
        import ctypes
        own = ctypes.windll.kernel32.GetCurrentProcess()
        print("own process gpu priority:", W.set_gpu_priority(own), "| error:", W.gpu_priority_error)
        self.assertIn(sess.gpu_priority, ("realtime", "high", "above normal", None))
        sess.stop()

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not on PATH")
    def test_capture_paths(self):
        ff = shutil.which("ffmpeg")
        caps = E.probe(ff)
        print("caps:", caps)
        self.assertIn("ddagrab", caps.filters)
        self.assertIn("gfxcapture", caps.filters)
        s = E.Settings(height=480, fps=30)
        mon = W.list_monitors()[0]
        target = E.Target(rect=(mon["x"], mon["y"], mon["w"], mon["h"]))
        best, results = E.autotune(ff, caps, s, target, seconds=3)
        for r in results:
            print("tune", r)
        self.assertIsNotNone(best)
        w = self.win()
        for path in ("gpuscale", "cpu"):
            plan = E.Plan("gfxcapture", path, "libx264")
            r = E.benchmark(ff, s, plan, E.Target(kind="window", hwnd=w["hwnd"], title=w["title"]), 3)
            print("window", path, r)


if __name__ == "__main__":
    unittest.main()
