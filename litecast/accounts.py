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
import re
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


LANGUAGES = [("en", "English"), ("es", "Spanish"), ("pt", "Portuguese"), ("fr", "French"), ("de", "German"),
             ("it", "Italian"), ("ru", "Russian"), ("pl", "Polish"), ("tr", "Turkish"), ("ar", "Arabic"),
             ("ja", "Japanese"), ("ko", "Korean"), ("zh", "Chinese"), ("nl", "Dutch"), ("sv", "Swedish"),
             ("other", "Other")]


def _boxart(url):
    return url.replace("{width}x{height}", "52x72") if url else ""


def clean_tags(tags, pid):
    """Twitch/Kick: max 10 one-word tags (letters+numbers, <=25 chars). YouTube: phrases, <=500 chars total."""
    out, seen, total = [], set(), 0
    for t in tags or []:
        t = str(t).strip()
        if pid in ("twitch", "kick"):
            t = re.sub(r"[\W_]+", "", t)[:25]
        else:
            t = re.sub(r"[,<>]", " ", t).strip()[:60]
        if not t or t.lower() in seen:
            continue
        if pid == "youtube":
            total += len(t) + 1
            if total > 500:
                break
        seen.add(t.lower())
        out.append(t)
    return out[:10] if pid in ("twitch", "kick") else out


def clean_info(pid, info):
    """Keep only the stream-info fields a platform supports, with sane limits."""
    info = info if isinstance(info, dict) else {}
    out = {"title": str(info.get("title") or "").strip()[:140 if pid == "twitch" else 100],
           "tags": clean_tags(info.get("tags"), pid), "category": None}
    cat = info.get("category")
    if isinstance(cat, dict) and cat.get("id"):
        out["category"] = {"id": str(cat["id"]), "name": str(cat.get("name") or ""), "img": str(cat.get("img") or "")}
    if pid == "twitch":
        lang = str(info.get("language") or "")
        out["language"] = lang if lang in dict(LANGUAGES) else ""
        out["labels"] = [x for x in (info.get("labels") or []) if x in Twitch.LABELS]
        out["branded"] = bool(info.get("branded"))
    elif pid == "youtube":
        out["description"] = str(info.get("description") or "")[:5000]
        out["privacy"] = info.get("privacy") if info.get("privacy") in ("public", "unlisted", "private") else "public"
        out["kids"] = bool(info.get("kids"))
        if not out["category"]:
            out["category"] = {"id": "20", "name": "Gaming", "img": ""}
    return out


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

    LABELS = ["ProfanityVulgarity", "ViolentGraphic", "Gambling", "DrugsIntoxication", "SexualThemes",
              "DebatedSocialIssuesAndPolitics"]

    def channel_info(self, tok, prof):
        st, js = self.http("GET", "https://api.twitch.tv/helix/channels?broadcaster_id=" + prof["id"], headers=self._h(tok))
        if st != 200 or not js.get("data"):
            _fail(st, "Couldn't read your Twitch channel: %s" % _err(js, st))
        ch = js["data"][0]
        cat = None
        if ch.get("game_id"):
            cat = {"id": ch["game_id"], "name": ch.get("game_name", ""), "img": ""}
            st2, g = self.http("GET", "https://api.twitch.tv/helix/games?id=" + ch["game_id"], headers=self._h(tok))
            if st2 == 200 and g.get("data"):
                cat["img"] = _boxart(g["data"][0].get("box_art_url", ""))
        return {"title": ch.get("title", ""), "category": cat, "tags": ch.get("tags") or [],
                "language": ch.get("broadcaster_language") or "",
                "labels": [x for x in (ch.get("content_classification_labels") or []) if x in self.LABELS],
                "branded": bool(ch.get("is_branded_content"))}

    def search_categories(self, tok, q):
        st, js = self.http("GET", "https://api.twitch.tv/helix/search/categories?first=10&query=" + urllib.parse.quote(q),
                           headers=self._h(tok))
        if st != 200:
            _fail(st, "Category search failed: %s" % _err(js, st))
        return [{"id": c["id"], "name": c["name"], "img": _boxart(c.get("box_art_url", ""))} for c in js.get("data") or []]

    def apply_info(self, tok, prof, info):
        body = {"tags": info.get("tags") or [], "is_branded_content": bool(info.get("branded")),
                "content_classification_labels": [{"id": x, "is_enabled": x in (info.get("labels") or [])}
                                                  for x in self.LABELS]}
        if info.get("title"):
            body["title"] = info["title"]
        if info.get("category"):
            body["game_id"] = info["category"]["id"]
        if info.get("language"):
            body["broadcaster_language"] = info["language"]
        st, js = self.http("PATCH", "https://api.twitch.tv/helix/channels?broadcaster_id=" + prof["id"],
                           body=body, headers=self._h(tok))
        if st not in (200, 204):
            _fail(st, "Twitch didn't accept the stream info: %s" % _err(js, st))

    def go_live(self, tok, prof, info):
        warn = ""
        try:
            self.apply_info(tok, prof, info)
        except Unauthorized:
            raise
        except AuthError as e:
            warn = str(e)
        st, js = self.http("GET", "https://api.twitch.tv/helix/streams/key?broadcaster_id=" + prof["id"], headers=self._h(tok))
        if st != 200 or not js.get("data"):
            _fail(st, "Couldn't get your Twitch stream key: %s" % _err(js, st))
        return self.INGEST, js["data"][0]["stream_key"], warn


