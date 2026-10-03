import os
import shutil
import tempfile
import time
import unittest
from unittest import mock

from litecast import engine as E

DSHOW_NEW = '''[dshow @ 0000] "Integrated Camera" (video)
[dshow @ 0000]   Alternative name "@device_pnp_\\\\?\\usb"
[dshow @ 0000] "Microphone Array (Realtek(R) Audio)" (audio)
[dshow @ 0000]   Alternative name "@device_cm_{33D9}\\wave_{A1}"
[dshow @ 0000] "Stereo Mix (Realtek(R) Audio)" (audio)
'''
DSHOW_OLD = '''[dshow @ 0000] DirectShow video devices (some may be both video and audio devices)
[dshow @ 0000]  "Integrated Camera"
[dshow @ 0000] DirectShow audio devices
[dshow @ 0000]  "Microphone (USB Mic)"
[dshow @ 0000]     Alternative name "@device_cm_{33D9}"
'''
AVF = '''[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] FaceTime HD Camera
[AVFoundation indev @ 0x1] [1] Capture screen 0
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] MacBook Pro Microphone
'''
WIN_CAPS = E.Caps(filters={"ddagrab", "gfxcapture", "scale_d3d11", "hwmap", "hwdownload", "fps"},
                  encoders=["h264_qsv", "h264_mf", "libx264"])
SCREEN = E.Target(rect=(0, 0, 1920, 1080))
URL = "rtmp://live.twitch.tv/app/live_123"


def settings(**kw):
    return E.Settings(out_dir=tempfile.gettempdir(), **kw)


def arg_after(argv, flag):
    return argv[argv.index(flag) + 1]


class ParsingTests(unittest.TestCase):
    def test_dshow_new_format(self):
        self.assertEqual(E.parse_dshow_audio(DSHOW_NEW),
                         ["Microphone Array (Realtek(R) Audio)", "Stereo Mix (Realtek(R) Audio)"])

    def test_dshow_old_format(self):
        self.assertEqual(E.parse_dshow_audio(DSHOW_OLD), ["Microphone (USB Mic)"])

    def test_avfoundation(self):
        self.assertEqual(E.parse_avfoundation_audio(AVF), ["MacBook Pro Microphone"])

    def test_stats(self):
        st = E.parse_stats({"frame": "90", "fps": "29.97", "bitrate": "3500.2kbits/s",
                            "speed": "1.01x", "drop_frames": "2", "total_size": "N/A"})
        self.assertEqual((st["frame"], st["drop"], st["size"]), (90, 2, 0))
        self.assertAlmostEqual(st["kbps"], 3500.2)
        self.assertAlmostEqual(st["speed"], 1.01)
        self.assertIsNone(E.parse_stats({"bitrate": "N/A"})["kbps"])

    def test_tee_escape(self):
        self.assertEqual(E.tee_escape(r"C:\Vids\it's [1]|x"), r"C:\\Vids\\it\'s \[1\]\|x")

    def test_stream_join(self):
        self.assertEqual(E.stream_join("rtmp://a/app/ ", " k1 "), "rtmp://a/app/k1")
        self.assertEqual(E.stream_join("rtmps://x/app/", ""), "rtmps://x/app")

    def test_redact_hides_keys(self):
        out = E._redact(["-f", "flv", "rtmp://live.twitch.tv/app/live_123456789_abcdef"])
        self.assertEqual(out[-1], "rtmp://live.twitch.tv/app/<key>")


