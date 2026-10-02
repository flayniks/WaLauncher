"""Windows helpers: list open apps and screens, and grab small previews/icons of them.

Pure ctypes, no extra installs. On other platforms everything returns empty results.
"""

import base64
import os
import struct
import sys
import zlib

IS_WIN = sys.platform.startswith("win")


# ---------------------------------------------------------------- tiny PNG encoder

def png_bytes(width, height, pixels, channels):
    """pixels: tightly packed RGB (channels=3) or RGBA (channels=4), top row first."""
    stride = width * channels
    raw = b"".join(b"\x00" + bytes(pixels[y * stride:(y + 1) * stride]) for y in range(height))

    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6 if channels == 4 else 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")


def data_url(png):
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def bgra_to_rgb(buf):
    n = len(buf) // 4
    rgb = bytearray(n * 3)
    rgb[0::3] = buf[2::4]
    rgb[1::3] = buf[1::4]
    rgb[2::3] = buf[0::4]
    return rgb


def bgra_to_rgba(buf):
    out = bytearray(buf)
    out[0::4] = buf[2::4]
    out[2::4] = buf[0::4]
    return out


def fit(w, h, max_w, max_h):
    scale = min(max_w / float(w), max_h / float(h), 1.0)
    return max(1, int(w * scale)), max(1, int(h * scale))


# ---------------------------------------------------------------- Win32 plumbing

if IS_WIN:
    import ctypes
    from ctypes import wintypes as W

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32")
    kernel32 = ctypes.WinDLL("kernel32")
    dwmapi = ctypes.WinDLL("dwmapi")
    shell32 = ctypes.WinDLL("shell32")

    WNDENUMPROC = ctypes.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
    MONITORENUMPROC = ctypes.WINFUNCTYPE(W.BOOL, W.HANDLE, W.HDC, ctypes.POINTER(W.RECT), W.LPARAM)

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [("biSize", W.DWORD), ("biWidth", W.LONG), ("biHeight", W.LONG), ("biPlanes", W.WORD),
                    ("biBitCount", W.WORD), ("biCompression", W.DWORD), ("biSizeImage", W.DWORD),
                    ("biXPelsPerMeter", W.LONG), ("biYPelsPerMeter", W.LONG), ("biClrUsed", W.DWORD),
                    ("biClrImportant", W.DWORD)]

    class BITMAPINFO(ctypes.Structure):
        _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", W.DWORD * 3)]

    class MONITORINFO(ctypes.Structure):
        _fields_ = [("cbSize", W.DWORD), ("rcMonitor", W.RECT), ("rcWork", W.RECT), ("dwFlags", W.DWORD)]

    class SHFILEINFOW(ctypes.Structure):
        _fields_ = [("hIcon", W.HICON), ("iIcon", ctypes.c_int), ("dwAttributes", W.DWORD),
                    ("szDisplayName", W.WCHAR * 260), ("szTypeName", W.WCHAR * 80)]

    def _sig(fn, args, res=W.BOOL):
        fn.argtypes, fn.restype = args, res

    _sig(user32.EnumWindows, [WNDENUMPROC, W.LPARAM])
    _sig(user32.EnumDisplayMonitors, [W.HDC, ctypes.POINTER(W.RECT), MONITORENUMPROC, W.LPARAM])
    _sig(user32.GetMonitorInfoW, [W.HANDLE, ctypes.POINTER(MONITORINFO)])
    _sig(user32.IsWindow, [W.HWND])
    _sig(user32.IsWindowVisible, [W.HWND])
    _sig(user32.IsIconic, [W.HWND])
    _sig(user32.GetWindow, [W.HWND, W.UINT], W.HWND)
    _sig(user32.GetWindowLongPtrW, [W.HWND, ctypes.c_int], ctypes.c_ssize_t)
    _sig(user32.GetWindowTextLengthW, [W.HWND], ctypes.c_int)
    _sig(user32.GetWindowTextW, [W.HWND, W.LPWSTR, ctypes.c_int], ctypes.c_int)
    _sig(user32.GetClassNameW, [W.HWND, W.LPWSTR, ctypes.c_int], ctypes.c_int)
    _sig(user32.GetWindowThreadProcessId, [W.HWND, ctypes.POINTER(W.DWORD)], W.DWORD)
    _sig(user32.GetClientRect, [W.HWND, ctypes.POINTER(W.RECT)])
    _sig(user32.PrintWindow, [W.HWND, W.HDC, W.UINT])
    _sig(user32.GetDC, [W.HWND], W.HDC)
    _sig(user32.ReleaseDC, [W.HWND, W.HDC], ctypes.c_int)
    _sig(user32.DrawIconEx, [W.HDC, ctypes.c_int, ctypes.c_int, W.HICON, ctypes.c_int, ctypes.c_int,
                             W.UINT, W.HBRUSH, W.UINT])
    _sig(user32.DestroyIcon, [W.HICON])
    _sig(dwmapi.DwmGetWindowAttribute, [W.HWND, W.DWORD, ctypes.c_void_p, W.DWORD], ctypes.c_long)
    _sig(kernel32.OpenProcess, [W.DWORD, W.BOOL, W.DWORD], W.HANDLE)
    _sig(kernel32.QueryFullProcessImageNameW, [W.HANDLE, W.DWORD, W.LPWSTR, ctypes.POINTER(W.DWORD)])
    _sig(kernel32.CloseHandle, [W.HANDLE])
    _sig(gdi32.CreateCompatibleDC, [W.HDC], W.HDC)
    _sig(gdi32.CreateCompatibleBitmap, [W.HDC, ctypes.c_int, ctypes.c_int], W.HBITMAP)
    _sig(gdi32.CreateDIBSection, [W.HDC, ctypes.POINTER(BITMAPINFO), W.UINT, ctypes.POINTER(ctypes.c_void_p),
                                  W.HANDLE, W.DWORD], W.HBITMAP)
    _sig(gdi32.SelectObject, [W.HDC, W.HGDIOBJ], W.HGDIOBJ)
    _sig(gdi32.DeleteObject, [W.HGDIOBJ])
    _sig(gdi32.DeleteDC, [W.HDC])
    _sig(gdi32.StretchBlt, [W.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, W.HDC,
                            ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, W.DWORD])
    _sig(gdi32.SetStretchBltMode, [W.HDC, ctypes.c_int], ctypes.c_int)
    _sig(gdi32.SetBrushOrgEx, [W.HDC, ctypes.c_int, ctypes.c_int, ctypes.c_void_p])
    _sig(gdi32.GdiFlush, [])
    _sig(shell32.SHGetFileInfoW, [W.LPCWSTR, W.DWORD, ctypes.POINTER(SHFILEINFOW), W.UINT, W.UINT], ctypes.c_size_t)

    GW_OWNER = 4
    GWL_EXSTYLE = -20
    WS_EX_TOOLWINDOW = 0x00000080
    DWMWA_CLOAKED = 14
    PW_CLIENTONLY_FULLCONTENT = 3
    SRCCOPY = 0x00CC0020
    HALFTONE = 4
    DI_MASK, DI_NORMAL = 1, 3
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

