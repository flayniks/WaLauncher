"""Windows capability probe, run in CI for information. Prints what FFmpeg can do on this box."""
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from litecast import engine as E  # noqa: E402
from litecast import winapi as W  # noqa: E402

ff = E.find_ffmpeg() or E.download_ffmpeg()
print("ffmpeg:", ff)
caps = E.probe(ff)
print("version:", caps.version)
print("filters:", sorted(caps.filters))
print("working encoders:", caps.encoders)
listing = subprocess.run([ff, "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
print("compiled h264 encoders:", re.findall(r"^\s*V\S*\s+(\S*264\S*)", listing, re.M))
print("monitors:", W.list_monitors())
print("windows:", [(w["exe"], w["title"][:40]) for w in W.list_windows()])
