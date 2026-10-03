"""Bridge between the UI (HTML in a webview) and the engine.

Every public method is callable from JavaScript as `pywebview.api.<name>(...)` and
returns plain JSON data. The UI polls `status()` a couple of times a second.
"""

import os
import re
import subprocess
import sys
import threading
import time
import webbrowser

from . import accounts as A
from . import credentials
from . import engine as E
from . import winapi as W

__version__ = "2.0.0"

MAX_RECONNECTS = 5
EARLY_FAIL_SECONDS = 8
STALL_SECONDS = 4  # no new frames for this long = capture is frozen


def _truncate(path):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "w").close()
    except OSError:
        pass


def _plan_label(plan):
    if not plan:
        return ""
    where = {"zerocopy": "100% GPU", "gpuscale": "GPU resize", "cpu": "CPU resize"}.get(plan.path, plan.path)
    cap = {"ddagrab": "screen", "gfxcapture": "app", "gdigrab": "compat"}.get(plan.capture, plan.capture)
    return "%s · %s · %s" % (E.ENCODER_NAMES.get(plan.encoder, plan.encoder), where, cap)


class Api:
    def __init__(self, settings=None, accounts=None, ffmpeg=None, auto_boot=True):
        self._lock = threading.RLock()
        self._s = settings or E.Settings.load()
        self._accounts = accounts or A.Accounts(os.path.join(E.data_dir(), "accounts.json"),
                                                credentials.load(E.data_dir()))
        self._ffmpeg = ffmpeg if ffmpeg is not None else E.find_ffmpeg()
        self._auto_boot = auto_boot
        self._booted = False
        self._caps = None
        self._audio = []
        self._monitors = W.list_monitors()
        self._phase = "boot"  # boot download detecting tuning ready starting live stopping error
        self._note = "Starting up…"
        self._warn = ""
        self._error = ""
        self._detail = ""
        self._download = None
        self._tune = None
        self._tune_thread = None
        self._login = None
        self._session = None
        self._run = {}
        self._window = None  # pywebview window, set by app.py
        self._log_dir = os.path.join(E.data_dir(), "logs")
        self._selftest = False
        self._selftest_result = None

    # ------------------------------------------------------------ helpers

    def _set(self, **kw):
        with self._lock:
            for k, v in kw.items():
                setattr(self, "_" + k, v)

    def _bg(self, fn, *args):
        t = threading.Thread(target=fn, args=args, daemon=True)
        t.start()
        return t

    def _target(self):
        """The screen target (window targets are resolved at go-live time)."""
        s = self._s
        mon = self._monitors[s.monitor] if s.monitor < len(self._monitors) else None
        rect = (mon["x"], mon["y"], mon["w"], mon["h"]) if mon else None
        return E.Target(kind="screen", monitor=s.monitor, rect=rect, hmonitor=mon.get("handle", 0) if mon else 0)

    def _plan(self):
        key = self._s.tuned.get(E.tune_key(self._s, self._target()))
        plan = E.Plan.from_key(key) if key else None
        if plan and self._caps and plan.encoder not in self._caps.encoders:
            plan = None
        return plan

    # ------------------------------------------------------------ boot / detection / tuning

    def _boot(self):
        if not self._ffmpeg:
            if not E.IS_WIN:
                self._set(phase="error", error="FFmpeg isn't installed. Install it (sudo apt install ffmpeg / "
                                               "brew install ffmpeg) and restart.")
                return
            self._set(phase="download", note="Downloading FFmpeg (one time, ~90 MB)…", download={"done": 0, "total": 0})
            try:
                path = E.download_ffmpeg(lambda d, t: self._set(download={"done": d, "total": t}))
            except Exception as e:
                self._set(phase="error", error="Couldn't download FFmpeg: %s" % e)
                return
            self._set(ffmpeg=path, download=None)
        self._set(phase="detecting", note="Checking your PC…")
        caps = E.probe(self._ffmpeg)
        audio = E.list_audio_devices(self._ffmpeg)
        self._set(caps=caps, audio=audio)
        if not caps.encoders:
            self._set(phase="error", error="This FFmpeg has no video encoder. Delete it and restart to re-download.")
            return
        self._ensure_tuned()

    def _ensure_tuned(self, force=False):
        if not force and self._plan():
            self._set(phase="ready", note="Ready", tune=None)
            return
        self._set(phase="tuning", note="Finding the fastest way to capture on your PC…", tune={"i": 0, "n": 1})
        s, target = self._s, self._target()

        def progress(i, n, plan):
            self._set(tune={"i": i, "n": n, "label": _plan_label(plan)})

        _truncate(os.path.join(self._log_dir, "autotune.log"))
        best, results = E.autotune(self._ffmpeg, self._caps, s, target, progress,
                                   log_path=os.path.join(self._log_dir, "autotune.log"))
        if not best:
            cands = E.candidates(self._caps, s)
            best = cands[0] if cands else None
        with self._lock:
            if best:
                s.tuned[E.tune_key(s, target)] = best.key()
                try:
                    s.save()
                except OSError:
                    pass
            ok = any(r["ok"] for r in results)
            self._phase, self._tune = "ready", None
            self._note = "Ready"
            self._warn = "" if ok else ("Your PC struggled in the speed test. Pick a lower quality preset "
                                        "(Potato or Low) for smooth video.")
            self._tune_results = results

    def _retune_async(self, force=False):
        with self._lock:
            if self._phase not in ("ready", "error") or not self._caps:
                return
            if self._tune_thread and self._tune_thread.is_alive():
                return
            self._tune_thread = self._bg(self._ensure_tuned, force)

    # ------------------------------------------------------------ JS: info

    def init(self):
        with self._lock:
            if not self._booted and self._auto_boot:
                self._booted = True
                self._bg(self._boot)
        return {
            "app": E.APP_NAME, "version": __version__, "os": sys.platform,
            "settings": self.settings(),
            "presets": [{"id": k, "height": v[0], "fps": v[1], "kbps": v[2]} for k, v in E.PRESETS.items()],
            "platforms": [{"id": k, "name": v["name"], "server": v["server"]} for k, v in E.PLATFORMS.items()],
            "can_pick_windows": E.IS_WIN,
            "is_admin": W.is_admin(), "can_elevate": E.IS_WIN,
            "selftest": self._selftest,
        }

    def retry_boot(self):
        with self._lock:
            if self._phase != "error":
                return False
            self._phase, self._error, self._note = "boot", "", "Starting up…"
        self._bg(self._boot)
        return True

    def settings(self):
        d = dict(vars(self._s))
        d.pop("tuned", None)
        return d

    def status(self):
        with self._lock:
            st = {
                "phase": self._phase, "note": self._note, "warn": self._warn, "error": self._error,
                "detail": self._detail, "download": self._download, "tune": self._tune, "login": self._login,
                "accounts": self._accounts.summary(),
                "encoders": [{"id": e, "label": E.ENCODER_NAMES.get(e, e)} for e in (self._caps.encoders if self._caps else [])],
                "audio": self._audio,
                "plan": _plan_label(self._run.get("plan") or self._plan()),
                "live": None,
            }
            sess = self._session
            if sess and self._phase in ("live", "stopping"):
                stats = self._run.get("stats") or {}
                st["live"] = {
                    "mode": self._run["settings"].mode, "elapsed": sess.elapsed(),
                    "fps": round(sess.steady_fps() or stats.get("fps") or 0, 1),
                    "target_fps": self._run["settings"].fps,
                    "kbps": stats.get("kbps"), "drop": stats.get("drop", 0),
                    "stream_dead": self._run.get("stream_dead", False),
                    "gpu_priority": sess.gpu_priority,
                    "reconnects": self._run.get("reconnects", 0),
                }
            return st

    def save(self, patch):
        """Merge a dict of settings from the UI. Returns the full settings."""
        with self._lock:
            before = E.tune_key(self._s, self._target())
            for k, v in (patch or {}).items():
                if k == "tuned" or not hasattr(self._s, k):
                    continue
                default = getattr(self._s, k)
                try:
                    setattr(self._s, k, type(default)(v) if not isinstance(default, dict) else dict(v))
                except (TypeError, ValueError):
                    pass
            s = self._s
            s.fps = min(60, max(10, s.fps))
            s.bitrate = min(50000, max(300, s.bitrate))
            s.height = s.height if s.height in (0, 360, 480, 720, 900, 1080, 1440) else 720
            if s.mode not in ("record", "stream", "both"):
                s.mode = "record"
            if s.platform not in E.PLATFORMS:
                s.platform = "twitch"
            try:
                s.save()
            except OSError:
                pass
            changed = E.tune_key(s, self._target()) != before
        if changed and not self._plan():
            self._retune_async()
        return self.settings()

    # ------------------------------------------------------------ JS: sources

    def sources(self):
        self._monitors = W.list_monitors() or self._monitors
        screens = [{"id": i, "name": "Screen %d" % (i + 1) + (" (main)" if m["primary"] else ""),
                    "w": m["w"], "h": m["h"]} for i, m in enumerate(self._monitors)]
        if not screens:
            screens = [{"id": 0, "name": "Main screen", "w": 0, "h": 0}]
        wins = [{"hwnd": w["hwnd"], "title": w["title"], "exe": w["exe"], "path": w["path"],
                 "minimized": w["minimized"]} for w in W.list_windows()]
        return {"screens": screens, "windows": wins}

    def thumb(self, kind, ident):
        try:
            if kind == "screen":
                mons = self._monitors
                return W.screen_thumb(mons[int(ident)]) if int(ident) < len(mons) else None
            return W.window_thumb(int(ident))
        except Exception:
            return None

    def icon(self, path):
        try:
            return W.exe_icon(path)
        except Exception:
            return None

    # ------------------------------------------------------------ JS: accounts

    def login(self, pid):
        with self._lock:
            if self._login and self._login.get("stage") in ("starting", "code", "browser"):
                return False
            self._login = {"platform": pid, "stage": "starting"}

        def run():
            def progress(info):
                with self._lock:
                    self._login = dict(info, platform=pid)
            try:
                prof = self._accounts.login(pid, progress)
                self._set(login={"platform": pid, "stage": "done", "user": prof})
                with self._lock:
                    self._s.platform = pid
                    self._s.save()
            except A.AuthError as e:
                self._set(login={"platform": pid, "stage": "error", "error": str(e)})
            except Exception as e:  # network hiccups etc.
                self._set(login={"platform": pid, "stage": "error", "error": "Login failed: %s" % e})

        self._bg(run)
        return True

    def login_setup(self, pid, values):
        """Save app IDs the user created on the platform's developer site, so 'Log in with…' works."""
        keys = credentials.SETUP_KEYS.get(pid)
        if not keys:
            return {"ok": False, "error": "Unknown platform."}
        vals = {k: str((values or {}).get(k) or "").strip() for k in keys}
        if not all(vals.values()):
            return {"ok": False, "error": "Fill in every box."}
        if pid == "twitch" and not re.fullmatch(r"[a-z0-9]{20,40}", vals["TWITCH_CLIENT_ID"]):
            return {"ok": False, "error": "That doesn't look like a Twitch Client ID (about 30 letters and numbers)."}
        if pid == "youtube" and not vals["YOUTUBE_CLIENT_ID"].endswith(".apps.googleusercontent.com"):
            return {"ok": False, "error": "That doesn't look like a Google Client ID - it ends in .apps.googleusercontent.com."}
        try:
            credentials.save(E.data_dir(), vals)
        except OSError as e:
            return {"ok": False, "error": "Couldn't save: %s" % e}
        self._accounts.reload(credentials.load(E.data_dir()))
        return {"ok": True}

    def cancel_login(self):
        self._accounts.cancel()
        self._set(login=None)

    def dismiss_login(self):
        self._set(login=None)

    def logout(self, pid):
        self._accounts.logout(pid)

    # ------------------------------------------------------------ JS: stream info (title, category, tags…)

    def _logged_in(self, pid):
        return bool((self._accounts.data.get(pid) or {}).get("profile"))

    def stream_info(self, pid):
        """Saved info for a platform, refreshed from what's currently set on the platform."""
        local = A.clean_info(pid, self._s.stream_info.get(pid))
        res = {"info": local, "error": "", "languages": A.LANGUAGES,
               "labels": A.Twitch.LABELS, "yt_categories": [{"id": i, "name": n} for i, n in A.YouTube.CATEGORIES]}
        if pid in ("twitch", "kick") and self._logged_in(pid):
            try:
                remote = self._accounts.channel_info(pid)
            except Exception as e:
                res["error"] = "Couldn't load your current %s info (%s)." % (E.PLATFORMS[pid]["name"], e)
                remote = None
            if remote:
                merged = dict(local)
                merged.update({k: v for k, v in remote.items() if v not in (None, "")})
                res["info"] = A.clean_info(pid, merged)
        return res

    def save_stream_info(self, pid, info):
        if pid not in E.PLATFORMS:
            return None
        clean = A.clean_info(pid, info)
        with self._lock:
            self._s.stream_info[pid] = clean
            try:
                self._s.save()
            except OSError:
                pass
        return clean

    def search_categories(self, pid, query):
        query = (query or "").strip()
        if not query:
            return []
        if pid == "youtube" or not self._logged_in(pid):
            return [{"id": i, "name": n, "img": ""} for i, n in A.YouTube.CATEGORIES
                    if query.lower() in n.lower()] if pid == "youtube" else []
        try:
            return self._accounts.search_categories(pid, query)[:10]
        except Exception:
            return []

    def apply_stream_info(self, pid, info):
        """Save the info and push it to the platform right away (Twitch/Kick any time, YouTube while live)."""
        clean = self.save_stream_info(pid, info)
        if not self._logged_in(pid) or (pid == "youtube" and self._phase != "live"):
            return {"ok": True, "info": clean, "pushed": False}
        try:
            self._accounts.update_info(pid, clean)
        except A.AuthError as e:
            return {"ok": False, "error": str(e)}
        except Exception as e:
            return {"ok": False, "error": "Couldn't update: %s" % e, "info": clean}
        return {"ok": True, "info": clean, "pushed": True}

    # ------------------------------------------------------------ JS: go live / stop

    def start(self):
        with self._lock:
            if self._phase not in ("ready",):
                if self._phase == "tuning":
                    return {"ok": False, "error": "Hang on, still running the speed test (a few seconds)."}
                return {"ok": False, "error": self._error or "Not ready yet."}
            s = E.Settings(**{k: (dict(v) if isinstance(v, dict) else v) for k, v in vars(self._s).items()})
            if s.mode != "record":
                logged_in = (self._accounts.data.get(s.platform) or {}).get("profile")
                key = s.stream_keys.get(s.platform, "").strip()
                if not logged_in and not key:
                    name = E.PLATFORMS[s.platform]["name"]
                    return {"ok": False, "error": "Log in to %s or paste your stream key first." % name}
                if not logged_in and s.platform in ("kick", "custom") and not s.custom_server.strip():
                    return {"ok": False, "error": "Paste the server URL for %s." % E.PLATFORMS[s.platform]["name"]}
            if s.source == "window" and not s.window_exe and not s.window_hwnd:
                return {"ok": False, "error": "Pick an app to capture first."}
            _truncate(os.path.join(self._log_dir, "last-session.log"))
            self._phase, self._error, self._warn, self._detail = "starting", "", "", ""
            self._note = "Getting ready…"
            self._run = {"settings": s, "reconnects": 0}
        self._bg(self._go, s)
        return {"ok": True}

    def _go(self, s):
        try:
            url = None
            if s.mode != "record":
                acct = (self._accounts.data.get(s.platform) or {}).get("profile")
                if acct:
                    self._set(note="Getting your stream key from %s…" % E.PLATFORMS[s.platform]["name"])
                    server, key, warn = self._accounts.go_live(s.platform, s.stream_info.get(s.platform) or {})
                    if warn:
                        self._set(warn=warn)
                else:
                    server = E.PLATFORMS[s.platform]["server"] or s.custom_server
                    key = s.stream_keys.get(s.platform, "")
                url = E.stream_join(server, key)

            screen_target = self._target()
            screen_plan = self._plan() or (E.candidates(self._caps, s) or [None])[0]
            if s.source == "window":
                win = W.find_window(s.window_hwnd, s.window_exe, s.window_title)
                if not win:
                    raise A.AuthError("Can't find %s. Open it, then pick it again." % (s.window_exe or "that app"))
                target = E.Target(kind="window", hwnd=win["hwnd"], title=win["title"],
                                  monitor=screen_target.monitor)
                first = E.window_plan(self._caps, screen_plan)
                chain = [first] + [E.Plan("gfxcapture", p, first.encoder) for p in ("gpuscale", "cpu")
                                   if first.capture == "gfxcapture" and p != first.path]
                chain.append(E.Plan("gdigrab", "cpu", first.encoder))
            else:
                target = screen_target
                cands = E.candidates(self._caps, s)
                idx = next((i for i, p in enumerate(cands) if p.key() == screen_plan.key()), 0)
                chain = [screen_plan] + [p for p in cands[idx + 1:] if p.key() != screen_plan.key()]
            with self._lock:
                self._run.update(url=url, target=target, chain=chain)
            self._launch(0)
        except A.AuthError as e:
            self._fail(str(e))
        except Exception as e:
            self._fail("Couldn't start: %s" % e)

    def _launch(self, idx):
        run = self._run
        s, plan = run["settings"], run["chain"][idx]
        try:
            argv, path = E.build_command(self._ffmpeg, s, plan, run["target"], stream_url=run.get("url"))
        except OSError as e:
            self._fail("Can't save to that folder: %s" % e)
            return
        sess = E.Session(argv,
                         on_stats=lambda st: self._on_stats(sess, st),
                         on_log=lambda line: self._on_log(sess, line),
                         on_exit=lambda rc, log: self._on_exit(sess, rc, log),
                         log_path=os.path.join(self._log_dir, "last-session.log"))
        with self._lock:
            run.update(plan=plan, idx=idx, path=path, stream_dead=False, slow=0, stall_warned=False)
            self._session = sess
        try:
            sess.start()
        except OSError as e:
            self._fail("Couldn't start FFmpeg: %s" % e)
            return
        self._set(phase="live", note="")

    def _speed_tips(self, s):
        tips = []
        if E.IS_WIN and not W.is_admin():
            tips.append("Turn on Gaming boost (Quality card) so capture gets GPU priority")
        tips.append("cap your game's FPS (e.g. 60, or turn on V-Sync) so the GPU has room")
        if s.height > 480 or s.fps > 30:
            tips.append("try the Potato preset")
        return "Fixes: " + "; ".join(tips) + "."

    def _switch_to_screen(self, sess):
        """App capture stopped delivering frames (usually exclusive fullscreen) - capture its screen instead."""
        run = self._run
        s = run["settings"]
        mons = W.list_monitors() or self._monitors
        handle = W.monitor_of_window(run["target"].hwnd)
        idx = next((i for i, m in enumerate(mons) if handle and m.get("handle") == handle), s.monitor)
        mon = mons[idx] if idx < len(mons) else None
        target = E.Target(kind="screen", monitor=idx, rect=(mon["x"], mon["y"], mon["w"], mon["h"]) if mon else None,
                          hmonitor=mon.get("handle", 0) if mon else 0)
        cands = E.candidates(self._caps, s)
        tuned = E.Plan.from_key(s.tuned.get(E.tune_key(s, target)) or "")
        first = tuned or (cands[0] if cands else run["plan"])
        run.update(target=target, chain=[first] + [p for p in cands if p.key() != first.key()],
                   switching=True, switched=True)
        self._warn = ("%s stopped sending frames - it's probably in exclusive fullscreen. Switched to capturing "
                      "your whole screen%s. Tip: set the game to Borderless or Windowed."
                      % (s.window_exe or "The app", " (recording continues in a new file)" if run.get("path") else ""))
        sess.stopping = True  # ignore its last stats while it shuts down
        self._bg(sess.stop)

    def restart_as_admin(self):
        """Gaming boost: relaunch elevated so FFmpeg can get top GPU priority."""
        with self._lock:
            if self._phase in ("live", "stopping", "starting"):
                return {"ok": False, "error": "Stop streaming/recording first."}
        if not W.relaunch_as_admin():
            return {"ok": False, "error": "Windows didn't allow it (you can also right-click LiteCast → Run as administrator)."}

        def close():
            time.sleep(0.5)
            if self._window:
                self._window.destroy()
        self._bg(close)
        return {"ok": True}

    def stop(self):
        with self._lock:
            sess = self._session
            if self._phase == "starting" and not sess:
                return False
            if not sess or self._phase not in ("live",):
                return False
            if not sess.running:  # waiting to reconnect
                self._finish("Stream ended")
                return True
            self._phase, self._note = "stopping", "Finishing up the file…"
        self._bg(sess.stop)
        return True

    def _on_stats(self, sess, st):
        with self._lock:
            if sess is not self._session or sess.stopping:
                return
            self._run["stats"] = st
            s = self._run["settings"]
            run = self._run
            if sess.elapsed() > 5 and sess.stalled_for() > STALL_SECONDS:
                if run["target"].kind == "window" and not run.get("switched"):
                    self._switch_to_screen(sess)
                    return
                if not run.get("stall_warned"):
                    run["stall_warned"] = True
                    self._warn = ("Capture is frozen - no new frames for %d seconds. %s"
                                  % (sess.stalled_for(), self._speed_tips(s)))
            elif run.get("stall_warned") and sess.stalled_for() < 1:
                run["stall_warned"] = False
                if self._warn.startswith("Capture is frozen"):
                    self._warn = ""
            fps = sess.steady_fps()
            if fps is not None and sess.elapsed() > 6 and not run.get("stall_warned"):
                run["slow"] = run.get("slow", 0) + 1 if fps < 0.8 * s.fps else 0
                if run["slow"] >= 12:
                    self._warn = "Only getting %.0f of %d fps. %s" % (fps, s.fps, self._speed_tips(s))
                elif self._warn.startswith("Only getting") and run["slow"] == 0:
                    self._warn = ""
            if self._run.get("reconnects") and st["frame"] > 0 and self._warn.startswith("Stream dropped"):
                self._warn = ""

    def _on_log(self, sess, line):
        with self._lock:
            if sess is not self._session:
                return
            if "Slave muxer #0 failed" in line or ("Slave '" in line and "error opening" in line):
                self._run["stream_dead"] = True
                self._warn = "Stream connection failed - still recording. Check your key / internet."

    def _on_exit(self, sess, rc, log):
        with self._lock:
            if sess is not self._session:
                return
            run = self._run
            s = run["settings"]
            elapsed = sess.elapsed()
            if run.get("switching"):
                run["switching"] = False
                self._bg(self._launch, 0)
                return
            user_stop = sess.stopping
            if (not user_stop and rc != 0 and elapsed < EARLY_FAIL_SECONDS and run["idx"] + 1 < len(run["chain"])
                    and E.looks_like_capture_error(log)):
                nxt = run["idx"] + 1
                self._note = "Trying another capture method…"
                self._bg(self._launch, nxt)
                return
            if (not user_stop and s.mode == "stream" and (elapsed > 15 or run["reconnects"])
                    and run["reconnects"] < MAX_RECONNECTS):
                if elapsed > 60:
                    run["reconnects"] = 0
                run["reconnects"] += 1
                self._warn = "Stream dropped - reconnecting (%d/%d)…" % (run["reconnects"], MAX_RECONNECTS)

                def again(r=run):
                    time.sleep(5)
                    with self._lock:
                        if self._run is not r or self._phase != "live":
                            return
                    self._launch(r["idx"])
                self._bg(again)
                return
            target = run.get("target")
        if user_stop or rc == 0:
            self._finish("Saved: %s" % os.path.basename(run["path"]) if run.get("path") else "Stream ended")
        elif target and target.kind == "window" and not W.window_alive(target.hwnd):
            self._finish("Stopped: the app you were capturing was closed", error=True)
        else:
            err = next((ln for ln in reversed(log) if ln.strip()), "FFmpeg exited with code %d" % rc)
            self._finish("Stopped: something went wrong", error=True, detail=err)

    def _fail(self, msg):
        self._finish(msg, error=True)

    def _finish(self, msg, error=False, detail=""):
        with self._lock:
            self._session = None
            self._phase = "ready"
            self._note = msg
            self._error = msg if error else ""
            self._detail = detail[:400]
            self._run["last_path"] = self._run.get("path")
        yt = getattr(self._accounts, "platforms", {}).get("youtube")
        if yt is not None:
            yt.live_video = None  # that broadcast is over

    # ------------------------------------------------------------ JS: misc

    def retune(self):
        self._retune_async(force=True)
        return True

    def browse_folder(self):
        if not self._window:
            return None
        try:
            import webview
            res = self._window.create_file_dialog(webview.FileDialog.FOLDER, directory=self._s.out_dir or "")
        except Exception:
            return None
        if res:
            path = res[0] if isinstance(res, (list, tuple)) else res
            self.save({"out_dir": path})
            return path
        return None

    def open_folder(self, path=None):
        path = path or self._s.out_dir
        if path and os.path.isdir(path):
            self._open(path)
        return True

    def open_logs(self):
        os.makedirs(self._log_dir, exist_ok=True)
        self._open(self._log_dir)
        return True

    def _open(self, path):
        if E.IS_WIN:
            os.startfile(path)
        else:
            subprocess.Popen(["open" if E.IS_MAC else "xdg-open", path])

    def open_url(self, url):
        if url.startswith(("https://", "http://")):
            webbrowser.open(url)
        return True

    def diagnostics(self):
        lines = ["%s %s on %s" % (E.APP_NAME, __version__, sys.platform)]
        try:
            lines += W.system_info()
        except Exception as e:
            lines.append("system info failed: %s" % e)
        if self._caps:
            lines += [self._caps.version, "filters: %s" % sorted(self._caps.filters),
                      "encoders: %s" % self._caps.encoders]
        s = self._s
        lines.append("settings: mode=%s platform=%s source=%s%s %sp@%dfps %dkbps encoder=%s mic=%s pc_audio=%s" % (
            s.mode, s.platform, s.source, " (%s)" % s.window_exe if s.source == "window" else " #%d" % s.monitor,
            s.height or "native", s.fps, s.bitrate, s.encoder, bool(s.mic), bool(s.desktop_audio)))
        lines.append("plan: %s (%s)" % (_plan_label(self._plan()), (self._plan() or E.Plan("?", "?", "?")).key()))
        tune = getattr(self, "_tune_results", [])
        for r in tune:
            lines.append("tune %(plan)s ok=%(ok)s fps=%(fps)s cpu=%(cpu)s %(error)s" % r)
        if not tune:
            try:
                with open(os.path.join(self._log_dir, "autotune.log"), encoding="utf-8") as f:
                    lines += ["--- speed test ---"] + [ln for ln in f.read().splitlines() if not ln.startswith("===")][-20:]
            except OSError:
                pass
        try:
            with open(os.path.join(self._log_dir, "last-session.log"), encoding="utf-8") as f:
                lines += ["--- last session ---"] + f.read().splitlines()[-40:]
        except OSError:
            pass
        return "\n".join(lines)

    def selftest_report(self, result):
        self._selftest_result = result
        return True

    def shutdown(self):
        """Window closing: finish the recording properly."""
        sess = self._session
        if sess and sess.running:
            sess.stop()
        self._accounts.cancel()
