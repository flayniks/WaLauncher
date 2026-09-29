"""WaLauncher window (tkinter, no extra installs needed)."""

import os
import queue
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from . import engine as E

BG = "#15151c"
PANEL = "#1e1e28"
FIELD = "#2a2a36"
FG = "#ececf4"
MUTED = "#9494a8"
ACCENT = "#7c5cff"
RED = "#ff4d5e"
YELLOW = "#ffcc4d"
GREEN = "#3ddc84"

RESOLUTIONS = [("480p", 480), ("720p", 720), ("900p", 900), ("1080p", 1080), ("Native", 0)]
FPS_CHOICES = ["24", "30", "48", "60"]
MODES = [("record", "Record"), ("stream", "Stream"), ("both", "Stream + Record")]
NONE = "None"
CUSTOM = "Custom"
MAX_RECONNECTS = 5


class App:
    def __init__(self, root):
        self.root = root
        self.s = E.Settings.load()
        self.ffmpeg = E.find_ffmpeg()
        self.encoders = []
        self.capture = None
        self.monitors = E.list_monitors()
        self.session = None
        self.state = "idle"  # idle | busy | running | stopping
        self.run = {}  # details of the current run
        self.slow_ticks = 0
        self.q = queue.Queue()
        self._style()
        self._build()
        self._load()
        root.protocol("WM_DELETE_WINDOW", self.on_close)
        root.bind("<F9>", lambda _e: self.toggle())
        root.after(50, self._poll)
        root.after(1000, self._tick)
        root.after(150, self._startup)

    # ------------------------------------------------------------ look

    def _style(self):
        r = self.root
        r.title("WaLauncher")
        r.configure(bg=BG)
        r.minsize(820, 0)
        st = ttk.Style(r)
        st.theme_use("clam")
        st.configure(".", background=BG, foreground=FG, fieldbackground=FIELD,
                     bordercolor=PANEL, lightcolor=PANEL, darkcolor=PANEL, font=("Segoe UI", 10))
        st.configure("TFrame", background=BG)
        st.configure("Card.TFrame", background=PANEL)
        st.configure("TLabel", background=PANEL, foreground=FG)
        st.configure("Muted.TLabel", background=PANEL, foreground=MUTED, font=("Segoe UI", 9))
        st.configure("Title.TLabel", background=BG, foreground=FG, font=("Segoe UI", 16, "bold"))
        st.configure("Sub.TLabel", background=BG, foreground=MUTED, font=("Segoe UI", 9))
        st.configure("Head.TLabel", background=PANEL, foreground=ACCENT, font=("Segoe UI", 10, "bold"))
        st.configure("Status.TLabel", background=BG, foreground=FG, font=("Segoe UI", 11, "bold"))
        st.configure("Warn.TLabel", background=BG, foreground=YELLOW, font=("Segoe UI", 9))
        for w in ("TRadiobutton", "TCheckbutton"):
            st.configure(w, background=PANEL, foreground=FG, indicatorbackground=FIELD)
            st.map(w, background=[("active", PANEL)], indicatorbackground=[("selected", ACCENT)])
        st.configure("TEntry", fieldbackground=FIELD, foreground=FG, insertcolor=FG)
        st.configure("TCombobox", fieldbackground=FIELD, background=FIELD, foreground=FG, arrowcolor=FG)
        st.map("TCombobox", fieldbackground=[("readonly", FIELD), ("disabled", PANEL)],
               foreground=[("disabled", MUTED)], selectbackground=[("readonly", FIELD)],
               selectforeground=[("readonly", FG)])
        st.configure("TButton", background=FIELD, foreground=FG, padding=(8, 3))
        st.map("TButton", background=[("active", ACCENT)])
        r.option_add("*TCombobox*Listbox.background", FIELD)
        r.option_add("*TCombobox*Listbox.foreground", FG)
        r.option_add("*TCombobox*Listbox.selectBackground", ACCENT)

    def _card(self, parent, title):
        outer = ttk.Frame(parent, style="Card.TFrame", padding=(12, 8))
        ttk.Label(outer, text=title, style="Head.TLabel").grid(row=0, column=0, columnspan=4, sticky="w", pady=(0, 4))
        outer.columnconfigure(1, weight=1)
        return outer

    def _row(self, card, row, label, widget, hint=None):
        ttk.Label(card, text=label).grid(row=row, column=0, sticky="w", padx=(0, 10), pady=3)
        widget.grid(row=row, column=1, columnspan=3 if hint is None else 1, sticky="ew", pady=3)
        if hint:
            hint.grid(row=row, column=2, columnspan=2, sticky="w", padx=(6, 0))

    # ------------------------------------------------------------ layout

    def _build(self):
        r = self.root
        top = ttk.Frame(r, padding=(14, 12, 14, 6))
        top.pack(fill="x")
        ttk.Label(top, text="WaLauncher", style="Title.TLabel").pack(side="left")
        ttk.Label(top, text="  no preview, GPU encoding, no lag", style="Sub.TLabel").pack(side="left", pady=(6, 0))

        body = ttk.Frame(r, padding=(14, 0))
        body.pack(fill="both", expand=True)
        body.columnconfigure((0, 1), weight=1, uniform="col")
        self.left = ttk.Frame(body)
        self.left.grid(row=0, column=0, sticky="new", padx=(0, 5))
        self.right = ttk.Frame(body)
        self.right.grid(row=0, column=1, sticky="new", padx=(5, 0))

        # What
        self.v_mode = tk.StringVar()
        self.c_mode = self._card(self.left, "What are we doing?")
        radios = ttk.Frame(self.c_mode, style="Card.TFrame")
        radios.grid(row=1, column=0, columnspan=4, sticky="w")
        for key, label in MODES:
            ttk.Radiobutton(radios, text=label, value=key, variable=self.v_mode,
                            command=self._layout).pack(side="left", padx=(0, 16))

        # Stream
        self.c_stream = self._card(self.left, "Stream")
        self.v_platform = tk.StringVar()
        self.cb_platform = ttk.Combobox(self.c_stream, textvariable=self.v_platform, state="readonly",
                                        values=list(E.PLATFORMS))
        self.cb_platform.bind("<<ComboboxSelected>>", self._on_platform)
        self._row(self.c_stream, 1, "Platform", self.cb_platform)
        self.v_server = tk.StringVar()
        self._row(self.c_stream, 2, "Server", ttk.Entry(self.c_stream, textvariable=self.v_server))
        self.v_key = tk.StringVar()
        self.e_key = ttk.Entry(self.c_stream, textvariable=self.v_key, show="•")
        self.b_show = ttk.Button(self.c_stream, text="Show", width=6, command=self._toggle_key)
        self._row(self.c_stream, 3, "Stream key", self.e_key, self.b_show)

        # Quality
        self.c_quality = self._card(self.left, "Quality")
        self.v_preset = tk.StringVar()
        self.cb_preset = ttk.Combobox(self.c_quality, textvariable=self.v_preset, state="readonly",
                                      values=list(E.PRESETS) + [CUSTOM])
        self.cb_preset.bind("<<ComboboxSelected>>", self._on_preset)
        self._row(self.c_quality, 1, "Preset", self.cb_preset)
        line = ttk.Frame(self.c_quality, style="Card.TFrame")
        self.v_res = tk.StringVar()
        self.v_fps = tk.StringVar()
        self.v_kbps = tk.StringVar()
        self.cb_res = ttk.Combobox(line, textvariable=self.v_res, state="readonly", width=7,
                                   values=[n for n, _ in RESOLUTIONS])
        self.cb_fps = ttk.Combobox(line, textvariable=self.v_fps, state="readonly", width=4, values=FPS_CHOICES)
        self.e_kbps = ttk.Entry(line, textvariable=self.v_kbps, width=7)
        self.cb_res.pack(side="left")
        ttk.Label(line, text=" @ ").pack(side="left")
        self.cb_fps.pack(side="left")
        ttk.Label(line, text=" fps   ").pack(side="left")
        self.e_kbps.pack(side="left")
        ttk.Label(line, text=" kbps").pack(side="left")
        for w in (self.cb_res, self.cb_fps):
            w.bind("<<ComboboxSelected>>", lambda _e: self.v_preset.set(CUSTOM))
        self.e_kbps.bind("<KeyRelease>", lambda _e: self.v_preset.set(CUSTOM))
        self._row(self.c_quality, 2, "Video", line)
        self.v_encoder = tk.StringVar()
        self.cb_encoder = ttk.Combobox(self.c_quality, textvariable=self.v_encoder, state="readonly")
        self._row(self.c_quality, 3, "Encoder", self.cb_encoder)

        # Capture
        self.c_capture = self._card(self.right, "Capture")
        self.v_monitor = tk.StringVar()
        self.cb_monitor = ttk.Combobox(self.c_capture, textvariable=self.v_monitor, state="readonly")
        self.v_mouse = tk.BooleanVar()
        self._row(self.c_capture, 1, "Screen", self.cb_monitor,
                  ttk.Checkbutton(self.c_capture, text="Show mouse", variable=self.v_mouse))
        self.v_mic = tk.StringVar()
        self.cb_mic = ttk.Combobox(self.c_capture, textvariable=self.v_mic, state="readonly")
        self._row(self.c_capture, 2, "Mic", self.cb_mic)
        self.v_desk = tk.StringVar()
        self.cb_desk = ttk.Combobox(self.c_capture, textvariable=self.v_desk, state="readonly")
        self._row(self.c_capture, 3, "Game/PC audio", self.cb_desk)
        self.l_audio_hint = ttk.Label(self.c_capture, style="Muted.TLabel", wraplength=400, text=(
            'No PC-audio device? On Windows: Sound settings > More sound settings > Recording, '
            'right-click > Show disabled devices > enable "Stereo Mix".' if E.IS_WIN else
            'Pick a ".monitor" device to capture what your PC plays.'))
        self.l_audio_hint.grid(row=4, column=0, columnspan=4, sticky="w", pady=(2, 0))

        # Recording
        self.c_record = self._card(self.right, "Recording")
        self.v_dir = tk.StringVar()
        folder = ttk.Frame(self.c_record, style="Card.TFrame")
        ttk.Entry(folder, textvariable=self.v_dir).pack(side="left", fill="x", expand=True)
        ttk.Button(folder, text="…", width=3, command=self._browse).pack(side="left", padx=(4, 0))
        ttk.Button(folder, text="Open", width=5, command=self._open_folder).pack(side="left", padx=(4, 0))
        self._row(self.c_record, 1, "Save to", folder)
        self.v_container = tk.StringVar()
        self._row(self.c_record, 2, "Format", ttk.Combobox(
            self.c_record, textvariable=self.v_container, state="readonly", width=24,
            values=["mkv (safe if PC crashes)", "mp4"]))

        # Go
        bottom = ttk.Frame(r, padding=(14, 8, 14, 12))
        bottom.pack(fill="x", side="bottom")
        self.btn = tk.Button(bottom, text="START", command=self.toggle, bg=ACCENT, fg="white",
                             activebackground="#6a4cf0", activeforeground="white", relief="flat",
                             font=("Segoe UI", 13, "bold"), cursor="hand2", pady=8, bd=0)
        self.btn.pack(fill="x")
        self.v_status = tk.StringVar(value="Getting ready…")
        self.l_status = ttk.Label(bottom, textvariable=self.v_status, style="Status.TLabel")
        self.l_status.pack(anchor="w", pady=(8, 0))
        self.v_warn = tk.StringVar()
        ttk.Label(bottom, textvariable=self.v_warn, style="Warn.TLabel", wraplength=860).pack(anchor="w")
        self.log = tk.Text(bottom, height=4, bg=PANEL, fg=MUTED, relief="flat", font=("Consolas", 8),
                           wrap="word", state="disabled", highlightthickness=0)
        self.log.pack(fill="x", pady=(6, 0))
        self.inputs = [w for card in (self.c_mode, self.c_stream, self.c_quality, self.c_capture, self.c_record)
                       for w in self._descendants(card)
                       if isinstance(w, (ttk.Entry, ttk.Combobox, ttk.Radiobutton, ttk.Checkbutton, ttk.Button))]

    def _descendants(self, w):
        for child in w.winfo_children():
            yield child
            yield from self._descendants(child)

    def _layout(self):
        mode = self.v_mode.get()
        for card in (self.c_mode, self.c_stream, self.c_quality, self.c_capture, self.c_record):
            card.pack_forget()
        cards = [self.c_mode]
        if mode in ("stream", "both"):
            cards.append(self.c_stream)
        cards += [self.c_quality, self.c_capture]
        if mode in ("record", "both"):
            cards.append(self.c_record)
        for card in cards:
            card.pack(fill="x", pady=(0, 8))
        if self.state == "idle":
            self.btn.config(text={"record": "●  START RECORDING", "stream": "●  GO LIVE",
                                  "both": "●  GO LIVE + RECORD"}[mode])

    # ------------------------------------------------------------ settings <-> ui

    def _load(self):
        s = self.s
        self.v_mode.set(s.mode if s.mode in dict(MODES) else "record")
        self.v_platform.set(s.platform if s.platform in E.PLATFORMS else "Custom")
        self.v_server.set(s.server)
        self.v_key.set(s.stream_key)
        self.v_preset.set(s.preset if s.preset in E.PRESETS else CUSTOM)
        self.v_res.set(next((n for n, h in RESOLUTIONS if h == s.height), "720p"))
        self.v_fps.set(str(s.fps))
        self.v_kbps.set(str(s.bitrate))
        self.v_mouse.set(s.draw_mouse)
        self.v_dir.set(s.out_dir)
        self.v_container.set("mp4" if s.container == "mp4" else "mkv (safe if PC crashes)")
        self._fill_encoders()
        self._fill_monitors()
        self._fill_audio([])
        self._layout()

    def _fill_encoders(self):
        best = E.ENCODER_NAMES.get(self.encoders[0], "?") if self.encoders else "checking…"
        self.enc_choices = [("auto", "Auto - " + best)] + [(n, E.ENCODER_NAMES[n]) for n in self.encoders]
        if self.s.encoder not in self.encoders and self.s.encoder != "auto":
            self.enc_choices.append((self.s.encoder, E.ENCODER_NAMES.get(self.s.encoder, self.s.encoder)))
        self.cb_encoder["values"] = [label for _, label in self.enc_choices]
        self.v_encoder.set(next(label for key, label in self.enc_choices if key == self.s.encoder)
                           if any(k == self.s.encoder for k, _ in self.enc_choices) else self.enc_choices[0][1])

    def _fill_monitors(self):
        if self.monitors:
            names = ["Screen %d%s (%dx%d)" % (i + 1, " - main" if i == 0 else "", m[2], m[3])
                     for i, m in enumerate(self.monitors)]
        else:
            names = ["Main screen (%dx%d)" % (self.root.winfo_screenwidth(), self.root.winfo_screenheight())]
        self.cb_monitor["values"] = names
        self.v_monitor.set(names[min(self.s.monitor, len(names) - 1)])

    def _fill_audio(self, devices):
        for cb, var, saved in ((self.cb_mic, self.v_mic, self.s.mic),
                               (self.cb_desk, self.v_desk, self.s.desktop_audio)):
            cb["values"] = [NONE] + devices + ([saved] if saved and saved not in devices else [])
            var.set(saved or NONE)

    def _read(self):
        s = E.Settings(**vars(self.s))
        s.mode = self.v_mode.get()
        s.platform = self.v_platform.get()
        s.server = self.v_server.get().strip()
        s.stream_key = self.v_key.get().strip()
        s.preset = self.v_preset.get()
        s.height = dict(RESOLUTIONS).get(self.v_res.get(), 720)
        s.fps = int(self.v_fps.get() or 30)
        try:
            s.bitrate = max(300, min(50000, int(self.v_kbps.get())))
        except ValueError:
            raise ValueError("Bitrate has to be a number, like 3500.")
        s.encoder = next((k for k, label in self.enc_choices if label == self.v_encoder.get()), "auto")
        s.monitor = max(0, self.cb_monitor.current())
        s.draw_mouse = self.v_mouse.get()
        s.mic = "" if self.v_mic.get() == NONE else self.v_mic.get()
        s.desktop_audio = "" if self.v_desk.get() == NONE else self.v_desk.get()
        s.out_dir = self.v_dir.get().strip() or E.default_out_dir()
        s.container = "mp4" if self.v_container.get() == "mp4" else "mkv"
        return s

    # ------------------------------------------------------------ small handlers

    def _on_platform(self, _e=None):
        url = E.PLATFORMS.get(self.v_platform.get(), "")
        self.v_server.set(url)

    def _on_preset(self, _e=None):
        p = E.PRESETS.get(self.v_preset.get())
        if p:
            h, fps, kbps = p
            self.v_res.set(next(n for n, hh in RESOLUTIONS if hh == h))
            self.v_fps.set(str(fps))
            self.v_kbps.set(str(kbps))

    def _toggle_key(self):
        hidden = self.e_key.cget("show") != ""
        self.e_key.config(show="" if hidden else "•")
        self.b_show.config(text="Hide" if hidden else "Show")

    def _browse(self):
        d = filedialog.askdirectory(initialdir=self.v_dir.get() or E.default_out_dir())
        if d:
            self.v_dir.set(d)

    def _open_folder(self, path=None):
        path = path or self.v_dir.get()
        if not os.path.isdir(path):
            return
        if E.IS_WIN:
            os.startfile(path)
        else:
            subprocess.Popen(["open" if E.IS_MAC else "xdg-open", path])

    def _set_log(self, lines):
        self.log.config(state="normal")
        self.log.delete("1.0", "end")
        self.log.insert("end", "\n".join(lines[-40:]))
        self.log.see("end")
        self.log.config(state="disabled")

    def _append_log(self, line):
        self.log.config(state="normal")
        self.log.insert("end", ("\n" if self.log.index("end-1c") != "1.0" else "") + line)
        if int(self.log.index("end-1c").split(".")[0]) > 200:
            self.log.delete("1.0", "50.0")
        self.log.see("end")
        self.log.config(state="disabled")

    # ------------------------------------------------------------ threads -> ui

    def post(self, fn, *args):
        self.q.put((fn, args))

    def _poll(self):
        try:
            while True:
                fn, args = self.q.get_nowait()
                fn(*args)
        except queue.Empty:
            pass
        self.root.after(50, self._poll)

    def _bg(self, fn, *args):
        threading.Thread(target=fn, args=args, daemon=True).start()

    # ------------------------------------------------------------ startup

    def _startup(self):
        if self.ffmpeg:
            self._detect_start()
            return
        if E.IS_WIN and messagebox.askyesno(
                "WaLauncher", "WaLauncher uses FFmpeg to capture and encode.\n\n"
                              "Download it now? (about 90 MB, one time only)"):
            self.state = "busy"
            self._lock(True)
            self.v_status.set("Downloading FFmpeg…")
            self._bg(self._download)
        else:
            self.v_status.set("FFmpeg not found")
            self.v_warn.set("Install FFmpeg (e.g. 'sudo apt install ffmpeg' or 'brew install ffmpeg') "
                            "or put ffmpeg next to WaLauncher, then restart.")

    def _download(self):
        def progress(done, total):
            pct = " %d%%" % (done * 100 // total) if total else ""
            self.post(self.v_status.set, "Downloading FFmpeg…%s (%d MB)" % (pct, done >> 20))
        try:
            path = E.download_ffmpeg(progress)
        except Exception as e:
            self.post(self._download_failed, str(e))
            return
        self.post(self._download_done, path)

    def _download_failed(self, err):
        self.state = "idle"
        self._lock(False)
        self.v_status.set("FFmpeg download failed")
        self.v_warn.set(err + "\nGrab ffmpeg.exe manually from gyan.dev and put it next to WaLauncher.")

    def _download_done(self, path):
        self.ffmpeg = path
        self.state = "idle"
        self._lock(False)
        self._detect_start()

    def _detect_start(self):
        self.v_status.set("Checking your GPU…")
        self._bg(self._detect)

    def _detect(self):
        encoders = E.detect_encoders(self.ffmpeg)
        capture = E.pick_capture(self.ffmpeg, self.s.capture)
        audio = E.list_audio_devices(self.ffmpeg)
        self.post(self._detect_done, encoders, capture, audio)

    def _detect_done(self, encoders, capture, audio):
        self.encoders = encoders
        self.capture = capture
        self._fill_encoders()
        self._fill_audio(audio)
        if not encoders:
            self.v_status.set("No working video encoder found")
            self.v_warn.set("Your FFmpeg build has no H.264 encoder. Get a full build (gyan.dev on Windows).")
            return
        self.v_status.set("Ready - using %s" % E.ENCODER_NAMES[encoders[0]])
        self.l_status.config(foreground=GREEN)
        if encoders[0] == "libx264":
            self.v_warn.set("No GPU encoder found, so the CPU does the work. "
                            "Use the Potato or Low preset to keep games smooth.")
        else:
            self.v_warn.set("")

    # ------------------------------------------------------------ start / stop

    def _lock(self, locked):
        for w in self.inputs:
            try:
                if isinstance(w, ttk.Combobox):
                    w.config(state="disabled" if locked else "readonly")
                else:
                    w.config(state="disabled" if locked else "normal")
            except tk.TclError:
                pass

    def toggle(self):
        if self.state == "idle":
            self.start()
        elif self.state == "running":
            self.stop()

    def start(self):
        if not self.ffmpeg:
            self._startup()
            return
        if not self.encoders:
            messagebox.showinfo("WaLauncher", "Still checking your hardware, give it a sec.")
            return
        try:
            s = self._read()
        except ValueError as e:
            messagebox.showerror("WaLauncher", str(e))
            return
        if s.mode != "record" and not (s.server and s.stream_key):
            messagebox.showerror("WaLauncher", "Paste your server URL and stream key first.\n\n"
                                               "Twitch: Creator Dashboard > Settings > Stream\n"
                                               "YouTube: Studio > Go live > Stream")
            return
        try:
            s.save()
        except OSError:
            pass
        self.s = s
        encoder = s.encoder if s.encoder != "auto" else self.encoders[0]
        capture = self.capture or E.pick_capture(self.ffmpeg, s.capture)
        self.run = {"settings": s, "encoder": encoder, "reconnects": 0,
                    "fallback": s.capture == "auto" and capture == "ddagrab"}
        self._set_log([])
        self.v_warn.set("")
        self._launch(capture)

    def _launch(self, capture):
        s, encoder = self.run["settings"], self.run["encoder"]
        rect = self.monitors[s.monitor] if s.monitor < len(self.monitors) else None
        try:
            argv, path = E.build_command(self.ffmpeg, s, encoder, capture, rect)
        except OSError as e:
            self._finish("Can't use that folder: %s" % e, error=True)
            return
        self.run.update(capture=capture, path=path, stream_dead=False)
        self.session = sess = E.Session(
            argv,
            on_stats=lambda st: self.post(self._on_stats, sess, st),
            on_log=lambda line: self.post(self._on_log, sess, line),
            on_exit=lambda rc, log: self.post(self._on_exit, sess, rc, log))
        try:
            sess.start()
        except OSError as e:
            self._finish("Couldn't start FFmpeg: %s" % e, error=True)
            return
        self.state = "running"
        self.slow_ticks = 0
        self._lock(True)
        self.btn.config(text="■  STOP", bg=RED, activebackground="#e04352")
        self.v_status.set("Starting…")
        self.l_status.config(foreground=RED)

    def stop(self):
        if not self.session:
            return
        if not self.session.running:  # between reconnect attempts
            self._finish("Stream ended")
            return
        self.state = "stopping"
        self.btn.config(text="Stopping…", state="disabled")
        self.v_status.set("Finishing up the file…")
        self._bg(self.session.stop)

    def _on_stats(self, sess, st):
        if sess is not self.session or self.state != "running":
            return
        self.run["stats"] = st
        if self.run["reconnects"] and st["frame"] > 0 and self.v_warn.get().startswith("Stream dropped"):
            self.v_warn.set("")
        if st["speed"] is not None and st["frame"] > self.run["settings"].fps * 3:
            self.slow_ticks = self.slow_ticks + 1 if st["speed"] < 0.9 else 0
            if self.slow_ticks >= 6:
                self.v_warn.set("Your laptop can't keep up. Stop and pick a lower preset "
                                "(fewer fps / lower resolution).")

    def _on_log(self, sess, line):
        if sess is not self.session:
            return
        self._append_log(line)
        if "Slave muxer #0 failed" in line or ("Slave '" in line and "error opening" in line):
            self.run["stream_dead"] = True
            self.v_warn.set("Stream connection failed - still recording. Check your key / internet.")

    def _on_exit(self, sess, rc, log):
        if sess is not self.session:
            return
        run = self.run
        user_stop = sess.stopping
        elapsed = sess.elapsed()
        if not user_stop and run.get("fallback") and elapsed < 8 and E.looks_like_capture_error(log):
            run["fallback"] = False
            self.v_warn.set("Fast capture not supported here, switched to compatibility capture.")
            self._launch("gdigrab")
            return
        if not user_stop and run["settings"].mode == "stream" and (elapsed > 15 or run["reconnects"]):
            if elapsed > 60:  # it was stable for a while, so start counting fresh
                run["reconnects"] = 0
            if run["reconnects"] < MAX_RECONNECTS:
                run["reconnects"] += 1
                self.v_warn.set("Stream dropped - reconnecting (%d/%d)…" % (run["reconnects"], MAX_RECONNECTS))
                self.root.after(5000, lambda: self._launch(run["capture"])
                                if self.run is run and self.state == "running" else None)
                return
        if user_stop or rc == 0:
            msg = "Saved: %s" % os.path.basename(run["path"]) if run.get("path") else "Stream ended"
            self._finish(msg)
        else:
            err = next((ln for ln in reversed(log) if ln.strip()), "FFmpeg exited with code %d" % rc)
            self._finish("Stopped: something went wrong", error=True, detail=err)

    def _finish(self, msg, error=False, detail=""):
        self.state = "idle"
        self.session = None
        self._lock(False)
        self.btn.config(state="normal", bg=ACCENT, activebackground="#6a4cf0")
        self._layout()
        self.v_status.set(msg)
        self.l_status.config(foreground=RED if error else GREEN)
        if detail:
            self.v_warn.set(detail[:300])

    def _tick(self):
        if self.state == "running" and self.session:
            t = int(self.session.elapsed())
            clock = "%02d:%02d:%02d" % (t // 3600, t // 60 % 60, t % 60)
            mode = self.run["settings"].mode
            tag = {"record": "● REC", "stream": "● LIVE", "both": "● LIVE + REC"}[mode]
            if self.run.get("stream_dead"):
                tag = "● REC (stream failed)"
            st = self.run.get("stats")
            parts = [tag, clock]
            if st:
                parts.append("%.0f fps" % st["fps"])
                if st["kbps"]:
                    parts.append("%.0f kbps" % st["kbps"])
                if st["drop"]:
                    parts.append("%d dropped" % st["drop"])
            self.v_status.set("   ".join(parts))
        self.root.after(1000, self._tick)

    def on_close(self):
        if self.state in ("running", "stopping") and self.session:
            if not messagebox.askyesno("WaLauncher", "Stop and quit?"):
                return
            sess = self.session
            self.session = None
            self.v_status.set("Finishing up the file…")
            self.root.update()
            sess.stop()
        try:
            self._read().save()
        except (OSError, ValueError):
            pass
        self.root.destroy()


def main():
    E.enable_dpi_awareness()
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
