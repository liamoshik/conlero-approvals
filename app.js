"use strict";
// CONLERO Approvals: mobile-first reviewer app. No secrets here. Reads via RLS, writes only via RPC (publisher_review / publisher_set_setting).
if (window.top !== window.self) { document.documentElement.textContent = ""; throw new Error("framing refused"); } // anti-clickjacking (static hosting cannot send headers)
const CFG = window.APP_CONFIG;
const sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
const TZ = CFG.timezone; // all scheduling in America/New_York. Never the device timezone.
const S = { me: null, posts: [], approvals: [], settings: {}, tab: "queue", calMode: "week", calAnchor: null, urls: {}, busy: false };

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") el.className = v; else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, ""); else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const toast = (m) => { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 3500); };
const fmt = (iso, tz, o) => new Intl.DateTimeFormat("en-US", { timeZone: tz, ...o }).format(new Date(iso));
const nyWhen = (iso) => fmt(iso, TZ, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";
const ilWhen = (iso) => fmt(iso, "Asia/Jerusalem", { weekday: "short", hour: "numeric", minute: "2-digit" }) + " Israel";
const nyKey = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); // YYYY-MM-DD in New York
const keyToUTC = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const addDays = (k, n) => nyKey(new Date(keyToUTC(k).getTime() + n * 86400000 + 12 * 3600000)).slice(0, 10);
const dowOf = (k) => keyToUTC(k).getUTCDay();
const STATUS = { ready_for_review: ["pending", "Pending approval"], approved: ["approved", "Approved · scheduled"], publishing: ["publishing", "Publishing…"], published: ["published", "Published"], failed: ["failed", "Failed"], needs_reconcile: ["needs_reconcile", "Needs check"], rejected: ["rejected", "Rejected"], changes_requested: ["changes_requested", "Changes requested"], draft: ["", "Proposed (later batch)"], postponed: ["changes_requested", "Postponed"], cancelled: ["", "Cancelled"] };
const chip = (st) => h("span", { class: "chip " + (STATUS[st]?.[0] || "") }, STATUS[st]?.[1] || st);
const PLAT = { instagram: "Instagram", facebook: "Facebook" };
const tagsOf = (a) => (a || []).map((t) => (t.startsWith("#") ? t : "#" + t)).join(" ");
// Exactly how the publisher composes the final text (src/meta.js fullCaption).
const full = (cap, cta, tags) => [String(cap || "").trim(), cta ? String(cta).trim() : "", tagsOf(tags)].filter(Boolean).join("\n\n");
const finalCaption = (p, plat) => plat === "facebook" ? full(p.caption_facebook ?? p.caption, p.cta_facebook ?? p.cta, p.hashtags_facebook ?? p.hashtags) : full(p.caption, p.cta, p.hashtags);
function platformState(p, plat) {
  const r = (p.results || {})[plat];
  if (r && (r.url || r.media_id || r.post_id)) return ["published", "Published", r.url];
  if (r && r.error) return ["failed", "Failed: " + String(r.error).slice(0, 80)];
  if (p.status === "approved") return ["approved", "Scheduled"];
  if (p.status === "ready_for_review") return ["pending", "Awaiting approval"];
  return [STATUS[p.status]?.[0] || "", STATUS[p.status]?.[1] || p.status];
}
async function imgUrl(m) {
  if (S.urls[m.path]) return S.urls[m.path];
  const { data } = await sb.storage.from("media-staging").createSignedUrl(m.path, 3600);
  const u = data?.signedUrl || m.url || "";
  S.urls[m.path] = u; return u;
}

