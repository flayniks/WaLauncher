# LiteCast

A tiny streamer + recorder for weak laptops. Like OBS with all the heavy stuff ripped out.

- **Pick a single app** (your game, Chrome, Discord…) or a whole screen, with live thumbnails.
- **Log in with Twitch, YouTube or Kick** and hit Go live: no copying stream keys. (Or paste a key, or use any custom RTMP server.)
- **Record, stream, or both** at once.
- **Set your stream info before you go live** (and change it while live): title, category/game, tags, language and content warnings on Twitch; title, description, tags, category, privacy and made-for-kids on YouTube; title, category and tags on Kick.

## Why it doesn't lag

- **No live preview and no scene compositor.** That's most of what makes OBS heavy.
- **100% GPU pipeline.** On Windows the picture is grabbed by the GPU (Desktop Duplication / Windows Graphics Capture), resized on the GPU, and fed straight into the GPU's video encoder (NVIDIA NVENC, AMD AMF or Intel QuickSync). Frames never get copied through your CPU.
- **Speed test on first launch.** Every laptop is different, so LiteCast tries each capture method for a few seconds and keeps the fastest one that holds full frame rate. It re-tests when you change quality. You can re-run it from *Quality → Re-test*.
- If your PC still can't keep up, it tells you live ("only getting 18 of 30 fps") so you know to pick a lower preset.

## Get it (Windows 10/11)

Grab `LiteCast.exe` from the repo's **Actions** tab (latest "Build Windows app" run → Artifacts) or from **Releases**, and double-click it.
First launch downloads FFmpeg (~90 MB, one time) and runs the speed test (about 10 seconds).

> Windows SmartScreen may warn about an unsigned app: click *More info* → *Run anyway*.
> LiteCast uses the Edge WebView2 runtime that ships with Windows 10/11. If it's missing, the app links you to the free download.

From source: install Python 3.9+ and double-click `run.bat` (or `pip install pywebview` then `python -m litecast`).

## Use it

1. **What you're capturing:** click the preview → pick an app or a screen.
2. **Where it goes:** Record, Stream, or Stream + Record. For streaming, pick the platform and **Log in** (or paste your stream key).
3. **Quality:** start with **Balanced (720p 30fps)**. On a potato, use **Potato** or **Low**.
4. Hit **Go live** / **Start recording** (or **F9**).

## Tips for weak laptops

- 720p 30fps is the sweet spot. 60fps is double the work.
- Plug in the charger and set Windows power mode to **Best performance**.
- Capturing a game? Run it **windowed or borderless**; exclusive fullscreen can't be captured by any app without hooking into the game.
- Gaming laptop with two GPUs? If capture is slow, open Windows *Settings → Display → Graphics*, add `LiteCast.exe` and FFmpeg (`%APPDATA%\LiteCast\ffmpeg.exe`), and set both to the same GPU your game uses. Then hit *Re-test*.
- Still laggy? *Quality → Advanced → Copy diagnostics* and send that to whoever's helping you.

## Game / PC sound

Windows needs a recording device that "hears" your PC: Sound settings → More sound settings → **Recording** → right-click → *Show disabled devices* → enable **Stereo Mix**. No Stereo Mix? Install [screen-capture-recorder](https://github.com/rdp/screen-capture-recorder-to-video-windows-free) and pick **virtual-audio-capturer**.

## "Log in with…" buttons

Each site requires the app to be registered once (free, about 5 minutes). Until then LiteCast shows a stream key box instead. See [LOGIN_SETUP.md](LOGIN_SETUP.md).

## Files

- Settings, logins and logs: `%APPDATA%\LiteCast\` (the `logs` folder has the last session and the speed test).
- Recordings: your *Videos* folder by default, as `.mkv` (survives crashes) or `.mp4`.

## Dev

- `python -m unittest discover -s tests -t .` runs the tests (FFmpeg on PATH enables the real-capture ones).
- `python tools/devserver.py --fake-logins out --fake-windows` serves the real UI in a normal browser at http://127.0.0.1:8765 for UI work on any OS.