class PlanTests(unittest.TestCase):
    @mock.patch.object(E, "IS_WIN", True)
    def test_windows_candidates_prefer_zero_copy(self):
        keys = [p.key() for p in E.candidates(WIN_CAPS, settings())]
        self.assertEqual(keys[:3], ["ddagrab/zerocopy/h264_qsv", "ddagrab/gpuscale/h264_qsv", "ddagrab/cpu/h264_qsv"])
        self.assertNotIn("ddagrab/zerocopy/h264_mf", keys)  # MF can't take GPU frames
        self.assertEqual(keys[-1], "gdigrab/cpu/h264_qsv")  # slow screenshot capture only as last resort
        self.assertLessEqual(len(keys), E.MAX_CANDIDATES)
        caps = E.Caps(filters=WIN_CAPS.filters, encoders=["h264_nvenc", "libx264"])
        keys = [p.key() for p in E.candidates(caps, settings())]
        self.assertIn("gfxcapture/zerocopy/h264_nvenc", keys)
        self.assertLess(keys.index("gfxcapture/zerocopy/h264_nvenc"), keys.index("ddagrab/cpu/libx264"))

    @mock.patch.object(E, "IS_WIN", True)
    def test_chosen_encoder_goes_first(self):
        plans = E.candidates(WIN_CAPS, settings(encoder="libx264"))
        self.assertEqual(plans[0].encoder, "libx264")

    @mock.patch.object(E, "IS_WIN", True)
    def test_without_gpu_scaler(self):
        caps = E.Caps(filters={"ddagrab", "hwdownload"}, encoders=["h264_nvenc"])
        self.assertEqual([p.key() for p in E.candidates(caps, settings())],
                         ["ddagrab/cpu/h264_nvenc", "gdigrab/cpu/h264_nvenc"])

    def test_gfxcapture_screen_uses_monitor_handle(self):
        target = E.Target(rect=(0, 0, 1920, 1080), hmonitor=65537)
        _, graph, _ = E.video_graph(E.Plan("gfxcapture", "zerocopy", "h264_amf"), settings(), target)
        self.assertTrue(graph.startswith("gfxcapture=hmonitor=65537:"))

    def test_zero_copy_graph_qsv(self):
        _, graph, n = E.video_graph(E.Plan("ddagrab", "zerocopy", "h264_qsv"), settings(), SCREEN)
        self.assertEqual(n, 0)
        self.assertEqual(graph, "ddagrab=output_idx=0:framerate=30:draw_mouse=1,"
                                "scale_d3d11=width=1280:height=720:format=nv12,hwmap=derive_device=qsv,format=qsv[v]")

    def test_zero_copy_graph_nvenc_has_no_download(self):
        _, graph, _ = E.video_graph(E.Plan("ddagrab", "zerocopy", "h264_nvenc"), settings(), SCREEN)
        self.assertNotIn("hwdownload", graph)
        self.assertNotIn("hwmap", graph)

    def test_out_size_keeps_aspect_and_even(self):
        self.assertEqual(E.out_size(settings(height=720), E.Target(rect=(0, 0, 1366, 768))), (1280, 720))
        self.assertEqual(E.out_size(settings(height=720), E.Target(rect=(0, 0, 1920, 1200))), (1152, 720))
        self.assertEqual(E.out_size(settings(height=0), E.Target(rect=(0, 0, 1367, 769))), (1366, 768))
        self.assertEqual(E.out_size(settings(height=1080), E.Target(rect=(0, 0, 1366, 768))), (1366, 768))

    def test_window_capture_scales_on_gpu(self):
        with mock.patch.object(E, "IS_WIN", True):
            plan = E.window_plan(WIN_CAPS, E.Plan("ddagrab", "gpuscale", "h264_mf"))
        self.assertEqual(plan.key(), "gfxcapture/gpuscale/h264_mf")
        target = E.Target(kind="window", hwnd=0x1A2B, title="Minecraft")
        _, graph, _ = E.video_graph(plan, settings(fps=60), target)
        self.assertTrue(graph.startswith("gfxcapture=hwnd=6699:max_framerate=60:capture_cursor=1:"
                                         "width=1280:height=720:resize_mode=scale_aspect,fps=60,"))
        self.assertIn("hwdownload,format=nv12", graph)

    def test_window_falls_back_to_gdigrab_title(self):
        caps = E.Caps(filters={"ddagrab"}, encoders=["libx264"])
        plan = E.window_plan(caps, E.Plan("ddagrab", "cpu", "libx264"))
        args, graph, n = E.video_graph(plan, settings(), E.Target(kind="window", title="My Game"))
        self.assertEqual(arg_after(args, "-i"), "title=My Game")
        self.assertEqual(n, 1)

    def test_plan_key_roundtrip(self):
        p = E.Plan("gfxcapture", "zerocopy", "h264_amf")
        self.assertEqual(E.Plan.from_key(p.key()), p)
        self.assertIsNone(E.Plan.from_key("junk"))


