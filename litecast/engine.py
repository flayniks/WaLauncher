"""LiteCast engine: finds FFmpeg, probes the hardware, builds and runs the capture pipeline.

Why it's light: no preview and no compositor. On Windows the screen (or one app) is
grabbed by the GPU, resized on the GPU and handed straight to the GPU encoder
(NVENC / AMF / QuickSync), so frames never touch the CPU. Because every laptop is
different, `autotune` actually tries the candidate pipelines for a few seconds and
keeps the first one that holds full frame rate.
"""

import collections
import datetime as _dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from dataclasses import asdict, dataclass, field, fields

APP_NAME = "LiteCast"
IS_WIN = sys.platform.startswith("win")
IS_MAC = sys.platform == "darwin"

if getattr(sys, "frozen", False):
    APP_DIR = os.path.dirname(sys.executable)
else:
    APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_NO_WINDOW = 0x08000000 if IS_WIN else 0
_ABOVE_NORMAL = 0x00008000 if IS_WIN else 0

PLATFORMS = {
    "twitch": {"name": "Twitch", "server": "rtmp://live.twitch.tv/app"},
    "youtube": {"name": "YouTube", "server": "rtmp://a.rtmp.youtube.com/live2"},
    "kick": {"name": "Kick", "server": ""},
    "custom": {"name": "Custom", "server": ""},
}

# name -> (height, fps, video kbps)
PRESETS = {
    "Potato": (480, 30, 1500),
    "Low": (720, 30, 2500),
    "Balanced": (720, 30, 3500),
    "Smooth": (720, 60, 4500),
    "Sharp": (1080, 30, 5000),
    "Max": (1080, 60, 6000),
}

# Least laggy first.
ENCODERS = [
    ("h264_nvenc", "NVIDIA GPU"),
    ("h264_amf", "AMD GPU"),
    ("h264_qsv", "Intel GPU"),
    ("h264_videotoolbox", "Apple GPU"),
    ("h264_mf", "Windows GPU encoder"),
    ("libx264", "CPU (slowest)"),
]
ENCODER_NAMES = dict(ENCODERS)
ZERO_COPY_ENCODERS = ("h264_nvenc", "h264_amf", "h264_qsv")

FFMPEG_URLS = [
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
]


def data_dir(name=APP_NAME):
    if IS_WIN:
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
    elif IS_MAC:
        base = os.path.expanduser("~/Library/Application Support")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base, name)


OLD_DATA_DIR_NAME = "WaLauncher"  # before the rename; reuse its ffmpeg/settings


def default_out_dir():
    videos = os.path.join(os.path.expanduser("~"), "Videos")
    return videos if os.path.isdir(videos) else os.path.expanduser("~")


@dataclass
class Settings:
    mode: str = "record"  # record | stream | both
    platform: str = "twitch"  # twitch | youtube | kick | custom
    custom_server: str = ""
    stream_keys: dict = field(default_factory=dict)  # platform -> pasted key (when not logged in)
    stream_info: dict = field(default_factory=dict)  # platform -> {title, category, tags, ...}
    ask_info: bool = True  # show the stream info sheet before going live
    preset: str = "Balanced"
    height: int = 720  # 0 = native
    fps: int = 30
    bitrate: int = 3500  # video kbps
    encoder: str = "auto"
    source: str = "screen"  # screen | window
    monitor: int = 0
    window_hwnd: int = 0
    window_exe: str = ""
    window_title: str = ""
    draw_mouse: bool = True
    mic: str = ""
    desktop_audio: str = ""
    out_dir: str = ""
    container: str = "mkv"
    tuned: dict = field(default_factory=dict)  # autotune results, keyed by tune_key()

    @classmethod
    def path(cls):
        return os.path.join(data_dir(), "settings.json")

    @classmethod
    def load(cls, path=None):
        path = path or cls.path()
        if not os.path.exists(path):
            old = os.path.join(data_dir(OLD_DATA_DIR_NAME), "settings.json")
            path = old if os.path.exists(old) else path
        s = cls()
        try:
            with open(path, encoding="utf-8") as f:
                raw = json.load(f)
        except (OSError, ValueError):
            raw = {}
        if not isinstance(raw, dict):
            raw = {}
        for fld in fields(cls):
            if fld.name in raw:
                default = getattr(s, fld.name)
                try:
                    setattr(s, fld.name, type(default)(raw[fld.name]))
                except (TypeError, ValueError):
                    pass
        # Old WaLauncher settings
        if s.platform not in PLATFORMS:
            s.platform = str(s.platform).lower() if str(s.platform).lower() in PLATFORMS else "twitch"
        if raw.get("stream_key") and not s.stream_keys.get(s.platform):
            s.stream_keys[s.platform] = raw["stream_key"]
        if raw.get("stream_title") and not s.stream_info:
            s.stream_info = {pid: {"title": raw["stream_title"]} for pid in ("twitch", "youtube", "kick")}
        if raw.get("yt_privacy"):
            s.stream_info.setdefault("youtube", {}).setdefault("privacy", raw["yt_privacy"])
        if s.preset not in PRESETS:
            s.preset = next((p for p in PRESETS if str(raw.get("preset", "")).startswith(p)), "Balanced")
        if not s.out_dir:
            s.out_dir = default_out_dir()
        return s

    def save(self, path=None):
        path = path or self.path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(asdict(self), f, indent=2)
        os.replace(tmp, path)