SKIP_CLASSES = {"Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "Windows.UI.Core.CoreWindow"}
SKIP_EXES = {"textinputhost.exe", "searchhost.exe", "startmenuexperiencehost.exe",
             "shellexperiencehost.exe", "lockapp.exe", "searchapp.exe"}


def _window_text(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def _class_name(hwnd):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def _exe_path(pid):
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""
    try:
        size = W.DWORD(1024)
        buf = ctypes.create_unicode_buffer(size.value)
        return buf.value if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)) else ""
    finally:
        kernel32.CloseHandle(h)


# ---------------------------------------------------------------- public API

def list_windows(exclude_pid=None):
    """Apps you could capture: [{hwnd, title, exe, path, minimized}] in Z-order (top first)."""
    if not IS_WIN:
        return []
    exclude_pid = os.getpid() if exclude_pid is None else exclude_pid
    found = []

    def cb(hwnd, _lparam):
        try:
            if not hwnd or not user32.IsWindowVisible(hwnd) or user32.GetWindow(hwnd, GW_OWNER):
                return True
            if user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOOLWINDOW:
                return True
            title = _window_text(hwnd)
            if not title or _class_name(hwnd) in SKIP_CLASSES:
                return True
            cloaked = W.DWORD(0)
            if dwmapi.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ctypes.byref(cloaked),
                                            ctypes.sizeof(cloaked)) == 0 and cloaked.value:
                return True
            pid = W.DWORD(0)
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value == exclude_pid:
                return True
            path = _exe_path(pid.value)
            exe = os.path.basename(path)
            if exe.lower() in SKIP_EXES:
                return True
            found.append({"hwnd": int(hwnd), "title": title, "exe": exe, "path": path,
                          "minimized": bool(user32.IsIconic(hwnd))})
        except Exception:
            pass
        return True

    proc = WNDENUMPROC(cb)
    user32.EnumWindows(proc, 0)
    return found


def window_alive(hwnd):
    return bool(IS_WIN and hwnd and user32.IsWindow(hwnd))


def find_window(hwnd=0, exe="", title=""):
    """Re-find the app picked last time (window handles change when an app restarts)."""
    wins = list_windows()
    for w in wins:
        if hwnd and w["hwnd"] == hwnd and (not exe or w["exe"].lower() == exe.lower()):
            return w
    same_exe = [w for w in wins if exe and w["exe"].lower() == exe.lower()]
    for w in same_exe:
        if w["title"] == title:
            return w
    return same_exe[0] if same_exe else None


