"""Log in with Twitch / YouTube / Kick and grab the stream key automatically.

Twitch uses the device-code flow (you just click "Authorize" on twitch.tv).
YouTube and Kick use the normal browser flow with a tiny local web server
catching the redirect. Tokens are stored next to settings.json.
"""

import base64
import datetime as _dt
import hashlib
import http.server
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

USER_AGENT = "LiteCast"


class AuthError(Exception):
    pass


class Unauthorized(AuthError):
    """The access token was rejected (expired/revoked) - worth one refresh + retry."""


def _fail(st, msg):
    raise (Unauthorized if st == 401 else AuthError)(msg)


def http_json(method, url, form=None, body=None, headers=None, timeout=20):
    """Tiny JSON HTTP client. Returns (status, parsed json or {})."""
    data = None
    h = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        h["Content-Type"] = "application/x-www-form-urlencoded"
    elif body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    except (urllib.error.URLError, OSError) as e:
        raise AuthError("Can't reach %s - check your internet. (%s)" % (urllib.parse.urlparse(url).netloc, e))
    try:
        parsed = json.loads(raw) if raw else {}
    except ValueError:
        parsed = {"raw": raw[:300].decode("utf-8", "replace")}
    return status, parsed


def pkce_pair():
    verifier = secrets.token_urlsafe(64)[:96]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


DONE_PAGE = """<!doctype html><meta charset=utf-8><title>LiteCast</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#0e0e13;color:#ececf4;
font:16px system-ui,Segoe UI,sans-serif"><div style="text-align:center">
<div style="font-size:44px">%s</div><h2 style="margin:.4em 0">%s</h2>
<p style="color:#9a9ab0">You can close this tab and go back to LiteCast.</p></div>"""


class LoopbackCatcher:
    """One-shot local web server that receives the ?code= redirect."""

    def __init__(self, port=0):
        catcher = self
        self.result = None

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                if "code" not in q and "error" not in q:
                    self.send_response(404)
                    self.end_headers()
                    return
                catcher.result = {k: v[0] for k, v in q.items()}
                ok = "code" in q
                page = DONE_PAGE % ("&#x2705;" if ok else "&#x274C;", "You're connected!" if ok else "Login cancelled")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(page.encode())

            def log_message(self, *a):
                pass

        try:
            self.server = http.server.HTTPServer(("127.0.0.1", port), Handler)
        except OSError as e:
            raise AuthError("Port %d is busy, close other apps using it and try again. (%s)" % (port, e))
        self.server.timeout = 0.5
        self.port = self.server.server_address[1]

    def wait(self, state, cancel, timeout=300):
        deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < deadline and not cancel.is_set():
                self.server.handle_request()
                if self.result is not None:
                    if self.result.get("state") != state:
                        raise AuthError("Login response didn't match, try again.")
                    if "error" in self.result:
                        raise AuthError("Login cancelled (%s)." % self.result["error"])
                    return self.result["code"]
        finally:
            self.server.server_close()
        raise AuthError("Login cancelled." if cancel.is_set() else "Login timed out, try again.")


def _expiry(tok):
    tok = dict(tok)
    tok["expires_at"] = time.time() + float(tok.get("expires_in") or 3600) - 60
    return tok


def _err(js, fallback):
    if isinstance(js, dict):
        e = js.get("error")
        if isinstance(e, dict):
            return e.get("message") or fallback
        return js.get("message") or js.get("error_description") or e or fallback
    return fallback


# ---------------------------------------------------------------- platforms

