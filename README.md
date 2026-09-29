# WaLauncher

A tiny streamer + recorder for weak laptops. Think OBS with all the heavy stuff ripped out.

## Why it lags less than OBS

- **No live preview.** OBS redraws your whole screen in its window all the time. This doesn't.
- **GPU screen grab.** On Windows it uses Desktop Duplication (same thing OBS's display capture uses) instead of slow screenshots.
- **GPU encoding.** Auto-detects NVIDIA (NVENC), AMD (AMF) or Intel (QuickSync) and uses the first one that works. CPU (x264 ultrafast) only if there's no GPU encoder.
- **One cheap resize pass**, low-latency encoder settings, no scenes/sources/filters.

It's all powered by [FFmpeg](https://ffmpeg.org) under the hood.

## Get it (Windows)

**Easy way:** grab `WaLauncher.exe` from the repo's **Actions** tab (latest "Build Windows app" run → Artifacts) or from **Releases**, then double-click it.
First launch asks to download FFmpeg (~90 MB, one time).

**From source:** install Python 3.8+ from python.org (tick "Add python.exe to PATH"), then double-click `run.bat`.

> Windows SmartScreen may warn about an unsigned app. Click "More info" → "Run anyway".

## Use it

1. Pick **Record**, **Stream**, or **Stream + Record**.
2. Streaming? Pick Twitch/YouTube and paste your stream key.
   - Twitch: Creator Dashboard → Settings → Stream
   - YouTube: Studio → Go live → Stream
   - Kick / anything else: pick **Custom** and paste the server URL + key.
3. Pick a preset. Start with **Balanced - 720p 30fps**.
4. Hit **START** (or press **F9** while the window is focused).

If you see *"Your laptop can't keep up"*, stop and go down a preset (Low or Potato).

## Tips for potato laptops

- **720p 30fps** is the sweet spot. 60fps doubles the work.
- Plug in the charger and set Windows power mode to **Best performance**.
- Close Chrome, Discord overlay, etc. while streaming.
- Black screen when capturing a game? Switch the game to **borderless / windowed fullscreen**.
- Bitrate: keep it under ~70% of your upload speed (run a speed test). Twitch tops out at 6000.
- Recordings default to **.mkv** so they survive a crash. Want mp4? Pick it in Format.

## Game / PC audio

Windows needs a recording device that "hears" your PC:
Sound settings → More sound settings → **Recording** tab → right-click → *Show disabled devices* → enable **Stereo Mix**, then pick it as *Game/PC audio*.
No Stereo Mix on your laptop? Install [screen-capture-recorder](https://github.com/rdp/screen-capture-recorder-to-video-windows-free) and pick **virtual-audio-capturer**.

## Other stuff

- Settings live in `%APPDATA%\WaLauncher\settings.json` (includes your stream key, don't share that file).
- If the fast capture fails, it automatically falls back to compatibility capture.
- Stream drops (Stream mode) auto-reconnect up to 5 times.
- Linux (X11) and macOS work too; install FFmpeg yourself (`sudo apt install ffmpeg` / `brew install ffmpeg`) and run `python3 -m walauncher`.
- Tests: `python -m unittest discover -s tests -t .`