class CommandTests(unittest.TestCase):
    def test_record_cpu(self):
        argv, path = E.build_command("ffmpeg", settings(mode="record"), E.Plan("x11grab", "cpu", "libx264"), SCREEN)
        self.assertTrue(path.endswith(".mkv") and os.path.basename(path).startswith("LiteCast "))
        self.assertEqual(argv[-1], path)
        self.assertIn("ultrafast", argv)
        self.assertNotIn("-c:a", argv)  # no mic, not streaming -> no audio track

    def test_stream_adds_silent_audio_after_filter_source(self):
        argv, path = E.build_command("ffmpeg", settings(mode="stream"), E.Plan("ddagrab", "zerocopy", "h264_nvenc"),
                                     SCREEN, stream_url=URL)
        self.assertIsNone(path)
        self.assertIn("anullsrc=channel_layout=stereo:sample_rate=48000", argv)
        self.assertEqual(argv.count("-i"), 1)  # video comes from the filter graph, not an input
        self.assertEqual(argv[argv.index("-map") + 3], "0:a")
        self.assertEqual(argv[-1], URL)
        self.assertEqual(arg_after(argv, "-fifo_format"), "flv")  # slow internet drops packets instead of freezing
        self.assertEqual(arg_after(argv, "-drop_pkts_on_overflow"), "1")

    def test_both_uses_tee(self):
        argv, path = E.build_command("ffmpeg", settings(mode="both", container="mp4"),
                                     E.Plan("ddagrab", "gpuscale", "h264_qsv"), SCREEN, stream_url=URL)
        self.assertTrue(path.endswith(".mp4"))
        self.assertIn("+global_header", argv)
        self.assertTrue(argv[-1].startswith("[f=flv:onfail=ignore]" + URL + "|[f=mp4:"))
        self.assertIn(":use_fifo=0]", argv[-1])  # the recording never drops packets
        self.assertEqual(arg_after(argv, "-use_fifo"), "1")

    def test_two_audio_sources_are_mixed_with_right_indexes(self):
        s = settings(mode="record", mic="Mic", desktop_audio="Stereo Mix")
        argv, _ = E.build_command("ffmpeg", s, E.Plan("ddagrab", "cpu", "h264_amf"), SCREEN)
        self.assertIn("[0:a][1:a]amix=inputs=2", arg_after(argv, "-filter_complex"))
        argv, _ = E.build_command("ffmpeg", s, E.Plan("test", "cpu", "libx264"), SCREEN)
        self.assertIn("[1:a][2:a]amix=inputs=2", arg_after(argv, "-filter_complex"))

    def test_benchmark_command_is_video_only_null(self):
        argv, path = E.build_command("ffmpeg", settings(mode="both", mic="Mic"), E.Plan("test", "cpu", "libx264"),
                                     SCREEN, stream_url=URL, bench_seconds=3)
        self.assertIsNone(path)
        self.assertEqual(argv[-5:], ["-t", "3", "-f", "null", "-"])
        self.assertNotIn("-c:a", argv)

    def test_encoder_args(self):
        self.assertIn("p2", E.encoder_args("h264_nvenc", 60, 4500))
        self.assertEqual(E.encoder_args("h264_nvenc", 60, 4500)[-1], "120")
        self.assertIn("lowlatency", E.encoder_args("h264_amf", 30, 2500))
        self.assertIn("live_streaming", E.encoder_args("h264_mf", 30, 2500))


class ReliabilityTests(unittest.TestCase):
    def test_stream_reconnects_and_never_blocks(self):
        argv, _ = E.build_command("ffmpeg", settings(mode="stream"), E.Plan("test", "cpu", "libx264"), SCREEN,
                                  stream_url=URL)
        self.assertEqual(arg_after(argv, "-attempt_recovery"), "1")
        self.assertIn("+global_header", argv)  # FLV can reconnect without re-running header filters
        self.assertIn("-re", argv[argv.index("anullsrc=channel_layout=stereo:sample_rate=48000") - 4:])
        argv, _ = E.build_command("ffmpeg", settings(mode="both"), E.Plan("test", "cpu", "libx264"), SCREEN,
                                  stream_url=URL)
        self.assertIn("attempt_recovery=1", arg_after(argv, "-fifo_options"))

    def test_brb_card(self):
        _, graph, n = E.video_graph(E.Plan("brb", "plain", "h264_qsv"), settings(height=720), E.Target(kind="window"))
        self.assertEqual(n, 0)
        self.assertTrue(graph.startswith("color=c=0x15151c:s=1280x720:r=30"))
        self.assertIn("realtime", graph)
        self.assertNotIn("ddagrab", graph)

    def test_last_error_line(self):
        log = ["[out @ 1] [info] fine", "[tcp @ 2] [error] Connection refused", "[x @ 3] [info] bye"]
        self.assertEqual(E.last_error_line(log), "[tcp @ 2] Connection refused")
        self.assertFalse(E.looks_like_capture_error(["[x] [info] Stream #0: Video: h264 (h264_qsv) device d3d11"]))
        self.assertTrue(E.looks_like_capture_error(["[Parsed_ddagrab_0 @ 1] [error] Failed to create DXGI device"]))