class Twitch:
    id, name = "twitch", "Twitch"
    SCOPES = "channel:read:stream_key channel:manage:broadcast"
    INGEST = "rtmp://live.twitch.tv/app"

    def __init__(self, creds, http):
        self.cid, self.http = creds.get("TWITCH_CLIENT_ID"), http

    def configured(self):
        return bool(self.cid)

    def login(self, progress, cancel, open_url):
        st, js = self.http("POST", "https://id.twitch.tv/oauth2/device", form={"client_id": self.cid, "scopes": self.SCOPES})
        if st != 200:
            raise AuthError("Twitch said: %s" % _err(js, st))
        progress({"stage": "code", "code": js["user_code"], "url": js["verification_uri"]})
        open_url(js["verification_uri"])
        interval = int(js.get("interval") or 5)
        deadline = time.monotonic() + int(js.get("expires_in") or 1800)
        while time.monotonic() < deadline:
            if cancel.wait(interval):
                raise AuthError("Login cancelled.")
            st, tok = self.http("POST", "https://id.twitch.tv/oauth2/token", form={
                "client_id": self.cid, "scopes": self.SCOPES, "device_code": js["device_code"],
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code"})
            if st == 200:
                return _expiry(tok)
            msg = _err(tok, "")
            if "pending" in msg:
                continue
            if "slow_down" in msg:
                interval += 5
                continue
            raise AuthError("Twitch login failed: %s" % (msg or st))
        raise AuthError("Twitch login timed out, try again.")

    def refresh(self, tok):
        st, js = self.http("POST", "https://id.twitch.tv/oauth2/token", form={
            "client_id": self.cid, "grant_type": "refresh_token", "refresh_token": tok.get("refresh_token", "")})
        if st != 200:
            raise AuthError("Twitch login expired, log in again.")
        return _expiry(js)

    def _h(self, tok):
        return {"Client-Id": self.cid, "Authorization": "Bearer " + tok["access_token"]}

    def profile(self, tok):
        st, js = self.http("GET", "https://api.twitch.tv/helix/users", headers=self._h(tok))
        if st != 200 or not js.get("data"):
            _fail(st, "Couldn't read your Twitch profile: %s" % _err(js, st))
        u = js["data"][0]
        return {"id": u["id"], "name": u.get("display_name") or u.get("login"), "avatar": u.get("profile_image_url", "")}

    def go_live(self, tok, prof, title, privacy):
        warn = ""
        if title:
            st, js = self.http("PATCH", "https://api.twitch.tv/helix/channels?broadcaster_id=" + prof["id"],
                               body={"title": title[:140]}, headers=self._h(tok))
            if st not in (200, 204):
                warn = "Couldn't set the title (%s)." % _err(js, st)
        st, js = self.http("GET", "https://api.twitch.tv/helix/streams/key?broadcaster_id=" + prof["id"], headers=self._h(tok))
        if st != 200 or not js.get("data"):
            _fail(st, "Couldn't get your Twitch stream key: %s" % _err(js, st))
        return self.INGEST, js["data"][0]["stream_key"], warn


class YouTube:
    id, name = "youtube", "YouTube"
    SCOPE = "https://www.googleapis.com/auth/youtube"
    API = "https://www.googleapis.com/youtube/v3/"
    STREAM_NAME = "LiteCast"

    def __init__(self, creds, http):
        self.cid, self.secret, self.http = creds.get("YOUTUBE_CLIENT_ID"), creds.get("YOUTUBE_CLIENT_SECRET"), http

    def configured(self):
        return bool(self.cid and self.secret)

    def login(self, progress, cancel, open_url):
        catcher = LoopbackCatcher(0)
        redirect = "http://127.0.0.1:%d/" % catcher.port
        verifier, challenge = pkce_pair()
        state = secrets.token_urlsafe(16)
        url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
            "client_id": self.cid, "redirect_uri": redirect, "response_type": "code", "scope": self.SCOPE,
            "code_challenge": challenge, "code_challenge_method": "S256", "state": state,
            "access_type": "offline", "prompt": "consent"})
        progress({"stage": "browser", "url": url})
        open_url(url)
        code = catcher.wait(state, cancel)
        st, tok = self.http("POST", "https://oauth2.googleapis.com/token", form={
            "client_id": self.cid, "client_secret": self.secret, "code": code, "code_verifier": verifier,
            "grant_type": "authorization_code", "redirect_uri": redirect})
        if st != 200:
            raise AuthError("Google login failed: %s" % _err(tok, st))
        return _expiry(tok)

    def refresh(self, tok):
        st, js = self.http("POST", "https://oauth2.googleapis.com/token", form={
            "client_id": self.cid, "client_secret": self.secret, "grant_type": "refresh_token",
            "refresh_token": tok.get("refresh_token", "")})
        if st != 200:
            raise AuthError("YouTube login expired, log in again.")
        js.setdefault("refresh_token", tok.get("refresh_token"))
        return _expiry(js)

    def _h(self, tok):
        return {"Authorization": "Bearer " + tok["access_token"]}

    def _call(self, method, path, tok, body=None):
        st, js = self.http(method, self.API + path, body=body, headers=self._h(tok))
        if st >= 300:
            reason = ""
            try:
                reason = js["error"]["errors"][0]["reason"]
            except (KeyError, IndexError, TypeError):
                pass
            if reason in ("liveStreamingNotEnabled", "livePermissionBlocked"):
                raise AuthError("Live streaming isn't turned on for this YouTube channel yet. Turn it on at "
                                "youtube.com/features (the first time can take up to 24 hours).")
            _fail(st, "YouTube said: %s" % _err(js, st))
        return js

    def profile(self, tok):
        js = self._call("GET", "channels?part=snippet&mine=true", tok)
        if not js.get("items"):
            raise AuthError("This Google account doesn't have a YouTube channel yet.")
        ch = js["items"][0]
        thumbs = ch["snippet"].get("thumbnails", {})
        return {"id": ch["id"], "name": ch["snippet"]["title"],
                "avatar": (thumbs.get("default") or thumbs.get("medium") or {}).get("url", "")}

    def go_live(self, tok, prof, title, privacy):
        streams = self._call("GET", "liveStreams?part=id,snippet,cdn&mine=true&maxResults=50", tok).get("items", [])
        stream = next((x for x in streams if x.get("snippet", {}).get("title") == self.STREAM_NAME
                       and x.get("cdn", {}).get("ingestionType") == "rtmp"), None)
        if not stream:
            stream = self._call("POST", "liveStreams?part=id,snippet,cdn,contentDetails", tok, body={
                "snippet": {"title": self.STREAM_NAME},
                "cdn": {"frameRate": "variable", "ingestionType": "rtmp", "resolution": "variable"},
                "contentDetails": {"isReusable": True}})
        now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        bc = self._call("POST", "liveBroadcasts?part=id,snippet,status,contentDetails", tok, body={
            "snippet": {"title": (title or "Live with LiteCast")[:100], "scheduledStartTime": now},
            "status": {"privacyStatus": privacy if privacy in ("public", "unlisted", "private") else "public",
                       "selfDeclaredMadeForKids": False},
            "contentDetails": {"enableAutoStart": True, "enableAutoStop": True, "latencyPreference": "low"}})
        self._call("POST", "liveBroadcasts/bind?id=%s&part=id,contentDetails&streamId=%s" % (bc["id"], stream["id"]), tok)
        info = stream["cdn"]["ingestionInfo"]
        return info["ingestionAddress"], info["streamName"], ""