// ---------- data ----------
async function load() {
  const [p, a, s] = await Promise.all([
    sb.from("publisher_posts").select("*").order("schedule_at", { ascending: true }),
    sb.from("publisher_approvals").select("*").order("decided_at", { ascending: false }).limit(200),
    sb.from("publisher_settings").select("*"),
  ]);
  if (p.error) throw p.error;
  S.posts = (p.data || []).filter((x) => !x.meta?.tombstone); S.approvals = a.data || []; // tombstones (removed obsolete packages) are never shown
  S.settings = Object.fromEntries((s.data || []).map((r) => [r.key, r]));
}
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return renderLogin();
  const { data: me } = await sb.from("publisher_reviewers").select("*").eq("user_id", session.user.id).maybeSingle();
  if (!me || !me.active) { await sb.auth.signOut(); return renderLogin("This account is not an approved reviewer."); }
  S.me = me;
  try { await load(); } catch (e) { toast("Load failed: " + e.message); }
  render();
}
sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_IN" && !S.me) boot(); if (ev === "SIGNED_OUT") { S.me = null; renderLogin(); } });

// ---------- login ----------
// Email one-time code (OTP). Only existing, approved reviewers can ever get in: sign-ups are off (shouldCreateUser:false) and boot() re-checks the reviewer allowlist.
const OTP_COOLDOWN = 60; // seconds between code requests from this device (Supabase also rate-limits server-side)
function renderLogin(msg) {
  const app = $("#app"); app.replaceChildren();
  const email = h("input", { type: "email", autocomplete: "email", inputmode: "email", autocapitalize: "none", placeholder: "you@email.com", required: true });
  const pass = h("input", { type: "password", autocomplete: "current-password", placeholder: "Password (optional)" });
  const err = h("p", { class: "muted" }, msg || "");
  const go = async () => {
    err.textContent = "";
    const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
    if (error) err.textContent = "Sign-in failed. Check email and password, or use an email code.";
  };
  const sendCode = async (addr) => {
    const { error } = await sb.auth.signInWithOtp({ email: addr, options: { shouldCreateUser: false } });
    if (!error) return { ok: true };
    if (error.status === 429 || /rate limit/i.test(error.message || "")) return { ok: false, text: "Too many emails sent recently. Please wait a few minutes and try again." };
    if (error.status === 422 || /signups? not allowed|otp_disabled/i.test((error.code || "") + " " + (error.message || ""))) return { ok: true }; // not an approved account: same neutral answer, no code will arrive
    return { ok: false, text: "Could not send the code (" + (error.code || error.status || "network") + "). Try again in a minute." };
  };
  const start = async () => {
    const addr = email.value.trim();
    if (!addr) { err.textContent = "Enter your email first."; return; }
    err.textContent = "Sending...";
    const r = await sendCode(addr);
    if (!r.ok) { err.textContent = r.text; return; }
    renderCode(addr);
  };
  app.append(h("div", { class: "login" }, h("h1", null, "CONLERO Approvals"), h("p", { class: "muted" }, "Private. Approved reviewers only."),
    h("label", null, "Email", email),
    h("button", { class: "btn orange", onclick: start }, "Email me a code"),
    h("details", null, h("summary", { class: "muted" }, "Use a password instead"), h("label", null, "Password", pass), h("button", { class: "btn neutral", onclick: go }, "Sign in")), err));
  function renderCode(addr) {
    app.replaceChildren();
    const code = h("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", pattern: "[0-9]*", maxlength: "10", placeholder: "Code from the email", "aria-label": "Verification code" });
    const note = h("p", { class: "muted" }, "If this email is an approved reviewer, a code is on its way. It expires in about an hour.");
    const cerr = h("p", { class: "muted" }, "");
    const verify = async () => {
      const token = code.value.replace(/\D/g, "");
      if (token.length < 6) { cerr.textContent = "Enter the code from the email."; return; }
      cerr.textContent = "Checking...";
      const { error } = await sb.auth.verifyOtp({ email: addr, token, type: "email" });
      if (error) cerr.textContent = error.status === 429 ? "Too many attempts. Wait a few minutes." : "That code is wrong or expired. Check it or request a new one.";
      // success: onAuthStateChange(SIGNED_IN) -> boot() checks the reviewer allowlist
    };
    const resend = h("button", { class: "btn neutral", disabled: true }, "");
    let left = OTP_COOLDOWN;
    const tick = () => { resend.disabled = left > 0; resend.textContent = left > 0 ? `Resend code in ${left}s` : "Resend code"; if (left > 0) { left--; setTimeout(tick, 1000); } };
    resend.onclick = async () => { if (left > 0) return; left = OTP_COOLDOWN; tick(); const r = await sendCode(addr); cerr.textContent = r.ok ? "A new code was requested." : r.text; };
    tick();
    code.addEventListener("keydown", (e) => { if (e.key === "Enter") verify(); });
    app.append(h("div", { class: "login" }, h("h1", null, "Enter your code"), h("p", { class: "muted" }, "We emailed a code to " + addr + "."), note,
      h("label", null, "Code", code), h("button", { class: "btn orange", onclick: verify }, "Verify and sign in"), resend,
      h("button", { class: "btn neutral", onclick: () => renderLogin() }, "Use a different email"), cerr));
    code.focus();
  }
}

