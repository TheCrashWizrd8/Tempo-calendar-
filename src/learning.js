// The "learning" half of Tempo: turns raw location pings + calendar history + your
// reactions to suggestions into a weekly habit model, then scores free time with it.
import { db } from "./db.js";

const DAY = 86400000, HOUR = 3600000, MIN = 60000;
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STUDY_KINDS = new Set(["library", "school", "cafe"]);
const AWAY_KINDS = new Set(["gym", "social", "work"]);
const BUSY_CATEGORIES = new Set(["class", "work", "exercise", "social", "meal", "appointment", "commute", "sleep"]);

// ---------- time helpers ----------
const fmtCache = new Map();
export function localParts(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { dow: DAYS.indexOf(p.weekday), hour: +p.hour, minute: +p.minute, dateKey: `${p.year}-${p.month}-${p.day}` };
}
export function label(ms, endMs, tz) {
  const d = new Date(ms);
  const day = d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
  const t = (x) => new Date(x).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
  return endMs ? `${day}, ${t(ms)}–${t(endMs)}` : `${day}, ${t(ms)}`;
}
const grid = () => Array.from({ length: 7 }, () => Array(24).fill(0));

/** Visit each (dow, hour) cell an interval covers, weighted by the fraction of the hour covered. */
function eachHour(start, end, tz, fn) {
  for (let t = start; t < end; t += 15 * MIN) {
    const { dow, hour } = localParts(t, tz);
    fn(dow, hour, 0.25);
  }
}

