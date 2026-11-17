#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyicloud>=2.0", "mcp>=1.2,<2", "keyring>=24"]
# ///
"""Tempo's Find My helper for macOS.

Asks Find My (through iCloud, the same unofficial route Home Assistant uses) where your
iPhone is every few minutes, keeps the history on this Mac, and serves it to the Tempo
page in the Claude desktop app as a local MCP server.

  tempo_findmy.py login   open a sign-in page on this Mac (Apple ID, password, 2FA code)
  tempo_findmy.py poll    run forever (launchd keeps it alive); adaptive interval
  tempo_findmy.py once    take one reading now and print it
  tempo_findmy.py mcp     MCP server on stdio: get_pings, status
"""
from __future__ import annotations

import html
import json
import math
import os
import sqlite3
import sys
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HOME = Path.home() / "Library" / "Application Support" / "Tempo"
DB = HOME / "pings.sqlite"
STATE = HOME / "state.json"
COOKIES = HOME / "icloud-session"
KEYCHAIN_SERVICE = "tempo-findmy"
PORT = 8765


# ------------------------------------------------------------------ storage
def db() -> sqlite3.Connection:
    HOME.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB)
    con.execute("CREATE TABLE IF NOT EXISTS pings (ts INTEGER PRIMARY KEY, lat REAL, lng REAL, acc REAL, source TEXT)")
    return con


def load_state() -> dict:
    try:
        return json.loads(STATE.read_text())
    except Exception:
        return {}


def save_state(**kw) -> None:
    s = load_state()
    s.update(kw)
    HOME.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(s, indent=2))