// ---------- shell ----------
function render() {
  const app = $("#app"); app.replaceChildren();
  const paused = S.settings.publishing_paused?.value === true;
  const pend = S.posts.filter((p) => p.status === "ready_for_review").length;
  app.append(h("header", { class: "top" }, h("div", null, h("h1", null, "CONLERO Approvals"), h("div", { class: "sub" }, "Signed in as " + S.me.display_name + " · times in New York")),
    h("button", { class: "btn neutral refresh", onclick: () => load().then(render).catch((e) => toast(e.message)) }, "Refresh")));
  const main = h("main", null);
  if (paused) main.append(h("div", { class: "banner" }, "Publishing is PAUSED. Nothing will be posted until you resume it in Settings."));
  ({ queue: viewQueue, library: viewLibrary, calendar: viewCalendar, history: viewHistory, settings: viewSettings }[S.tab])(main);
  app.append(main);
  const tabs = [["queue", "📥", "Queue" + (pend ? ` (${pend})` : "")], ["library", "📚", "Library"], ["calendar", "🗓️", "Calendar"], ["history", "✅", "History"], ["settings", "⚙️", "Settings"]];
  app.append(h("nav", { class: "tabs" }, tabs.map(([k, ic, lb]) => h("button", { class: S.tab === k ? "on" : "", onclick: () => { S.tab = k; render(); } }, h("span", { class: "ic" }, ic), lb))));
}
function thumbCard(p, onclick) {
  const img = h("img", { class: "thumb", alt: "" });
  if (p.media?.[0]) imgUrl(p.media[0]).then((u) => u && img.setAttribute("src", u));
  return h("div", { class: "card post", onclick },
    img, h("div", null, h("h3", null, p.id), h("div", { class: "muted" }, nyWhen(p.schedule_at)), h("div", { class: "muted" }, ilWhen(p.schedule_at)),
      h("div", null, chip(p.status), (p.platforms || []).map((x) => h("span", { class: "chip" }, PLAT[x])), p.media?.length > 1 ? h("span", { class: "chip" }, p.media.length + " slides") : null, p.meta?.content_type ? h("span", { class: "chip" }, p.meta.content_type === "promotional" ? "Promo" : "Educational") : null, p.meta?.flags?.length ? h("span", { class: "chip warnflag" }, "⚑ " + p.meta.flags.length) : null)));
}

