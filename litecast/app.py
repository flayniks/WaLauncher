"""LiteCast window: the HTML UI in a native webview (Edge WebView2 on Windows)."""

import json
import os
import sys
import threading
import time

from . import engine as E
from .api import Api

UI_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ui")
WEBVIEW2_URL = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"


def _fatal(msg):
    if E.IS_WIN:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, msg, E.APP_NAME, 0x10)
    else:
        print(msg, file=sys.stderr)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    selftest_out = argv[argv.index("--selftest") + 1] if "--selftest" in argv else None
    E.enable_dpi_awareness()
    try:
        import webview
    except Exception as e:
        _fatal("Couldn't load the window library: %s" % e)
        return 1

    api = Api()
    api._selftest = bool(selftest_out)
    window = webview.create_window(E.APP_NAME, url=os.path.join(UI_DIR, "index.html"), js_api=api,
                                   width=1180, height=780, min_size=(940, 660), background_color="#0b0b10")
    api._window = window
    window.events.closing += api.shutdown

    def selftest_watch():
        deadline = time.time() + 150
        while time.time() < deadline and api._selftest_result is None:
            time.sleep(0.5)
        res = api._selftest_result or {"ok": False, "error": "UI never reported back"}
        with open(selftest_out, "w", encoding="utf-8") as f:
            json.dump(res, f, indent=2)
        window.destroy()

    try:
        webview.start(selftest_watch if selftest_out else None, gui="edgechromium" if E.IS_WIN else None,
                      http_server=True, private_mode=True)
    except Exception as e:
        if selftest_out:
            with open(selftest_out, "w", encoding="utf-8") as f:
                json.dump({"ok": False, "error": "webview failed: %s" % e}, f)
        _fatal("LiteCast needs the Microsoft Edge WebView2 Runtime (free).\n\nGet it here:\n%s\n\n(%s)"
               % (WEBVIEW2_URL, e))
        if E.IS_WIN:
            import webbrowser
            webbrowser.open(WEBVIEW2_URL)
        return 1
    api.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
