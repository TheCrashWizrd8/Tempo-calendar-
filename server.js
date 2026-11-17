import express from "express";
import cookieParser from "cookie-parser";
import multer from "multer";
import crypto from "node:crypto";
import { db, json, getSettings, DEFAULT_SETTINGS } from "./src/db.js";
import * as google from "./src/google.js";
import * as ai from "./src/ai.js";
import * as learn from "./src/learning.js";

try { process.loadEnvFile(); } catch { /* no .env file */ }
for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ANTHROPIC_API_KEY"]) {
  if (!process.env[k]) console.warn(`⚠ ${k} is not set — see README.md`);
}

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const SECRET = process.env.SESSION_SECRET || "dev-only-change-me";
const secure = (process.env.BASE_URL || "").startsWith("https://");
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser(SECRET));
app.use(express.static("public"));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Something went wrong" });
});
const getUser = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);
function auth(req, res, next) {
  const sid = req.signedCookies.sid;
  const row = sid && db.prepare("SELECT user_id FROM sessions WHERE id = ?").get(sid);
  if (!row) return res.status(401).json({ error: "Not signed in" });
  req.user = getUser(row.user_id);
  next();
}

// ---------------- Google sign-in ----------------
app.get("/auth/google", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("oauth_state", state, { signed: true, httpOnly: true, secure, maxAge: 10 * 60000, sameSite: "lax" });
  // the iOS app signs in through the system browser, then gets handed back a one-time code
  res.cookie("oauth_app", req.query.app === "1" ? "1" : "0", { signed: true, httpOnly: true, secure, maxAge: 10 * 60000, sameSite: "lax" });
  res.redirect(google.authUrl(state));
});

app.get("/auth/google/callback", wrap(async (req, res) => {
  if (!req.query.state || req.query.state !== req.signedCookies.oauth_state) return res.status(400).send("Bad sign-in state, please try again.");
  const { tokens, profile } = await google.exchangeCode(req.query.code);
  const allowed = (process.env.ALLOWED_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(profile.email.toLowerCase())) return res.status(403).send("This Google account is not allowed on this server.");

  let user = db.prepare("SELECT * FROM users WHERE google_sub = ?").get(profile.sub);
  if (user) {
    const merged = { ...json(user.tokens, {}), ...tokens }; // keep refresh_token if Google omits it
    db.prepare("UPDATE users SET tokens = ?, email = ?, name = ? WHERE id = ?").run(JSON.stringify(merged), profile.email, profile.name, user.id);
  } else {
    db.prepare("INSERT INTO users (google_sub, email, name, tokens, ingest_token) VALUES (?, ?, ?, ?, ?)")
      .run(profile.sub, profile.email, profile.name, JSON.stringify(tokens), crypto.randomBytes(18).toString("base64url"));
  }
  user = db.prepare("SELECT * FROM users WHERE google_sub = ?").get(profile.sub);
  try {
    db.prepare("UPDATE users SET timezone = ? WHERE id = ?").run(await google.getTimezone(user), user.id);
  } catch (e) { console.warn("timezone lookup failed", e.message); }

  res.clearCookie("oauth_state");
  if (req.signedCookies.oauth_app === "1") {
    res.clearCookie("oauth_app");
    const code = crypto.randomBytes(24).toString("base64url");
    appLoginCodes.set(code, { userId: user.id, expires: Date.now() + 2 * 60000 });
    return res.redirect(`${process.env.APP_SCHEME || "tempo"}://auth?code=${code}`);
  }
  startSession(res, user.id);
  res.redirect("/");
}));

const appLoginCodes = new Map();
function startSession(res, userId) {
  const sid = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO sessions (id, user_id) VALUES (?, ?)").run(sid, userId);
  res.cookie("sid", sid, { signed: true, httpOnly: true, secure, sameSite: "lax", maxAge: 180 * 86400000 });
}

// The app's web view opens this with the one-time code to receive its session cookie.
app.get("/auth/app-login", (req, res) => {
  const entry = appLoginCodes.get(req.query.code);
  appLoginCodes.delete(req.query.code);
  if (!entry || entry.expires < Date.now()) return res.redirect("/");
  startSession(res, entry.userId);
  res.redirect("/");
});

app.post("/auth/logout", auth, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(req.signedCookies.sid);
  res.clearCookie("sid").json({ ok: true });
});

// ---------------- account ----------------
app.get("/api/me", auth, (req, res) => {
  const u = req.user;
  res.json({
    name: u.name, email: u.email, timezone: u.timezone, settings: getSettings(u),
    ingestUrl: `${process.env.BASE_URL || `${req.protocol}://${req.get("host")}`}/api/ingest/${u.ingest_token}`,
  });
});