class Kick:
    id, name = "kick", "Kick"
    SCOPES = "user:read channel:read channel:write streamkey:read"

    def __init__(self, creds, http):
        self.cid, self.secret, self.http = creds.get("KICK_CLIENT_ID"), creds.get("KICK_CLIENT_SECRET"), http
        self.port = int(creds.get("KICK_REDIRECT_PORT") or 17563)

    def configured(self):
        return bool(self.cid and self.secret)

    def login(self, progress, cancel, open_url):
        catcher = LoopbackCatcher(self.port)
        redirect = "http://localhost:%d/callback" % self.port
        verifier, challenge = pkce_pair()
        state = secrets.token_urlsafe(16)
        url = "https://id.kick.com/oauth/authorize?" + urllib.parse.urlencode({
            "response_type": "code", "client_id": self.cid, "redirect_uri": redirect, "scope": self.SCOPES,
            "code_challenge": challenge, "code_challenge_method": "S256", "state": state})
        progress({"stage": "browser", "url": url})
        open_url(url)
        code = catcher.wait(state, cancel)
        st, tok = self.http("POST", "https://id.kick.com/oauth/token", form={
            "grant_type": "authorization_code", "client_id": self.cid, "client_secret": self.secret,
            "redirect_uri": redirect, "code_verifier": verifier, "code": code})
        if st != 200:
            raise AuthError("Kick login failed: %s" % _err(tok, st))
        return _expiry(tok)

    def refresh(self, tok):
        st, js = self.http("POST", "https://id.kick.com/oauth/token", form={
            "grant_type": "refresh_token", "client_id": self.cid, "client_secret": self.secret,
            "refresh_token": tok.get("refresh_token", "")})
        if st != 200:
            raise AuthError("Kick login expired, log in again.")
        return _expiry(js)

    def _h(self, tok):
        return {"Authorization": "Bearer " + tok["access_token"]}

    def profile(self, tok):
        st, js = self.http("GET", "https://api.kick.com/public/v1/users", headers=self._h(tok))
        if st != 200 or not js.get("data"):
            _fail(st, "Couldn't read your Kick profile: %s" % _err(js, st))
        u = js["data"][0]
        return {"id": str(u.get("user_id", "")), "name": u.get("name", "Kick user"), "avatar": u.get("profile_picture", "")}

    def go_live(self, tok, prof, title, privacy):
        warn = ""
        if title:
            st, js = self.http("PATCH", "https://api.kick.com/public/v1/channels", body={"stream_title": title[:100]},
                               headers=self._h(tok))
            if st not in (200, 204):
                warn = "Couldn't set the title (%s)." % _err(js, st)
        st, js = self.http("GET", "https://api.kick.com/public/v1/channels", headers=self._h(tok))
        if st == 401:
            _fail(st, "Kick login expired.")
        try:
            stream = js["data"][0]["stream"]
            url, key = stream["url"], stream["key"]
        except (KeyError, IndexError, TypeError):
            raise AuthError("Couldn't get your Kick stream key: %s" % _err(js, st))
        if not url or not key:
            raise AuthError("Kick didn't return a stream key. Check your channel's stream settings on kick.com.")
        return url, key, warn