class NetworkTests(unittest.TestCase):
    def test_stream_budget(self):
        s = settings(bitrate=3500, height=720, fps=30)
        self.assertEqual(E.stream_budget(0, s)[:3], (3500, 720, 30))  # untested: leave it alone
        self.assertEqual(E.stream_budget(20000, s), (3500, 720, 30, ""))
        kbps, h, fps, why = E.stream_budget(2500, s)
        self.assertEqual((kbps, h, fps), (1300, 480, 30))
        self.assertIn("2.5 Mbps", why)
        self.assertEqual(E.stream_budget(800, settings(bitrate=6000, height=1080, fps=60))[:3], (300, 360, 30))
        self.assertEqual(E.stream_budget(8000, settings(bitrate=6000, height=1080, fps=60))[:3], (4600, 720, 60))

    def test_measure_upload(self):
        sizes = []

        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b"{}"

        def fake_urlopen(req, timeout=0):
            sizes.append(len(req.data))
            time.sleep(len(req.data) * 8 / 4_000_000.0)  # pretend 4 Mbps upload
            return Resp()

        with mock.patch.object(E.urllib.request, "urlopen", fake_urlopen):
            kbps = E.measure_upload_kbps()
        self.assertTrue(3000 < kbps <= 4100, kbps)
        self.assertGreater(max(sizes), 400 * 1024)


class SettingsTests(unittest.TestCase):
    def test_roundtrip_and_bad_values(self):
        d = tempfile.mkdtemp()
        try:
            path = os.path.join(d, "s.json")
            s = E.Settings(mode="both", fps=60, out_dir=d, stream_keys={"kick": "k"})
            s.save(path)
            self.assertEqual(E.Settings.load(path), s)
            with open(path, "w") as f:
                f.write('{"fps": "lots", "bitrate": "4000", "junk": 1}')
            loaded = E.Settings.load(path)
            self.assertEqual((loaded.fps, loaded.bitrate), (30, 4000))
        finally:
            shutil.rmtree(d)

    def test_migrates_old_walauncher_settings(self):
        d = tempfile.mkdtemp()
        try:
            path = os.path.join(d, "s.json")
            with open(path, "w") as f:
                f.write('{"platform": "YouTube", "stream_key": "abc", "preset": "Smooth - 720p 60fps", "server": "x"}')
            s = E.Settings.load(path)
            self.assertEqual((s.platform, s.stream_keys, s.preset), ("youtube", {"youtube": "abc"}, "Smooth"))
        finally:
            shutil.rmtree(d)

    def test_missing_file(self):
        self.assertEqual(E.Settings.load("/nope/nothing.json").mode, "record")


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
class RealFFmpegTests(unittest.TestCase):
    def test_record_and_stop_cleanly(self):
        d = tempfile.mkdtemp()
        try:
            s = E.Settings(mode="record", out_dir=d, height=480)
            argv, path = E.build_command(shutil.which("ffmpeg"), s, E.Plan("test", "cpu", "libx264"), SCREEN)
            stats, done = [], []
            sess = E.Session(argv, on_stats=stats.append, on_exit=lambda rc, log: done.append(rc),
                             log_path=os.path.join(d, "logs", "s.log"))
            sess.start()
            time.sleep(2.5)
            self.assertGreater(sess.steady_fps() or 0, 20)
            sess.stop()
            for _ in range(30):
                if done:
                    break
                time.sleep(0.1)
            self.assertEqual(done, [0])
            self.assertTrue(stats and stats[-1]["frame"] > 0)
            self.assertGreater(os.path.getsize(path), 1000)
            with open(os.path.join(d, "logs", "s.log")) as f:
                self.assertIn("exit rc=0", f.read())
        finally:
            shutil.rmtree(d)

    def test_autotune_picks_a_plan_that_holds_fps(self):
        caps = E.Caps(filters=set(), encoders=["libx264"])
        s = E.Settings(height=480, fps=30)
        with mock.patch.object(E, "candidates", lambda c, st: [E.Plan("bogus_capture_xyz", "cpu", "libx264"),
                                                               E.Plan("test", "cpu", "libx264")]):
            orig = E.video_graph

            def graph(plan, st, target):
                if plan.capture == "bogus_capture_xyz":
                    return ["-f", "lavfi", "-i", "nosuchfilter"], "[0:v]null[v]", 1
                return orig(plan, st, target)

            with mock.patch.object(E, "video_graph", graph):
                best, results = E.autotune(shutil.which("ffmpeg"), caps, s, SCREEN, seconds=3)
        self.assertEqual(best.key(), "test/cpu/libx264")
        self.assertFalse(results[0]["ok"])
        self.assertTrue(results[1]["ok"], results)

    def test_detects_a_working_encoder(self):
        self.assertIn("libx264", E.detect_encoders(shutil.which("ffmpeg")))

    def test_capture_error_detection(self):
        self.assertTrue(E.looks_like_capture_error(["[Parsed_ddagrab_0 @ 0] [error] Failed to create DXGI device"]))
        self.assertFalse(E.looks_like_capture_error(["Connection refused"]))


if __name__ == "__main__":
    unittest.main()