# ---------------------------------------------------------------- ffmpeg lookup

def find_ffmpeg():
    exe = "ffmpeg.exe" if IS_WIN else "ffmpeg"
    for folder in (APP_DIR, os.path.join(APP_DIR, "ffmpeg", "bin"), data_dir(), data_dir(OLD_DATA_DIR_NAME)):
        cand = os.path.join(folder, exe)
        if os.path.isfile(cand):
            return cand
    return shutil.which("ffmpeg")


def download_ffmpeg(progress=None):
    """Download a Windows FFmpeg build into data_dir(). progress(done_bytes, total_bytes)."""
    last_err = None
    for url in FFMPEG_URLS:
        try:
            return _download_ffmpeg_from(url, progress)
        except Exception as e:  # try the next mirror
            last_err = e
    raise RuntimeError("Couldn't download FFmpeg: %s" % last_err)


def _download_ffmpeg_from(url, progress):
    dest = data_dir()
    os.makedirs(dest, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix=".zip", dir=dest)
    os.close(fd)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": APP_NAME})
        with urllib.request.urlopen(req, timeout=30) as r, open(tmp, "wb") as f:
            total = int(r.headers.get("Content-Length") or 0)
            done = 0
            while True:
                chunk = r.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if progress:
                    progress(done, total)
        target = os.path.join(dest, "ffmpeg.exe")
        with zipfile.ZipFile(tmp) as z:
            member = next(n for n in z.namelist() if n.lower().endswith("bin/ffmpeg.exe"))
            with z.open(member) as src, open(target + ".part", "wb") as dst:
                shutil.copyfileobj(src, dst)
        os.replace(target + ".part", target)
        return target
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


# ---------------------------------------------------------------- detection

def _run(args, timeout=20):
    try:
        return subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=timeout, creationflags=_NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired):
        return None


def _text(b):
    return b.decode("utf-8", "replace") if b else ""


def _listed(listing, name):
    return re.search(r"^\s*\S+\s+%s\s" % re.escape(name), listing, re.M) is not None


@dataclass
class Caps:
    version: str = ""
    filters: set = field(default_factory=set)
    encoders: list = field(default_factory=list)  # working ones, best first


def probe(ffmpeg):
    caps = Caps()
    r = _run([ffmpeg, "-hide_banner", "-version"], 15)
    caps.version = _text(r.stdout).splitlines()[0] if r and r.stdout else ""
    r = _run([ffmpeg, "-hide_banner", "-filters"], 15)
    listing = _text(r.stdout) if r else ""
    caps.filters = {f for f in ("ddagrab", "gfxcapture", "scale_d3d11", "hwmap", "hwdownload", "fps")
                    if _listed(listing, f)}
    caps.encoders = detect_encoders(ffmpeg)
    return caps


def detect_encoders(ffmpeg):
    """Encoders that are compiled in AND actually work on this machine, best first."""
    r = _run([ffmpeg, "-hide_banner", "-encoders"], 15)
    listing = _text(r.stdout) if r else ""
    found = []
    for name, _ in ENCODERS:
        if not _listed(listing, name):
            continue
        if name == "libx264" or _encoder_works(ffmpeg, name):
            found.append(name)
    return found