PLATFORM_CLASSES = (Twitch, YouTube, Kick)


# ---------------------------------------------------------------- manager

class Accounts:
    def __init__(self, path, creds, http=http_json, open_url=webbrowser.open):
        self.path, self.open_url = path, open_url
        self.platforms = {cls.id: cls(creds, http) for cls in PLATFORM_CLASSES}
        self.cancel_event = threading.Event()
        self._lock = threading.Lock()
        try:
            with open(path, encoding="utf-8") as f:
                self.data = json.load(f)
        except (OSError, ValueError):
            self.data = {}

    def _save(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.data, f)
        os.replace(tmp, self.path)

    def summary(self):
        return {pid: {"name": p.name, "configured": p.configured(),
                      "user": (self.data.get(pid) or {}).get("profile")}
                for pid, p in self.platforms.items()}

    def login(self, pid, progress=lambda info: None):
        """Blocking. Returns the profile on success, raises AuthError otherwise."""
        p = self.platforms[pid]
        if not p.configured():
            raise AuthError("%s login isn't set up in this build yet (see LOGIN_SETUP.md). "
                            "You can paste your stream key instead." % p.name)
        self.cancel_event.clear()
        tok = p.login(progress, self.cancel_event, self.open_url)
        prof = p.profile(tok)
        with self._lock:
            self.data[pid] = {"token": tok, "profile": prof}
            self._save()
        return prof

    def cancel(self):
        self.cancel_event.set()

    def logout(self, pid):
        with self._lock:
            self.data.pop(pid, None)
            self._save()

    def _token(self, pid, force=False):
        entry = self.data.get(pid)
        if not entry:
            raise AuthError("Log in to %s first." % self.platforms[pid].name)
        tok = entry["token"]
        if force or time.time() >= float(tok.get("expires_at", 0)):
            try:
                tok = self.platforms[pid].refresh(tok)
            except AuthError:
                self.logout(pid)
                raise
            with self._lock:
                entry["token"] = tok
                self._save()
        return tok

    def go_live(self, pid, title="", privacy="public"):
        """Returns (server_url, stream_key, warning)."""
        p = self.platforms[pid]
        prof = self.data.get(pid, {}).get("profile") or {}
        try:
            return p.go_live(self._token(pid), prof, title, privacy)
        except Unauthorized:
            # One retry with a fresh token in case it was revoked/expired early.
            return p.go_live(self._token(pid, force=True), prof, title, privacy)