// ---------- views ----------
function viewQueue(main) {
  const pending = S.posts.filter((p) => p.status === "ready_for_review");
  main.append(h("h2", null, "Waiting for your approval"));
  if (!pending.length) main.append(h("div", { class: "card muted" }, "Nothing is waiting. New items appear here when Claude prepares them."));
  const weeks = {}; pending.forEach((p) => { const k = nyKey(new Date(p.schedule_at)); (weeks[addDays(k, -((dowOf(k) + 6) % 7))] ||= []).push(p); }); // weeks run Monday to Sunday (New York)
  Object.keys(weeks).sort().forEach((wk) => {
    const list = weeks[wk];
    main.append(h("h2", null, "Week of " + fmt(keyToUTC(wk), "UTC", { month: "short", day: "numeric" }) + " · " + list.length + " package" + (list.length > 1 ? "s" : "")));
    list.forEach((p) => main.append(thumbCard(p, () => openPost(p.id))));
    main.append(h("button", { class: "btn primary", onclick: () => approveAll(list) }, "Approve all " + list.length + " in this week"));
  });
  const sched = S.posts.filter((p) => ["approved", "publishing"].includes(p.status));
  if (sched.length) { main.append(h("h2", null, "Approved · scheduled")); sched.forEach((p) => main.append(thumbCard(p, () => openPost(p.id)))); }
  const other = S.posts.filter((p) => ["changes_requested", "postponed", "failed", "needs_reconcile"].includes(p.status));
  if (other.length) { main.append(h("h2", null, "Needs attention")); other.forEach((p) => main.append(thumbCard(p, () => openPost(p.id)))); }
}
function viewLibrary(main) {
  const groups = [["Pending approval", ["ready_for_review"]], ["Approved · scheduled", ["approved", "publishing"]], ["Proposed for later batches", ["draft"]], ["Published", ["published"]], ["Needs attention", ["changes_requested", "postponed", "failed", "needs_reconcile"]], ["Rejected or removed from the library", ["rejected", "cancelled"]]];
  main.append(h("div", { class: "card" }, h("strong", null, S.posts.length + " packages in the library"), h("div", { class: "muted" }, groups.map(([t, st]) => t + ": " + S.posts.filter((p) => st.includes(p.status)).length).join(" · "))));
  groups.forEach(([title, st]) => { const list = S.posts.filter((p) => st.includes(p.status)); if (!list.length) return; main.append(h("h2", null, title + " (" + list.length + ")")); list.forEach((p) => main.append(thumbCard(p, () => openPost(p.id)))); });
}
function viewHistory(main) {
  const done = S.posts.filter((p) => ["published", "failed", "needs_reconcile"].includes(p.status) || Object.keys(p.results || {}).length).sort((a, b) => new Date(b.schedule_at) - new Date(a.schedule_at));
  main.append(h("h2", null, "Published content"));
  if (!done.length) main.append(h("div", { class: "card muted" }, "Nothing has been published yet."));
  done.forEach((p) => {
    const c = h("div", { class: "card" }, h("h3", { class: "flat" }, p.id), h("div", { class: "muted" }, nyWhen(p.schedule_at)));
    (p.platforms || []).forEach((pl) => { const [cls, label, url] = platformState(p, pl); c.append(h("div", null, h("span", { class: "chip " + cls }, PLAT[pl] + ": " + label), url ? h("a", { href: url, target: "_blank", rel: "noopener" }, "Open post") : null)); });
    c.addEventListener("click", (e) => { if (e.target.tagName !== "A") openPost(p.id); });
    main.append(c);
  });
}
function viewCalendar(main) {
  const today = nyKey(new Date());
  if (!S.calAnchor) S.calAnchor = today;
  const byDay = {}; S.posts.filter((p) => !["rejected", "cancelled"].includes(p.status)).forEach((p) => { (byDay[nyKey(new Date(p.schedule_at))] ||= []).push(p); });
  const mode = S.calMode, a = S.calAnchor;
  const seg = h("div", { class: "seg" }, ["week", "month"].map((m) => h("button", { class: mode === m ? "on" : "", onclick: () => { S.calMode = m; render(); } }, m === "week" ? "Week" : "Month")));
  const ev = (p) => h("span", { class: "ev", onclick: (e) => { e.stopPropagation(); openPost(p.id); } }, fmt(p.schedule_at, TZ, { hour: "numeric", minute: "2-digit" }) + " " + (STATUS[p.status]?.[1] || p.status).split(" ")[0]);
  if (mode === "week") {
    const start = addDays(a, -dowOf(a)); // Sunday start
    const title = fmt(keyToUTC(start), "UTC", { month: "short", day: "numeric" }) + " – " + fmt(keyToUTC(addDays(start, 6)), "UTC", { month: "short", day: "numeric", year: "numeric" });
    main.append(h("div", { class: "cal-head" }, h("button", { onclick: () => { S.calAnchor = addDays(a, -7); render(); } }, "‹"), h("strong", null, title), h("button", { onclick: () => { S.calAnchor = addDays(a, 7); render(); } }, "›")), seg);
    const list = h("div", { class: "week-list" });
    for (let i = 0; i < 7; i++) {
      const k = addDays(start, i), items = byDay[k] || [];
      list.append(h("div", { class: "card week" }, h("div", { class: "w84" }, h("strong", null, fmt(keyToUTC(k), "UTC", { weekday: "short", month: "short", day: "numeric" })), k === today ? h("div", { class: "chip approved" }, "Today") : null),
        h("div", { class: "grow" }, items.length ? items.map((p) => h("div", { class: "clk", onclick: () => openPost(p.id) }, h("div", null, h("strong", null, fmt(p.schedule_at, TZ, { hour: "numeric", minute: "2-digit" }) + " ET"), " ", chip(p.status)), h("div", { class: "muted" }, p.id))) : h("span", { class: "muted" }, "—"))));
    }
    main.append(list);
  } else {
    const [y, m] = a.split("-").map(Number), first = `${y}-${String(m).padStart(2, "0")}-01`;
    const start = addDays(first, -dowOf(first)), prev = nyKey(new Date(Date.UTC(y, m - 2, 15))).slice(0, 7) + "-15", next = nyKey(new Date(Date.UTC(y, m, 15))).slice(0, 7) + "-15";
    main.append(h("div", { class: "cal-head" }, h("button", { onclick: () => { S.calAnchor = prev; render(); } }, "‹"), h("strong", null, fmt(keyToUTC(first), "UTC", { month: "long", year: "numeric" })), h("button", { onclick: () => { S.calAnchor = next; render(); } }, "›")), seg);
    const grid = h("div", { class: "grid" }, ["S", "M", "T", "W", "T", "F", "S"].map((d) => h("div", { class: "dow" }, d)));
    for (let i = 0; i < 42; i++) {
      const k = addDays(start, i), inMonth = k.slice(0, 7) === first.slice(0, 7);
      grid.append(h("div", { class: "day" + (inMonth ? "" : " dim") + (k === today ? " today" : "") }, h("div", { class: "n" }, String(Number(k.slice(8)))), (byDay[k] || []).map(ev)));
    }
    main.append(grid);
  }
}
function viewSettings(main) {
  const paused = S.settings.publishing_paused?.value === true;
  const pc = h("div", { class: "card" }, h("h3", { class: "flat" }, "Pause all publishing"),
    h("p", { class: "muted" }, paused ? "Publishing is paused. Approved posts stay scheduled but nothing is sent to Facebook or Instagram." : "Publishing is active. Approved posts go out at their scheduled New York time."),
    h("button", { class: "btn " + (paused ? "primary" : "danger"), onclick: async () => {
      if (!confirm(paused ? "Resume publishing?" : "Pause ALL publishing now?")) return;
      await act(() => sb.rpc("publisher_set_setting", { p_key: "publishing_paused", p_value: !paused }), paused ? "Publishing resumed" : "Publishing paused");
    } }, paused ? "Resume publishing" : "Pause all publishing"));
  const bat = S.settings.approval_batches?.value || { days: ["sun", "wed"], time: "09:00" };
  const DAYS = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];
  const boxes = DAYS.map(([k, l]) => h("label", null, h("input", { type: "checkbox", value: k, checked: bat.days.includes(k) }), l));
  const time = h("input", { type: "time", value: bat.time });
  const bc = h("div", { class: "card" }, h("h3", { class: "flat" }, "Approval batches"), h("p", { class: "muted" }, "One consolidated email with an approval link is sent on these days (New York time). You can approve at any time in the app."),
    h("div", { class: "row" }, boxes), h("label", null, "Time (New York)", time),
    h("button", { class: "btn orange", onclick: async () => {
      const days = boxes.map((b) => b.querySelector("input")).filter((i) => i.checked).map((i) => i.value);
      if (!days.length) return toast("Pick at least one day");
      await act(() => sb.rpc("publisher_set_setting", { p_key: "approval_batches", p_value: { days, time: time.value } }), "Batch schedule saved");
    } }, "Save batch schedule"), h("p", { class: "muted" }, "Last changed by " + (S.settings.approval_batches?.updated_by || "—")));
  const ss = S.settings.library_sync_status?.value || {}, sr = S.settings.library_sync_request?.value || {}, sy = S.settings.library_sync?.value || { time: "08:00" };
  const ageH = ss.last_ok_at ? (Date.now() - new Date(ss.last_ok_at)) / 36e5 : null;
  const sc = h("div", { class: "card" }, h("h3", { class: "flat" }, "Library sync"),
    h("p", { class: "muted" }, "The approved library lives on the office PC. It is synchronized once a day at " + sy.time + " ET, and whenever you press the button, while that PC is on. New or deleted files reach the cloud only through this sync."),
    h("div", { class: "kv" }, h("div", null, "Last sync"), h("div", null, ss.last_ok_at ? nyWhen(ss.last_ok_at) + (ageH > 36 ? "  ⚠ more than 36 h ago" : "") : "never"),
      h("div", null, "Inventory"), h("div", null, ss.counts ? `${ss.counts.standalone_posts} posts + ${ss.counts.carousels} carousel(s) = ${ss.counts.packages} packages, ${ss.counts.images} images` : "—"),
      h("div", null, "Held for you"), h("div", null, (ss.held_for_decision || []).length ? ss.held_for_decision.join(", ") + " (source of a removed package: tell Claude whether to rebuild it)" : "none"),
      h("div", null, "Request"), h("div", null, sr.pending ? "Waiting for the office PC (asked " + nyWhen(sr.requested_at) + ")" : "none")),
    h("button", { class: "btn orange", disabled: !!sr.pending, onclick: () => act(() => sb.rpc("publisher_request_sync"), "Sync requested. The office PC picks it up within about 15 minutes.") }, sr.pending ? "Sync requested…" : "Sync Library Now"));
  main.append(pc, sc, bc, h("div", { class: "card" }, h("p", { class: "muted" }, "Signed in as " + S.me.display_name + " (" + S.me.email + ")"), h("button", { class: "btn neutral", onclick: () => sb.auth.signOut() }, "Sign out")));
}

