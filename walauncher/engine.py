"""WaLauncher engine: finds FFmpeg, detects hardware, builds and runs the capture pipeline.

The whole trick to being lighter than OBS: no preview, no scene compositing,
screen grabbed with the GPU (Desktop Duplication on Windows) and encoded on
the GPU (NVENC / AMF / QuickSync) so the CPU stays free for your game.
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
from dataclasses import asdict, dataclass, fields

IS_WIN = sys.platform.startswith("win")
IS_MAC = sys.platform == "darwin"

if getattr(sys, "frozen", False):
    APP_DIR = os.path.dirname(sys.executable)
else:
    APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_NO_WINDOW = 0x08000000 if IS_WIN else 0
_ABOVE_NORMAL = 0x00008000 if IS_WIN else 0

PLATFORMS = {
    "Twitch": "rtmp://live.twitch.tv/app",
    "YouTube": "rtmp://a.rtmp.youtube.com/live2",
    "Custom": "",
}

# name -> (height, fps, video kbps)
PRESETS = {
    "Potato - 480p 30fps": (480, 30, 1500),
    "Low - 720p 30fps": (720, 30, 2500),
    "Balanced - 720p 30fps": (720, 30, 3500),
    "Smooth - 720p 60fps": (720, 60, 4500),
    "Sharp - 1080p 30fps": (1080, 30, 5000),
    "Max - 1080p 60fps": (1080, 60, 6000),
}

# Least laggy first.
ENCODERS = [
    ("h264_nvenc", "NVIDIA GPU"),
    ("h264_amf", "AMD GPU"),
    ("h264_qsv", "Intel GPU (QuickSync)"),
    ("h264_videotoolbox", "Apple GPU"),
    ("libx264", "CPU (x264) - heaviest"),
]
ENCODER_NAMES = dict(ENCODERS)

FFMPEG_URLS = [
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
]


def data_dir():
    if IS_WIN:
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
    elif IS_MAC:
        base = os.path.expanduser("~/Library/Application Support")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return os.path.join(base, "WaLauncher")


def default_out_dir():
    videos = os.path.join(os.path.expanduser("~"), "Videos")
    return videos if os.path.isdir(videos) else os.path.expanduser("~")


@dataclass
class Settings:
    mode: str = "record"  # record | stream | both
    platform: str = "Twitch"
    server: str = PLATFORMS["Twitch"]
    stream_key: str = ""
    preset: str = "Balanced - 720p 30fps"
    height: int = 720  # 0 = native
    fps: int = 30
    bitrate: int = 3500  # video kbps
    encoder: str = "auto"
    capture: str = "auto"
    monitor: int = 0
    draw_mouse: bool = True
    mic: str = ""
    desktop_audio: str = ""
    out_dir: str = ""
    container: str = "mkv"

    @classmethod
    def load(cls, path=None):
        path = path or os.path.join(data_dir(), "settings.json")
        s = cls()
        try:
            with open(path, encoding="utf-8") as f:
                raw = json.load(f)
        except (OSError, ValueError):
            raw = {}
        for fld in fields(cls):
            if fld.name in raw:
                default = getattr(s, fld.name)
                try:
                    setattr(s, fld.name, type(default)(raw[fld.name]))
                except (TypeError, ValueError):
                    pass
        if not s.out_dir:
            s.out_dir = default_out_dir()
        return s

    def save(self, path=None):
        path = path or os.path.join(data_dir(), "settings.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(asdict(self), f, indent=2)


# ---------------------------------------------------------------- ffmpeg lookup

def find_ffmpeg():
    exe = "ffmpeg.exe" if IS_WIN else "ffmpeg"
    for folder in (APP_DIR, os.path.join(APP_DIR, "ffmpeg", "bin"), data_dir()):
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
        req = urllib.request.Request(url, headers={"User-Agent": "WaLauncher"})
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


def has_filter(ffmpeg, name):
    r = _run([ffmpeg, "-hide_banner", "-filters"], 15)
    return bool(r) and _listed(_text(r.stdout), name)


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
    r = _run([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
              "-i", "color=black:s=1280x720:r=30", "-frames:v", "5",
              "-vf", "format=nv12", "-c:v", name, "-f", "null", "-"], 20)
    return r is not None and r.returncode == 0


def pick_capture(ffmpeg, preferred="auto"):
    if preferred != "auto":
        return preferred
    if IS_WIN:
        return "ddagrab" if has_filter(ffmpeg, "ddagrab") else "gdigrab"
    if IS_MAC:
        return "avfoundation"
    return "x11grab"


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


def list_monitors():
    """[(x, y, w, h)] with the primary monitor first. Empty if unknown (non-Windows)."""
    if not IS_WIN:
        return []
    try:
        import ctypes
        from ctypes import wintypes

        class MONITORINFO(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", wintypes.RECT),
                        ("rcWork", wintypes.RECT), ("dwFlags", wintypes.DWORD)]

        user32 = ctypes.windll.user32
        mons = []
        proc_type = ctypes.WINFUNCTYPE(ctypes.c_int, wintypes.HANDLE, wintypes.HDC,
                                       ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)

        def cb(hmon, _hdc, _rect, _lparam):
            info = MONITORINFO()
            info.cbSize = ctypes.sizeof(MONITORINFO)
            if user32.GetMonitorInfoW(hmon, ctypes.byref(info)):
                r = info.rcMonitor
                mons.append((r.left, r.top, r.right - r.left, r.bottom - r.top, bool(info.dwFlags & 1)))
            return 1

        callback = proc_type(cb)
        user32.EnumDisplayMonitors(None, None, callback, 0)
        mons.sort(key=lambda m: not m[4])
        return [m[:4] for m in mons]
    except Exception:
        return []


# ---------------------------------------------------------------- command building

def stream_url(s):
    server = s.server.strip().rstrip("/")
    key = s.stream_key.strip()
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
    else:
        extra = ["-preset", "ultrafast", "-tune", "zerolatency"]
    return ["-c:v", encoder] + extra + rate + ["-g", str(max(1, fps) * 2)]


def _audio_input(dev):
    if IS_WIN:
        return ["-f", "dshow", "-audio_buffer_size", "50", "-i", "audio=" + dev]
    if IS_MAC:
        return ["-f", "avfoundation", "-i", ":" + dev]
    return ["-f", "pulse", "-i", dev]


def build_command(ffmpeg, s, encoder, capture, monitor_rect=None, now=None):
    """Return (argv, recording_path or None)."""
    fps, height, kbps = int(s.fps), int(s.height), int(s.bitrate)
    streaming = s.mode in ("stream", "both")
    recording = s.mode in ("record", "both")
    args = [ffmpeg, "-hide_banner", "-loglevel", "warning", "-nostats", "-progress", "pipe:1", "-y"]

    # Video in
    pre = []
    iq = ["-thread_queue_size", "512"]
    if capture == "ddagrab":
        src = "ddagrab=output_idx=%d:framerate=%d:draw_mouse=%d" % (s.monitor, fps, int(s.draw_mouse))
        args += iq + ["-f", "lavfi", "-i", src]
        pre = ["hwdownload", "format=bgra"]
    elif capture == "gdigrab":
        args += iq + ["-f", "gdigrab", "-framerate", str(fps), "-draw_mouse", str(int(s.draw_mouse))]
        if monitor_rect:
            x, y, w, h = monitor_rect
            args += ["-offset_x", str(x), "-offset_y", str(y), "-video_size", "%dx%d" % (w, h)]
        args += ["-i", "desktop"]
    elif capture == "x11grab":
        x = y = 0
        args += iq + ["-f", "x11grab", "-framerate", str(fps), "-draw_mouse", str(int(s.draw_mouse))]
        if monitor_rect:
            x, y, w, h = monitor_rect
            args += ["-video_size", "%dx%d" % (w, h)]
        args += ["-i", "%s+%d,%d" % (os.environ.get("DISPLAY") or ":0.0", x, y)]
    elif capture == "avfoundation":
        args += iq + ["-f", "avfoundation", "-framerate", str(fps),
                      "-capture_cursor", str(int(s.draw_mouse)), "-i", "Capture screen %d:none" % s.monitor]
    elif capture == "test":
        args += ["-re", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=%d" % fps]
    else:
        raise ValueError("unknown capture method: %s" % capture)

    # Audio in
    audio = []
    for dev in (s.mic, s.desktop_audio):
        if dev and dev not in audio:
            audio.append(dev)
    for dev in audio:
        args += ["-thread_queue_size", "1024"] + _audio_input(dev)
    if not audio and streaming:  # platforms want an audio track
        args += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]

    # Filters: one swscale pass does resize + pixel format conversion.
    even_ih = "trunc(ih/2)*2"
    out_h = "'min(%d,%s)'" % (height, even_ih) if height else even_ih
    pix = "yuv420p" if encoder == "libx264" else "nv12"
    vchain = pre + ["scale=-2:%s:flags=fast_bilinear" % out_h, "format=" + pix]
    graph = "[0:v]%s[v]" % ",".join(vchain)
    maps = ["-map", "[v]"]
    if len(audio) == 2:
        graph += (";[1:a][2:a]amix=inputs=2:duration=longest:dropout_transition=0,"
                  "volume=2,aresample=async=1000[a]")
        maps += ["-map", "[a]"]
    elif audio:
        graph += ";[1:a]aresample=async=1000[a]"
        maps += ["-map", "[a]"]
    elif streaming:
        maps += ["-map", "1:a"]
    args += ["-filter_complex", graph] + maps

    # Encode
    args += encoder_args(encoder, fps, kbps) + ["-r", str(fps)]
    if audio or streaming:
        args += ["-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2"]

    # Out
    path = None
    if recording:
        ext = "mp4" if s.container == "mp4" else "mkv"
        os.makedirs(s.out_dir, exist_ok=True)
        stamp = (now or _dt.datetime.now()).strftime("%Y-%m-%d %H-%M-%S")
        path = os.path.join(s.out_dir, "WaLauncher %s.%s" % (stamp, ext))
        if ext == "mp4":  # fragmented so a crash doesn't kill the file
            rec_fmt = ["-f", "mp4", "-movflags", "+frag_keyframe+empty_moov+default_base_moof"]
            tee_fmt = "f=mp4:movflags=+frag_keyframe+empty_moov+default_base_moof"
        else:
            rec_fmt = ["-f", "matroska"]
            tee_fmt = "f=matroska"
    if s.mode == "both":
        args += ["-flags", "+global_header", "-f", "tee",
                 "[f=flv:onfail=ignore]%s|[%s]%s" % (tee_escape(stream_url(s)), tee_fmt, tee_escape(path))]
    elif streaming:
        args += ["-f", "flv", stream_url(s)]
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


def looks_like_capture_error(log_lines):
    blob = "\n".join(log_lines).lower()
    return any(k in blob for k in ("ddagrab", "d3d11", "dxgi", "duplicat", "hwdownload"))


class Session:
    """One running FFmpeg process. Callbacks fire on background threads."""

    def __init__(self, argv, on_stats=None, on_log=None, on_exit=None):
        self.argv = argv
        self.on_stats = on_stats or (lambda st: None)
        self.on_log = on_log or (lambda line: None)
        self.on_exit = on_exit or (lambda rc, log: None)
        self.log = collections.deque(maxlen=200)
        self.proc = None
        self.started = None
        self.stopping = False
        self._readers = []

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
        for line in self.proc.stdout:
            key, _, val = _text(line).strip().partition("=")
            if key == "progress":
                self.on_stats(parse_stats(raw))
                raw = {}
            elif key:
                raw[key] = val

    def _read_log(self):
        for line in self.proc.stderr:
            text = _text(line).rstrip()
            if text:
                self.log.append(text)
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
        self.on_exit(rc, list(self.log))