// ---------- places ----------
export function distanceM(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Attach pings to known places; discover new places where you repeatedly spend time. */
export function updatePlaces(userId) {
  const places = db.prepare("SELECT * FROM places WHERE user_id = ?").all(userId);
  const setPlace = db.prepare("UPDATE pings SET place_id = ? WHERE id = ?");
  const loose = db.prepare(
    "SELECT * FROM pings WHERE user_id = ? AND place_id IS NULL AND ts > ? AND (acc IS NULL OR acc < 250) ORDER BY ts DESC LIMIT 4000",
  ).all(userId, Date.now() - 90 * DAY);

  const unassigned = [];
  for (const p of loose) {
    const near = nearest(places, p);
    if (near) setPlace.run(near.id, p.id); else unassigned.push(p);
  }

  // greedy density clustering: >= 8 samples within 100 m on >= 2 different days = a place
  const used = new Set();
  let created = 0;
  for (const p of unassigned) {
    if (used.has(p.id)) continue;
    const nb = unassigned.filter((q) => !used.has(q.id) && distanceM(p, q) < 100);
    const days = new Set(nb.map((q) => Math.floor(q.ts / DAY)));
    if (nb.length < 8 || days.size < 2) continue;
    const lat = nb.reduce((s, q) => s + q.lat, 0) / nb.length;
    const lng = nb.reduce((s, q) => s + q.lng, 0) / nb.length;
    const { lastInsertRowid } = db.prepare("INSERT INTO places (user_id, lat, lng) VALUES (?, ?, ?)").run(userId, lat, lng);
    const place = { id: Number(lastInsertRowid), lat, lng, radius: 120 };
    places.push(place);
    for (const q of unassigned) {
      if (!used.has(q.id) && distanceM(place, q) < place.radius) { used.add(q.id); setPlace.run(place.id, q.id); }
    }
    created++;
  }
  return created;
}

function nearest(places, p) {
  let best = null, bestD = Infinity;
  for (const pl of places) {
    const d = distanceM(pl, p);
    if (d < (pl.radius || 120) && d < bestD) { best = pl; bestD = d; }
  }
  return best;
}

/** Collapse consecutive pings at the same place into visits {place_id, start, end}. */
export function visits(userId, from, to) {
  const pings = db.prepare("SELECT ts, place_id FROM pings WHERE user_id = ? AND ts BETWEEN ? AND ? ORDER BY ts").all(userId, from, to);
  const out = [];
  let cur = null;
  for (const p of pings) {
    if (cur && p.place_id === cur.place_id && p.ts - cur.end <= 45 * MIN) { cur.end = p.ts; continue; }
    if (cur && cur.place_id) out.push(cur);
    cur = { place_id: p.place_id, start: p.ts, end: p.ts };
  }
  if (cur && cur.place_id) out.push(cur);
  // a single sample still means you were there for a bit
  return out.map((v) => ({ ...v, end: Math.max(v.end, v.start + 15 * MIN) }));
}

// ---------- feedback ----------
/** Use location to check whether accepted study sessions in the past actually happened. */
export function verifySessions(userId) {
  const due = db.prepare("SELECT * FROM proposals WHERE user_id = ? AND status = 'accepted' AND end_ms < ?").all(userId, Date.now());
  const places = new Map(db.prepare("SELECT * FROM places WHERE user_id = ?").all(userId).map((p) => [p.id, p]));
  const upd = db.prepare("UPDATE proposals SET status = ? WHERE id = ?");
  for (const s of due) {
    const pings = db.prepare("SELECT place_id FROM pings WHERE user_id = ? AND ts BETWEEN ? AND ?").all(userId, s.start_ms, s.end_ms);
    if (!pings.length) continue; // no evidence: the app asks you instead
    let study = 0, away = 0;
    for (const p of pings) {
      const kind = places.get(p.place_id)?.kind;
      if (STUDY_KINDS.has(kind) || kind === "home") study++;
      else if (AWAY_KINDS.has(kind) || !p.place_id) away++;
    }
    if (study > away) upd.run("completed", s.id);
    else if (away > study) upd.run("skipped", s.id);
  }
}

// ---------- the habit model ----------
export function buildProfile(user) {
  const tz = user.timezone || "UTC";
  const now = Date.now();
  const from = now - 8 * 7 * DAY;
  const study = grid(), busy = grid(), pref = grid();
  const busyWhy = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({})));
  const note = (d, h, why, w) => { busyWhy[d][h][why] = (busyWhy[d][h][why] || 0) + w; };

  const events = db.prepare("SELECT * FROM events WHERE user_id = ? AND start_ms BETWEEN ? AND ? AND all_day = 0").all(user.id, from, now);
  const places = new Map(db.prepare("SELECT * FROM places WHERE user_id = ?").all(user.id).map((p) => [p.id, p]));
  const vs = visits(user.id, from, now);
  const props = db.prepare("SELECT * FROM proposals WHERE user_id = ? AND status IN ('accepted','rejected','completed','skipped')").all(user.id);

  const firstData = Math.min(events[0]?.start_ms ?? now, vs[0]?.start ?? now);
  const weeks = Math.max(1, Math.min(8, (now - firstData) / (7 * DAY)));

  for (const e of events) {
    if (e.tempo_kind === "study") continue; // judged by outcome below instead
    if (e.category === "study") eachHour(e.start_ms, e.end_ms, tz, (d, h, w) => { study[d][h] += w; });
    else if (BUSY_CATEGORIES.has(e.category)) eachHour(e.start_ms, e.end_ms, tz, (d, h, w) => { busy[d][h] += w; note(d, h, e.category, w); });
  }
  for (const v of vs) {
    const pl = places.get(v.place_id);
    if (!pl) continue;
    if (STUDY_KINDS.has(pl.kind)) eachHour(v.start, v.end, tz, (d, h, w) => { study[d][h] += 0.5 * w; });
    else if (AWAY_KINDS.has(pl.kind)) eachHour(v.start, v.end, tz, (d, h, w) => { busy[d][h] += w; note(d, h, `at ${pl.name || pl.kind}`, w); });
  }
  const weight = { completed: 1.5, accepted: 0.4, rejected: -1, skipped: -1.5 };
  for (const p of props) eachHour(p.start_ms, p.end_ms, tz, (d, h, w) => { pref[d][h] += weight[p.status] * w; });

  for (const g of [study, busy]) for (const row of g) for (let h = 0; h < 24; h++) row[h] /= weeks; // -> avg hours/week
  const blur = (g) => g.map((row) => row.map((v, h) => 0.6 * v + 0.2 * (row[h - 1] || 0) + 0.2 * (row[h + 1] || 0)));
  const studyS = blur(study), maxStudy = Math.max(0.25, ...studyS.flat());

  const counts = {
    events: events.length, visits: vs.length, places: places.size, weeks: +weeks.toFixed(1),
    pings: db.prepare("SELECT COUNT(*) n FROM pings WHERE user_id = ?").get(user.id).n,
    outcomes: Object.fromEntries(["accepted", "rejected", "completed", "skipped"].map((s) => [s, props.filter((p) => p.status === s).length])),
  };
  return { tz, study: studyS.map((r) => r.map((v) => v / maxStudy)), busy, pref, busyWhy, counts, places: [...places.values()] };
}