// Always shown in the approval screen: content type, CTA strategy, destinations, hashtags, verified contact details.
function contactCard(p) {
  const c = S.settings.contact_info?.value || {}, m = p.meta || {};
  const rows = [
    ["Content type", m.content_type === "promotional" ? "Promotional (20% of the mix)" : m.content_type === "educational" ? "Educational (80% of the mix)" : "Not set"],
    ["CTA strategy", m.cta_strategy || "Not set"],
    ["Posts to", (p.platforms || []).map((x) => PLAT[x]).join(" + ")],
    ...(p.platforms || []).map((x) => [PLAT[x] + " hashtags", tagsOf(x === "facebook" ? (p.hashtags_facebook ?? p.hashtags) : p.hashtags) || "none"]),
    ["Phone", c.phone || "—"], ["Website", c.website || "—"], ["Email", c.email || "—"],
    ["Facebook Page", c.facebook || "—"], ["Instagram profile", c.instagram || "—"], ["Verified", c.verified_on || "—"],
  ];
  return h("div", { class: "card kv" }, rows.flatMap(([k, v]) => [h("div", null, k), h("div", null, v)]),
    h("div", null, "Note"), h("div", null, "Buttons drawn inside the image (e.g. FREE INSPECTION) are not clickable. The phone number does not have to be in every caption."));
}

