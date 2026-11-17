const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let me = null;
const inNativeApp = !!window.ReactNativeWebView;

async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body ? "POST" : "GET"), headers: {}, credentials: "same-origin" };
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body) { init.body = JSON.stringify(opts.body); init.headers["Content-Type"] = "application/json"; }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { showLogin(); throw new Error("Please sign in"); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function toast(msg, ms = 2800) {
  const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add("hidden"), ms);
}
async function busy(btn, label, fn) {
  const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>${label}`;
  try { return await fn(); } catch (e) { toast(e.message, 5000); } finally { btn.disabled = false; btn.innerHTML = old; }
}
const tz = () => me?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { timeZone: tz(), hour: "numeric", minute: "2-digit" });
const dayKey = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: tz() });
const fmtDay = (ms) => new Date(ms).toLocaleDateString([], { timeZone: tz(), weekday: "long", month: "short", day: "numeric" });
const fmtSlot = (p) => `${new Date(p.start_ms).toLocaleDateString([], { timeZone: tz(), weekday: "short", month: "short", day: "numeric" })} · ${fmtTime(p.start_ms)}–${fmtTime(p.end_ms)}`;

function showLogin() {
  $("#app").classList.add("hidden"); $("#login").classList.remove("hidden");
  if (inNativeApp) window.ReactNativeWebView.postMessage(JSON.stringify({ type: "signed-out" }));
}

// ---------------- tabs ----------------
const loaders = { agenda: loadAgenda, study: loadStudy, insights: loadInsights, import: async () => {} };
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => openTab(b.dataset.tab)));
function openTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("hidden", s.id !== `tab-${name}`));
  try { localStorage.setItem("tab", name); } catch {}
  loaders[name]().catch((e) => toast(e.message));
}

// ---------------- agenda ----------------
async function loadAgenda() {
  const [{ events, proposals }, study] = await Promise.all([api("/api/agenda?days=14"), api("/api/study")]);
  renderCheckins(study.needsCheckIn);
  const items = [...events.map((e) => ({ ...e, kind: "event" })), ...proposals.map((p) => ({ ...p, kind: "proposal" }))]
    .filter((x) => x.end_ms > Date.now() - 3600000 || x.all_day)
    .sort((a, b) => a.start_ms - b.start_ms);
  if (!items.length) { $("#agenda").innerHTML = `<div class="empty">Nothing on your calendar yet.<br>Tap ↻ Sync, or import a screenshot.</div>`; return; }
  let html = "", cur = "";
  for (const it of items) {
    // all-day events are stored as UTC midnight; show them on their own date
    const k = it.all_day ? new Date(it.start_ms).toISOString().slice(0, 10) : dayKey(it.start_ms);
    if (k < dayKey(Date.now()) && it.all_day) continue;
    if (k !== cur) { cur = k; html += `<div class="day">${fmtDay(it.all_day ? Date.parse(k + "T12:00:00") : it.start_ms)}</div>`; }
    html += it.kind === "proposal" ? proposalCard(it) : eventCard(it);
  }
  $("#agenda").innerHTML = html;
}
function eventCard(e) {
  const time = e.all_day ? "All day" : `${fmtTime(e.start_ms)}<br>${fmtTime(e.end_ms)}`;
  return `<div class="ev ${e.tempo_kind === "study" || e.category === "study" ? "study" : ""}">
    <div class="time">${time}</div>
    <div class="body"><div class="title">${esc(e.summary)}${e.category ? `<span class="chip">${esc(e.category.replace(/_/g, " "))}</span>` : ""}</div>
    ${e.location ? `<div class="meta">📍 ${esc(e.location)}</div>` : ""}</div></div>`;
}
function proposalCard(p) {
  return `<div class="ev proposal" data-id="${p.id}">
    <div class="time">${fmtTime(p.start_ms)}<br>${fmtTime(p.end_ms)}</div>
    <div class="body"><div class="title">📚 ${esc(p.subject)} <span class="chip">suggested</span></div>
    <div class="meta">${esc(p.reason)}</div>
    <div class="actions"><button class="btn primary small" data-act="accept">Add to calendar</button><button class="btn small" data-act="reject">Not then</button></div></div></div>`;
}
function renderCheckins(list) {
  $("#checkins").innerHTML = list.map((p) => `<div class="card" data-id="${p.id}">
    <b>Did you study ${esc(p.subject)}?</b><div class="muted small">${fmtSlot(p)}</div>
    <div class="actions" style="display:flex;gap:6px;margin-top:8px"><button class="btn primary small" data-act="done">Yes 👍</button><button class="btn small" data-act="skipped">Skipped it</button></div>
    </div>`).join("");
}
document.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-act]");
  if (!btn) return;
  const id = btn.closest("[data-id]")?.dataset.id;
  const act = btn.dataset.act;
  if (!id) return;
  await busy(btn, "", async () => {
    if (act === "accept") { await api(`/api/study/${id}/accept`, { method: "POST" }); toast("Added to Google Calendar"); }
    if (act === "reject") { await api(`/api/study/${id}/reject`, { method: "POST" }); toast("Got it — I'll learn from that"); }
    if (act === "done" || act === "skipped") { await api(`/api/study/${id}/outcome`, { body: { done: act === "done" } }); toast(act === "done" ? "Nice! Noted." : "Noted — I'll adjust."); }
    const tab = localStorage.getItem("tab") || "agenda";
    await loaders[tab]();
  });
});

$("#sync-btn").addEventListener("click", (e) => busy(e.currentTarget, "Syncing", async () => {
  const r = await api("/api/sync", { method: "POST" });
  toast(`Synced ${r.events} events${r.newPlaces ? ` · found ${r.newPlaces} new place(s)` : ""}`);
  await loaders[localStorage.getItem("tab") || "agenda"]();
}));

// ---------------- import ----------------
let imageFile = null;
function setImage(file) {
  if (!file || !file.type.startsWith("image/")) return;
  imageFile = file;
  const img = $("#preview"); img.src = URL.createObjectURL(file); img.classList.remove("hidden");
  $("#drop-text").classList.add("hidden"); $("#extract-btn").disabled = false;
  $("#extracted").innerHTML = ""; $("#import-status").textContent = "";
}
$("#file").addEventListener("change", (e) => setImage(e.target.files[0]));
const drop = $("#drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); setImage(e.dataTransfer.files[0]); });
document.addEventListener("paste", (e) => {
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith("image/"));
  if (f) { openTab("import"); setImage(f); }
});

let extracted = [];
$("#extract-btn").addEventListener("click", (e) => busy(e.currentTarget, "Reading…", async () => {
  const fd = new FormData(); fd.append("image", imageFile); fd.append("hint", $("#hint").value);
  const r = await api("/api/import/screenshot", { body: fd });
  extracted = r.events;
  $("#import-status").textContent = extracted.length ? `Found ${extracted.length} event(s). ${r.notes_for_user || ""}` : `No events found. ${r.notes_for_user || ""}`;
  renderExtracted();
}));
function renderExtracted() {
  if (!extracted.length) { $("#extracted").innerHTML = ""; return; }
  $("#extracted").innerHTML = extracted.map((ev, i) => `<div class="card x-ev ${ev.confidence === "low" ? "conf-low" : ""}" data-i="${i}">
    <input type="checkbox" class="pick" checked aria-label="Include">
    <div class="fields">
      <input class="input wide" data-f="title" value="${esc(ev.title)}">
      <input class="input" data-f="start" value="${esc(ev.start)}" title="Start">
      <input class="input" data-f="end" value="${esc(ev.end)}" title="End">
      <input class="input wide" data-f="location" value="${esc(ev.location || "")}" placeholder="Location">
      ${ev.recurrence ? `<div class="muted small wide">🔁 ${esc(ev.recurrence.replace("RRULE:", ""))}</div>` : ""}
      ${ev.confidence !== "high" ? `<div class="muted small wide">⚠ ${ev.confidence} confidence — double-check</div>` : ""}
    </div></div>`).join("") + `<button id="confirm-import" class="btn primary">Add selected to Google Calendar</button>`;
  $("#confirm-import").addEventListener("click", (e) => busy(e.currentTarget, "Adding…", async () => {
    const chosen = [...document.querySelectorAll(".x-ev")].filter((c) => c.querySelector(".pick").checked).map((c) => {
      const ev = { ...extracted[c.dataset.i] };
      c.querySelectorAll("[data-f]").forEach((inp) => { ev[inp.dataset.f] = inp.value || null; });
      return ev;
    });
    if (!chosen.length) return toast("Nothing selected");
    const r = await api("/api/import/confirm", { body: { events: chosen } });
    toast(`Added ${r.created.length} event(s)`);
    extracted = []; renderExtracted(); $("#import-status").textContent = "";
  }));
}

// ---------------- study ----------------
async function loadStudy() {
  const s = await api("/api/study");
  $("#proposals").innerHTML = s.proposed.map((p) => proposalCard(p).replace('<div class="time">', `<div class="time">${new Date(p.start_ms).toLocaleDateString([], { timeZone: tz(), weekday: "short", day: "numeric" })}<br>`)).join("");
  $("#booked").innerHTML = s.upcoming.length ? s.upcoming.map((p) => `<div class="ev study"><div class="body"><div class="title">${esc(p.subject)}</div><div class="meta">${fmtSlot(p)}</div></div></div>`).join("") : "None yet.";
}
$("#propose-btn").addEventListener("click", (e) => busy(e.currentTarget, "Planning…", async () => {
  const r = await api("/api/study/propose", { body: { goals: $("#goals").value, days: Number($("#plan-days").value) } });
  $("#plan-summary").textContent = r.summary; $("#plan-summary").classList.remove("hidden");
  await loadStudy();
}));

// ---------------- insights ----------------
const KINDS = ["unknown", "home", "school", "library", "work", "gym", "cafe", "social", "other"];
async function loadInsights() {
  const d = await api("/api/insights");
  $("#summary").textContent = d.summary;
  heat("#heat-study", d.study.map((row, i) => row.map((v, h) => Math.max(0, v + 0.3 * Math.tanh(d.pref[i][h])))), "--study");
  heat("#heat-busy", d.busy, "--busy");
  $("#places").innerHTML = d.places.length ? d.places.map((p) => `<div class="card place" data-pid="${p.id}">
      <input class="input" data-k="name" value="${esc(p.name || "")}" placeholder="Name this place${p.guessed ? "" : " (e.g. Library)"}">
      <select class="input" data-k="kind">${KINDS.map((k) => `<option ${k === p.kind ? "selected" : ""}>${k}</option>`).join("")}</select>
      <button class="btn small" data-save>Save</button><button class="btn small danger" data-del>✕</button>
      <div class="muted small" style="flex-basis:100%">${p.hours} h over ${p.visits} visits (8 wks)${p.guessed ? " · name guessed by AI" : ""} · <a href="https://maps.google.com/?q=${p.lat},${p.lng}" target="_blank" rel="noopener">map</a></div>
    </div>`).join("") : `<p class="muted">No places yet. Turn on location learning below — places appear after you've spent time somewhere on 2+ days.</p>`;
  $("#ingest-url").value = me.ingestUrl;
  const f = $("#settings");
  for (const [k, v] of Object.entries(me.settings)) if (f.elements[k]) f.elements[k].value = Array.isArray(v) ? v.join(", ") : v;
  $("#who").textContent = `${me.name || ""} (${me.email}) · ${me.timezone}`;
}
function heat(sel, g, color) {
  const H0 = 6, H1 = 24;
  const max = Math.max(0.01, ...g.flat());
  let html = `<div></div>`;
  for (let h = H0; h < H1; h++) html += `<div class="hl">${h % 3 === 0 ? h : ""}</div>`;
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((day, d) => {
    html += `<div class="lbl">${day}</div>`;
    for (let h = H0; h < H1; h++) {
      const a = Math.min(1, g[d][h] / max);
      html += `<div class="c" title="${day} ${h}:00" style="${a > 0.02 ? `background:rgba(var(${color}),${(0.15 + 0.85 * a).toFixed(2)})` : ""}"></div>`;
    }
  });
  $(sel).innerHTML = html;
}
$("#places").addEventListener("click", async (e) => {
  const card = e.target.closest("[data-pid]"); if (!card) return;
  const id = card.dataset.pid;
  if (e.target.matches("[data-save]")) {
    await api(`/api/places/${id}`, { method: "PUT", body: { name: card.querySelector("[data-k=name]").value, kind: card.querySelector("[data-k=kind]").value } });
    toast("Saved");
  } else if (e.target.matches("[data-del]") && confirm("Forget this place?")) {
    await api(`/api/places/${id}`, { method: "DELETE" }); loadInsights();
  }
});
$("#settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  me.settings = await api("/api/settings", { method: "PUT", body });
  toast("Preferences saved");
});
$("#copy-ingest").addEventListener("click", async () => { await navigator.clipboard.writeText(me.ingestUrl); toast("Copied"); });
$("#rotate-ingest").addEventListener("click", async () => {
  if (!confirm("Old link will stop working. Continue?")) return;
  await api("/api/ingest-token/rotate", { method: "POST" }); me = await api("/api/me"); $("#ingest-url").value = me.ingestUrl;
  if (inNativeApp) window.ReactNativeWebView.postMessage(JSON.stringify({ type: "ingest-url", url: me.ingestUrl }));
});
$("#forget-loc").addEventListener("click", async () => {
  if (!confirm("Delete all location samples and learned places?")) return;
  await api("/api/location-history", { method: "DELETE" }); toast("Location history deleted"); loadInsights();
});
$("#logout").addEventListener("click", async () => { await api("/auth/logout", { method: "POST" }); showLogin(); });

