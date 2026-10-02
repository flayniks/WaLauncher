# Turning on "Log in with Twitch / YouTube / Kick"

Streaming sites only let registered apps log people in, so you register LiteCast once per site. It's free. Then add what you get as **GitHub secrets** (repo → Settings → Secrets and variables → Actions → *New repository secret*), and the next build has working login buttons.

You only need to do the sites you use.

## Twitch (about 2 minutes)

1. Go to <https://dev.twitch.tv/console/apps> → **Register Your Application**.
2. Name: `LiteCast <your name>` · OAuth Redirect URL: `http://localhost` · Category: *Broadcaster Suite* · Client Type: **Public**.
3. Copy the **Client ID** → secret `TWITCH_CLIENT_ID`.

## YouTube (about 5 minutes)

1. <https://console.cloud.google.com/> → create a project → *APIs & Services* → *Library* → enable **YouTube Data API v3**.
2. *OAuth consent screen* → External → fill in the app name and your email → add yourself under **Test users**.
3. *Credentials* → *Create credentials* → *OAuth client ID* → Application type **Desktop app**.
4. Copy the **Client ID** → secret `YOUTUBE_CLIENT_ID`, and the **Client secret** → `YOUTUBE_CLIENT_SECRET`.

While the app is in "testing" mode Google shows an "unverified app" screen (click *Continue*), and you log in again every 7 days.
Your channel must have live streaming turned on (<https://www.youtube.com/features>; the first time takes up to 24 hours).

## Kick (about 2 minutes)

1. <https://kick.com/settings/developer> → **Create app**.
2. Redirect URL: `http://localhost:17563/callback` · Scopes: *Read user*, *Read channel*, *Write channel*, *Read stream key*.
3. Copy the **Client ID** → `KICK_CLIENT_ID` and **Client Secret** → `KICK_CLIENT_SECRET`.

## Then

Push any commit (or run the "Build Windows app" workflow manually) and download the new `LiteCast.exe`.

Running from source instead? Put the values in `litecast/credentials.py`, or in `%APPDATA%\LiteCast\oauth.json`:

```json
{"TWITCH_CLIENT_ID": "...", "YOUTUBE_CLIENT_ID": "...", "YOUTUBE_CLIENT_SECRET": "..."}
```