app.put("/api/settings", auth, (req, res) => {
  const s = { ...getSettings(req.user) };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in req.body) s[k] = req.body[k];
  s.subjects = (Array.isArray(s.subjects) ? s.subjects : String(s.subjects).split(",")).map((x) => String(x).trim()).filter(Boolean);
  for (const k of ["sessionMinutes", "maxSessionsPerDay", "bufferMinutes", "earliestHour", "latestHour"]) s[k] = Number(s[k]) || DEFAULT_SETTINGS[k];
  db.prepare("UPDATE users SET settings = ? WHERE id = ?").run(JSON.stringify(s), req.user.id);
  res.json(s);
});

// ---------------- calendar sync + learning refresh ----------------
async function sync(user) {
  const from = Date.now() - 120 * 86400000, to = Date.now() + 30 * 86400000;
  const items = await google.listEvents(user, from, to);
  const keep = db.prepare("SELECT gcal_id, category FROM events WHERE user_id = ?").all(user.id);
  const known = new Map(keep.map((r) => [r.gcal_id, r.category]));
  const upsert = db.prepare(`INSERT INTO events (user_id, gcal_id, start_ms, end_ms, all_day, summary, location, description, category, tempo_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, gcal_id) DO UPDATE SET start_ms=excluded.start_ms, end_ms=excluded.end_ms, all_day=excluded.all_day,
      summary=excluded.summary, location=excluded.location, description=excluded.description, tempo_kind=excluded.tempo_kind,
      category=CASE WHEN events.summary = excluded.summary THEN events.category ELSE NULL END`);
  const seen = new Set();
  for (const e of items) {
    const r = google.toRow(e);
    seen.add(r.gcal_id);
    upsert.run(user.id, r.gcal_id, r.start_ms, r.end_ms, r.all_day, r.summary, r.location, r.description,
      r.tempo_kind === "study" ? "study" : known.get(r.gcal_id) ?? null, r.tempo_kind);
  }
  // drop events deleted in Google
  const del = db.prepare("DELETE FROM events WHERE user_id = ? AND gcal_id = ?");
  for (const r of db.prepare("SELECT gcal_id FROM events WHERE user_id = ? AND start_ms BETWEEN ? AND ?").all(user.id, from, to)) {
    if (!seen.has(r.gcal_id)) del.run(user.id, r.gcal_id);
  }

  // AI-categorise new events (bounded per sync)
  const todo = db.prepare("SELECT gcal_id, summary, location FROM events WHERE user_id = ? AND category IS NULL LIMIT 400").all(user.id);
  const setCat = db.prepare("UPDATE events SET category = ? WHERE user_id = ? AND gcal_id = ?");
  for (let i = 0; i < todo.length; i += 100) {
    for (const it of await ai.categoriseEvents(todo.slice(i, i + 100))) setCat.run(it.category, user.id, it.id);
  }

  const newPlaces = learn.updatePlaces(user.id);
  await guessPlaceNames(user);
  learn.verifySessions(user.id);
  return { events: items.length, categorised: todo.length, newPlaces };
}

async function guessPlaceNames(user) {
  const unnamed = db.prepare("SELECT * FROM places WHERE user_id = ? AND name IS NULL LIMIT 3").all(user.id);
  for (const pl of unnamed) {
    const vs = learn.visits(user.id, Date.now() - 60 * 86400000, Date.now()).filter((v) => v.place_id === pl.id);
    if (vs.length < 2) continue;
    const titles = new Set(), hours = {};
    for (const v of vs) {
      for (const e of db.prepare("SELECT summary, location FROM events WHERE user_id = ? AND all_day = 0 AND start_ms < ? AND end_ms > ?").all(user.id, v.end, v.start)) {
        titles.add(e.summary + (e.location ? ` @ ${e.location}` : ""));
      }
      const p = learn.localParts(v.start, user.timezone);
      const k = `${learn.DAYS[p.dow]} ${p.hour}:00`;
      hours[k] = (hours[k] || 0) + 1;
    }
    const top = Object.entries(hours).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k).join(", ");
    const g = await ai.guessPlace({ overlappingEvents: [...titles].slice(0, 15), hours: top });
    db.prepare("UPDATE places SET name = ?, kind = ?, guessed = 1 WHERE id = ?").run(g.name, g.kind, pl.id);
  }
}

app.post("/api/sync", auth, wrap(async (req, res) => res.json(await sync(req.user))));

app.get("/api/agenda", auth, (req, res) => {
  const days = Math.min(31, Number(req.query.days) || 14);
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const start = from.getTime() - 86400000, end = Date.now() + days * 86400000;
  const events = db.prepare("SELECT gcal_id, start_ms, end_ms, all_day, summary, location, category, tempo_kind FROM events WHERE user_id = ? AND end_ms > ? AND start_ms < ? ORDER BY start_ms").all(req.user.id, start, end);
  const proposals = db.prepare("SELECT * FROM proposals WHERE user_id = ? AND status = 'proposed' AND end_ms > ? ORDER BY start_ms").all(req.user.id, Date.now());
  res.json({ timezone: req.user.timezone, events, proposals });
});