async function approveAll(list) {
  const NL = String.fromCharCode(10);
  const lines = list.map((p) => "• " + nyWhen(p.schedule_at) + " · " + p.id).join(NL);
  if (!confirm("Approve " + list.length + " packages?" + NL + NL + lines + NL + NL + "Each is released for its own scheduled time. Nothing is posted immediately.")) return;
  if (S.busy) return; S.busy = true; let ok = 0; const bad = [];
  for (const p of list) { const { error } = await sb.rpc("publisher_review", { p_id: p.id, p_hash: p.content_hash, p_decision: "approved", p_note: null }); if (error) bad.push(p.id + ": " + String(error.message).slice(0, 60)); else ok++; }
  S.busy = false; await load().catch(() => {}); render(); toast(bad.length ? "Approved " + ok + " of " + list.length + ". Problem: " + bad[0] : "Approved " + ok + " packages (each at its own scheduled time)");
}

// ---------- post detail ----------
async function act(fn, okMsg) {
  if (S.busy) return false; S.busy = true;
  try { const { error } = await fn(); if (error) throw error; await load(); toast(okMsg); return true; }
  catch (e) { toast(String(e.message || e).replace(/^.*STALE/, "STALE")); await load().catch(() => {}); return false; }
  finally { S.busy = false; render(); }
}
async function openPost(id) {
  const p = S.posts.find((x) => x.id === id); if (!p) return;
  const sheet = h("div", { class: "sheet" }); document.body.append(sheet);
  const close = () => sheet.remove();
  const slides = h("div", { class: "slides" });
  (p.media || []).forEach((m, i) => { const im = h("img", { alt: "Slide " + (i + 1), loading: "lazy" }); imgUrl(m).then((u) => { if (u) { im.setAttribute("src", u); im.addEventListener("click", () => window.open(u, "_blank", "noopener")); } }); slides.append(h("div", { class: "slide" }, im, (p.media || []).length > 1 ? h("div", { class: "muted" }, "Slide " + (i + 1) + " of " + p.media.length) : null)); });
  let plat = (p.platforms || [])[0] || "instagram";
  const capBox = h("div", { class: "caption" }), seg = h("div", { class: "seg" }), checks = h("div", null);
  const paint = () => {
    seg.replaceChildren(...(p.platforms || []).map((x) => h("button", { class: x === plat ? "on" : "", onclick: () => { plat = x; paint(); } }, PLAT[x])));
    const text = finalCaption(p, plat); capBox.textContent = text;
    const web = new RegExp(CFG.business.website.replace(".", "\\."), "i").test(text), ph = new RegExp(CFG.business.phoneMatch).test(text);
    checks.replaceChildren(h("div", { class: "check " + (web ? "ok" : "no") }, "Website " + CFG.business.website + (web ? " is in the caption" : " is NOT in the caption")),
      h("div", { class: "check " + (ph ? "ok" : "na") }, ph ? "Phone " + CFG.business.phoneDisplay + " is in the caption" : "Phone " + CFG.business.phoneDisplay + " is not in this caption (optional)"),
      h("div", { class: "check na" }, text.length + " characters · " + ((text.match(/#\w+/g) || []).length) + " hashtags"));
  };
  paint();
  const content = h("div", { class: "content" }, slides, h("div", { class: "mt" }, chip(p.status), (p.platforms || []).map((x) => { const [c, l, u] = platformState(p, x); return h("span", { class: "chip " + c }, PLAT[x] + ": " + l); })),
    h("h2", null, "Full caption (exactly as it will post)"), seg, capBox, checks,
    h("h2", null, "Contact details and CTA strategy"), contactCard(p),
    p.meta?.flags?.length ? h("div", { class: "card flags" }, h("strong", null, "Flags for your attention (not blocking)"), p.meta.flags.map((f) => h("p", { class: "muted" }, "⚑ " + f))) : null,
    h("h2", null, "Details"), h("div", { class: "card kv" }, h("div", null, "Scheduled"), h("div", null, nyWhen(p.schedule_at)), h("div", null, "Israel time"), h("div", null, ilWhen(p.schedule_at)),
      h("div", null, "Version"), h("div", null, "v" + p.version + " · " + p.content_hash.slice(0, 12)), h("div", null, "Images"), h("div", null, (p.media || []).map((m) => `${m.width}×${m.height}`).join(", ")),
      h("div", null, "Approved by"), h("div", null, p.approved_by ? p.approved_by + " · " + nyWhen(p.approved_at) : "—"), p.review_note ? [h("div", null, "Note"), h("div", null, p.review_note)] : null,
      p.error ? [h("div", null, "Error"), h("div", null, p.error)] : null));
  const hist = S.approvals.filter((a) => a.post_id === p.id);
  if (hist.length) content.append(h("h2", null, "Decision history"), h("div", { class: "card" }, hist.map((a) => h("div", { class: "muted" }, `${a.decision} · ${a.decided_by} · v${a.version} (${a.content_hash.slice(0, 8)}) · ${nyWhen(a.decided_at)}${a.note ? " · " + a.note : ""}`))));
  if (p.status === "draft") content.append(h("div", { class: "card muted" }, (p.meta?.needs_caption ? "New file found in the library. Claude is preparing its caption and schedule; it is not in the approval queue yet." : "This package is proposed for a later batch and is not in the approval queue yet. It moves to the queue in an upcoming batch.")));
  const doDecision = async (decision, needNote) => {
    const note = needNote ? $("#note", sheet).value.trim() : null;
    if (decision === "changes_requested" && !note) return toast("Please write what should change");
    const msg = decision === "approved" ? `Approve v${p.version} (${p.content_hash.slice(0, 8)}) for ${nyWhen(p.schedule_at)} on ${p.platforms.map((x) => PLAT[x]).join(" + ")}?\nIt will be posted automatically at that time.` : decision === "rejected" ? "Reject this post?" : decision === "postponed" ? "Postpone this post? It will not publish until it is rescheduled." : "Send change request?";
    if (!confirm(msg)) return;
    if (await act(() => sb.rpc("publisher_review", { p_id: p.id, p_hash: p.content_hash, p_decision: decision, p_note: note }), decision === "approved" ? "Approved and scheduled" : "Saved")) close();
  };
  if (["ready_for_review", "approved"].includes(p.status)) {
    content.append(h("h2", null, p.status === "approved" ? "Pull back before it posts" : "Your decision"));
    if (p.status === "ready_for_review") content.append(h("button", { class: "btn primary", onclick: () => doDecision("approved") }, "Approve and schedule"));
    content.append(h("label", null, "Comment (required for “Request changes”)", h("textarea", { id: "note", placeholder: "What should change?" })),
      h("button", { class: "btn warn", onclick: () => doDecision("changes_requested", true) }, "Request changes"),
      h("button", { class: "btn neutral", onclick: () => doDecision("postponed", true) }, "Postpone"),
      h("button", { class: "btn danger", onclick: () => doDecision("rejected", true) }, "Reject"));
  }
  sheet.append(h("div", { class: "bar" }, h("button", { onclick: close }, "‹ Back"), h("strong", null, p.id)), content);
}

if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
boot();