def _encoder_works(ffmpeg, name):
    extra = ["-hw_encoding", "1"] if name == "h264_mf" else []
    r = _run([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
              "-i", "color=black:s=1280x720:r=30", "-frames:v", "5",
              "-vf", "format=nv12", "-c:v", name] + extra + ["-f", "null", "-"], 20)
    return r is not None and r.returncode == 0


def list_audio_devices(ffmpeg):
    if IS_WIN:
        r = _run([ffmpeg, "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], 15)
        return parse_dshow_audio(_text(r.stderr) if r else "")
    if IS_MAC:
        r = _run([ffmpeg, "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], 15)
        return parse_avfoundation_audio(_text(r.stderr) if r else "")
    r = _run(["pactl", "list", "short", "sources"], 5)
    if not r or r.returncode != 0:
        return ["default"]
    names = [ln.split("\t")[1] for ln in _text(r.stdout).splitlines() if ln.count("\t") >= 1]
    return names or ["default"]


def parse_dshow_audio(text):
    devices, section = [], None
    for line in text.splitlines():
        if "DirectShow audio devices" in line:
            section = "audio"
            continue
        if "DirectShow video devices" in line:
            section = "video"
            continue
        if "Alternative name" in line:
            continue
        m = re.search(r'"([^"]+)"\s*(?:\(([a-z, ]+)\))?\s*$', line)
        if not m:
            continue
        kind = m.group(2) or section or ""
        if "audio" in kind and m.group(1) not in devices:
            devices.append(m.group(1))
    return devices


def parse_avfoundation_audio(text):
    devices, in_audio = [], False
    for line in text.splitlines():
        if "audio devices" in line:
            in_audio = True
            continue
        if "video devices" in line:
            in_audio = False
            continue
        m = re.search(r"\]\s*\[(\d+)\]\s*(.+?)\s*$", line)
        if in_audio and m:
            devices.append(m.group(2))
    return devices


def enable_dpi_awareness():
    """So Windows reports real pixels instead of scaled ones."""
    if not IS_WIN:
        return
    import ctypes
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


# ---------------------------------------------------------------- pipeline plans

@dataclass
class Target:
    """What to capture."""
    kind: str = "screen"  # screen | window
    monitor: int = 0
    rect: tuple = None  # (x, y, w, h) of the monitor, when known
    hwnd: int = 0
    title: str = ""
    hmonitor: int = 0  # for gfxcapture screen capture


@dataclass
class Plan:
    """How to capture + encode.

    path: zerocopy  - frames stay on the GPU the whole way (best)
          gpuscale  - resized on the GPU, then copied to RAM for the encoder
          cpu       - copied to RAM full size, resized on the CPU
    """
    capture: str  # ddagrab | gfxcapture | gdigrab | x11grab | avfoundation | test
    path: str
    encoder: str

    def key(self):
        return "%s/%s/%s" % (self.capture, self.path, self.encoder)

    @classmethod
    def from_key(cls, key):
        parts = (key or "").split("/")
        return cls(*parts) if len(parts) == 3 else None


def even(x):
    return max(2, int(x) // 2 * 2)


def out_size(s, target):
    """Output (w, h); h=0 means 'native' and w follows the source aspect."""
    if target.rect:
        sw, sh = target.rect[2], target.rect[3]
    else:
        sw, sh = 1920, 1080
    if not s.height or s.height >= sh:
        return even(sw), even(sh)
    return even(round(s.height * sw / float(sh))), even(s.height)


MAX_CANDIDATES = 9


def candidates(caps, s):
    """Pipelines to try for screen capture, most efficient first."""
    encs = caps.encoders if s.encoder == "auto" else [s.encoder] + [e for e in caps.encoders if e != s.encoder]
    plans = []
    if IS_WIN and "ddagrab" in caps.filters:
        gpu_scale = "scale_d3d11" in caps.filters

        def gpu_paths(capture, enc):
            out = []
            if gpu_scale and enc in ZERO_COPY_ENCODERS and (enc != "h264_qsv" or "hwmap" in caps.filters):
                out.append(Plan(capture, "zerocopy", enc))
            if gpu_scale:
                out.append(Plan(capture, "gpuscale", enc))
            return out

        for i, enc in enumerate(encs):
            plans += gpu_paths("ddagrab", enc) + [Plan("ddagrab", "cpu", enc)]
            if i == 0 and "gfxcapture" in caps.filters:
                # Windows Graphics Capture copes better with some two-GPU laptops.
                plans += gpu_paths("gfxcapture", enc) or [Plan("gfxcapture", "cpu", enc)]
        plans = plans[:MAX_CANDIDATES - 1]
        plans.append(Plan("gdigrab", "cpu", encs[0] if encs else "libx264"))
    elif IS_WIN:
        plans += [Plan("gdigrab", "cpu", enc) for enc in encs]
    elif IS_MAC:
        plans += [Plan("avfoundation", "cpu", enc) for enc in encs]
    else:
        plans += [Plan("x11grab", "cpu", enc) for enc in encs]
    return plans


def window_plan(caps, screen_plan):
    """Plan for capturing a single app, reusing the encode path that won for the screen."""
    if IS_WIN and "gfxcapture" in caps.filters and screen_plan.capture in ("ddagrab", "gfxcapture"):
        return Plan("gfxcapture", screen_plan.path, screen_plan.encoder)
    return Plan("gdigrab", "cpu", screen_plan.encoder)


def tune_key(s, target):
    w, h = out_size(s, target)
    return "%dx%d@%d|%s|%s" % (w, h, s.fps, s.encoder, target.monitor)


def video_graph(plan, s, target):
    """Return (input_args, filter_graph ending in [v], number_of_video_inputs)."""
    fps = int(s.fps)
    w, h = out_size(s, target)
    mouse = int(bool(s.draw_mouse))
    to_gpu_out = {
        "zerocopy": (["hwmap=derive_device=qsv", "format=qsv"] if plan.encoder == "h264_qsv" else []),
        "gpuscale": ["hwdownload", "format=nv12"],
    }

    if plan.capture == "ddagrab":
        src = "ddagrab=output_idx=%d:framerate=%d:draw_mouse=%d" % (target.monitor, fps, mouse)
        if plan.path == "cpu":
            chain = [src, "hwdownload", "format=bgra", "scale=%d:%d:flags=fast_bilinear" % (w, h), "format=nv12"]
        else:
            chain = [src, "scale_d3d11=width=%d:height=%d:format=nv12" % (w, h)] + to_gpu_out[plan.path]
        return [], ",".join(chain) + "[v]", 0

    if plan.capture == "gfxcapture":
        if target.kind == "window":
            sel = "hwnd=%d" % target.hwnd
        else:
            sel = "hmonitor=%d" % target.hmonitor if target.hmonitor else "monitor_idx=%d" % target.monitor
        if s.height:  # fixed 16:9 canvas, app letterboxed into it, scaled on the GPU
            size = "width=%d:height=%d:resize_mode=scale_aspect" % (even(round(s.height * 16 / 9.0)), even(s.height))
        else:
            size = "width=-2:height=-2:resize_mode=scale_aspect"
        src = "gfxcapture=%s:max_framerate=%d:capture_cursor=%d:%s" % (sel, fps, mouse, size)
        if plan.path == "cpu":
            chain = [src, "hwdownload", "format=bgra", "fps=%d" % fps, "format=nv12"]
        else:
            chain = [src, "fps=%d" % fps, "scale_d3d11=format=nv12"] + to_gpu_out[plan.path]
        return [], ",".join(chain) + "[v]", 0

    iq = ["-thread_queue_size", "512"]
    if plan.capture == "gdigrab":
        args = iq + ["-f", "gdigrab", "-framerate", str(fps), "-draw_mouse", str(mouse)]
        if target.kind == "window" and target.title:
            args += ["-i", "title=" + target.title]
        else:
            if target.rect:
                x, y, rw, rh = target.rect
                args += ["-offset_x", str(x), "-offset_y", str(y), "-video_size", "%dx%d" % (rw, rh)]
            args += ["-i", "desktop"]
    elif plan.capture == "x11grab":
        x = y = 0
        args = iq + ["-f", "x11grab", "-framerate", str(fps), "-draw_mouse", str(mouse)]
        if target.rect:
            x, y, rw, rh = target.rect
            args += ["-video_size", "%dx%d" % (rw, rh)]
        args += ["-i", "%s+%d,%d" % (os.environ.get("DISPLAY") or ":0.0", x, y)]
    elif plan.capture == "avfoundation":
        args = iq + ["-f", "avfoundation", "-framerate", str(fps), "-capture_cursor", str(mouse),
                     "-i", "Capture screen %d:none" % target.monitor]
    elif plan.capture == "test":
        args = ["-re", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=%d" % fps]
    else:
        raise ValueError("unknown capture method: %s" % plan.capture)
    if target.kind == "window" or not target.rect:  # size unknown up front; keep aspect
        scale = "scale=-2:%s:flags=fast_bilinear" % (even(s.height) if s.height else "trunc(ih/2)*2")
    else:
        scale = "scale=%d:%d:flags=fast_bilinear" % (w, h)
    return args, "[0:v]%s,format=nv12[v]" % scale, 1


def stream_join(server, key):
    server, key = server.strip().rstrip("/"), key.strip()
    return server + "/" + key if key else server


def tee_escape(text):
    return re.sub(r"([\\'|\[\]])", r"\\\1", text)


def encoder_args(encoder, fps, kbps):
    rate = ["-b:v", "%dk" % kbps, "-maxrate", "%dk" % kbps, "-bufsize", "%dk" % (kbps * 2)]
    if encoder == "h264_nvenc":
        extra = ["-preset", "p2", "-tune", "ll", "-rc", "cbr", "-bf", "0"]
    elif encoder == "h264_amf":
        extra = ["-usage", "lowlatency", "-quality", "speed", "-rc", "cbr"]
    elif encoder == "h264_qsv":
        extra = ["-preset", "veryfast"]
    elif encoder == "h264_videotoolbox":
        extra = ["-realtime", "1"]
    elif encoder == "h264_mf":
        extra = ["-hw_encoding", "1", "-rate_control", "cbr", "-scenario", "live_streaming"]
    else:
        extra = ["-preset", "ultrafast", "-tune", "zerolatency"]
    return ["-c:v", encoder] + extra + rate + ["-g", str(max(1, fps) * 2)]


def _audio_input(dev):
    if IS_WIN:
        return ["-f", "dshow", "-audio_buffer_size", "50", "-i", "audio=" + dev]
    if IS_MAC:
        return ["-f", "avfoundation", "-i", ":" + dev]
    return ["-f", "pulse", "-i", dev]


def build_command(ffmpeg, s, plan, target, stream_url=None, now=None, bench_seconds=None):
    """Return (argv, recording_path or None). bench_seconds -> video-only test run to a null output."""
    fps, kbps = int(s.fps), int(s.bitrate)
    bench = bench_seconds is not None
    streaming = not bench and s.mode in ("stream", "both")
    recording = not bench and s.mode in ("record", "both")
    args = [ffmpeg, "-hide_banner", "-loglevel", "warning", "-nostats", "-progress", "pipe:1", "-y"]

    vin_args, graph, n_vin = video_graph(plan, s, target)
    args += vin_args

    audio = []
    if not bench:
        for dev in (s.mic, s.desktop_audio):
            if dev and dev not in audio:
                audio.append(dev)
    for dev in audio:
        args += ["-thread_queue_size", "1024"] + _audio_input(dev)
    if not audio and streaming:  # platforms want an audio track
        args += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]

    maps = ["-map", "[v]"]
    a0 = n_vin
    if len(audio) == 2:
        graph += (";[%d:a][%d:a]amix=inputs=2:duration=longest:dropout_transition=0,"
                  "volume=2,aresample=async=1000[a]" % (a0, a0 + 1))
        maps += ["-map", "[a]"]
    elif audio:
        graph += ";[%d:a]aresample=async=1000[a]" % a0
        maps += ["-map", "[a]"]
    elif streaming:
        maps += ["-map", "%d:a" % a0]
    args += ["-filter_complex", graph] + maps

    args += encoder_args(plan.encoder, fps, kbps)
    if plan.capture in ("gdigrab", "x11grab", "avfoundation"):
        args += ["-fps_mode", "cfr", "-r", str(fps)]
    if audio or streaming:
        args += ["-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"]

    if bench:
        return args + ["-t", "%g" % bench_seconds, "-f", "null", "-"], None

    path = None
    if recording:
        ext = "mp4" if s.container == "mp4" else "mkv"
        os.makedirs(s.out_dir, exist_ok=True)
        stamp = (now or _dt.datetime.now()).strftime("%Y-%m-%d %H-%M-%S")
        path = os.path.join(s.out_dir, "%s %s.%s" % (APP_NAME, stamp, ext))
        if ext == "mp4":  # fragmented so a crash doesn't kill the file
            rec_fmt = ["-f", "mp4", "-movflags", "+frag_keyframe+empty_moov+default_base_moof"]
            tee_fmt = "f=mp4:movflags=+frag_keyframe+empty_moov+default_base_moof"
        else:
            rec_fmt = ["-f", "matroska"]
            tee_fmt = "f=matroska"
    if s.mode == "both":
        args += ["-flags", "+global_header", "-f", "tee",
                 "[f=flv:onfail=ignore]%s|[%s]%s" % (tee_escape(stream_url), tee_fmt, tee_escape(path))]
    elif streaming:
        args += ["-f", "flv", stream_url]
    else:
        args += rec_fmt + [path]
    return args, path


# ---------------------------------------------------------------- running

def parse_stats(raw):
    def num(key, cast=float):
        m = re.match(r"\s*([0-9.]+)", raw.get(key, ""))
        try:
            return cast(m.group(1)) if m else None
        except ValueError:
            return None

    return {
        "frame": num("frame", int) or 0,
        "fps": num("fps") or 0.0,
        "kbps": num("bitrate"),
        "speed": num("speed"),
        "drop": num("drop_frames", int) or 0,
        "dup": num("dup_frames", int) or 0,
        "size": num("total_size", int) or 0,
    }


def process_cpu_seconds(proc):
    """Total CPU time used by a finished/running child (Windows only, else None)."""
    if not IS_WIN or proc is None:
        return None
    try:
        import ctypes
        k = ctypes.c_ulonglong
        c, e, kt, ut = k(), k(), k(), k()
        ok = ctypes.windll.kernel32.GetProcessTimes(ctypes.c_void_p(int(proc._handle)), ctypes.byref(c),
                                                    ctypes.byref(e), ctypes.byref(kt), ctypes.byref(ut))
        return (kt.value + ut.value) / 1e7 if ok else None
    except Exception:
        return None


def looks_like_capture_error(log_lines):
    blob = "\n".join(log_lines).lower()
    return any(k in blob for k in ("ddagrab", "gfxcapture", "d3d11", "dxgi", "duplicat", "hwdownload",
                                   "hwmap", "scale_d3d11", "graphics capture", "qsv", "nvenc", "amf",
                                   "error opening input", "error initializing", "device"))


class Session:
    """One running FFmpeg process. Callbacks fire on background threads."""

    def __init__(self, argv, on_stats=None, on_log=None, on_exit=None, log_path=None):
        self.argv = argv
        self.on_stats = on_stats or (lambda st: None)
        self.on_log = on_log or (lambda line: None)
        self.on_exit = on_exit or (lambda rc, log: None)
        self.log = collections.deque(maxlen=200)
        self.samples = collections.deque(maxlen=600)  # (monotonic time, stats)
        self.proc = None
        self.started = None
        self.stopping = False
        self._readers = []
        self._log_file = None
        if log_path:
            try:
                os.makedirs(os.path.dirname(log_path), exist_ok=True)
                self._log_file = open(log_path, "a", encoding="utf-8")
                self._write_log("=== %s  %s" % (_dt.datetime.now().isoformat(" ", "seconds"),
                                                subprocess.list2cmdline(_redact(argv))))
            except OSError:
                self._log_file = None

    def _write_log(self, line):
        if self._log_file:
            try:
                self._log_file.write(line + "\n")
                self._log_file.flush()
            except (OSError, ValueError):
                pass

    def start(self):
        self.proc = subprocess.Popen(self.argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, creationflags=_NO_WINDOW | _ABOVE_NORMAL)
        self.started = time.monotonic()
        self._readers = [threading.Thread(target=fn, daemon=True) for fn in (self._read_log, self._read_progress)]
        for t in self._readers:
            t.start()
        threading.Thread(target=self._wait, daemon=True).start()

    @property
    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def elapsed(self):
        return time.monotonic() - self.started if self.started else 0.0

    def steady_fps(self, window=3.0):
        """Frames per second over the last `window` seconds (ignores startup)."""
        if len(self.samples) < 2:
            return None
        t_end, st_end = self.samples[-1]
        for t, st in self.samples:
            if t_end - t <= window:
                if t_end - t < 0.8:
                    return None
                return (st_end["frame"] - st["frame"]) / (t_end - t)
        return None

    def stop(self, timeout=10):
        """Ask FFmpeg to finish cleanly (so the file isn't broken). Blocks."""
        self.stopping = True
        if not self.running:
            return
        try:
            self.proc.stdin.write(b"q")
            self.proc.stdin.flush()
        except (OSError, ValueError):  # already exited / pipe closed
            pass
        try:
            self.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            self.proc.terminate()
            try:
                self.proc.wait(3)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def _read_progress(self):
        raw = {}
        last_logged = 0
        for line in self.proc.stdout:
            key, _, val = _text(line).strip().partition("=")
            if key == "progress":
                st = parse_stats(raw)
                now = time.monotonic()
                self.samples.append((now, st))
                if now - last_logged >= 5:
                    last_logged = now
                    self._write_log("stats t=%.0fs fps=%.1f now=%s speed=%s drop=%d dup=%d kbps=%s" % (
                        self.elapsed(), st["fps"], "%.1f" % self.steady_fps() if self.steady_fps() else "-",
                        st["speed"], st["drop"], st["dup"], st["kbps"]))
                self.on_stats(st)
                raw = {}
            elif key:
                raw[key] = val

    def _read_log(self):
        for line in self.proc.stderr:
            text = _text(line).rstrip()
            if text:
                self.log.append(text)
                self._write_log(text)
                self.on_log(text)

    def _wait(self):
        rc = self.proc.wait()
        for t in self._readers:
            t.join(2)
        for pipe in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                pipe.close()
            except OSError:
                pass
        self.cpu_seconds = process_cpu_seconds(self.proc)
        self._write_log("exit rc=%s after %.1fs" % (rc, self.elapsed()))
        if self._log_file:
            self._log_file.close()
            self._log_file = None
        self.on_exit(rc, list(self.log))


def _redact(argv):
    """Hide stream keys in logs."""
    out = []
    for a in argv:
        a = re.sub(r"(rtmps?://[^|\s]+/)[^/|\s\]]{8,}", r"\1<key>", a)
        out.append(a)
    return out


# ---------------------------------------------------------------- autotune

def benchmark(ffmpeg, s, plan, target, seconds=4.0, log_path=None):
    """Run a plan for a few seconds into a null output. Returns a result dict."""
    argv, _ = build_command(ffmpeg, s, plan, target, bench_seconds=seconds)
    done = threading.Event()
    result = {"plan": plan.key(), "ok": False, "fps": 0.0, "cpu": None, "error": ""}

    def on_exit(rc, log):
        result["rc"] = rc
        result["error"] = log[-1] if log and rc != 0 else ""
        done.set()

    sess = Session(argv, on_exit=on_exit, log_path=log_path)
    t0 = time.monotonic()
    try:
        sess.start()
    except OSError as e:
        result["error"] = str(e)
        return result
    if not done.wait(seconds + 20):
        sess.stop(3)
        done.wait(5)
    wall = time.monotonic() - t0
    fps = sess.steady_fps(window=max(1.5, seconds - 1.5)) or 0.0
    result["fps"] = round(fps, 1)
    cpu = getattr(sess, "cpu_seconds", None)
    result["cpu"] = round(cpu / wall * 100, 1) if cpu is not None and wall else None
    result["ok"] = result.get("rc") == 0 and fps >= 0.9 * s.fps
    return result


def autotune(ffmpeg, caps, s, target, progress=None, log_path=None, seconds=4.0):
    """Try candidate pipelines until one holds full frame rate. Returns (best Plan or None, results)."""
    results, best, best_fps = [], None, -1.0
    plans = candidates(caps, s)
    for i, plan in enumerate(plans):
        if progress:
            progress(i, len(plans), plan)
        res = benchmark(ffmpeg, s, plan, target, seconds, log_path)
        results.append(res)
        if res["ok"]:
            return plan, results
        if res.get("rc") == 0 and res["fps"] > best_fps:
            best, best_fps = plan, res["fps"]
    return best, results
