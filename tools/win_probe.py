"""Windows capability/perf probe, run in CI. Prints what FFmpeg can do on this box."""
import ctypes
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from walauncher import engine as E  # noqa: E402


def sh(args, timeout=60):
    r = subprocess.run(args, capture_output=True, timeout=timeout)
    return r.returncode, r.stdout.decode("utf-8", "replace") + r.stderr.decode("utf-8", "replace")


def cpu_seconds(handle):
    k = ctypes.c_ulonglong
    c, e, kt, ut = k(), k(), k(), k()
    ctypes.windll.kernel32.GetProcessTimes(int(handle), ctypes.byref(c), ctypes.byref(e), ctypes.byref(kt), ctypes.byref(ut))
    return (kt.value + ut.value) / 1e7


def run_pipeline(name, ff, pre_inputs, graph, enc, secs=5):
    args = [ff, "-hide_banner", "-loglevel", "warning", "-nostats", "-progress", "pipe:1", "-y"] + pre_inputs
    if graph:
        args += ["-filter_complex", graph + "[v]", "-map", "[v]"]
    args += enc + ["-t", str(secs), "-f", "null", "-"]
    t0 = time.time()
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        out, err = p.communicate(timeout=secs + 25)
    except subprocess.TimeoutExpired:
        p.kill()
        out, err = p.communicate()
    wall = time.time() - t0
    cpu = cpu_seconds(p._handle)
    stats = {}
    for line in out.decode().splitlines():
        k, _, v = line.partition("=")
        stats[k] = v
    errtail = " | ".join(err.decode("utf-8", "replace").strip().splitlines()[-3:])
    print("PIPE %-34s rc=%-4s frames=%-5s fps=%-6s speed=%-7s dup=%-4s drop=%-4s cpu=%.2fs wall=%.1fs %s" % (
        name, p.returncode, stats.get("frame"), stats.get("fps"), stats.get("speed"),
        stats.get("dup_frames"), stats.get("drop_frames"), cpu, wall, errtail[:300]))
    sys.stdout.flush()


def main():
    print("python", sys.version)
    ff = E.find_ffmpeg()
    if not ff:
        print("downloading ffmpeg...")
        ff = E.download_ffmpeg()
    print("ffmpeg at", ff)
    print(sh([ff, "-version"])[1].splitlines()[0])
    _, filters = sh([ff, "-hide_banner", "-filters"])
    for f in ("ddagrab", "gfxcapture", "scale_d3d11", "hwmap", "hwupload", "vpp_qsv", "scale_qsv", "scale_cuda", "hwdownload", "fps"):
        print("FILTER %-12s %s" % (f, bool(re.search(r"^\s*\S+\s+%s\s" % f, filters, re.M))))
    _, encs = sh([ff, "-hide_banner", "-encoders"])
    print("ENCODERS", [l.split()[1] for l in encs.splitlines() if re.match(r"^\s*V\S*\s+h264", l)])
    for f in ("gfxcapture", "scale_d3d11", "ddagrab"):
        print("==== -h filter=%s" % f)
        print(sh([ff, "-hide_banner", "-h", "filter=" + f])[1][:3500])
    for enc in ("h264_nvenc", "h264_amf", "h264_qsv"):
        print("==== -h encoder=%s (pix fmts/hw)" % enc)
        txt = sh([ff, "-hide_banner", "-h", "encoder=" + enc])[1]
        print("\n".join(l for l in txt.splitlines() if "pixel formats" in l.lower() or "hardware" in l.lower() or "Supported" in l)[:800])
    rc, wv = sh(["reg", "query", r"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}", "/v", "pv"])
    print("WEBVIEW2", rc, wv.strip()[-80:])
    print("MONITORS", E.list_monitors())

    # Something that keeps repainting so window capture has frames.
    anim = subprocess.Popen(["cmd", "/c", "for /l %i in (0,0,1) do @echo %random%%random%%random%%random%%random%"],
                            creationflags=0x00000010)
    note = subprocess.Popen(["notepad.exe"])
    time.sleep(3)

    x264 = ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-b:v", "3500k"]
    dd = "ddagrab=output_idx=0:framerate=30"
    run_pipeline("ddagrab+cpu-scale (current)", ff, [], dd + ",hwdownload,format=bgra,scale=-2:720:flags=fast_bilinear,format=yuv420p", x264)
    run_pipeline("ddagrab lavfi-input (current)", ff, ["-f", "lavfi", "-i", dd], "[0:v]hwdownload,format=bgra,scale=-2:720:flags=fast_bilinear,format=yuv420p", x264)
    run_pipeline("gdigrab+cpu-scale", ff, ["-f", "gdigrab", "-framerate", "30", "-i", "desktop"], "[0:v]scale=-2:720:flags=fast_bilinear,format=yuv420p", x264)
    run_pipeline("ddagrab capture only", ff, [], dd + ",hwdownload,format=bgra", ["-c:v", "rawvideo"])
    run_pipeline("ddagrab no download", ff, [], dd, ["-c:v", "wrapped_avframe"])
    run_pipeline("gfx monitor gpu-scale", ff, [], "gfxcapture=monitor_idx=0:max_framerate=30:width=1280:height=720:resize_mode=scale_aspect,hwdownload,format=bgra,fps=30,format=yuv420p", x264)
    run_pipeline("gfx window(cmd) gpu-scale", ff, [], "gfxcapture=window_exe='(?i)^conhost.exe$|^cmd.exe$|^WindowsTerminal.exe$':max_framerate=30:width=1280:height=720:resize_mode=scale_aspect,hwdownload,format=bgra,fps=30,format=yuv420p", x264)
    run_pipeline("gfx window(notepad)", ff, [], "gfxcapture=window_exe='(?i)notepad.exe':max_framerate=30:width=1280:height=720:resize_mode=scale_aspect,hwdownload,format=bgra,fps=30,format=yuv420p", x264)
    if re.search(r"^\s*\S+\s+scale_d3d11\s", filters, re.M):
        run_pipeline("ddagrab+scale_d3d11", ff, [], dd + ",scale_d3d11=width=1280:height=720:format=nv12,hwdownload,format=nv12", x264)
        run_pipeline("ddagrab+scale_d3d11 bgra", ff, [], dd + ",scale_d3d11=width=1280:height=720,hwdownload,format=bgra,format=yuv420p", x264)
    for p in (anim, note):
        p.kill()


if __name__ == "__main__":
    main()