// ---------------- location while open ----------------
let watchId = null;
function setLocation(on) {
  try { localStorage.setItem("loc", on ? "1" : "0"); } catch {}
  $("#loc-toggle").checked = on;
  $("#loc-dot").classList.toggle("on", on);
  if (inNativeApp) { window.ReactNativeWebView.postMessage(JSON.stringify({ type: "location", enabled: on })); return; }
  if (on && watchId === null && "geolocation" in navigator) {
    watchId = navigator.geolocation.watchPosition(
      (p) => api("/api/location", { body: { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, ts: p.timestamp } }).catch(() => {}),
      (err) => { toast(`Location: ${err.message}`); setLocation(false); },
      { enableHighAccuracy: false, maximumAge: 120000, timeout: 30000 },
    );
  } else if (!on && watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
}
$("#loc-toggle").addEventListener("change", (e) => setLocation(e.target.checked));
if (inNativeApp) {
  // Google doesn't allow sign-in inside embedded web views: let the app open the system browser.
  document.querySelector("#login a").addEventListener("click", (e) => {
    e.preventDefault();
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: "sign-in" }));
  });
}
if (inNativeApp) $("#loc-toggle").parentElement.lastChild.textContent = " Learn from my location (works in the background)";

// ---------------- boot ----------------
(async () => {
  try { me = await api("/api/me"); } catch { return; }
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  if (inNativeApp) window.ReactNativeWebView.postMessage(JSON.stringify({ type: "signed-in", ingestUrl: me.ingestUrl }));
  let saved = "agenda", loc = false;
  try { saved = localStorage.getItem("tab") || "agenda"; loc = localStorage.getItem("loc") === "1"; } catch {}
  setLocation(loc);
  openTab(saved);
  if (!sessionStorage.getItem("synced")) {
    sessionStorage.setItem("synced", "1");
    api("/api/sync", { method: "POST" }).then(() => loaders[saved]()).catch((e) => toast(`Sync: ${e.message}`));
  }
})();
if ("serviceWorker" in navigator && !inNativeApp) navigator.serviceWorker.register("/sw.js").catch(() => {});