def list_monitors():
    """[{x, y, w, h, primary, handle}] with the primary monitor first."""
    if not IS_WIN:
        return []
    mons = []

    def cb(hmon, _hdc, _rect, _lparam):
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        if user32.GetMonitorInfoW(hmon, ctypes.byref(info)):
            r = info.rcMonitor
            mons.append({"x": r.left, "y": r.top, "w": r.right - r.left, "h": r.bottom - r.top,
                         "primary": bool(info.dwFlags & 1), "handle": int(hmon or 0)})
        return True

    try:
        proc = MONITORENUMPROC(cb)
        user32.EnumDisplayMonitors(None, None, proc, 0)
    except Exception:
        return []
    mons.sort(key=lambda m: not m["primary"])
    return mons


def _dib(hdc, w, h):
    bmi = BITMAPINFO()
    hdr = bmi.bmiHeader
    hdr.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    hdr.biWidth, hdr.biHeight = w, -h  # negative = top-down rows
    hdr.biPlanes, hdr.biBitCount = 1, 32
    bits = ctypes.c_void_p()
    bmp = gdi32.CreateDIBSection(hdc, ctypes.byref(bmi), 0, ctypes.byref(bits), None, 0)
    return bmp, bits


def _shrink(src_dc, sx, sy, sw, sh, tw, th):
    """StretchBlt a region of src_dc into a tw x th BGRA buffer."""
    mem = gdi32.CreateCompatibleDC(src_dc)
    bmp, bits = _dib(src_dc, tw, th)
    old = gdi32.SelectObject(mem, bmp)
    try:
        gdi32.SetStretchBltMode(mem, HALFTONE)
        gdi32.SetBrushOrgEx(mem, 0, 0, None)
        gdi32.StretchBlt(mem, 0, 0, tw, th, src_dc, sx, sy, sw, sh, SRCCOPY)
        gdi32.GdiFlush()
        return ctypes.string_at(bits, tw * th * 4)
    finally:
        gdi32.SelectObject(mem, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem)


def _looks_blank(bgra):
    sample = bgra[::97 * 4]
    return max(sample) < 10 if sample else True


def window_thumb(hwnd, max_w=320, max_h=180):
    """PNG data URL preview of an app window, or None if it can't be grabbed."""
    if not IS_WIN:
        return None
    rc = W.RECT()
    if not user32.GetClientRect(hwnd, ctypes.byref(rc)) or rc.right <= 0 or rc.bottom <= 0:
        return None
    w, h = rc.right, rc.bottom
    screen = user32.GetDC(None)
    full = gdi32.CreateCompatibleDC(screen)
    bmp = gdi32.CreateCompatibleBitmap(screen, w, h)
    old = gdi32.SelectObject(full, bmp)
    try:
        if not user32.PrintWindow(hwnd, full, PW_CLIENTONLY_FULLCONTENT):
            return None
        tw, th = fit(w, h, max_w, max_h)
        bgra = _shrink(full, 0, 0, w, h, tw, th)
    finally:
        gdi32.SelectObject(full, old)
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(full)
        user32.ReleaseDC(None, screen)
    if _looks_blank(bgra):
        return None
    return data_url(png_bytes(tw, th, bgra_to_rgb(bgra), 3))


def screen_thumb(mon, max_w=320, max_h=180):
    if not IS_WIN:
        return None
    screen = user32.GetDC(None)
    try:
        tw, th = fit(mon["w"], mon["h"], max_w, max_h)
        bgra = _shrink(screen, mon["x"], mon["y"], mon["w"], mon["h"], tw, th)
    finally:
        user32.ReleaseDC(None, screen)
    return data_url(png_bytes(tw, th, bgra_to_rgb(bgra), 3))


def exe_icon(path, size=32):
    """PNG data URL of an exe's icon, or None."""
    if not IS_WIN or not path:
        return None
    info = SHFILEINFOW()
    if not shell32.SHGetFileInfoW(path, 0, ctypes.byref(info), ctypes.sizeof(info), 0x100) or not info.hIcon:
        return None
    screen = user32.GetDC(None)
    mem = gdi32.CreateCompatibleDC(screen)
    try:
        def draw(flags):
            bmp, bits = _dib(screen, size, size)
            old = gdi32.SelectObject(mem, bmp)
            user32.DrawIconEx(mem, 0, 0, info.hIcon, size, size, 0, None, flags)
            gdi32.GdiFlush()
            data = ctypes.string_at(bits, size * size * 4)
            gdi32.SelectObject(mem, old)
            gdi32.DeleteObject(bmp)
            return data

        rgba = bgra_to_rgba(draw(DI_NORMAL))
        if not any(rgba[3::4]):  # old-style icon without alpha: use its mask
            mask = draw(DI_MASK)
            rgba[3::4] = bytes(0 if m else 255 for m in mask[0::4])
        return data_url(png_bytes(size, size, rgba, 4))
    finally:
        gdi32.DeleteDC(mem)
        user32.ReleaseDC(None, screen)
        user32.DestroyIcon(info.hIcon)
