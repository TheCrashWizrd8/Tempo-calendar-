import { OAuth2Client } from "google-auth-library";
import { calendar as gcal } from "@googleapis/calendar";
import { db } from "./db.js";

const SCOPES = [
  "openid", "email", "profile",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

export function oauthClient() {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BASE_URL || "http://localhost:3000"}/auth/google/callback`,
  );
}

export function authUrl(state) {
  return oauthClient().generateAuthUrl({
    access_type: "offline", prompt: "consent", scope: SCOPES, state,
  });
}

export async function exchangeCode(code) {
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
  return { tokens, profile: ticket.getPayload() };
}

function calendarFor(user) {
  const client = oauthClient();
  client.setCredentials(JSON.parse(user.tokens));
  // persist refreshed access tokens
  client.on("tokens", (t) => {
    const merged = { ...JSON.parse(user.tokens), ...t };
    user.tokens = JSON.stringify(merged);
    db.prepare("UPDATE users SET tokens = ? WHERE id = ?").run(user.tokens, user.id);
  });
  return gcal({ version: "v3", auth: client });
}

export async function getTimezone(user) {
  const { data } = await calendarFor(user).calendars.get({ calendarId: "primary" });
  return data.timeZone || "UTC";
}

export async function listEvents(user, timeMin, timeMax) {
  const cal = calendarFor(user);
  const out = [];
  let pageToken;
  do {
    const { data } = await cal.events.list({
      calendarId: "primary",
      timeMin: new Date(timeMin).toISOString(),
      timeMax: new Date(timeMax).toISOString(),
      singleEvents: true, orderBy: "startTime", maxResults: 2500, pageToken,
    });
    out.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out.filter((e) => e.status !== "cancelled");
}

export async function insertEvent(user, ev) {
  const tz = user.timezone || "UTC";
  const body = {
    summary: ev.title,
    location: ev.location || undefined,
    description: ev.notes || undefined,
    recurrence: ev.recurrence ? [ev.recurrence] : undefined,
    colorId: ev.colorId,
    extendedProperties: ev.tempoKind ? { private: { tempo: ev.tempoKind } } : undefined,
  };
  if (ev.all_day) {
    const s = ev.start.slice(0, 10);
    let e = (ev.end || ev.start).slice(0, 10);
    if (e <= s) e = addDays(s, 1);
    body.start = { date: s };
    body.end = { date: e };
  } else if (typeof ev.start === "number") {
    body.start = { dateTime: new Date(ev.start).toISOString(), timeZone: tz };
    body.end = { dateTime: new Date(ev.end).toISOString(), timeZone: tz };
  } else {
    // local wall-clock time like 2026-11-18T14:00 interpreted in the calendar's timezone
    body.start = { dateTime: ev.start.slice(0, 19), timeZone: tz };
    body.end = { dateTime: (ev.end || ev.start).slice(0, 19), timeZone: tz };
  }
  const { data } = await calendarFor(user).events.insert({ calendarId: "primary", requestBody: body });
  return data;
}

export async function deleteEvent(user, id) {
  await calendarFor(user).events.delete({ calendarId: "primary", eventId: id });
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Normalise a Google event into our row shape. */
export function toRow(e) {
  const allDay = !!e.start?.date;
  const start = allDay ? Date.parse(e.start.date + "T00:00:00Z") : Date.parse(e.start.dateTime);
  const end = allDay ? Date.parse(e.end.date + "T00:00:00Z") : Date.parse(e.end.dateTime);
  return {
    gcal_id: e.id, start_ms: start, end_ms: end, all_day: allDay ? 1 : 0,
    summary: e.summary || "(no title)", location: e.location || null,
    description: (e.description || "").slice(0, 500),
    tempo_kind: e.extendedProperties?.private?.tempo || null,
  };
}