class YouTube:
    id, name = "youtube", "YouTube"
    SCOPE = "https://www.googleapis.com/auth/youtube"
    API = "https://www.googleapis.com/youtube/v3/"
    STREAM_NAME = "LiteCast"

    CATEGORIES = [("20", "Gaming"), ("24", "Entertainment"), ("22", "People & Blogs"), ("23", "Comedy"),
                  ("10", "Music"), ("17", "Sports"), ("27", "Education"), ("28", "Science & Technology"),
                  ("26", "Howto & Style"), ("1", "Film & Animation"), ("2", "Autos & Vehicles"),
                  ("15", "Pets & Animals"), ("19", "Travel & Events"), ("25", "News & Politics"),
                  ("29", "Nonprofits & Activism")]

    def __init__(self, creds, http):
        self.cid, self.secret, self.http = creds.get("YOUTUBE_CLIENT_ID"), creds.get("YOUTUBE_CLIENT_SECRET"), http
        self.live_video = None

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

    def channel_info(self, tok, prof):
        return None  # YouTube makes a fresh broadcast each time; we keep your last info locally

    def search_categories(self, tok, q):
        return [{"id": i, "name": n, "img": ""} for i, n in self.CATEGORIES if q.lower() in n.lower()]

    def _snippet(self, info):
        return {"title": info.get("title") or "Live with LiteCast", "description": info.get("description") or "",
                "tags": info.get("tags") or [], "categoryId": (info.get("category") or {}).get("id") or "20"}

    def apply_info(self, tok, prof, info):
        if not self.live_video:
            raise AuthError("You're not live on YouTube right now.")
        self._call("PUT", "videos?part=snippet", tok, body={"id": self.live_video, "snippet": self._snippet(info)})

    def go_live(self, tok, prof, info):
        streams = self._call("GET", "liveStreams?part=id,snippet,cdn&mine=true&maxResults=50", tok).get("items", [])
        stream = next((x for x in streams if x.get("snippet", {}).get("title") == self.STREAM_NAME
                       and x.get("cdn", {}).get("ingestionType") == "rtmp"), None)
        if not stream:
            stream = self._call("POST", "liveStreams?part=id,snippet,cdn,contentDetails", tok, body={
                "snippet": {"title": self.STREAM_NAME},
                "cdn": {"frameRate": "variable", "ingestionType": "rtmp", "resolution": "variable"},
                "contentDetails": {"isReusable": True}})
        now = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        snip = self._snippet(info)
        bc = self._call("POST", "liveBroadcasts?part=id,snippet,status,contentDetails", tok, body={
            "snippet": {"title": snip["title"], "description": snip["description"], "scheduledStartTime": now},
            "status": {"privacyStatus": info.get("privacy") or "public",
                       "selfDeclaredMadeForKids": bool(info.get("kids"))},
            "contentDetails": {"enableAutoStart": True, "enableAutoStop": True, "latencyPreference": "low"}})
        self._call("POST", "liveBroadcasts/bind?id=%s&part=id,contentDetails&streamId=%s" % (bc["id"], stream["id"]), tok)
        self.live_video = bc["id"]
        warn = ""
        try:  # tags + category live on the video, not the broadcast
            self._call("PUT", "videos?part=snippet", tok, body={"id": bc["id"], "snippet": snip})
        except Unauthorized:
            raise
        except AuthError as e:
            warn = "Couldn't set tags/category: %s" % e
        info_ = stream["cdn"]["ingestionInfo"]
        return info_["ingestionAddress"], info_["streamName"], warn


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

    def channel_info(self, tok, prof):
        st, js = self.http("GET", "https://api.kick.com/public/v1/channels", headers=self._h(tok))
        if st != 200 or not js.get("data"):
            _fail(st, "Couldn't read your Kick channel: %s" % _err(js, st))
        ch = js["data"][0]
        cat = ch.get("category") or {}
        return {"title": ch.get("stream_title") or "",
                "category": {"id": str(cat["id"]), "name": cat.get("name", ""), "img": cat.get("thumbnail", "")}
                if cat.get("id") else None,
                "tags": (ch.get("stream") or {}).get("custom_tags") or []}

    def search_categories(self, tok, q):
        q = q.strip()
        if len(q) >= 3:
            st, js = self.http("GET", "https://api.kick.com/public/v2/categories?limit=10&name=" + urllib.parse.quote(q),
                               headers=self._h(tok))
            if st == 200 and js.get("data"):
                return [{"id": str(c["id"]), "name": c["name"], "img": c.get("thumbnail", "")} for c in js["data"]]
        st, js = self.http("GET", "https://api.kick.com/public/v1/categories?q=" + urllib.parse.quote(q), headers=self._h(tok))
        if st != 200:
            _fail(st, "Category search failed: %s" % _err(js, st))
        return [{"id": str(c["id"]), "name": c["name"], "img": c.get("thumbnail", "")} for c in (js.get("data") or [])[:10]]

    def apply_info(self, tok, prof, info):
        body = {"custom_tags": info.get("tags") or []}
        if info.get("title"):
            body["stream_title"] = info["title"]
        if info.get("category"):
            body["category_id"] = int(info["category"]["id"])
        st, js = self.http("PATCH", "https://api.kick.com/public/v1/channels", body=body, headers=self._h(tok))
        if st not in (200, 204):
            _fail(st, "Kick didn't accept the stream info: %s" % _err(js, st))

    def go_live(self, tok, prof, info):
        warn = ""
        try:
            self.apply_info(tok, prof, info)
        except Unauthorized:
            raise
        except AuthError as e:
            warn = str(e)
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
        self.path, self.open_url, self.http = path, open_url, http
        self.classes = PLATFORM_CLASSES
        self.platforms = {cls.id: cls(creds, http) for cls in self.classes}
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

    def reload(self, creds):
        """New app IDs were entered (login setup) - rebuild the platform clients."""
        self.platforms = {cls.id: cls(creds, self.http) for cls in self.classes}

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

    def _with_token(self, pid, fn):
        """Call fn(token, profile); on a rejected token refresh once and retry."""
        prof = self.data.get(pid, {}).get("profile") or {}
        try:
            return fn(self._token(pid), prof)
        except Unauthorized:
            return fn(self._token(pid, force=True), prof)

    def channel_info(self, pid):
        """What's currently set on the platform (None when the platform has no such thing)."""
        p = self.platforms[pid]
        return self._with_token(pid, p.channel_info)

    def search_categories(self, pid, q):
        p = self.platforms[pid]
        return self._with_token(pid, lambda tok, prof: p.search_categories(tok, q))

    def update_info(self, pid, info):
        p = self.platforms[pid]
        return self._with_token(pid, lambda tok, prof: p.apply_info(tok, prof, clean_info(pid, info)))

    def go_live(self, pid, info=None):
        """Apply the stream info and return (server_url, stream_key, warning)."""
        p = self.platforms[pid]
        return self._with_token(pid, lambda tok, prof: p.go_live(tok, prof, clean_info(pid, info)))