// ---------------- screenshot import ----------------
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
app.post("/api/import/screenshot", auth, upload.single("image"), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });
  if (!IMAGE_TYPES.includes(req.file.mimetype)) return res.status(400).json({ error: "Use a PNG, JPEG, GIF or WebP image" });
  const tz = req.user.timezone || "UTC";
  const now = new Date().toLocaleString("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  const out = await ai.extractEventsFromImage({ base64: req.file.buffer.toString("base64"), mediaType: req.file.mimetype, timezone: tz, now, hint: req.body.hint });
  res.json(out);
}));

app.post("/api/import/confirm", auth, wrap(async (req, res) => {
  const created = [];
  for (const ev of req.body.events || []) {
    const data = await google.insertEvent(req.user, ev);
    created.push({ id: data.id, link: data.htmlLink, title: data.summary });
  }
  sync(req.user).catch((e) => console.warn("post-import sync failed", e.message));
  res.json({ created });
}));

// ---------------- location ----------------
function addPings(userId, points, source) {
  const last = db.prepare("SELECT ts, lat, lng FROM pings WHERE user_id = ? ORDER BY ts DESC LIMIT 1").get(userId);
  const ins = db.prepare("INSERT INTO pings (user_id, ts, lat, lng, acc, source) VALUES (?, ?, ?, ?, ?, ?)");
  let prev = last, n = 0;
  for (const p of points) {
    const lat = Number(p.lat ?? p.latitude), lng = Number(p.lng ?? p.lon ?? p.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const ts = Number(p.ts) || Date.parse(p.time || p.timestamp) || Date.now();
    // skip near-duplicates (same spot within 2 minutes)
    if (prev && Math.abs(ts - prev.ts) < 120000 && learn.distanceM(prev, { lat, lng }) < 30) continue;
    ins.run(userId, ts, lat, lng, p.acc ?? p.accuracy ?? null, source);
    prev = { ts, lat, lng };
    n++;
  }
  if (n) learn.updatePlaces(userId);
  return n;
}

app.post("/api/location", auth, (req, res) => {
  res.json({ stored: addPings(req.user.id, req.body.points || [req.body], "app") });
});

// For phone automations (iOS Shortcuts / Android Tasker) that send location in the background.
// Accepts JSON {lat,lng}, {latitude,longitude}, or {location:"lat,lng"}.
app.post("/api/ingest/:token", (req, res) => {
  const user = db.prepare("SELECT id FROM users WHERE ingest_token = ?").get(req.params.token);
  if (!user) return res.status(404).json({ error: "Unknown token" });
  let body = req.body || {};
  if (typeof body.location === "string") {
    const [lat, lng] = body.location.split(",").map(Number);
    body = { ...body, lat, lng };
  }
  res.json({ stored: addPings(user.id, Array.isArray(body.points) ? body.points : [body], "automation") });
});

app.post("/api/ingest-token/rotate", auth, (req, res) => {
  db.prepare("UPDATE users SET ingest_token = ? WHERE id = ?").run(crypto.randomBytes(18).toString("base64url"), req.user.id);
  res.json({ ok: true });
});

// ---------------- places & insights ----------------
app.get("/api/insights", auth, (req, res) => {
  learn.verifySessions(req.user.id);
  const profile = learn.buildProfile(req.user);
  const vs = learn.visits(req.user.id, Date.now() - 56 * 86400000, Date.now());
  const places = profile.places.map((p) => {
    const mine = vs.filter((v) => v.place_id === p.id);
    return { ...p, visits: mine.length, hours: +(mine.reduce((s, v) => s + v.end - v.start, 0) / 3600000).toFixed(1) };
  }).sort((a, b) => b.hours - a.hours);
  res.json({ summary: learn.describeProfile(profile), study: profile.study, busy: profile.busy, pref: profile.pref, counts: profile.counts, places });
});

app.put("/api/places/:id", auth, (req, res) => {
  const { name, kind } = req.body;
  db.prepare("UPDATE places SET name = ?, kind = ?, guessed = 0 WHERE id = ? AND user_id = ?").run(name || null, kind || "other", req.params.id, req.user.id);
  res.json({ ok: true });
});
app.delete("/api/places/:id", auth, (req, res) => {
  db.prepare("UPDATE pings SET place_id = NULL WHERE place_id = ? AND user_id = ?").run(req.params.id, req.user.id);
  db.prepare("DELETE FROM places WHERE id = ? AND user_id = ?").run(req.params.id, req.user.id);
  res.json({ ok: true });
});
app.delete("/api/location-history", auth, (req, res) => {
  db.prepare("DELETE FROM pings WHERE user_id = ?").run(req.user.id);
  db.prepare("DELETE FROM places WHERE user_id = ?").run(req.user.id);
  res.json({ ok: true });
});

// ---------------- study planning ----------------
app.post("/api/study/propose", auth, wrap(async (req, res) => {
  const user = getUser(req.user.id);
  await sync(user);
  const settings = getSettings(user);
  const days = Math.min(14, Number(req.body.days) || 7);
  const profile = learn.buildProfile(user);
  const busy = db.prepare("SELECT start_ms, end_ms FROM events WHERE user_id = ? AND all_day = 0 AND end_ms > ?").all(user.id, Date.now())
    .map((e) => [e.start_ms, e.end_ms]);
  const candidates = learn.candidateSlots({ profile, busyIntervals: busy, settings, days });
  db.prepare("DELETE FROM proposals WHERE user_id = ? AND status = 'proposed'").run(user.id);
  if (!candidates.length) return res.json({ summary: "I couldn't find any free time that fits your settings in that window.", proposals: [] });

  const upcoming = db.prepare("SELECT * FROM events WHERE user_id = ? AND start_ms BETWEEN ? AND ? ORDER BY start_ms LIMIT 150")
    .all(user.id, Date.now(), Date.now() + 14 * 86400000)
    .map((e) => ({ when: e.all_day ? `${new Date(e.start_ms).toISOString().slice(0, 10)} (all day)` : learn.label(e.start_ms, e.end_ms, profile.tz), summary: e.summary, category: e.category }));
  const plan = await ai.planStudy({
    candidates, upcoming, goals: req.body.goals, subjects: settings.subjects,
    profileText: learn.describeProfile(profile), maxPerDay: settings.maxSessionsPerDay,
    now: new Date().toLocaleString("en-US", { timeZone: profile.tz }), timezone: profile.tz,
  });
  const ins = db.prepare("INSERT INTO proposals (user_id, start_ms, end_ms, subject, reason, score) VALUES (?, ?, ?, ?, ?, ?)");
  const used = [];
  for (const s of plan.sessions) {
    const c = candidates[s.candidate];
    if (!c || used.some((u) => c.start < u.end && c.end > u.start)) continue; // guard against bad indices / overlaps
    used.push(c);
    ins.run(user.id, c.start, c.end, s.subject, s.reason, c.score);
  }
  const proposals = db.prepare("SELECT * FROM proposals WHERE user_id = ? AND status = 'proposed' ORDER BY start_ms").all(user.id);
  res.json({ summary: plan.summary, proposals });
}));

app.get("/api/study", auth, (req, res) => {
  learn.verifySessions(req.user.id);
  const rows = db.prepare("SELECT * FROM proposals WHERE user_id = ? AND (status = 'proposed' AND end_ms > ? OR status = 'accepted') ORDER BY start_ms").all(req.user.id, Date.now());
  res.json({
    proposed: rows.filter((r) => r.status === "proposed"),
    upcoming: rows.filter((r) => r.status === "accepted" && r.end_ms > Date.now()),
    needsCheckIn: rows.filter((r) => r.status === "accepted" && r.end_ms <= Date.now()),
  });
});

function ownProposal(req) {
  const p = db.prepare("SELECT * FROM proposals WHERE id = ? AND user_id = ?").get(req.params.id, req.user.id);
  if (!p) throw Object.assign(new Error("Not found"), { status: 404 });
  return p;
}

app.post("/api/study/:id/accept", auth, wrap(async (req, res) => {
  const p = ownProposal(req);
  if (p.status !== "proposed") return res.status(409).json({ error: "Already handled" });
  const ev = await google.insertEvent(req.user, {
    title: `📚 Study: ${p.subject}`, start: p.start_ms, end: p.end_ms, notes: `Planned by Tempo — ${p.reason}`, colorId: "2", tempoKind: "study",
  });
  db.prepare("UPDATE proposals SET status = 'accepted', gcal_id = ? WHERE id = ?").run(ev.id, p.id);
  res.json({ ok: true, link: ev.htmlLink });
}));

app.post("/api/study/:id/reject", auth, wrap(async (req, res) => {
  db.prepare("UPDATE proposals SET status = 'rejected' WHERE id = ?").run(ownProposal(req).id);
  res.json({ ok: true });
}));

app.post("/api/study/:id/outcome", auth, wrap(async (req, res) => {
  db.prepare("UPDATE proposals SET status = ? WHERE id = ?").run(req.body.done ? "completed" : "skipped", ownProposal(req).id);
  res.json({ ok: true });
}));

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Tempo running on http://localhost:${port}`));
