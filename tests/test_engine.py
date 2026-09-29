import os
import shutil
import tempfile
import time
import unittest
from unittest import mock

from walauncher import engine as E

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


def settings(**kw):
    s = E.Settings(out_dir=tempfile.gettempdir(), stream_key="live_123", **kw)
    return s


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
        self.assertEqual(st["frame"], 90)
        self.assertAlmostEqual(st["kbps"], 3500.2)
        self.assertAlmostEqual(st["speed"], 1.01)
        self.assertEqual(st["drop"], 2)
        self.assertEqual(st["size"], 0)
        self.assertIsNone(E.parse_stats({"bitrate": "N/A"})["kbps"])

    def test_tee_escape(self):
        self.assertEqual(E.tee_escape(r"C:\Vids\it's [1]|x"), r"C:\\Vids\\it\'s \[1\]\|x")

    def test_stream_url(self):
        self.assertEqual(E.stream_url(settings(server="rtmp://a/app/ ")), "rtmp://a/app/live_123")


class CommandTests(unittest.TestCase):
    def test_record_cpu(self):
        argv, path = E.build_command("ffmpeg", settings(mode="record"), "libx264", "x11grab")
        self.assertTrue(path.endswith(".mkv"))
        self.assertEqual(argv[-1], path)
        self.assertIn("format=yuv420p", arg_after(argv, "-filter_complex"))
        self.assertIn("ultrafast", argv)
        self.assertNotIn("-c:a", argv)  # no mic, not streaming -> no audio track

    def test_stream_gpu_adds_silent_audio(self):
        argv, path = E.build_command("ffmpeg", settings(mode="stream"), "h264_nvenc", "ddagrab")
        self.assertIsNone(path)
        graph = arg_after(argv, "-filter_complex")
        self.assertTrue(graph.startswith("[0:v]hwdownload,format=bgra,scale="))
        self.assertIn("format=nv12", graph)
        self.assertIn("anullsrc=channel_layout=stereo:sample_rate=48000", argv)
        self.assertEqual(argv[-2:], ["flv", "rtmp://live.twitch.tv/app/live_123"])
        self.assertEqual(arg_after(argv, "-b:v"), "3500k")

    def test_both_uses_tee(self):
        s = settings(mode="both", container="mp4")
        argv, path = E.build_command("ffmpeg", s, "h264_qsv", "gdigrab", monitor_rect=(1920, 0, 1280, 1024))
        self.assertTrue(path.endswith(".mp4"))
        self.assertIn("+global_header", argv)
        self.assertEqual(arg_after(argv, "-offset_x"), "1920")
        self.assertEqual(arg_after(argv, "-video_size"), "1280x1024")
        self.assertTrue(argv[-1].startswith("[f=flv:onfail=ignore]rtmp://live.twitch.tv/app/live_123|[f=mp4:"))

    def test_two_audio_sources_are_mixed(self):
        s = settings(mode="record", mic="Mic", desktop_audio="Stereo Mix")
        argv, _ = E.build_command("ffmpeg", s, "h264_amf", "test")
        self.assertIn("amix=inputs=2", arg_after(argv, "-filter_complex"))
        self.assertEqual(argv.count("-thread_queue_size"), 2)
        self.assertIn("[a]", argv)

    def test_native_resolution(self):
        argv, _ = E.build_command("ffmpeg", settings(height=0), "libx264", "test")
        self.assertIn("scale=-2:trunc(ih/2)*2:", arg_after(argv, "-filter_complex"))

    def test_encoder_args(self):
        self.assertIn("p2", E.encoder_args("h264_nvenc", 60, 4500))
        self.assertEqual(E.encoder_args("h264_nvenc", 60, 4500)[-1], "120")
        self.assertIn("lowlatency", E.encoder_args("h264_amf", 30, 2500))


class SettingsTests(unittest.TestCase):
    def test_roundtrip_and_bad_values(self):
        d = tempfile.mkdtemp()
        try:
            path = os.path.join(d, "s.json")
            s = E.Settings(mode="both", fps=60, out_dir=d)
            s.save(path)
            self.assertEqual(E.Settings.load(path), s)
            with open(path, "w") as f:
                f.write('{"fps": "lots", "bitrate": "4000", "junk": 1}')
            loaded = E.Settings.load(path)
            self.assertEqual(loaded.fps, 30)
            self.assertEqual(loaded.bitrate, 4000)
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
            argv, path = E.build_command(shutil.which("ffmpeg"), s, "libx264", "test")
            stats, done = [], []
            sess = E.Session(argv, on_stats=stats.append, on_exit=lambda rc, log: done.append(rc))
            sess.start()
            time.sleep(2.5)
            sess.stop()
            for _ in range(20):
                if done:
                    break
                time.sleep(0.1)
            self.assertEqual(done, [0])
            self.assertTrue(stats and stats[-1]["frame"] > 0)
            self.assertGreater(os.path.getsize(path), 1000)
        finally:
            shutil.rmtree(d)

    def test_detects_a_working_encoder(self):
        self.assertIn("libx264", E.detect_encoders(shutil.which("ffmpeg")))

    def test_capture_error_detection(self):
        self.assertTrue(E.looks_like_capture_error(["[Parsed_ddagrab_0 @ 0] Failed to create DXGI device"]))
        self.assertFalse(E.looks_like_capture_error(["Connection refused"]))


class PickCaptureTests(unittest.TestCase):
    def test_explicit_choice_wins(self):
        self.assertEqual(E.pick_capture("ffmpeg", "gdigrab"), "gdigrab")

    @mock.patch.object(E, "IS_WIN", True)
    @mock.patch.object(E, "has_filter", return_value=False)
    def test_windows_falls_back_to_gdigrab(self, _hf):
        self.assertEqual(E.pick_capture("ffmpeg"), "gdigrab")


if __name__ == "__main__":
    unittest.main()