export function scoreSlot(profile, start, end) {
  let s = 0, n = 0;
  const why = new Set();
  eachHour(start, end, profile.tz, (d, h) => {
    const st = profile.study[d][h], bz = Math.min(1, profile.busy[d][h]), pf = profile.pref[d][h];
    s += st - 1.2 * bz + 0.5 * Math.tanh(pf) - (h >= 22 || h < 7 ? 0.3 : 0);
    n++;
    if (st > 0.5) why.add("you often study around this time");
    if (bz > 0.4) {
      const top = Object.entries(profile.busyWhy[d][h]).sort((a, b) => b[1] - a[1])[0]?.[0];
      why.add(`you're usually busy then${top ? ` (${top})` : ""}`);
    }
    if (pf > 0.5) why.add("you've followed through on sessions at this time");
    if (pf < -0.5) why.add("you've skipped/declined sessions at this time");
  });
  return { score: s / Math.max(1, n), why: [...why] };
}

/** Free, habit-scored slots for the next `days` days. */
export function candidateSlots({ profile, busyIntervals, settings, days = 7 }) {
  const tz = profile.tz;
  const dur = settings.sessionMinutes * MIN, buf = settings.bufferMinutes * MIN;
  const step = 30 * MIN;
  let t = Math.ceil((Date.now() + 30 * MIN) / step) * step;
  const end = Date.now() + days * DAY;
  const all = [];
  for (; t + dur <= end; t += step) {
    const a = localParts(t, tz), b = localParts(t + dur - 1, tz);
    if (a.hour < settings.earliestHour || a.dateKey !== b.dateKey) continue;
    if (b.hour + (b.minute + 1) / 60 > settings.latestHour) continue;
    if (busyIntervals.some(([s, e]) => t < e + buf && t + dur > s - buf)) continue;
    all.push({ start: t, end: t + dur, dateKey: a.dateKey, ...scoreSlot(profile, t, t + dur) });
  }
  // keep a diverse, non-overlapping shortlist for the planner
  all.sort((x, y) => y.score - x.score);
  const picked = [], perDay = {};
  for (const c of all) {
    if ((perDay[c.dateKey] || 0) >= settings.maxSessionsPerDay + 2) continue;
    if (picked.some((p) => c.start < p.end + step && c.end > p.start - step)) continue;
    picked.push(c);
    perDay[c.dateKey] = (perDay[c.dateKey] || 0) + 1;
    if (picked.length >= 24) break;
  }
  return picked.sort((x, y) => x.start - y.start).map((c) => ({ ...c, label: label(c.start, c.end, tz) }));
}

/** Plain-language summary of the model, for the planner prompt and the Insights tab. */
export function describeProfile(profile) {
  const lines = [];
  const c = profile.counts;
  lines.push(`Based on ${c.weeks} week(s): ${c.events} calendar events, ${c.pings} location samples, ${c.places} known places.`);
  const top = (g, k) => g.flatMap((row, d) => row.map((v, h) => ({ d, h, v }))).filter((x) => x.v > 0.15).sort((a, b) => b.v - a.v).slice(0, k);
  const fmt = (xs) => xs.map(({ d, h }) => `${DAYS[d]} ${h}:00`).join(", ");
  const st = top(profile.study, 6), bz = top(profile.busy, 8);
  lines.push(st.length ? `Usually studies: ${fmt(st)}.` : "No clear study habit yet.");
  if (bz.length) lines.push(`Usually busy (including things not on the calendar): ${bz.map(({ d, h }) => {
    const why = Object.entries(profile.busyWhy[d][h]).sort((a, b) => b[1] - a[1])[0]?.[0];
    return `${DAYS[d]} ${h}:00${why ? ` (${why})` : ""}`;
  }).join(", ")}.`);
  const o = c.outcomes;
  lines.push(`Past suggestions: ${o.completed} done, ${o.skipped} skipped, ${o.rejected} declined, ${o.accepted} accepted but unverified.`);
  const named = profile.places.filter((p) => p.name).map((p) => `${p.name} (${p.kind})`);
  if (named.length) lines.push(`Places: ${named.join(", ")}.`);
  return lines.join("\n");
}