def distance_m(a, b) -> float:
    r = math.pi / 180
    dlat, dlng = (b[0] - a[0]) * r, (b[1] - a[1]) * r
    h = math.sin(dlat / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin(dlng / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


# ------------------------------------------------------------------ iCloud
def password_for(apple_id: str) -> str | None:
    import keyring
    return keyring.get_password(KEYCHAIN_SERVICE, apple_id)


def service(apple_id: str, password: str | None = None):
    from pyicloud import PyiCloudService
    COOKIES.mkdir(parents=True, exist_ok=True)
    # refresh_interval=None: no background thread; we ask for a fresh fix ourselves
    return PyiCloudService(apple_id, password or password_for(apple_id), cookie_directory=str(COOKIES), refresh_interval=None)


def info(d) -> dict:
    return getattr(d, "data", None) or {}


def find_iphone(api):
    """The iPhone to track: the one chosen at sign-in, else the first iPhone on the account."""
    want = load_state().get("device_id")
    devices = list(api.devices)
    for d in devices:
        if want and info(d).get("id") == want:
            return d
    for d in devices:
        c = info(d)
        if "iphone" in f"{c.get('deviceClass', '')} {c.get('deviceDisplayName', '')} {getattr(d, 'name', '')}".lower():
            return d
    return devices[0] if devices else None


def read_location() -> dict | None:
    st = load_state()
    apple_id = st.get("apple_id")
    if not apple_id:
        save_state(last_error="Not signed in yet. Run: tempo_findmy.py login")
        return None
    api = service(apple_id)
    if getattr(api, "requires_2fa", False) or getattr(api, "requires_2sa", False):
        save_state(needs_login=True, last_error="Apple wants you to sign in again.")
        return None
    try:
        api.devices.refresh(locate=True)  # ask Find My for a fresh fix, not the last cached one
    except TypeError:
        api.devices.refresh()
    dev = find_iphone(api)
    if dev is None:
        save_state(last_error="No iPhone found on this Apple ID. Is Find My switched on?")
        return None
    loc = dev.location
    if not loc or loc.get("latitude") is None:
        save_state(last_error="Find My didn't return a location this time.")
        return None
    ts = int(loc.get("timeStamp") or time.time() * 1000)
    row = (ts, float(loc["latitude"]), float(loc["longitude"]), float(loc.get("horizontalAccuracy") or 0), "findmy")
    with db() as con:
        con.execute("INSERT OR IGNORE INTO pings VALUES (?,?,?,?,?)", row)
    save_state(needs_login=False, last_error=None, last_ok=int(time.time() * 1000), last_ping=ts)
    return {"ts": ts, "lat": row[1], "lng": row[2], "acc": row[3]}


# ------------------------------------------------------------------ polling
def next_interval(con: sqlite3.Connection) -> int:
    """Seconds until the next reading: every 5 min when moving, 15 min when still, 30 min at night."""
    hour = time.localtime().tm_hour
    if 0 <= hour < 6:
        return 30 * 60
    rows = con.execute("SELECT lat, lng FROM pings ORDER BY ts DESC LIMIT 3").fetchall()
    if len(rows) == 3 and max(distance_m(rows[0], r) for r in rows[1:]) < 100:
        return 15 * 60
    return 5 * 60


def poll_forever() -> None:
    while True:
        try:
            read_location()
        except Exception as e:  # keep running through network blips and Apple hiccups
            save_state(last_error=f"{type(e).__name__}: {e}"[:300])
        with db() as con:
            wait = next_interval(con)
        if load_state().get("needs_login"):
            wait = 30 * 60
        time.sleep(wait)


# ------------------------------------------------------------------ sign-in page
PAGE = """<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Tempo · Apple sign-in</title>
<style>body{{font:16px -apple-system,system-ui,sans-serif;max-width:420px;margin:60px auto;padding:0 16px;color:#14201d}}
h1{{font-size:22px}}input,button{{font:inherit;width:100%;padding:10px;margin:6px 0;box-sizing:border-box;border-radius:10px;border:1px solid #cfd8d5}}
button{{background:#0f766e;color:#fff;border:0;font-weight:600}}.muted{{color:#5d6b67;font-size:14px}}.err{{color:#b42318}}
@media(prefers-color-scheme:dark){{body{{background:#0e1513;color:#e7efec}}input{{background:#16201d;color:#e7efec;border-color:#26332f}}}}</style>
<h1>Connect Find My to Tempo</h1>{body}"""

FORM = """<p class=muted>Tempo uses Find My to see where your iPhone is. Your password is kept in this Mac's Keychain and only sent to Apple.</p>
{err}<form method=post action=/login><input name=apple_id type=email placeholder="Apple ID (email)" required value="{apple_id}">
<input name=password type=password placeholder="Password" required><button>Sign in</button></form>"""

CODE = """<p>Apple sent a 6-digit code to your devices. Enter it here.</p>{err}
<form method=post action=/code><input name=code inputmode=numeric autocomplete=one-time-code pattern="[0-9]{{6}}" placeholder="123456" required autofocus><button>Verify</button></form>"""

DONE = """<p><b>All set.</b> Tempo is now following your iPhone through Find My. You can close this page.</p>
<p class=muted>Found: {device}. Latest location received {when}.</p>"""


def login_server() -> None:
    session: dict = {}
    done = threading.Event()

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def send(self, body: str, status: int = 200):
            data = PAGE.format(body=body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def form(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            return {k: v[0] for k, v in urllib.parse.parse_qs(self.rfile.read(n).decode()).items()}

        def do_GET(self):
            self.send(FORM.format(err="", apple_id=html.escape(load_state().get("apple_id", ""))))

        def finish_login(self):
            import keyring
            api = session["api"]
            keyring.set_password(KEYCHAIN_SERVICE, session["apple_id"], session["password"])
            dev = find_iphone(api)
            save_state(apple_id=session["apple_id"], needs_login=False, device_id=info(dev).get("id") if dev else None)
            got = None
            try:
                got = read_location()
            except Exception:
                pass
            name = getattr(dev, "name", None) or "your iPhone" if dev else "no iPhone"
            self.send(DONE.format(device=html.escape(str(name)), when="just now" if got else "soon"))
            done.set()

        def do_POST(self):
            f = self.form()
            try:
                if self.path == "/login":
                    session.update(apple_id=f["apple_id"].strip(), password=f["password"])
                    session["api"] = service(session["apple_id"], session["password"])
                    api = session["api"]
                    if getattr(api, "requires_2fa", False):
                        return self.send(CODE.format(err=""))
                    return self.finish_login()
                if self.path == "/code":
                    api = session.get("api")
                    if not api:
                        return self.send(FORM.format(err="<p class=err>Start again.</p>", apple_id=""))
                    if not api.validate_2fa_code(f.get("code", "").strip()):
                        return self.send(CODE.format(err="<p class=err>That code didn't work. Try the newest one.</p>"))
                    if not getattr(api, "is_trusted_session", True):
                        api.trust_session()
                    return self.finish_login()
            except Exception as e:
                msg = html.escape(f"{type(e).__name__}: {e}")[:300]
                return self.send(FORM.format(err=f"<p class=err>Apple said: {msg}</p>", apple_id=html.escape(session.get("apple_id", ""))))
            self.send("<p>Not found</p>", 404)

    srv = HTTPServer(("127.0.0.1", PORT), H)
    url = f"http://127.0.0.1:{PORT}/"
    print(f"Sign-in page: {url}", flush=True)
    webbrowser.open(url)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    done.wait()
    time.sleep(1.5)
    srv.shutdown()
    print("Signed in.", flush=True)


# ------------------------------------------------------------------ MCP server for the Tempo page
def mcp_server() -> None:
    from mcp.server.fastmcp import FastMCP

    app = FastMCP("tempo_location")

    @app.tool()
    def get_pings(since_ms: int = 0, limit: int = 20000) -> dict:
        """Location samples of the user's iPhone from Find My, oldest first. Each: ts (epoch ms), lat, lng, acc (metres)."""
        with db() as con:
            rows = con.execute("SELECT ts, lat, lng, acc FROM pings WHERE ts > ? ORDER BY ts LIMIT ?", (int(since_ms), int(limit))).fetchall()
        return {"pings": [{"ts": t, "lat": round(a, 5), "lng": round(b, 5), "acc": round(c or 0)} for t, a, b, c in rows]}

    @app.tool()
    def status() -> dict:
        """Whether the Find My helper is signed in and collecting, and when it last got a location."""
        s = load_state()
        with db() as con:
            n = con.execute("SELECT COUNT(*) FROM pings").fetchone()[0]
        return {"signed_in": bool(s.get("apple_id")) and not s.get("needs_login"), "needs_login": bool(s.get("needs_login")),
                "last_ping": s.get("last_ping"), "last_ok": s.get("last_ok"), "last_error": s.get("last_error"), "count": n}

    app.run()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "poll"
    {"login": login_server, "poll": poll_forever, "mcp": mcp_server,
     "once": lambda: print(json.dumps(read_location(), indent=2))}.get(cmd, lambda: print(__doc__))()
