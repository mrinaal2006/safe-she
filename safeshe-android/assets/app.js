/* SafeShe Rides client: passenger, rider (driver) and admin.
 * Talks to the SafeShe server (REST + Socket.IO). Native features via window.Android (MainActivity.java);
 * in a normal browser it falls back to web APIs where possible. */
(function () {
  "use strict";
  var A = window.Android || null;
  var $ = function (id) { return document.getElementById(id); };
  var CHECK_SECONDS = 30, MIN_AWAY_MS = 3000;
  var VEH_ICON = { bike: "🏍️", auto: "🛺", cab: "🚗", pink: "🚘" };
  var VEH_NAME = { bike: "Bike", auto: "Auto", cab: "Cab", pink: "Pink Cab" };

  // ============================================================ utilities
  function toast(msg, ms) {
    var t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast._h); toast._h = setTimeout(function () { t.classList.remove("show"); }, ms || 3200);
  }
  function status(id, msg, kind) { var e = $(id); if (!e) return; e.textContent = msg || ""; e.className = "status" + (kind ? " " + kind : ""); }
  function pref(k, v) {
    if (v === undefined) { try { return A ? A.getPref(k) : (localStorage.getItem("ss_" + k) || ""); } catch (e) { return ""; } }
    try { if (A) A.setPref(k, v); else localStorage.setItem("ss_" + k, v); } catch (e) {}
  }
  function jpref(k, v) {
    if (v === undefined) { try { return JSON.parse(pref(k) || "null"); } catch (e) { return null; } }
    pref(k, v === null ? "" : JSON.stringify(v));
  }
  function el(tag, props) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k]; if (v == null || v === false) return;
      if (k === "class") e.className = v; else if (k === "text") e.textContent = v;
      else if (k === "value") e.value = v;
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? "" : v);
    });
    for (var i = 2; i < arguments.length; i++) [].concat(arguments[i]).forEach(function (c) {
      if (c == null || c === false) return;
      e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    });
    return e;
  }
  function fmt(ms) { var s = Math.floor(ms / 1000); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); }
  function rupees(n) { return "₹" + Math.round(n || 0); }
  function when(ts) { return ts ? new Date(ts).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : ""; }
  function hav(a, b) {
    var R = 6371, r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function mapsLink(lat, lng) { return "https://maps.google.com/?q=" + lat.toFixed(6) + "," + lng.toFixed(6); }
  function digitsOnly(s) { return String(s || "").replace(/\D/g, ""); }
  function shortName(n) { return (n || "").split(",").slice(0, 2).join(",").trim(); }
  function vibrate(ms) { if (A) A.vibrate(ms); else if (navigator.vibrate) navigator.vibrate(ms); }
  function beep() {
    try {
      var C = window.AudioContext || window.webkitAudioContext; if (!C) return;
      var c = beep.c || (beep.c = new C()), o = c.createOscillator(), g = c.createGain();
      o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + 0.25);
    } catch (e) {}
  }
  function dial(n) { if (!n) return; if (A) A.dial(n); else location.href = "tel:" + n; }
  function openUrl(u) { if (A) A.openUrl(u); else window.open(u, "_blank", "noopener"); }

  // ============================================================ server + API
  var isWeb = /^https?:$/.test(location.protocol);
  function apiBase() {
    if (isWeb && !A) return "";                              // served by the SafeShe server itself
    // The server address built into the app always wins; a typed address is only used by builds without one.
    return (window.SAFESHE_API || pref("server") || "").replace(/\/+$/, "");
  }
  function absUrl(u) { return /^https?:/.test(u || "") ? u : (apiBase() || location.origin) + (u || ""); }
  var session = jpref("session");
  function saveSession(s) { session = s; jpref("session", s); }

  function api(method, path, body) {
    var h = { "Content-Type": "application/json" };
    if (session && session.token) h.Authorization = "Bearer " + session.token;
    return fetch(apiBase() + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (r.status === 401 && session && path.indexOf("/api/auth/") !== 0 && path !== "/api/admin/login") forceLogout("Your session ended. Please log in again.");
          if (!r.ok) throw Object.assign(new Error(j.error || ("Server error " + r.status)), { status: r.status });
          return j;
        });
      }, function () { throw new Error("Can't reach the SafeShe server. Check your internet connection."); });
  }

  // Live updates: poll /api/events (works on serverless hosts such as Vercel).
  var live = { on: false, timer: null, cursor: null, gen: 0, fails: 0 };
  var HANDLERS = {
    "account:blocked": function () { forceLogout("Your account has been blocked. Contact SafeShe support."); },
    "ride:update": function (r) { onRideUpdate(r); },
    "ride:driver_location": function (d) { if (curRide && d.rideId === curRide.id) moveDriver([d.lat, d.lng]); },
    "ride:offer": function (o) { addOffer(o); },
    "ride:offer_closed": function (o) { removeOffer(o.rideId); },
    "driver:status": function (d) { toast(d.status === "approved" ? "You're approved! You can go online now." : "Your rider application was not approved."); boot(); },
    "admin:sos": function (s) { vibrate(600); beep(); toast("🆘 SOS from " + ((s.user && s.user.name) || "a user") + "!", 6000); adminLive("sos"); },
    "admin:ride": function () { adminLive("ride"); },
    "admin:driver_pending": function () { toast("New rider waiting for approval"); adminLive("rider"); },
    "admin:payment": function (p) { toast("💰 " + (p.name || "A rider") + " reported a commission payment of " + rupees(p.amount), 5000); adminLive("payment"); },
    "admin:pass": function (p) { toast("🎫 " + (p.name || "A rider") + " bought a " + (p.kind === "full" ? "Full-Day" : "Half-Day") + " Pass (" + rupees(p.price) + ")", 5000); adminLive("payment"); },
    "payment:update": function (p) { toast(p.status === "confirmed" ? "✅ Your payment of " + rupees(p.amount) + " was confirmed" : "❌ Your payment of " + rupees(p.amount) + " was not verified. Check the UPI reference.", 6000); loadDues(); }
  };
  function connectSocket() { // name kept for the callers; starts the event poller
    stopLive();
    if (!session) return;
    live.on = true; live.cursor = null; live.fails = 0; var gen = ++live.gen;
    function next(ms) { if (live.on && gen === live.gen) live.timer = setTimeout(pollOnce, ms); }
    function pollOnce() {
      if (!live.on || gen !== live.gen) return;
      api("GET", "/api/events" + (live.cursor != null ? "?after=" + live.cursor : "")).then(function (r) {
        if (gen !== live.gen) return;
        var first = live.cursor == null;
        live.cursor = r.cursor; live.fails = 0; $("netbar").hidden = true;
        if (first && session && session.kind === "user") refreshActive();
        (r.events || []).forEach(function (e) { var h = HANDLERS[e.type]; if (h) try { h(e.data); } catch (x) { console.error(x); } });
        next(document.hidden ? 8000 : 2000);
      }).catch(function () {
        live.fails++; if (live.fails > 1) $("netbar").hidden = false;
        next(Math.min(15000, 2000 * live.fails));
      });
    }
    pollOnce();
  }
  function stopLive() { live.on = false; live.gen++; clearTimeout(live.timer); }
  // Rider position → server (throttled to one update every 4 s).
  var lastLocSent = 0;
  function sendDriverLocation(d, force) {
    if (!driverOnline || !d) return;
    if (!force && Date.now() - lastLocSent < 4000) return;
    lastLocSent = Date.now();
    api("POST", "/api/driver/location", { lat: d.lat, lng: d.lng }).catch(function () {});
  }

  // ============================================================ screens
  var SCREENS = ["scr-offline", "scr-server", "scr-welcome", "scr-login", "scr-profile", "scr-driver-profile", "scr-driver-pending", "scr-main", "scr-admin"];
  function showScreen(id) { SCREENS.forEach(function (s) { $(s).hidden = s !== id; }); closePages(); openDrawer(false); if (id === "scr-main" && map) setTimeout(function () { map.invalidateSize(); }, 50); }
  function showView(id) {
    ["pv-home", "pv-choose", "pv-ride", "pv-done", "dv-home", "dv-ride"].forEach(function (v) { $(v).hidden = v !== id; });
    $("sheet").scrollTop = 0; syncSheet();
  }

  var me = null;
  function boot() {
    if (!apiBase() && !isWeb) { showScreen("scr-server"); $("serverUrl").value = pref("server") || ""; return; }
    if (!session) { showScreen("scr-welcome"); return; }
    if (session.kind === "admin") {
      api("GET", "/api/admin/stats").then(function () { connectSocket(); showScreen("scr-admin"); adminTab(adminCur || "dash"); })
        .catch(function (e) { if (e.status !== 401) offlineRetry(e); });
      return;
    }
    api("GET", "/api/me").then(function (r) {
      me = r.user; renderMe();
      if (me.role === "passenger") {
        if (!me.name) return openProfile();
        startMain("passenger"); if (r.activeRide) setRide(r.activeRide); else if (!curRide) showView("pv-home");
      } else {
        if (!me.name || !me.driver) return openDriverProfile();
        if (me.driver.status !== "approved") return showPending();
        startMain("driver"); if (r.activeRide) setDriverRide(r.activeRide); else showView("dv-home");
        restoreOnline();
      }
      connectSocket();
    }).catch(function (e) {
      if (e.status === 401 || e.status === 403) return;
      offlineRetry(e);
    });
  }
  // No internet / server unreachable: stay logged in and keep retrying (the login is never dropped for this).
  var retryTimer = null;
  function offlineRetry() {
    showScreen("scr-offline");
    clearTimeout(retryTimer); retryTimer = setTimeout(boot, 5000);
  }
  $("btnRetryNow").onclick = function () { clearTimeout(retryTimer); boot(); };
  function forceLogout(msg) {
    if (driverOnline) setOnlineLocal(false);
    stopLive();
    saveSession(null); me = null; curRide = null; driverRide = null; role = null;
    if (msg) toast(msg, 4500);
    showScreen("scr-welcome");
  }
  function logout() {
    var p = driverOnline ? api("POST", "/api/driver/online", { online: false }).catch(function () {}) : Promise.resolve();
    p.then(function () { return api("POST", "/api/logout").catch(function () {}); }).then(function () { forceLogout("Logged out."); });
  }

  // ---------------- server setup
  $("btnServerSave").onclick = function () {
    var u = $("serverUrl").value.trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s/]+/.test(u)) { status("serverStatus", "Enter the full address, starting with https://", "bad"); return; }
    status("serverStatus", "Connecting…");
    fetch(u + "/api/health").then(function (r) { return r.json(); }).then(function (j) {
      if (!j.ok) throw new Error();
      pref("server", u);
      if (/^http:/.test(u)) toast("Warning: this connection is not encrypted (http). Use https for real use.", 5000);
      boot();
    }).catch(function () { status("serverStatus", "Couldn't reach a SafeShe server at that address.", "bad"); });
  };

  // ---------------- login
  var loginRole = "passenger", otpPhone = "", resendTimer = null;
  document.querySelectorAll(".rolecard").forEach(function (b) {
    b.onclick = function () {
      loginRole = b.dataset.role;
      $("loginTitle").textContent = loginRole === "driver" ? "Log in as a Rider" : "Log in to book rides";
      $("loginPhone").hidden = false; $("loginOtp").hidden = true; $("loginAdmin").hidden = true;
      status("loginStatus", ""); showScreen("scr-login"); $("phoneInput").focus();
    };
  });
  $("btnAdminLogin").onclick = function () {
    loginRole = "admin"; $("loginPhone").hidden = true; $("loginOtp").hidden = true; $("loginAdmin").hidden = false;
    status("loginStatus", ""); showScreen("scr-login");
  };
  $("btnLoginBack").onclick = function () { showScreen("scr-welcome"); };
  function sendOtp() {
    var p = digitsOnly($("phoneInput").value).slice(-10);
    if (!/^[6-9]\d{9}$/.test(p)) { status("loginStatus", "Enter a valid 10-digit mobile number.", "bad"); return; }
    $("btnSendOtp").disabled = true; status("loginStatus", "Sending OTP…");
    api("POST", "/api/auth/otp/send", { phone: p, role: loginRole }).then(function (r) {
      otpPhone = p;
      $("loginPhone").hidden = true; $("loginOtp").hidden = false;
      $("otpSentTo").textContent = "Sent to +91 " + p.slice(0, 5) + " " + p.slice(5);
      if (r.devCode) { $("testCode").hidden = false; $("testCode").innerHTML = ""; $("testCode").appendChild(el("span", null, "Test mode (no SMS provider configured). Your code: ", el("b", { text: r.devCode }))); }
      else $("testCode").hidden = true;
      status("loginStatus", ""); $("otpInput").value = ""; $("otpInput").focus();
      var left = 30; $("btnResend").disabled = true; clearInterval(resendTimer);
      resendTimer = setInterval(function () { left--; $("btnResend").textContent = left > 0 ? "Resend in " + left + "s" : "Resend OTP"; if (left <= 0) { clearInterval(resendTimer); $("btnResend").disabled = false; } }, 1000);
    }).catch(function (e) { status("loginStatus", e.message, "bad"); }).then(function () { $("btnSendOtp").disabled = false; });
  }
  $("btnSendOtp").onclick = sendOtp;
  $("phoneInput").addEventListener("keydown", function (e) { if (e.key === "Enter") sendOtp(); });
  $("btnResend").onclick = function () { $("phoneInput").value = otpPhone; sendOtp(); };
  $("btnChangePhone").onclick = function () { $("loginPhone").hidden = false; $("loginOtp").hidden = true; status("loginStatus", ""); };
  function verifyOtp() {
    var c = digitsOnly($("otpInput").value);
    if (c.length !== 6) { status("loginStatus", "Enter the 6-digit code.", "bad"); return; }
    if (verifyOtp.busy) return; verifyOtp.busy = true;
    $("btnVerifyOtp").disabled = true; status("loginStatus", "Verifying…");
    api("POST", "/api/auth/otp/verify", { phone: otpPhone, role: loginRole, code: c }).then(function (r) {
      saveSession({ token: r.token, kind: "user", role: r.user.role }); status("loginStatus", ""); boot();
    }).catch(function (e) { status("loginStatus", e.message, "bad"); }).then(function () { $("btnVerifyOtp").disabled = false; verifyOtp.busy = false; });
  }
  $("btnVerifyOtp").onclick = verifyOtp;
  $("otpInput").addEventListener("input", function () { if (digitsOnly(this.value).length === 6) verifyOtp(); });
  $("btnAdminDoLogin").onclick = function () {
    var u = $("adminUser").value.trim(), p = $("adminPass").value;
    if (!u || !p) { status("loginStatus", "Enter your username or email, and your password.", "bad"); return; }
    status("loginStatus", "Logging in…");
    api("POST", "/api/admin/login", { username: u, password: p }).then(function (r) {
      $("adminPass").value = ""; saveSession({ token: r.token, kind: "admin" }); status("loginStatus", ""); boot();
    }).catch(function (e) { status("loginStatus", e.message, "bad"); });
  };
  $("adminPass").addEventListener("keydown", function (e) { if (e.key === "Enter") $("btnAdminDoLogin").click(); });
  // Warn about Caps Lock (passwords are case-sensitive) and let the admin see what they typed.
  ["keydown", "keyup"].forEach(function (ev) {
    $("adminPass").addEventListener(ev, function (e) { if (e.getModifierState) $("capsWarn").hidden = !e.getModifierState("CapsLock"); });
  });
  $("btnShowPass").onclick = function () {
    var p = $("adminPass"), show = p.type === "password";
    p.type = show ? "text" : "password"; this.textContent = show ? "Hide" : "Show"; p.focus();
  };

  // ---------------- profiles
  function local10(p) { return (p || "").replace(/^\+91/, ""); }
  function openProfile() {
    $("pfName").value = me.name || ""; $("pfGender").value = me.gender || ""; $("pfEmergency").value = local10(me.emergencyPhone);
    status("profileStatus", ""); showScreen("scr-profile");
  }
  $("btnProfileSave").onclick = function () {
    api("PUT", "/api/me", { name: $("pfName").value, gender: $("pfGender").value, emergencyPhone: digitsOnly($("pfEmergency").value) })
      .then(function (r) { me = r.user; renderMe(); boot(); }).catch(function (e) { status("profileStatus", e.message, "bad"); });
  };
  var dpVehicle = "";
  document.querySelectorAll("#dpVehicle button").forEach(function (b) {
    b.onclick = function () { dpVehicle = b.dataset.v; document.querySelectorAll("#dpVehicle button").forEach(function (x) { x.classList.toggle("on", x === b); }); };
  });
  function openDriverProfile() {
    var d = me.driver || {};
    $("dpName").value = me.name || ""; $("dpGender").value = me.gender || "female";
    $("dpModel").value = d.vehicleModel || ""; $("dpPlate").value = d.plate || ""; $("dpLicense").value = d.licenseNo || ""; $("dpUpi").value = d.upiId || ""; $("dpEmergency").value = local10(me.emergencyPhone);
    dpVehicle = d.vehicleType || ""; document.querySelectorAll("#dpVehicle button").forEach(function (x) { x.classList.toggle("on", x.dataset.v === dpVehicle); });
    status("driverProfileStatus", ""); showScreen("scr-driver-profile");
  }
  $("btnDriverProfileSave").onclick = function () {
    if (!dpVehicle) { status("driverProfileStatus", "Choose your vehicle type.", "bad"); return; }
    api("PUT", "/api/me", { name: $("dpName").value, gender: $("dpGender").value, emergencyPhone: digitsOnly($("dpEmergency").value) })
      .then(function () { return api("POST", "/api/driver/profile", { vehicleType: dpVehicle, vehicleModel: $("dpModel").value, plate: $("dpPlate").value, licenseNo: $("dpLicense").value, upiId: $("dpUpi").value.trim() }); })
      .then(function (r) { me = r.user; boot(); }).catch(function (e) { status("driverProfileStatus", e.message, "bad"); });
  };
  function showPending() {
    var rej = me.driver.status === "rejected";
    $("pendTitle").textContent = rej ? "Application not approved" : "Waiting for approval";
    $("pendText").textContent = rej ? "Your rider application was not approved. Check your details and resubmit, or contact SafeShe support."
      : "The SafeShe team is reviewing your details. You'll be able to go online as soon as you're approved. This screen updates automatically.";
    showScreen("scr-driver-pending"); connectSocket();
  }
  $("btnPendEdit").onclick = function () { openDriverProfile(); };
  $("btnPendLogout").onclick = logout;

  function renderMe() {
    if (!me) return;
    var box = $("meBox"); box.innerHTML = "";
    box.appendChild(el("b", { text: me.name || "SafeShe user" }));
    box.appendChild(el("span", { class: "muted", text: me.phone + " · " + (me.role === "driver" ? "Rider" : "Passenger") }));
    $("emergencyText").textContent = me.emergencyPhone ? "Alerts and trip links are pre-filled for " + me.emergencyPhone + "." : "No emergency contact yet. Add one so SOS alerts reach someone you trust.";
    var c = $("accountCard"); c.innerHTML = "";
    c.appendChild(el("h3", { text: me.name }));
    c.appendChild(el("p", { class: "muted small", text: me.phone + (me.gender ? " · " + me.gender : "") }));
    if (me.emergencyPhone) c.appendChild(el("p", { class: "small", text: "Emergency contact: " + me.emergencyPhone }));
    if (me.driver) c.appendChild(el("p", { class: "small", text: VEH_NAME[me.driver.vehicleType] + " · " + me.driver.vehicleModel + " · " + me.driver.plate + " · " + me.driver.status }));
    if (me.driver) c.appendChild(el("p", { class: "small", text: me.driver.upiId ? "UPI ID for passenger payments: " + me.driver.upiId : "⚠️ Add your UPI ID (Edit my details) so passengers can pay you by UPI." }));
  }
  $("btnEditProfile").onclick = function () { if (me.role === "driver") openDriverProfile(); else openProfile(); };
  $("btnEditContact").onclick = function () { $("btnEditProfile").onclick(); };

  // ============================================================ map (shared)
  var map = null, pickupMarker = null, dropMarker = null, driverMarker = null, routeLine = null, meMarker = null;
  var sheet = $("sheet");
  function syncSheet() { document.documentElement.style.setProperty("--sheet-h", sheet.offsetHeight + "px"); }
  if (window.ResizeObserver) new ResizeObserver(syncSheet).observe(sheet);
  function icon(cls, html) { return L.divIcon({ className: "", html: '<div class="mk ' + cls + '">' + (html || "") + "</div>", iconSize: [30, 30], iconAnchor: [15, 15] }); }
  function initMap() {
    if (map) return;
    map = L.map("map", { zoomControl: false }).setView([20.59, 78.96], 5);
    // Base map: OpenFreeMap vector map (free, no key, no limits) drawn with MapLibre; raster tiles as a fallback.
    // The server can switch provider via /api/config (TILE_STYLE for a vector style, TILE_URL for raster tiles).
    var base = baseLayer(DEFAULT_MAP).addTo(map);
    api("GET", "/api/config").then(function (c) {
      var t = c && c.map; if (!t || (t.style || t.url) === (DEFAULT_MAP.style || DEFAULT_MAP.url)) return;
      map.removeLayer(base); base = baseLayer(t).addTo(map);
    }).catch(function () {});
    map.on("click", onMapClick);
  }
  function fit(points) {
    points = points.filter(Boolean); if (!points.length || !map) return;
    if (points.length === 1) { map.setView(points[0], 16); return; }
    map.fitBounds(L.latLngBounds(points), { paddingTopLeft: [40, 90], paddingBottomRight: [40, sheet.offsetHeight + 30], maxZoom: 16 });
  }
  function setLayer(cur, latlng, cls, html) {
    if (!latlng) { if (cur) map.removeLayer(cur); return null; }
    if (cur) { cur.setLatLng(latlng); return cur; }
    return L.marker(latlng, { icon: icon(cls, html), zIndexOffset: cls ? 0 : 1000 }).addTo(map);
  }
  function drawRoute(pts, approx) {
    if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
    if (pts && pts.length > 1) routeLine = L.polyline(pts, { color: "#0f9d58", weight: 5, opacity: .9, dashArray: approx ? "8 8" : null }).addTo(map);
  }
  var DEFAULT_MAP = { style: "https://tiles.openfreemap.org/styles/liberty",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", maxZoom: 19,
    attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>' };
  function webglOk() {
    try { var c = document.createElement("canvas"); return !!(window.WebGLRenderingContext && (c.getContext("webgl") || c.getContext("experimental-webgl"))); } catch (e) { return false; }
  }
  /** Vector map (MapLibre) when the device supports WebGL, otherwise raster tiles. */
  function baseLayer(t) {
    if (t.style && L.maplibreGL && window.maplibregl && webglOk())
      return L.maplibreGL({ style: t.style, attribution: t.attribution || DEFAULT_MAP.attribution });
    return L.tileLayer(t.url || DEFAULT_MAP.url, { subdomains: t.subdomains || "abc", maxZoom: t.maxZoom || 19, attribution: t.attribution || DEFAULT_MAP.attribution });
  }
  var role = null;
  function startMain(r) {
    role = r; showScreen("scr-main"); initMap();
    $("roleTag").textContent = r === "driver" ? "rider" : "rides";
    if (r === "passenger") { renderSaved(); loadRegions(); if (!pickup) locatePickup(); }
    else { refreshDriverStats(); getLocation(function (d) { if (d) { meMarker = setLayer(meMarker, [d.lat, d.lng], "mk-pick"); if (!driverRide) map.setView([d.lat, d.lng], 15); } }); }
  }
  $("btnRecenter").onclick = function () {
    if (role === "passenger") { if (curRide) fitRide(); else locatePickup(); }
    else if (myPos) map.setView([myPos.lat, myPos.lng], 16);
  };

  // ============================================================ location (shared)
  var myPos = null, locWaiters = [], locListeners = [], webWatch = null;
  function getLocation(cb) {
    if (myPos && Date.now() - myPos.recv < 30000) { cb(myPos); return; }
    locWaiters.push(cb);
    if (locWaiters.length > 1) return;
    if (A) { A.getLocation(); return; }
    if (navigator.geolocation) navigator.geolocation.getCurrentPosition(function (p) {
      resolveLoc({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, time: Date.now() });
    }, function () { resolveLoc(null, "Location permission is needed."); }, { timeout: 10000, enableHighAccuracy: true });
    else resolveLoc(null, "Location unavailable.");
  }
  function resolveLoc(d, err) {
    if (d) { d.recv = Date.now(); myPos = d; locListeners.forEach(function (f) { f(d); }); }
    if (!d && myPos && locWaiters.length) { d = myPos; err = null; }
    var w = locWaiters; locWaiters = []; w.forEach(function (cb) { cb(d, err); });
  }
  function startWatch() {
    if (A && A.startWatch) { A.startWatch(); return; }
    if (navigator.geolocation && webWatch == null) webWatch = navigator.geolocation.watchPosition(function (p) {
      resolveLoc({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, time: Date.now() });
    }, function () {}, { enableHighAccuracy: true, maximumAge: 5000 });
  }
  function stopWatch() {
    if (A && A.stopWatch) A.stopWatch();
    if (webWatch != null) { navigator.geolocation.clearWatch(webWatch); webWatch = null; }
  }

  // ============================================================ PASSENGER
  var pickup = null, pickupName = "", drop = null, dropName = "", quote = null, chosen = null;
  var pickMode = null, curRide = null, payModes = [["cash", "💵 Cash"], ["upi", "📱 UPI"]], payIdx = 0;

  function setPickup(p, name) {
    pickup = p; pickupName = name || "Current location";
    $("pickupText").textContent = pickupName;
    pickupMarker = setLayer(pickupMarker, p, "mk-pick");
    if (!drop) map.setView(p, 16);
  }
  function locatePickup() {
    $("pickupText").textContent = "Finding your location…";
    getLocation(function (d, err) {
      if (!d) { $("pickupText").textContent = "Location unavailable. Tap to set pickup on the map"; toast(err || "Couldn't get your location."); return; }
      var p = [d.lat, d.lng]; setPickup(p, "Current location"); startWatch();
      autoRegion(p);
      api("GET", "/api/geo/reverse?lat=" + p[0] + "&lng=" + p[1]).then(function (r) { if (r.name && pickup === p) { pickupName = r.name; $("pickupText").textContent = r.name; } }).catch(function () {});
    });
  }

  // ---------------- service regions: the passenger's city; search and booking work inside it
  var regions = [], region = null, regionManual = false;
  function regionFor(p, activeOnly) {
    var best = null, bestKm = Infinity;
    regions.forEach(function (r) {
      if (activeOnly && !r.active) return;
      var km = hav([r.lat, r.lng], p);
      if (km <= r.radiusKm && km < bestKm) { best = r; bestKm = km; }
    });
    return best;
  }
  function loadRegions() {
    return api("GET", "/api/regions").then(function (r) {
      regions = r.regions || [];
      var saved = +pref("region") || 0;
      if (!region && saved) { region = regions.find(function (x) { return x.id === saved; }) || null; regionManual = !!region; }
      if (pickup) autoRegion(pickup); else renderRegion();
    }).catch(function () {});
  }
  function autoRegion(p) {
    if (!regions.length) return;
    var here = regionFor(p, true) || regionFor(p, false);
    if (here && (!regionManual || !region)) { region = here; pref("region", String(here.id)); }
    renderRegion(p);
  }
  function renderRegion(p) {
    p = p || pickup;
    $("regionChip").textContent = "📍 " + (region ? region.name : "Choose region") + " ▾";
    var w = $("regionWarn"), msg = "";
    if (region && !region.active) msg = "SafeShe is coming soon to " + region.name + ". Rides aren't available there yet.";
    else if (region && p && hav([region.lat, region.lng], p) > region.radiusKm) msg = "Your pickup is outside " + region.name + ". Tap the pickup to set it inside the city.";
    else if (!region && p && regions.length && !regionFor(p, false)) msg = "SafeShe isn't available at your location yet. Choose a city to see where we operate.";
    w.textContent = msg; w.hidden = !msg; syncSheet();
  }
  function openRegionPicker() {
    $("regionModal").classList.add("show"); $("regionFilter").value = ""; renderRegionList("");
    // Refresh: the admin may have made a city reachable / not reachable since the app opened.
    api("GET", "/api/regions").then(function (r) {
      regions = r.regions || [];
      if (region) region = regions.find(function (x) { return x.id === region.id; }) || null;
      renderRegionList($("regionFilter").value); renderRegion();
    }).catch(function () {});
  }
  function renderRegionList(filter) {
    var ul = $("regionList"); ul.innerHTML = ""; filter = (filter || "").toLowerCase();
    var mine = pickup ? regionFor(pickup, false) : null;
    regions.filter(function (r) { return !filter || (r.name + " " + r.state).toLowerCase().indexOf(filter) >= 0; })
      .sort(function (a, b) { return (b.active - a.active) || (a === mine ? -1 : b === mine ? 1 : 0); })
      .forEach(function (r) {
        ul.appendChild(el("li", { class: (r.active ? "" : "off") + (region && region.id === r.id ? " cur" : ""), onclick: function () {
          region = r; regionManual = true; pref("region", String(r.id)); $("regionModal").classList.remove("show");
          $("results").innerHTML = ""; renderRegion();
          if (!pickup || hav([r.lat, r.lng], pickup) > r.radiusKm) map.setView([r.lat, r.lng], 12);
          toast(r.active ? "Showing places in " + r.name : r.name + ": coming soon");
        } },
          el("span", null, el("b", { text: r.name }), el("span", { class: "muted", text: " · " + r.state + (r === mine ? " · you are here" : "") })),
          el("span", { class: "pill " + (r.active ? "" : "grey"), text: r.active ? "✅ Available" : "Coming soon" })));
      });
    if (!ul.children.length) ul.appendChild(el("li", { class: "muted", text: "No matching city." }));
  }
  $("regionChip").onclick = openRegionPicker;
  $("btnRegionClose").onclick = function () { $("regionModal").classList.remove("show"); };
  $("regionFilter").addEventListener("input", function () { renderRegionList(this.value); });
  $("pickupRow").onclick = function () { if (curRide) return; pickMode = "pickup"; toast("Tap the map to set your pickup point"); sheet.style.transform = "translateY(70%)"; syncSheet(); };
  $("btnPickOnMap").onclick = function () { pickMode = "drop"; toast("Tap the map to set your destination"); sheet.style.transform = "translateY(70%)"; syncSheet(); };
  function onMapClick(e) {
    if (!pickMode || role !== "passenger" || curRide) return;
    var mode = pickMode, p = [e.latlng.lat, e.latlng.lng]; pickMode = null; sheet.style.transform = ""; syncSheet();
    if (mode === "pickup") { setPickup(p, "Pinned pickup"); if (drop) requestQuote(); }
    else setDrop(p, "Pinned location");
    api("GET", "/api/geo/reverse?lat=" + p[0] + "&lng=" + p[1]).then(function (r) {
      if (!r.name) return;
      if (mode === "pickup" && pickup === p) { pickupName = r.name; $("pickupText").textContent = r.name; }
      if (mode === "drop" && drop === p) { dropName = r.name; $("destText").textContent = "To: " + r.name; }
    }).catch(function () {});
  }

  // Destination search: suggestions while typing (any place, ranked near the pickup), full search on Enter.
  var searchSeq = 0, suggestTimer = null;
  function runSearch(q, suggest) {
    var list = $("results"), seq = ++searchSeq;
    if (!suggest || !list.children.length) { list.innerHTML = ""; list.appendChild(el("li", { class: "muted", text: "Searching…" })); }
    var near = pickup ? "&lat=" + pickup[0] + "&lng=" + pickup[1] : "";
    var reg = region ? "&region=" + region.id : ""; // search only inside the chosen region
    api("GET", "/api/geo/search?q=" + encodeURIComponent(q) + near + reg + (suggest ? "&suggest=1" : "")).then(function (r) {
      if (seq !== searchSeq) return; // a newer search is running
      list.innerHTML = "";
      if (!r.results.length) { list.appendChild(el("li", { class: "muted", text: suggest ? "Keep typing, or press 🔍 to search everywhere." : "No places found. Try another spelling, add the city, or choose on the map." })); return; }
      r.results.forEach(function (x) {
        list.appendChild(el("li", { onclick: function () { list.innerHTML = ""; $("dropInput").value = x.name; setDrop([x.lat, x.lng], x.name || shortName(x.address)); } },
          el("b", { text: x.name }), el("span", { class: "muted", text: (x.distanceKm != null ? x.distanceKm + " km · " : "") + x.address })));
      });
      syncSheet();
    }).catch(function (err) { if (seq !== searchSeq) return; list.innerHTML = ""; list.appendChild(el("li", { class: "muted", text: err.message })); });
  }
  $("dropInput").addEventListener("input", function () {
    clearTimeout(suggestTimer);
    var q = this.value.trim();
    if (q.length < 3) { searchSeq++; $("results").innerHTML = ""; return; }
    suggestTimer = setTimeout(function () { runSearch(q, true); }, 350);
  });
  $("searchForm").onsubmit = function (e) {
    e.preventDefault(); clearTimeout(suggestTimer);
    var q = $("dropInput").value.trim(); if (q.length < 2) return;
    $("dropInput").blur();
    runSearch(q, false);
  };

  function renderSaved() {
    var box = $("savedChips"); box.innerHTML = "";
    [["home", "🏠 Home"], ["work", "💼 Work"]].forEach(function (s) {
      var v = jpref("place_" + s[0]); if (!v) return;
      box.appendChild(el("button", { class: "chip", text: s[1], onclick: function () { setDrop(v.p, v.name); } }));
    });
  }
  function savePlace(kind) { if (!drop) return; jpref("place_" + kind, { p: drop, name: dropName }); renderSaved(); toast("Saved as " + kind + "."); }
  $("saveHome").onclick = function () { savePlace("home"); };
  $("saveWork").onclick = function () { savePlace("work"); };

  function setDrop(p, name) {
    if (!pickup) { toast("Set your pickup first."); return; }
    drop = p; dropName = name;
    dropMarker = setLayer(dropMarker, p, "mk-drop");
    $("destText").textContent = "To: " + name;
    showView("pv-choose"); requestQuote();
  }
  function requestQuote() {
    quote = null; renderRides(); $("tripMeta").textContent = "Getting fares…"; fit([pickup, drop]);
    var req = { pickup: { lat: pickup[0], lng: pickup[1] }, drop: { lat: drop[0], lng: drop[1] } }, d0 = drop;
    api("POST", "/api/rides/quote", req).then(function (q) {
      if (drop !== d0) return;
      quote = q; drawRoute(q.points, q.approx); fit(q.points);
      $("tripMeta").textContent = (q.approx ? "~" : "") + q.km.toFixed(1) + " km · " + q.min + " min";
      if (!chosen || !q.options.some(function (o) { return o.vehicle === chosen; })) chosen = (q.options.find(function (o) { return o.ridersNearby; }) || q.options[0] || {}).vehicle;
      renderRides();
    }).catch(function (e) { $("tripMeta").textContent = ""; toast(e.message); });
  }
  function renderRides() {
    var ul = $("rides"); ul.innerHTML = "";
    if (!quote) { ul.appendChild(el("li", { class: "muted", text: "Calculating fares…" })); $("btnBook").disabled = true; return; }
    quote.options.forEach(function (o) {
      var b = el("b", { text: o.name }); if (o.vehicle === "pink") b.appendChild(el("span", { class: "tag", text: "Women riders" }));
      ul.appendChild(el("li", { class: o.vehicle === chosen ? "sel" : "", onclick: function () { chosen = o.vehicle; renderRides(); } },
        el("span", { class: "ico", text: VEH_ICON[o.vehicle] || "🚗" }),
        el("div", { class: "info" }, b, el("small", { text: o.ridersNearby ? (o.etaMin + " min away · " + o.ridersNearby + " nearby") : "No riders nearby right now" })),
        el("span", { class: "price", text: rupees(o.fare) })));
    });
    var c = quote.options.find(function (o) { return o.vehicle === chosen; });
    $("btnBook").disabled = !c;
    $("btnBook").textContent = c ? "Book " + c.name + " · " + rupees(c.fare) : "Book";
    var fb = $("fareBreak"); fb.innerHTML = "";
    if (c && c.breakdown) {
      fb.appendChild(fareTable(c.breakdown, "Upfront fare"));
      var notes = [];
      if (quote.gridlock) notes.push("+ " + rupees2(c.perMin) + "/min only if stuck in traffic (below " + quote.gridlock.speedKmh + " km/h for over " + quote.gridlock.minMinutes + " min).");
      if (c.maxPickupSurcharge > 0 && quote.pickup) notes.push("+ " + rupees2(quote.pickup.perKm) + "/km if your rider comes from more than " + quote.pickup.freeKm + " km away (up to " + rupees2(c.maxPickupSurcharge) + "), paid to the rider.");
      if (quote.night) notes.push("🌙 Night fare ×" + quote.nightMultiplier + " (11 PM – 5 AM).");
      notes.forEach(function (n) { fb.appendChild(el("p", { class: "muted small", text: n })); });
    }
    syncSheet();
  }
  /** Fare breakdown table (from the server's pricing engine). */
  function fareTable(b, title) {
    var rows = [["Base fare" + (b.includedKm ? " (first " + b.includedKm + " km)" : ""), b.base]];
    if (b.chargeableKm > 0) rows.push([b.chargeableKm.toFixed(1) + " km × " + rupees2(b.perKm), b.distance]);
    if (b.traffic > 0) rows.push(["Traffic time " + b.trafficMin.toFixed(1) + " min × " + rupees2(b.perMin), b.traffic]);
    if (b.nightExtra > 0) rows.push(["Night premium ×" + b.nightMultiplier, b.nightExtra]);
    if (b.pickupSurcharge > 0) rows.push(["Long pickup (to rider)", b.pickupSurcharge]);
    if (b.platformFee > 0) rows.push(["Platform fee", b.platformFee]);
    return el("div", { class: "farebreak" }, el("div", { class: "between" }, el("b", { text: title }), el("b", { text: rupees(b.total) })),
      rows.map(function (r) { return el("div", { class: "between small" }, el("span", { class: "muted", text: r[0] }), el("span", { text: rupees2(r[1]) })); }));
  }
  $("btnBackHome").onclick = function () { resetPassenger(); };
  $("btnPay").onclick = function () { payIdx = (payIdx + 1) % payModes.length; $("btnPay").textContent = payModes[payIdx][1]; };
  $("btnBook").onclick = function () {
    $("btnBook").disabled = true;
    api("POST", "/api/rides", { pickup: { lat: pickup[0], lng: pickup[1], name: pickupName }, drop: { lat: drop[0], lng: drop[1], name: dropName }, vehicle: chosen, payment: payModes[payIdx][0] })
      .then(function (r) { setRide(r.ride); if (r.route) drawRoute(r.route, r.ride.routeApprox); })
      .catch(function (e) { toast(e.message, 4500); $("btnBook").disabled = false; });
  };

  function setRide(r) {
    var prev = curRide; curRide = r;
    if (!pickup || prev == null || prev.id !== r.id) {
      pickup = [r.pickup.lat, r.pickup.lng]; pickupName = r.pickup.name; drop = [r.drop.lat, r.drop.lng]; dropName = r.drop.name;
      pickupMarker = setLayer(pickupMarker, pickup, "mk-pick"); dropMarker = setLayer(dropMarker, drop, "mk-drop");
      if (!routeLine) drawRoute([pickup, drop], true);
    }
    renderRide(prev);
  }
  function onRideUpdate(r) {
    if (role === "passenger" && curRide && r.id === curRide.id) setRide(r);
    if (role === "driver") onDriverRideUpdate(r);
  }
  function refreshActive() {
    if (!me) return;
    api("GET", "/api/rides/active").then(function (r) {
      if (role === "passenger") {
        if (r.ride) setRide(r.ride);
        else if (curRide && ["requested", "accepted", "arrived", "started"].indexOf(curRide.status) >= 0) api("GET", "/api/rides/" + curRide.id).then(function (x) { setRide(x.ride); }).catch(function () {});
      }
      if (role === "driver") { if (r.ride) setDriverRide(r.ride); refreshOffers(); }
    }).catch(function () {});
  }
  function moveDriver(p) { driverMarker = setLayer(driverMarker, p, "", VEH_ICON[curRide ? curRide.vehicle : "cab"]); updateEta(); }
  function updateEta() {
    if (!curRide || !driverMarker || curRide.status !== "accepted") return;
    var ll = driverMarker.getLatLng(), km = hav([ll.lat, ll.lng], pickup);
    $("rideStatus").textContent = "Rider arriving in ~" + Math.max(1, Math.round(km * 1.3 / 20 * 60)) + " min";
  }
  function fitRide() { var pts = [pickup, drop]; if (driverMarker) { var l = driverMarker.getLatLng(); pts.push([l.lat, l.lng]); } fit(pts); }
  var searchTick = null;
  function renderRide(prev) {
    var r = curRide, s = r.status;
    clearInterval(searchTick);
    if (s === "completed" || s === "cancelled" || s === "no_driver") return renderFinished(r);
    showView("pv-ride");
    $("searchingBox").hidden = s !== "requested";
    $("driverBox").hidden = $("driverActions").hidden = s === "requested";
    $("btnCancelRide").hidden = s === "started";
    $("tripLine").textContent = VEH_NAME[r.vehicle] + " · " + rupees(r.fare) + " · " + (r.payment === "upi" ? "UPI" : "Cash") + " · " + r.distanceKm.toFixed(1) + " km";
    if (s === "requested") {
      $("rideStatus").textContent = "Requesting your ride";
      var tick = function () { $("searchSub").textContent = "Searching for " + Math.max(0, Math.round((Date.now() - r.requestedAt) / 1000)) + " s. Nearby riders are being notified."; };
      tick(); searchTick = setInterval(tick, 1000);
    }
    if (r.driver) {
      var d = r.driver;
      $("drvAvatar").textContent = d.gender === "female" ? "👩" : d.gender === "male" ? "👨" : "🧑";
      $("drvName").textContent = d.name; $("drvRating").textContent = d.rating ? "★ " + d.rating : "New rider";
      $("drvVehicle").textContent = VEH_NAME[r.vehicle] + " · " + (d.vehicleModel || ""); $("drvPlate").textContent = d.plate || "";
      $("otp").textContent = r.otp;
      if (d.lat != null) moveDriver([d.lat, d.lng]);
    }
    if (s === "accepted") { $("rideStatus").textContent = "Rider is on the way"; updateEta(); }
    if (s === "arrived") $("rideStatus").textContent = "Your rider has arrived. Share OTP " + r.otp + " to start";
    if (s === "started") $("rideStatus").textContent = "On the way to " + shortName(r.drop.name);
    if (s !== "requested" && !tripMonitorOn && (!prev || prev.status === "requested")) setTripMonitor(true);
    if (s === "accepted" && prev && prev.status === "requested") {
      vibrate(200); fitRide();
      toast("Rider " + r.driver.name + " accepted your ride" + (r.pickupSurcharge > 0 ? " · long-pickup charge " + rupees2(r.pickupSurcharge) + " added (fare " + rupees(r.fare) + ")" : ""), 5000);
    }
    if (s === "arrived" && prev && prev.status !== "arrived") { vibrate(400); beep(); toast("Your rider has arrived"); }
    if (s === "started" && prev && prev.status !== "started") autoShare(r);
  }
  function renderFinished(r) {
    showView("pv-done"); setTripMonitor(false);
    driverMarker = setLayer(driverMarker, null);
    var ok = r.status === "completed";
    $("doneTitle").textContent = ok ? "You've arrived 🎉" : r.status === "no_driver" ? "No riders available" : "Ride cancelled";
    $("doneFare").textContent = ok ? rupees(r.fare) : "–";
    $("doneMeta").textContent = ok ? VEH_NAME[r.vehicle] + " with " + (r.driver ? r.driver.name : "") + " · " + r.distanceKm.toFixed(1) + " km · " + (r.payment === "upi" ? "Pay by UPI" : "Pay in cash")
      : r.status === "no_driver" ? "No rider accepted in time. Please try again in a few minutes, or choose another ride type."
      : "Cancelled by " + (r.cancelledBy === "passenger" ? "you" : r.cancelledBy === "driver" ? "the rider" : "SafeShe") + (r.cancelReason ? " · " + r.cancelReason : "");
    $("rateBox").hidden = !ok || !!r.rating;
    var dp = $("donePay"); dp.innerHTML = "";
    if (ok) dp.appendChild(passengerPayCard(r));
    var db = $("doneBreak"); db.innerHTML = "";
    if (ok && r.breakdown) db.appendChild(fareTable(r.breakdown, "Fare details"));
    renderStars(0);
  }
  function renderStars(n) {
    var box = $("stars"); box.innerHTML = "";
    for (var i = 1; i <= 5; i++) (function (i) {
      box.appendChild(el("button", { class: i <= n ? "on" : "", text: "★", "aria-label": i + " stars", onclick: function () {
        renderStars(i);
        api("POST", "/api/rides/" + curRide.id + "/rate", { stars: i }).then(function () { toast("Thanks for rating!"); $("rateBox").hidden = true; }).catch(function (e) { toast(e.message); });
      } }));
    })(i);
  }
  $("btnDone").onclick = function () { resetPassenger(); };
  $("btnCancelRide").onclick = function () {
    if (!curRide || !confirm("Cancel this ride?")) return;
    api("POST", "/api/rides/" + curRide.id + "/cancel", { reason: "Cancelled by passenger" }).then(function (r) { setRide(r.ride); }).catch(function (e) { toast(e.message); });
  };
  $("btnCallDriver").onclick = function () { if (curRide && curRide.driver) dial(curRide.driver.phone); };
  function resetPassenger() {
    clearInterval(searchTick);
    curRide = null; drop = null; quote = null;
    dropMarker = setLayer(dropMarker, null); driverMarker = setLayer(driverMarker, null); drawRoute(null);
    $("dropInput").value = ""; $("results").innerHTML = ""; renderSaved(); showView("pv-home");
    if (pickup) map.setView(pickup, 16);
  }

  // ============================================================ ride payments (UPI deep link + QR)
  /** UPI payment link understood by GPay, PhonePe, Paytm, BHIM and other UPI apps. */
  function upiLink(vpa, name, amount, note) {
    return "upi://pay?pa=" + encodeURIComponent(vpa).replace(/%40/g, "@") + "&pn=" + encodeURIComponent(name || "SafeShe") +
      (amount ? "&am=" + Number(amount).toFixed(2) : "") + "&cu=INR" + (note ? "&tn=" + encodeURIComponent(note) : "");
  }
  /** QR code (SVG) for any text, e.g. a UPI link that any UPI app can scan. */
  function qrEl(text) {
    var box = el("div", { class: "qrbox" });
    try { var q = qrcode(0, "M"); q.addData(text); q.make(); box.innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); }
    catch (e) { box.appendChild(el("p", { class: "muted small", text: "QR code unavailable" })); }
    return box;
  }
  /** QR code as a PNG (white background, label underneath) so it can be saved to the gallery. */
  function qrPngDataUrl(text, label) {
    var q = qrcode(0, "M"); q.addData(text); q.make();
    var n = q.getModuleCount(), cell = 10, pad = 40, size = n * cell + pad * 2, extra = label ? 70 : 0;
    var cv = document.createElement("canvas"); cv.width = size; cv.height = size + extra;
    var g = cv.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = "#000";
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect(pad + c * cell, pad + r * cell, cell, cell);
    if (label) { g.font = "bold 26px sans-serif"; g.textAlign = "center"; g.fillText(label, size / 2, size + 30, size - 20); }
    return cv.toDataURL("image/png");
  }
  function copyText(t) {
    if (A && A.copyText) { A.copyText(t); return Promise.resolve(); }
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t);
    var i = el("textarea", { value: t }); i.value = t; document.body.appendChild(i); i.select();
    try { document.execCommand("copy"); } finally { i.remove(); }
    return Promise.resolve();
  }
  /**
   * Other ways to pay when a UPI app declines the "Pay with UPI app" button ("declined for security reasons"):
   * GPay/PhonePe often block payment links opened by another app when the receiver is a personal UPI ID.
   * Paying to the copied UPI ID, or scanning the saved QR from the gallery, works.
   */
  function upiAlt(vpa, name, amount, note) {
    var box = el("div", { class: "upialt" });
    box.appendChild(el("div", { class: "upialt-btns" },
      el("button", { class: "ghost small", text: "📋 Copy UPI ID", onclick: function () {
        copyText(vpa).then(function () { toast("UPI ID copied: " + vpa + ". Open your UPI app → Pay UPI ID / number → paste → " + rupees2(amount), 6000); })
          .catch(function () { toast("UPI ID: " + vpa, 6000); });
      } }),
      el("button", { class: "ghost small", text: "🖼️ Save QR to gallery", onclick: function () {
        var file = "SafeShe-pay-" + String(vpa).replace(/[^A-Za-z0-9]/g, "_") + "-" + Math.round(amount) + ".png";
        var url; try { url = qrPngDataUrl(upiLink(vpa, name, amount, note), "Pay " + rupees2(amount) + " to " + vpa); } catch (e) { toast("Could not make the QR image."); return; }
        if (A && A.saveFile) { A.saveFile(url.split(",")[1], file, "image/png"); toast("Saving the QR… Then in your UPI app tap Scan → 🖼️ gallery and pick it.", 6000); return; }
        var a = document.createElement("a"); a.href = url; a.download = file; document.body.appendChild(a); a.click(); a.remove();
      } })));
    box.appendChild(el("p", { class: "small muted", text: "Payment declined \"for security reasons\"? Your UPI app blocks pay links to personal UPI IDs. " +
      "Copy the UPI ID and pay to it in the app (enter " + rupees2(amount) + "), or save the QR and use Scan → gallery." }));
    return box;
  }
  /** Passenger: pay the rider directly (UPI to the rider's own account, or cash). */
  function passengerPayCard(r) {
    var d = r.driver || {}, amt = r.fare, card = el("div", { class: "paycard" });
    if (r.payment === "upi" && d.upiId) {
      var link = upiLink(d.upiId, d.name, amt, "SafeShe ride #" + r.id);
      card.appendChild(el("h3", { text: "Pay " + rupees(amt) + " to " + (d.name || "your rider") }));
      card.appendChild(el("p", { class: "small muted", text: "The money goes straight to your rider's UPI account." }));
      card.appendChild(el("button", { class: "primary wide", text: "Pay " + rupees(amt) + " with UPI app", onclick: function () { openUrl(link); } }));
      card.appendChild(qrEl(link));
      card.appendChild(el("p", { class: "small center" }, "UPI ID: ", el("span", { class: "upiid", text: d.upiId })));
      card.appendChild(upiAlt(d.upiId, d.name, amt, "SafeShe ride #" + r.id));
    } else if (r.payment === "upi") {
      card.appendChild(el("h3", { text: "Pay " + rupees(amt) + " to " + (d.name || "your rider") }));
      card.appendChild(el("p", { class: "small", text: "Ask your rider to show their UPI QR code, or pay in cash." }));
    } else {
      card.appendChild(el("h3", { text: "Pay " + rupees(amt) + " in cash" }));
      card.appendChild(el("p", { class: "small", text: "Please pay " + rupees(amt) + " in cash to " + (d.name || "your rider") + "." }));
    }
    return card;
  }
  /** Rider, after completing a ride: 1) collect payment (own UPI QR or cash), 2) pay SafeShe's share to the admin's UPI ID. */
  var settleRide = null;
  function openSettle(r) {
    settleRide = r; var upi = me && me.driver && me.driver.upiId;
    $("settleStep1").hidden = false; $("settleStep2").hidden = true;
    $("settleAmt").textContent = rupees(r.fare);
    $("settleQr").innerHTML = ""; $("settleUpi").textContent = "";
    if (r.payment === "upi" && upi) {
      $("settleTitle").textContent = "Collect " + rupees(r.fare) + " by UPI";
      $("settleSub").textContent = "Show this QR code to the passenger. They scan it with any UPI app and the money goes straight to your account.";
      $("settleQr").appendChild(qrEl(upiLink(upi, me.name, r.fare, "SafeShe ride #" + r.id)).firstChild || el("span"));
      $("settleUpi").textContent = "Your UPI ID: " + upi;
    } else if (r.payment === "upi") {
      $("settleTitle").textContent = "Collect " + rupees(r.fare);
      $("settleSub").textContent = "Add your UPI ID in My account so passengers can pay you by UPI. For now, collect the fare in cash or from your own UPI app.";
    } else {
      $("settleTitle").textContent = "Collect " + rupees(r.fare) + " cash";
      $("settleSub").textContent = "The passenger chose cash. Collect the fare before they leave.";
    }
    $("btnCollected").textContent = r.payment === "upi" ? "Payment received" : "Cash received";
    $("settleModal").classList.add("show"); vibrate(200);
  }
  $("btnCollected").onclick = function () {
    var r = settleRide; if (!r) return;
    var btn = this; btn.disabled = true;
    api("POST", "/api/rides/" + r.id + "/collected").then(function (x) { settleRide = x.ride; showShareStep(x.ride); })
      .catch(function (e) { toast(e.message); }).then(function () { btn.disabled = false; });
  };
  function showShareStep(r) {
    var share = r.safeSheShare || 0;
    if (share <= 0) { closeSettle("Ride completed. You keep the full fare."); return; }
    api("GET", "/api/driver/dues").then(function (d) {
      $("settleStep1").hidden = true; $("settleStep2").hidden = false;
      $("shareAmt").textContent = rupees2(share);
      $("shareSub").textContent = "Platform fee " + rupees2(r.platformFee || 0) + " + minimum " + rupees2(r.commission || 0) +
        (r.tier && r.tier !== "perRide" ? " (minimum waived: pass active)" : "") +
        ". You keep " + rupees2(r.fare - share) + " from this ride.";
      $("shareQr").innerHTML = ""; $("shareUtr").value = ""; status("shareStatus", "");
      if (d.upiId) {
        var link = upiLink(d.upiId, d.payeeName, share, "SafeShe share ride #" + r.id);
        $("shareQr").appendChild(qrEl(link).firstChild || el("span"));
        $("shareUpi").textContent = "Pay to " + d.upiId + " (" + d.payeeName + ")";
        $("btnSharePay").hidden = false; $("btnSharePay").onclick = function () { openUrl(link); toast("Complete the payment, then enter the UPI reference here.", 4500); };
        $("shareAlt").innerHTML = ""; $("shareAlt").appendChild(upiAlt(d.upiId, d.payeeName, share, "SafeShe share ride #" + r.id));
      } else {
        $("shareAlt").innerHTML = "";
        $("shareUpi").textContent = "The admin hasn't set a UPI ID yet. This amount is added to your SafeShe dues.";
        $("btnSharePay").hidden = true;
      }
    }).catch(function () { closeSettle("Ride completed."); });
  }
  $("btnShareSubmit").onclick = function () {
    var r = settleRide; if (!r) return; var btn = this; btn.disabled = true;
    api("POST", "/api/driver/payments", { utr: $("shareUtr").value, amount: r.safeSheShare, rideId: r.id })
      .then(function () { closeSettle("Thanks! Your payment of " + rupees2(r.safeSheShare) + " was sent for verification."); })
      .catch(function (e) { status("shareStatus", e.message, "bad"); }).then(function () { btn.disabled = false; });
  };
  $("btnShareLater").onclick = function () { closeSettle("Added " + rupees2(settleRide ? settleRide.safeSheShare : 0) + " to your SafeShe dues. Pay it from your home screen."); };
  function closeSettle(msg) {
    $("settleModal").classList.remove("show"); settleRide = null;
    if (msg) toast(msg, 5000);
    refreshDriverStats();
  }

  // ============================================================ RIDER (driver)
  var driverOnline = false, driverRide = null, offers = {}, offerTick = null;
  function setOnlineLocal(on) {
    driverOnline = on; $("onlineToggle").checked = on;
    $("dvTitle").textContent = on ? "You're online" : "You're offline";
    $("dvSub").textContent = on ? "Waiting for ride requests near you…" : "Go online to receive ride requests.";
    if (A && A.keepScreenOn) A.keepScreenOn(on);
    if (on) startWatch(); else { stopWatch(); offers = {}; renderOffers(); }
  }
  function goOnline(on) {
    if (!on) {
      api("POST", "/api/driver/online", { online: false }).then(function () { setOnlineLocal(false); }).catch(function (e) { toast(e.message); $("onlineToggle").checked = true; });
      return;
    }
    $("dvSub").textContent = "Getting your location…";
    getLocation(function (d, err) {
      if (!d) { toast(err || "Location is needed to go online."); setOnlineLocal(false); return; }
      api("POST", "/api/driver/online", { online: true, lat: d.lat, lng: d.lng }).then(function (r) {
        setOnlineLocal(true); (r.offers || []).forEach(addOffer);
        meMarker = setLayer(meMarker, [d.lat, d.lng], "mk-pick"); if (!driverRide) map.setView([d.lat, d.lng], 15);
      }).catch(function (e) { toast(e.message, 4500); setOnlineLocal(false); });
    });
  }
  $("onlineToggle").onchange = function () { goOnline(this.checked); };
  function restoreOnline() { if (me.driver && me.driver.online) goOnline(true); else setOnlineLocal(false); }
  locListeners.push(function (d) {
    if (role !== "driver") return;
    meMarker = setLayer(meMarker, [d.lat, d.lng], "mk-pick");
    sendDriverLocation(d);
  });
  // Keep the server's position fresh even when the phone is standing still.
  setInterval(function () { if (role === "driver" && driverOnline && myPos) sendDriverLocation(myPos, true); }, 30000);

  function addOffer(o) {
    if (role !== "driver" || driverRide || offers[o.rideId]) return;
    offers[o.rideId] = o; renderOffers(); vibrate(500); beep();
  }
  function removeOffer(id) { if (offers[id]) { delete offers[id]; renderOffers(); } }
  function refreshOffers() {
    if (role === "driver" && driverOnline && !driverRide)
      api("GET", "/api/driver/offers").then(function (r) { offers = {}; r.offers.forEach(function (o) { offers[o.rideId] = o; }); renderOffers(); }).catch(function () {});
  }
  function renderOffers() {
    var ul = $("offers"); ul.innerHTML = "";
    clearInterval(offerTick);
    var list = Object.keys(offers).map(function (k) { return offers[k]; });
    list.forEach(function (o) {
      var left = el("span", { class: "muted small" });
      var li = el("li", { class: "offer" },
        el("div", { class: "top" }, el("b", { text: rupees(o.fare) }), el("span", { class: "pill", text: (o.night ? "🌙 " : "") + VEH_ICON[o.vehicle] + " " + VEH_NAME[o.vehicle] })),
        el("div", { class: "small", text: "You keep " + rupees2(o.youKeep != null ? o.youKeep : o.fare) + (o.pickupSurcharge > 0 ? " · incl. " + rupees2(o.pickupSurcharge) + " long-pickup bonus" : "") }),
        el("div", { class: "small muted", text: (o.pickupKm != null ? o.pickupKm + " km to pickup · " : "") + o.distanceKm + " km trip · " + (o.payment === "upi" ? "UPI" : "Cash") }),
        el("div", { class: "addr" }, el("div", { text: "🟢 " + o.pickup.name }), el("div", { text: "🔴 " + o.drop.name })),
        left,
        el("div", { class: "row" },
          el("button", { class: "ghost", text: "Decline", onclick: function () { api("POST", "/api/rides/" + o.rideId + "/decline").catch(function () {}); removeOffer(o.rideId); } }),
          el("button", { class: "primary", text: "Accept", onclick: function (e) {
            e.target.disabled = true;
            api("POST", "/api/rides/" + o.rideId + "/accept").then(function (r) { offers = {}; renderOffers(); setDriverRide(r.ride); })
              .catch(function (err) { toast(err.message, 4000); removeOffer(o.rideId); });
          } })));
      li._left = left; li._o = o; ul.appendChild(li);
    });
    function tick() {
      [].slice.call(ul.children).forEach(function (li) {
        var s = Math.round((li._o.expiresAt - Date.now()) / 1000);
        li._left.textContent = s > 0 ? "Request expires in " + s + " s" : "Expired";
        if (s <= 0) removeOffer(li._o.rideId);
      });
    }
    if (list.length) { tick(); offerTick = setInterval(tick, 1000); }
    $("dvSub").textContent = driverOnline ? (list.length ? list.length + " ride request" + (list.length > 1 ? "s" : "") : "Waiting for ride requests near you…") : "Go online to receive ride requests.";
    syncSheet();
  }
  function setDriverRide(r) {
    driverRide = r; showView("dv-ride");
    pickupMarker = setLayer(pickupMarker, [r.pickup.lat, r.pickup.lng], "mk-pick");
    dropMarker = setLayer(dropMarker, [r.drop.lat, r.drop.lng], "mk-drop");
    drawRoute([[r.pickup.lat, r.pickup.lng], [r.drop.lat, r.drop.lng]], true);
    $("dPassName").textContent = r.passenger ? r.passenger.name : "Passenger";
    $("dPayment").textContent = VEH_NAME[r.vehicle] + " · " + (r.payment === "upi" ? "UPI" : "Collect cash") + " · " + r.distanceKm.toFixed(1) + " km";
    $("dFare").textContent = rupees(r.fare);
    $("dPickup").textContent = r.pickup.name; $("dDrop").textContent = r.drop.name;
    var s = r.status;
    $("dRideStatus").textContent = s === "accepted" ? "Go to pickup" : s === "arrived" ? "Waiting for passenger" : "Ride in progress · drop at " + shortName(r.drop.name);
    $("otpEntry").hidden = s !== "arrived"; $("startOtp").value = "";
    $("btnRideStep").textContent = s === "accepted" ? "I've arrived at pickup" : s === "arrived" ? "Verify OTP & start ride" : "Complete ride · collect " + rupees(r.fare);
    $("btnDriverCancel").hidden = s === "started";
    var mp = myPos ? [myPos.lat, myPos.lng] : null;
    fit([mp, s === "started" ? [r.drop.lat, r.drop.lng] : [r.pickup.lat, r.pickup.lng]]);
  }
  function onDriverRideUpdate(r) {
    if (!driverRide || r.id !== driverRide.id) return;
    if (r.status === "cancelled") { toast("The ride was cancelled" + (r.cancelledBy === "passenger" ? " by the passenger" : "") + ".", 4500); vibrate(400); endDriverRide(); return; }
    if (r.status === "completed") { endDriverRide(); return; }
    setDriverRide(r);
  }
  function endDriverRide() {
    driverRide = null; pickupMarker = setLayer(pickupMarker, null); dropMarker = setLayer(dropMarker, null); drawRoute(null);
    showView("dv-home"); refreshDriverStats(); refreshOffers();
  }
  $("btnRideStep").onclick = function () {
    var r = driverRide; if (!r) return;
    var step = r.status === "accepted" ? "arrived" : r.status === "arrived" ? "start" : "complete";
    var body = step === "start" ? { otp: digitsOnly($("startOtp").value) } : {};
    if (step === "start" && body.otp.length !== 4) { toast("Enter the passenger's 4-digit OTP."); return; }
    var btn = this; btn.disabled = true;
    api("POST", "/api/rides/" + r.id + "/" + step, body).then(function (x) {
      if (step === "complete") { endDriverRide(); openSettle(x.ride); }
      else setDriverRide(x.ride);
    }).catch(function (e) { toast(e.message, 4000); }).then(function () { btn.disabled = false; });
  };
  $("btnDriverCancel").onclick = function () {
    if (!driverRide || !confirm("Cancel this ride? Frequent cancellations may affect your account.")) return;
    api("POST", "/api/rides/" + driverRide.id + "/cancel", { reason: "Cancelled by rider" }).then(function () { endDriverRide(); }).catch(function (e) { toast(e.message); });
  };
  $("btnCallPass").onclick = function () { if (driverRide && driverRide.passenger) dial(driverRide.passenger.phone); };
  $("btnNavigate").onclick = function () {
    if (!driverRide) return; var t = driverRide.status === "started" ? driverRide.drop : driverRide.pickup;
    openUrl("https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=" + t.lat + "," + t.lng);
  };
  function refreshDriverStats() {
    api("GET", "/api/rides/history").then(function (r) {
      var day = new Date(); day.setHours(0, 0, 0, 0);
      var today = r.rides.filter(function (x) { return x.status === "completed" && x.completedAt >= day.getTime(); });
      // What the rider keeps: fare minus the platform fee (passed to SafeShe).
      $("earnToday").textContent = rupees(today.reduce(function (s, x) { return s + (x.driverKeeps != null ? x.driverKeeps : x.fare); }, 0));
      $("ridesToday").textContent = today.length;
    }).catch(function () {});
    api("GET", "/api/me").then(function (r) { me = r.user; renderMe(); $("myRating").textContent = me.driver && me.driver.rating ? "★ " + me.driver.rating : "–"; }).catch(function () {});
    loadDues(); loadPlan();
  }

  // ---------------- rider plan: Tier 1 pay-per-ride, Tier 2 half-day pass, Tier 3 full-day pass
  var plan = null;
  function loadPlan() {
    if (role !== "driver") return;
    api("GET", "/api/driver/plan").then(function (p) {
      plan = p; $("planBox").hidden = false;
      var t = p.tiers;
      $("btnBuyHalf").textContent = t.half.name + " · " + rupees2(t.half.price) + " / " + t.half.hours + " h";
      $("btnBuyFull").textContent = t.full.name + " · " + rupees2(t.full.price) + " / " + t.full.hours + " h";
      if (p.active) {
        $("planName").textContent = p.active.name + " · unlimited rides";
        $("planUntil").textContent = "until " + new Date(p.active.endsAt).toLocaleString("en-IN", { hour: "numeric", minute: "2-digit", day: "numeric", month: "short" });
        $("planUntil").hidden = false; $("planBuy").hidden = true;
        $("planInfo").textContent = "No minimum amount while your pass is active. Only the platform fee goes to SafeShe.";
      } else {
        $("planName").textContent = t.perRide.name + " · SafeShe share per ride";
        $("planUntil").hidden = true; $("planBuy").hidden = false;
        var sh = (p.shares || []).map(function (x) { return (VEH_ICON[x.vehicle] || "") + " " + rupees2(x.platformFee + x.minimum); }).join(" · ");
        $("planInfo").textContent = "Each ride: platform fee + minimum amount (set by SafeShe). " + sh +
          ". Doing many rides? A pass removes the minimum amount for " + rupees2(t.full.price) + " a day." +
          (p.today.rides ? " Today: " + p.today.rides + " ride" + (p.today.rides > 1 ? "s" : "") + " = " + rupees2(p.today.rideFees) + " in minimum amounts." : "");
      }
      syncSheet();
    }).catch(function () {});
  }
  function buyPass(kind) {
    if (!plan) return;
    var t = plan.tiers[kind];
    if (!confirm("Buy " + t.name + " for " + rupees2(t.price) + "? It starts now and lasts " + t.hours + " hours. The price is added to your SafeShe dues (pay via UPI).")) return;
    api("POST", "/api/driver/pass", { kind: kind }).then(function () { toast(t.name + " active. Enjoy unlimited rides!", 4500); loadPlan(); loadDues(); })
      .catch(function (e) { toast(e.message, 5000); });
  }
  $("btnBuyHalf").onclick = function () { buyPass("half"); };
  $("btnBuyFull").onclick = function () { buyPass("full"); };

  // ---------------- rider: commission owed to SafeShe (paid to the admin's UPI ID)
  var dues = null;
  function loadDues() {
    if (role !== "driver") return;
    api("GET", "/api/driver/dues").then(function (d) {
      dues = d; var box = $("duesBox");
      box.hidden = !(d.charged > 0 || d.pending > 0);
      box.classList.toggle("clear", d.toPay <= 0);
      $("duesAmt").textContent = rupees2(d.toPay);
      $("btnPayUpi").hidden = d.toPay <= 0 || !d.upiId;
      $("duesAlt").innerHTML = "";
      if (d.toPay > 0 && d.upiId) $("duesAlt").appendChild(upiAlt(d.upiId, d.payeeName, Math.ceil(d.toPay), "SafeShe commission " + (me ? me.phone : "")));
      var info = [];
      if (d.toPay <= 0) info.push("All clear. Thank you!");
      if (d.pending > 0) info.push(rupees2(d.pending) + " waiting for admin verification.");
      if (d.toPay > 0 && !d.upiId) info.push("The admin hasn't set a UPI ID yet.");
      if (d.toPay > 0 && d.upiId) info.push("Pay to " + d.upiId + " (" + d.payeeName + ").");
      if (d.duesLimit > 0) info.push("You can stay online while dues are up to " + rupees(d.duesLimit) + ".");
      $("duesInfo").textContent = info.join(" ");
      if (!$("utrAmt").value && d.toPay > 0) $("utrAmt").value = Math.ceil(d.toPay);
      syncSheet();
    }).catch(function () {});
  }
  function rupees2(n) { n = Math.round((n || 0) * 100) / 100; return "₹" + (n % 1 ? n.toFixed(2) : n); }
  $("btnPayUpi").onclick = function () {
    if (!dues || !dues.upiId) return;
    var amt = Math.ceil(dues.toPay);
    var link = "upi://pay?pa=" + encodeURIComponent(dues.upiId).replace(/%40/g, "@") + "&pn=" + encodeURIComponent(dues.payeeName || "SafeShe") +
      "&am=" + amt.toFixed(2) + "&cu=INR&tn=" + encodeURIComponent("SafeShe commission " + (me ? me.phone : ""));
    $("utrAmt").value = amt; $("utrForm").hidden = false; $("btnUtrToggle").hidden = true;
    openUrl(link);
    toast("Complete the payment in your UPI app, then enter the UPI reference here.", 5000);
  };
  $("btnUtrToggle").onclick = function () { $("utrForm").hidden = false; this.hidden = true; syncSheet(); };
  $("btnUtrSubmit").onclick = function () {
    var btn = this; btn.disabled = true;
    api("POST", "/api/driver/payments", { utr: $("utrInput").value, amount: +$("utrAmt").value })
      .then(function () { toast("Payment submitted. The admin will verify it shortly.", 5000); $("utrInput").value = ""; $("utrAmt").value = ""; $("utrForm").hidden = true; $("btnUtrToggle").hidden = false; loadDues(); })
      .catch(function (e) { toast(e.message, 5000); }).then(function () { btn.disabled = false; });
  };

  // ============================================================ history page
  function renderHistory() {
    var ul = $("history"); ul.innerHTML = ""; ul.appendChild(el("li", { class: "muted", text: "Loading…" }));
    api("GET", "/api/rides/history").then(function (r) {
      ul.innerHTML = "";
      if (!r.rides.length) { ul.appendChild(el("li", { class: "muted", text: "No rides yet." })); return; }
      r.rides.forEach(function (x) {
        var other = me.role === "driver" ? (x.passenger && x.passenger.name) : (x.driver && (x.driver.name + " · " + (x.driver.plate || "")));
        ul.appendChild(el("li", null,
          el("div", { class: "between" }, el("b", { text: VEH_NAME[x.vehicle] + " · " + rupees(x.fare) }), el("span", { class: "pill " + (x.status === "completed" ? "" : "grey"), text: x.status.replace("_", " ") })),
          el("div", { class: "muted", text: shortName(x.pickup.name) + " → " + shortName(x.drop.name) }),
          el("div", { class: "small", text: when(x.requestedAt) + (other ? " · " + other : "") + (x.rating ? " · " + "★".repeat(x.rating) : "") })));
      });
    }).catch(function (e) { ul.innerHTML = ""; ul.appendChild(el("li", { class: "muted", text: e.message })); });
  }

  // ============================================================ SAFETY: trip monitor
  var tripMonitorOn = false;
  function setTripMonitor(on) {
    tripMonitorOn = on; $("tripMonitor").checked = on;
    $("tripMonitorText").textContent = on ? "Trip monitor on: if you leave the app, SafeShe checks on you when you return." : "Trip monitor off for this ride.";
  }
  $("tripMonitor").onchange = function () { setTripMonitor(this.checked); };
  var mon = $("monitor");
  mon.checked = A ? A.getMonitor() : pref("monitor") === "1";
  function monitorText() { status("monitorStatus", mon.checked ? "On: leaving the app at any time triggers a safety check when you return." : "Off outside rides.", mon.checked ? "good" : ""); }
  monitorText();
  mon.onchange = function () { if (A) A.setMonitor(mon.checked); else pref("monitor", mon.checked ? "1" : "0"); monitorText(); };
  var checkTimer = null, checkLeft = 0;
  function openCheck(awayMs) {
    $("checkText").textContent = "You were away from SafeShe for " + Math.max(1, Math.round(awayMs / 1000)) + " seconds" + (curRide && curRide.status === "started" ? " during your ride." : ".");
    checkLeft = CHECK_SECONDS; $("checkBar").style.transition = "none"; $("checkBar").style.width = "100%";
    $("check").classList.add("show"); vibrate(150);
    clearInterval(checkTimer); tickCheck();
    checkTimer = setInterval(function () { checkLeft--; tickCheck(); if (checkLeft <= 0) { closeCheck(); openSos(true); } }, 1000);
  }
  function tickCheck() {
    $("checkBar").style.transition = "width 1s linear"; $("checkBar").style.width = (100 * checkLeft / CHECK_SECONDS) + "%";
    $("checkCountdown").textContent = "No answer in " + checkLeft + "s and SafeShe will raise an SOS alert.";
  }
  function closeCheck() { clearInterval(checkTimer); checkTimer = null; $("check").classList.remove("show"); }
  $("btnSafe").onclick = function () { closeCheck(); toast("Glad you're safe."); };
  $("btnAlert").onclick = function () { closeCheck(); openSos(false); };

  // ============================================================ SAFETY: SOS + location sharing
  var sosLoc = null, msgEdited = false, sosReported = null;
  function activeRideForSafety() { return role === "driver" ? driverRide : (curRide && ["accepted", "arrived", "started"].indexOf(curRide.status) >= 0 ? curRide : null); }
  function tripLines() {
    var r = activeRideForSafety(); if (!r) return "";
    var s = "";
    if (role === "passenger" && r.driver) s += "\nRide: " + VEH_NAME[r.vehicle] + " · " + (r.driver.vehicleModel || "") + " · " + (r.driver.plate || "") + " · rider " + r.driver.name;
    if (role === "driver" && r.passenger) s += "\nRide " + r.id + " with passenger " + r.passenger.name;
    s += "\nHeading to: " + shortName(r.drop.name);
    if (r.shareUrl) s += "\nLive trip: " + absUrl(r.shareUrl);
    return s;
  }
  function alertText() {
    var m = "SafeShe ALERT: I may need help.";
    if (sosLoc) m += "\nMy location: " + mapsLink(sosLoc.lat, sosLoc.lng) + (sosLoc.accuracy > 0 ? " (±" + Math.round(sosLoc.accuracy) + " m)" : "") + "\nAt: " + new Date(sosLoc.time || Date.now()).toLocaleString("en-IN");
    else m += "\n(Location not available yet.)";
    return m + tripLines() + "\nPlease call me or check on me.";
  }
  function reportSos(reason) {
    // Every SOS also goes to the SafeShe safety team (admin dashboard). Re-sent once when a location arrives later.
    if (!session || session.kind !== "user") return;
    var hasLoc = !!sosLoc;
    if (sosReported && (sosReported.hasLoc || !hasLoc) && Date.now() - sosReported.at < 60000) return;
    sosReported = { at: Date.now(), hasLoc: hasLoc };
    api("POST", "/api/sos", { lat: sosLoc && sosLoc.lat, lng: sosLoc && sosLoc.lng, accuracy: sosLoc && sosLoc.accuracy, message: reason })
      .then(function () { $("sosTeamNote").textContent = "✅ The SafeShe safety team has been alerted" + (hasLoc ? " with your location." : ". Your location will follow."); })
      .catch(function () { $("sosTeamNote").textContent = "⚠️ Couldn't reach the SafeShe team. Call 112 or alert your contact."; });
  }
  function sosOpen() { return $("sosModal").classList.contains("show"); }
  function renderSosLoc(err) {
    var d = sosLoc;
    if (d) {
      var age = Math.max(0, Math.round((Date.now() - d.recv) / 1000));
      $("sosLoc").textContent = "📍 " + d.lat.toFixed(6) + ", " + d.lng.toFixed(6) + (d.accuracy > 0 ? " (±" + Math.round(d.accuracy) + " m)" : "") + (d.stale ? " · last known" : age < 5 ? " · live" : " · " + age + " s ago");
    } else $("sosLoc").textContent = err ? "⚠️ " + err + " The alert will be sent without location." : "Getting your location…";
  }
  function openSos(auto) {
    $("sosModal").classList.add("show"); msgEdited = false; sosLoc = myPos;
    renderSosLoc(null); $("alertMsg").value = alertText();
    $("sosTeamNote").textContent = "Alerting the SafeShe safety team…";
    status("sosStatus", auto ? "No response to the safety check, so an SOS was raised. Send the alert to your contact too." : "");
    if (auto) vibrate(400);
    reportSos(auto ? "No response to safety check" : "SOS pressed");
    if (A) A.getLocation(); else getLocation(function () {});
  }
  locListeners.push(function (d) {
    if (!sosOpen()) return;
    sosLoc = d; renderSosLoc(null);
    if (!msgEdited) $("alertMsg").value = alertText();
    reportSos("SOS location update");
  });
  setInterval(function () { if (sosOpen() && sosLoc) renderSosLoc(null); }, 5000);
  function contact() { return me && me.emergencyPhone ? me.emergencyPhone : ""; }
  function quickAlert() {
    sosLoc = myPos; msgEdited = false; vibrate(300);
    reportSos("SOS long-press");
    if (!contact() || !A) { openSos(false); toast(contact() ? "Quick SMS needs the Android app." : "Add an emergency contact for one-press alerts."); return; }
    A.sendSms(contact(), alertText());
    toast(myPos ? "Alert with your location is ready. Tap Send. SafeShe team alerted." : "Alert ready (location still loading). Tap Send.");
    A.getLocation();
  }
  (function () {
    var btn = $("btnSos"), t = null, fired = false;
    btn.addEventListener("pointerdown", function () { fired = false; t = setTimeout(function () { fired = true; quickAlert(); }, 800); });
    ["pointerup", "pointerleave", "pointercancel"].forEach(function (e) { btn.addEventListener(e, function () { clearTimeout(t); }); });
    btn.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    btn.onclick = function () { if (fired) { fired = false; return; } openSos(false); };
  })();
  $("alertMsg").addEventListener("input", function () { msgEdited = true; });
  $("btnTripSos").onclick = function () { openSos(false); };
  $("btnOpenSos").onclick = function () { closePages(); openSos(false); };
  $("btnSosClose").onclick = function () { $("sosModal").classList.remove("show"); };
  $("btnCall112").onclick = function () { dial("112"); };
  $("btnSms").onclick = function () {
    if (!contact()) { toast("Add an emergency contact in My account, or use Share."); return; }
    if (A) A.sendSms(contact(), $("alertMsg").value); else location.href = "sms:" + contact() + "?body=" + encodeURIComponent($("alertMsg").value);
  };
  $("btnShare").onclick = function () { doShare($("alertMsg").value); };
  function doShare(t) { if (A) A.share(t); else if (navigator.share) navigator.share({ text: t }).catch(function () {}); else toast("Sharing isn't supported in this browser."); }
  function shareText(r) {
    var p = myPos ? mapsLink(myPos.lat, myPos.lng) : "";
    return "I'm on a SafeShe ride." + (r.driver ? "\nRider: " + r.driver.name + " · " + (r.driver.vehicleModel || "") + " · " + (r.driver.plate || "") : "") +
      "\nTo: " + shortName(r.drop.name) + "\nTrack my ride live: " + absUrl(r.shareUrl) + (p ? "\nMy location now: " + p : "");
  }
  function autoShare(r) {
    if (!$("optShare").checked) return;
    var key = "shared_" + r.id; if (pref(key)) return; pref(key, "1");
    if (contact() && A) { A.sendSms(contact(), shareText(r)); toast("Ride started. Tap Send to share your live trip with " + contact() + "."); }
    else toast("Ride started. Use Share trip to send your live trip link.");
  }
  $("btnTripShare").onclick = function () { if (curRide) doShare(shareText(curRide)); };

  // ============================================================ SAFETY: voice recording
  var recording = false, playing = false, hasTake = false, recTick = null, recStart = 0;
  function setRecUI() {
    $("btnRec").textContent = recording ? "■ Stop recording" : "● Start recording";
    $("btnRec").className = recording ? "ghost" : "primary";
    $("btnPlay").disabled = recording || !hasTake; $("btnPlay").textContent = playing ? "■ Stop playback" : "▶ Play";
    $("btnSave").disabled = recording || !hasTake;
    $("recDot").className = "dot" + (recording ? " live" : "");
    $("btnTripRec").classList.toggle("live", recording);
    $("btnTripRec").querySelector("span").textContent = recording ? "Stop " + $("recTimer").textContent : "Record";
    $("btnSosRec").textContent = recording ? "■ Stop rec" : "🎙️ Record";
  }
  function toggleRec() {
    if (!A) { toast("Recording is available in the Android app."); return; }
    if (recording) A.stopRecording(); else { status("recStatus", "Starting…"); A.startRecording(); }
  }
  $("btnRec").onclick = toggleRec; $("btnTripRec").onclick = toggleRec; $("btnSosRec").onclick = toggleRec;
  $("btnPlay").onclick = function () { if (playing) A.stopPlayback(); else A.play(); };
  $("btnSave").onclick = function () { status("recStatus", "Saving…"); A.saveRecording(); };

  // ============================================================ drawer + pages
  function openDrawer(on) { $("drawer").classList.toggle("show", on); $("scrim").classList.toggle("show", on); }
  $("btnMenu").onclick = function () { renderMe(); openDrawer(true); };
  $("scrim").onclick = function () { openDrawer(false); };
  function closePages() { document.querySelectorAll(".page").forEach(function (p) { p.hidden = true; }); }
  document.querySelectorAll(".drawer [data-page]").forEach(function (b) {
    b.onclick = function () { openDrawer(false); closePages(); $(b.dataset.page).hidden = false; if (b.dataset.page === "page-history") renderHistory(); renderMe(); };
  });
  document.querySelectorAll(".page .back").forEach(function (b) { b.onclick = closePages; });
  $("btnLogout").onclick = function () { if (driverRide) { toast("Finish your ride before logging out."); return; } if (confirm("Log out of SafeShe?")) logout(); };

  // ============================================================ ADMIN
  var adminCur = null, adminTimer = null;
  document.querySelectorAll("#adminTabs button").forEach(function (b) { b.onclick = function () { adminTab(b.dataset.tab); }; });
  $("btnAdminLogout").onclick = function () { if (confirm("Log out of the admin panel?")) logout(); };
  function adminLive(kind) {
    if (!session || session.kind !== "admin") return;
    clearTimeout(adminTimer);
    adminTimer = setTimeout(function () {
      if (adminCur === "dash" || (kind === "sos" && adminCur === "sos") || (kind === "ride" && adminCur === "rides") || (kind === "rider" && adminCur === "riders") || (kind === "payment" && adminCur === "payments")) adminTab(adminCur, true);
      updateSosBadge();
    }, kind === "sos" ? 0 : 800);
  }
  function updateSosBadge() {
    api("GET", "/api/admin/stats").then(function (s) {
      var b = document.querySelector('#adminTabs [data-tab="sos"]'); b.innerHTML = ""; b.appendChild(document.createTextNode("SOS"));
      if (s.openSos) b.appendChild(el("span", { class: "badge", text: s.openSos }));
    }).catch(function () {});
  }
  function adminTab(tab, quiet) {
    adminCur = tab;
    document.querySelectorAll("#adminTabs button").forEach(function (b) { b.classList.toggle("on", b.dataset.tab === tab); });
    var c = $("adminContent"); if (!quiet) { c.innerHTML = ""; c.appendChild(el("p", { class: "muted", text: "Loading…" })); }
    ADMIN[tab](c).catch(function (e) { c.innerHTML = ""; c.appendChild(el("p", { class: "status bad", text: e.message })); });
    if (!quiet) updateSosBadge();
  }
  function act(label, cls, fn) {
    return el("button", { class: cls || "ghost", text: label, onclick: function (e) {
      var b = e.currentTarget; b.disabled = true;
      Promise.resolve().then(fn).catch(function (x) { toast(x.message); }).then(function () { b.disabled = false; });
    } });
  }
  function statusPill(s) { var cls = { completed: "", started: "amber", accepted: "amber", arrived: "amber", requested: "amber", cancelled: "grey", no_driver: "grey", pending: "amber", approved: "", rejected: "red" }[s]; return el("span", { class: "pill " + (cls || ""), text: s.replace("_", " ") }); }
  function filterChips(opts, cur, onPick) {
    return el("div", { class: "filters" }, opts.map(function (x) { return el("button", { class: "chip", style: x === cur ? "background:#0f9d58;color:#fff;border-color:#0f9d58" : null, text: x.replace("_", " "), onclick: function () { onPick(x); } }); }));
  }
  function rideItem(r) {
    var active = ["requested", "accepted", "arrived", "started"].indexOf(r.status) >= 0;
    return el("div", { class: "item" },
      el("div", { class: "between" }, el("h4", { text: "#" + r.id + " · " + VEH_NAME[r.vehicle] + " · " + rupees(r.fare) }), statusPill(r.status)),
      el("div", { class: "muted", text: shortName(r.pickup.name) + " → " + shortName(r.drop.name) + " · " + r.distanceKm.toFixed(1) + " km" }),
      el("div", { class: "small", text: "Passenger: " + (r.passenger ? r.passenger.name + " " + (r.passenger.phone || "") : "–") }),
      el("div", { class: "small", text: "Rider: " + (r.driver ? r.driver.name + " " + (r.driver.phone || "") + " · " + (r.driver.plate || "") : "not assigned") }),
      el("div", { class: "small muted", text: when(r.requestedAt) + (r.cancelReason ? " · " + r.cancelReason : "") }),
      el("div", { class: "acts" },
        active ? act("Cancel ride", "ghost", function () { if (!confirm("Cancel ride #" + r.id + "?")) return; return api("POST", "/api/admin/rides/" + r.id + "/cancel", { reason: "Cancelled by SafeShe support" }).then(function () { adminTab(adminCur, true); }); }) : null,
        r.shareUrl && active && r.status !== "requested" ? act("Live track", "ghost", function () { openUrl(absUrl(r.shareUrl)); }) : null));
  }
  function sosItem(s) {
    var open = !s.resolvedAt;
    return el("div", { class: "item" + (open ? " sos-open" : "") },
      el("div", { class: "between" }, el("h4", { text: "🆘 " + ((s.user && s.user.name) || "User") + " (" + (s.user && s.user.role === "driver" ? "rider" : "passenger") + ")" }), el("span", { class: "pill " + (open ? "red" : "grey"), text: open ? "OPEN" : "resolved" })),
      el("div", { class: "small", text: when(s.createdAt) + " · " + (s.user ? s.user.phone : "") + (s.user && s.user.emergencyPhone ? " · emergency contact " + s.user.emergencyPhone : "") }),
      el("div", { class: "small", text: s.lat != null ? "Location: " + s.lat.toFixed(5) + ", " + s.lng.toFixed(5) + (s.accuracy ? " (±" + Math.round(s.accuracy) + " m)" : "") : "No location shared" }),
      s.message ? el("div", { class: "small muted", text: s.message }) : null,
      s.ride ? el("div", { class: "small", text: "Ride #" + s.ride.id + " · " + s.ride.status + " · rider " + (s.ride.driver ? s.ride.driver.name + " " + (s.ride.driver.plate || "") + " " + (s.ride.driver.phone || "") : "–") }) : null,
      s.resolvedAt ? el("div", { class: "small muted", text: "Resolved " + when(s.resolvedAt) + (s.resolvedNote ? ": " + s.resolvedNote : "") }) : null,
      el("div", { class: "acts" },
        s.user ? act("📞 Call user", "danger", function () { dial(s.user.phone); }) : null,
        s.lat != null ? act("Open map", "ghost", function () { openUrl(mapsLink(s.lat, s.lng)); }) : null,
        s.ride && s.ride.shareUrl ? act("Live track", "ghost", function () { openUrl(absUrl(s.ride.shareUrl)); }) : null,
        open ? act("Mark resolved", "ok", function () { var n = prompt("Resolution note (what was done?)", ""); if (n === null) return; return api("POST", "/api/admin/sos/" + s.id + "/resolve", { note: n }).then(function () { adminTab(adminCur, true); }); }) : null));
  }
  var adminFilter = { riders: "pending", rides: "active", q: "", r: "" };

  // ---------------- reports helpers (dates are India time)
  var reportStatus = null;
  function istToday() {
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function addDaysYmd(ymd, n) { return new Date(Date.parse(ymd + "T12:00:00Z") + n * 86400000).toISOString().slice(0, 10); }
  function fmtYmd(ymd) { return ymd ? new Date(Date.parse(ymd + "T12:00:00Z")).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : ""; }
  /** Download the PDF: browser → normal file download; Android app → saved to Downloads/SafeShe via the native bridge. */
  function downloadReport(query, label, done) {
    if (done) done("Preparing the PDF for " + label + "…", true);
    var h = {}; if (session && session.token) h.Authorization = "Bearer " + session.token;
    return fetch(apiBase() + "/api/admin/report.pdf?" + query, { headers: h }).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || "Could not create the report (" + r.status + ")."); });
      var name = r.headers.get("X-Filename") || ("SafeShe-report-" + istToday() + ".pdf");
      return r.blob().then(function (b) { return { blob: b, name: name }; });
    }).then(function (x) {
      if (A && A.saveFile) {
        return new Promise(function (res, rej) {
          var fr = new FileReader();
          fr.onload = function () { A.saveFile(String(fr.result).split(",")[1], x.name, "application/pdf"); if (done) done("Saving " + x.name + "…", true); res(); };
          fr.onerror = function () { rej(new Error("Could not read the PDF.")); };
          fr.readAsDataURL(x.blob);
        });
      }
      var url = URL.createObjectURL(x.blob), a = document.createElement("a");
      a.href = url; a.download = x.name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      if (done) done("Downloaded " + x.name + " (" + Math.round(x.blob.size / 1024) + " KB)", true);
    }).catch(function (e) { if (done) done(e.message, false); throw e; });
  }
  var ADMIN = {
    dash: function (c) {
      return Promise.all([api("GET", "/api/admin/stats"), api("GET", "/api/admin/sos?open=1"), api("GET", "/api/admin/rides?status=active")]).then(function (x) {
        var s = x[0]; c.innerHTML = "";
        function k(label, v, alert) { return el("div", { class: "kpi" + (alert ? " alert" : "") }, el("small", { text: label }), el("b", { text: v })); }
        c.appendChild(el("div", { class: "kpis" },
          k("Open SOS alerts", s.openSos, s.openSos > 0), k("Active rides", s.activeRides), k("Riders online", s.ridersOnline), k("Riders pending approval", s.ridersPending, s.ridersPending > 0),
          k("Rides today", s.ridesToday), k("Completed today", s.completedToday), k("Revenue today", rupees(s.revenueToday)),
          k("SafeShe earnings today", rupees2(s.commissionToday)), k("Platform fees today", rupees2(s.platformFeesToday)), k("Minimum amounts today", rupees2(s.rideFeesToday)),
          k("Passes sold today", s.passesToday + " · " + rupees2(s.passRevenueToday)),
          k("Due from riders", rupees2(s.commissionDue)), k("Payments to verify", s.paymentsPending, s.paymentsPending > 0),
          k("Passengers", s.passengers), k("Riders", s.riders)));
        if (s.otpTestMode) c.appendChild(el("p", { class: "testcode", text: "OTP test mode: no SMS provider is configured, so login codes are shown in Settings. Set TWOFACTOR_API_KEY on the server to send real SMS." }));
        c.appendChild(el("h3", { text: "Open SOS alerts" }));
        c.appendChild(x[1].sos.length ? el("div", { class: "list" }, x[1].sos.map(sosItem)) : el("p", { class: "muted", text: "No open alerts." }));
        c.appendChild(el("h3", { text: "Active rides" }));
        c.appendChild(x[2].rides.length ? el("div", { class: "list" }, x[2].rides.map(rideItem)) : el("p", { class: "muted", text: "No active rides." }));
      });
    },
    sos: function (c) {
      return api("GET", "/api/admin/sos").then(function (r) { c.innerHTML = ""; c.appendChild(r.sos.length ? el("div", { class: "list" }, r.sos.map(sosItem)) : el("p", { class: "muted", text: "No SOS alerts yet." })); });
    },
    riders: function (c) {
      var f = adminFilter.riders;
      return api("GET", "/api/admin/riders" + (f === "all" ? "" : "?status=" + f)).then(function (r) {
        c.innerHTML = "";
        c.appendChild(filterChips(["pending", "approved", "rejected", "all"], f, function (x) { adminFilter.riders = x; adminTab("riders"); }));
        if (!r.riders.length) { c.appendChild(el("p", { class: "muted", text: "No riders here." })); return; }
        c.appendChild(el("div", { class: "list" }, r.riders.map(function (d) {
          return el("div", { class: "item" },
            el("div", { class: "between" }, el("h4", { text: d.name + (d.online ? " · 🟢 online" : "") }), statusPill(d.status)),
            el("div", { class: "small", text: d.phone + " · " + (d.gender || "–") + (d.blocked ? " · BLOCKED" : "") }),
            el("div", { class: "small", text: VEH_ICON[d.vehicleType] + " " + VEH_NAME[d.vehicleType] + " · " + d.vehicleModel + " · " + d.plate }),
            el("div", { class: "small muted", text: "Licence " + d.licenseNo + " · joined " + when(d.createdAt) + (d.rating ? " · ★ " + d.rating : "") }),
            el("div", { class: "acts" },
              d.status !== "approved" ? act("Approve", "ok", function () { return api("POST", "/api/admin/riders/" + d.id + "/approve").then(function () { toast(d.name + " approved"); adminTab("riders", true); }); }) : null,
              d.status !== "rejected" ? act("Reject", "ghost", function () { if (!confirm("Reject " + d.name + "?")) return; return api("POST", "/api/admin/riders/" + d.id + "/reject").then(function () { adminTab("riders", true); }); }) : null,
              act(d.blocked ? "Unblock" : "Block", "ghost", function () { return api("POST", "/api/admin/users/" + d.id + "/" + (d.blocked ? "unblock" : "block")).then(function () { adminTab("riders", true); }); })));
        })));
      });
    },
    rides: function (c) {
      var f = adminFilter.rides;
      return api("GET", "/api/admin/rides" + (f === "all" ? "" : "?status=" + f)).then(function (r) {
        c.innerHTML = "";
        c.appendChild(filterChips(["active", "completed", "cancelled", "no_driver", "all"], f, function (x) { adminFilter.rides = x; adminTab("rides"); }));
        c.appendChild(r.rides.length ? el("div", { class: "list" }, r.rides.map(rideItem)) : el("p", { class: "muted", text: "No rides here." }));
      });
    },
    users: function (c) {
      var q = adminFilter.q, rl = adminFilter.r;
      return api("GET", "/api/admin/users?q=" + encodeURIComponent(q) + (rl ? "&role=" + rl : "")).then(function (r) {
        c.innerHTML = "";
        var inp = el("input", { type: "search", placeholder: "Search name or phone", value: q });
        var sel = el("select", null, el("option", { value: "", text: "All" }), el("option", { value: "passenger", text: "Passengers" }), el("option", { value: "driver", text: "Riders" })); sel.value = rl;
        c.appendChild(el("div", { class: "filters" }, inp, sel, act("Search", "primary", function () { adminFilter.q = inp.value.trim(); adminFilter.r = sel.value; adminTab("users"); })));
        c.appendChild(r.users.length ? el("div", { class: "list" }, r.users.map(function (u) {
          return el("div", { class: "item" },
            el("div", { class: "between" }, el("h4", { text: (u.name || "(no name)") + " · " + (u.role === "driver" ? "Rider" : "Passenger") }), u.blocked ? el("span", { class: "pill red", text: "blocked" }) : null),
            el("div", { class: "small", text: u.phone + " · " + u.rides + " rides · joined " + when(u.createdAt) + (u.emergencyPhone ? " · emergency " + u.emergencyPhone : "") }),
            el("div", { class: "acts" }, act(u.blocked ? "Unblock" : "Block", u.blocked ? "ok" : "ghost", function () {
              if (!u.blocked && !confirm("Block " + (u.name || u.phone) + "? They will be logged out.")) return;
              return api("POST", "/api/admin/users/" + u.id + "/" + (u.blocked ? "unblock" : "block")).then(function () { adminTab("users", true); });
            }), act("📞 Call", "ghost", function () { dial(u.phone); })));
        })) : el("p", { class: "muted", text: "No users found." }));
      });
    },
    reports: function (c) {
      c.innerHTML = "";
      var today = istToday(), sel = adminFilter.report || { days: 7 };
      var from = el("input", { type: "date", max: today, value: sel.from || addDaysYmd(today, -29) });
      var to = el("input", { type: "date", max: today, value: sel.to || today });
      var preview = el("div"), st = el("div", { class: "status" });
      reportStatus = function (msg, ok) { st.textContent = msg; st.className = "status " + (ok ? "good" : "bad"); };
      function q() { return sel.days ? "days=" + sel.days : "from=" + from.value + "&to=" + to.value; }
      function label() { return sel.days ? "Last " + sel.days + " days" : fmtYmd(from.value) + " – " + fmtYmd(to.value); }
      function pick(s) { sel = s; adminFilter.report = s; render(); }
      var chips = el("div", { class: "filters" });
      function render() {
        chips.innerHTML = "";
        [[{ days: 7 }, "Last 7 days"], [{ days: 90 }, "Last 90 days"], [{ custom: true }, "Custom dates"]].forEach(function (o) {
          var on = o[0].days ? sel.days === o[0].days : !sel.days;
          chips.appendChild(el("button", { class: "chip", style: on ? "background:#0f9d58;color:#fff;border-color:#0f9d58" : null, text: o[1],
            onclick: function () { pick(o[0].days ? { days: o[0].days } : { from: from.value, to: to.value }); } }));
        });
        custom.hidden = !!sel.days;
        loadPreview();
      }
      var custom = el("div", { class: "grid2" }, el("label", { class: "small muted" }, "From", from), el("label", { class: "small muted" }, "To", to));
      [from, to].forEach(function (i) { i.addEventListener("change", function () { if (!sel.days) { sel = { from: from.value, to: to.value }; adminFilter.report = sel; loadPreview(); } }); });
      var dl = act("⬇ Download PDF report", "primary", function () { return downloadReport(q(), label(), reportStatus); });
      c.appendChild(el("section", { class: "card" }, el("h3", { text: "Download a report" }),
        el("p", { class: "small muted", text: "PDF with rides, fares, SafeShe earnings (platform fees, minimum amounts, passes), payments, new users, SOS alerts, and breakdowns by vehicle, region, day and top riders. Dates are India time." }),
        chips, custom, el("div", { style: "height:8px" }), dl, st));
      c.appendChild(preview);
      function loadPreview() {
        if (!sel.days && (!from.value || !to.value)) return;
        preview.innerHTML = ""; preview.appendChild(el("p", { class: "muted", text: "Loading summary…" }));
        api("GET", "/api/admin/report?" + q()).then(function (r) {
          var s = r.summary; preview.innerHTML = "";
          function k(l, v) { return el("div", { class: "kpi" }, el("small", { text: l }), el("b", { text: v })); }
          preview.appendChild(el("h3", { text: label() + " · " + r.range.days + " days" }));
          preview.appendChild(el("div", { class: "kpis" },
            k("Ride requests", s.requested), k("Completed", s.completed + " (" + s.completionRate + "%)"), k("Total fares", rupees2(s.gross)),
            k("SafeShe earnings", rupees2(s.safeSheEarnings)), k("Platform fees", rupees2(s.platformFees)), k("Passes sold", s.passesSold + " · " + rupees2(s.passRevenue)),
            k("Payments confirmed", rupees2(s.paymentsReceived)), k("New passengers / riders", s.newPassengers + " / " + s.newRiders), k("SOS alerts", s.sosTotal)));
        }).catch(function (e) { preview.innerHTML = ""; preview.appendChild(el("p", { class: "status bad", text: e.message })); });
      }
      render();
      return Promise.resolve();
    },
    regions: function (c) {
      return api("GET", "/api/admin/regions").then(function (r) {
        c.innerHTML = "";
        var on = r.regions.filter(function (x) { return x.active; }).length;
        c.appendChild(el("p", { class: "muted small", text: "Choose where in India SafeShe is reachable. Passengers can book only when pickup and drop are inside a reachable region (a circle around the city centre). " + on + " of " + r.regions.length + " regions are reachable." }));
        // add a region
        var nm = el("input", { type: "text", placeholder: "City / area name, e.g. Mysuru" }), st = el("input", { type: "text", placeholder: "State" });
        var la = el("input", { type: "number", step: "0.0001", placeholder: "Latitude" }), lo = el("input", { type: "number", step: "0.0001", placeholder: "Longitude" });
        var rad = el("input", { type: "number", min: "1", max: "200", value: "20" }), act0 = el("input", { type: "checkbox" }); act0.checked = true;
        c.appendChild(el("section", { class: "card" }, el("h3", { text: "Add a region" }),
          el("div", { class: "filters" }, nm, act("Find", "ghost", function () {
            if (nm.value.trim().length < 2) { toast("Type the city name first"); return; }
            return api("GET", "/api/geo/search?q=" + encodeURIComponent(nm.value.trim() + ", India")).then(function (s) {
              var x = (s.results || [])[0]; if (!x) { toast("City not found. Enter latitude/longitude."); return; }
              la.value = x.lat.toFixed(4); lo.value = x.lng.toFixed(4); toast("Found: " + x.address.slice(0, 60));
            });
          })),
          el("div", { class: "grid2" }, el("label", { class: "small muted" }, "State", st), el("label", { class: "small muted" }, "Latitude", la), el("label", { class: "small muted" }, "Longitude", lo), el("label", { class: "small muted" }, "Radius (km)", rad)),
          el("label", { class: "check" }, act0, " Reachable now (rides available)"),
          act("Add region", "primary", function () {
            return api("POST", "/api/admin/regions", { name: nm.value, state: st.value, lat: +la.value, lng: +lo.value, radiusKm: +rad.value, active: act0.checked })
              .then(function (x) { toast(x.region.name + " added"); adminTab("regions", true); });
          })));
        c.appendChild(el("div", { class: "list" }, r.regions.map(function (g) {
          var sw = el("input", { type: "checkbox" }); sw.checked = g.active;
          var radius = el("input", { type: "number", min: "1", max: "200", value: g.radiusKm, style: "max-width:90px" });
          sw.onchange = function () {
            api("PUT", "/api/admin/regions/" + g.id, { active: sw.checked }).then(function (x) { toast(x.region.name + (x.region.active ? " is now reachable" : " is now not reachable")); adminTab("regions", true); })
              .catch(function (e) { toast(e.message); sw.checked = !sw.checked; });
          };
          return el("div", { class: "item" },
            el("div", { class: "regionrow" },
              el("div", null, el("h4", { text: g.name + (g.state ? " · " + g.state : "") }),
                el("div", { class: "small muted", text: g.lat.toFixed(3) + ", " + g.lng.toFixed(3) + " · " + g.rides30d + " rides in 30 days" })),
              el("label", { class: "switch", title: "Reachable" }, sw, el("span", { class: "slider" }))),
            el("div", { class: "small", text: g.active ? "✅ Reachable: passengers can book here" : "⛔ Not reachable: shown as Coming soon" }),
            el("div", { class: "acts" }, el("span", { class: "small muted" }, "Radius km "), radius,
              act("Save radius", "ghost", function () { return api("PUT", "/api/admin/regions/" + g.id, { radiusKm: +radius.value }).then(function () { toast("Saved"); }); }),
              act("Delete", "ghost", function () { if (!confirm("Delete " + g.name + "?")) return; return api("DELETE", "/api/admin/regions/" + g.id).then(function () { adminTab("regions", true); }); })));
        })));
      });
    },
    payments: function (c) {
      var f = adminFilter.payments || "pending";
      return Promise.all([api("GET", "/api/admin/payments" + (f === "all" ? "" : "?status=" + f)), api("GET", "/api/admin/dues"), api("GET", "/api/admin/payment-settings")]).then(function (x) {
        var pays = x[0].payments, d = x[1], ps = x[2]; c.innerHTML = "";
        if (!ps.upiId) c.appendChild(el("p", { class: "testcode", text: "Set your UPI ID in Settings → Payments so riders can pay their commission." }));
        function k(label, v, alert) { return el("div", { class: "kpi" + (alert ? " alert" : "") }, el("small", { text: label }), el("b", { text: v })); }
        c.appendChild(el("div", { class: "kpis" }, k("Total commission", rupees(d.totals.charged)), k("Received (confirmed)", rupees(d.totals.paid)), k("Still due", rupees(d.totals.due), d.totals.due > 0), k("Waiting to verify", rupees(d.totals.pending), d.totals.pending > 0)));
        c.appendChild(el("h3", { text: "Payments reported by riders" }));
        c.appendChild(filterChips(["pending", "confirmed", "rejected", "all"], f, function (v) { adminFilter.payments = v; adminTab("payments"); }));
        c.appendChild(el("p", { class: "muted small", text: "Check each UPI reference (UTR) in your bank or UPI app before confirming." }));
        c.appendChild(pays.length ? el("div", { class: "list" }, pays.map(function (p) {
          return el("div", { class: "item" },
            el("div", { class: "between" }, el("h4", { text: rupees(p.amount) + " · " + (p.name || "Rider") }), el("span", { class: "pill " + (p.status === "pending" ? "amber" : p.status === "rejected" ? "red" : ""), text: p.status })),
            el("div", { class: "small" }, "UTR ", el("span", { class: "upiid", text: p.utr }), " · " + p.phone + " · " + when(p.createdAt)),
            p.note ? el("div", { class: "small muted", text: "Note: " + p.note }) : null,
            p.status === "pending" ? el("div", { class: "acts" },
              act("✓ Confirm received", "ok", function () { return api("POST", "/api/admin/payments/" + p.id + "/confirm", {}).then(function () { toast("Payment confirmed"); adminTab("payments", true); }); }),
              act("Reject", "ghost", function () { var n = prompt("Reason (shown to the rider)", "Payment not found in UPI statement"); if (n === null) return; return api("POST", "/api/admin/payments/" + p.id + "/reject", { note: n }).then(function () { adminTab("payments", true); }); })) : null);
        })) : el("p", { class: "muted", text: "No payments here." }));
        c.appendChild(el("h3", { text: "Commission by rider" }));
        c.appendChild(d.riders.length ? el("div", { class: "list" }, d.riders.map(function (r) {
          return el("div", { class: "item" },
            el("div", { class: "between" }, el("h4", { text: (r.name || "Rider") + " · " + (r.plate || "") }), el("b", { text: rupees(r.due) + " due" })),
            el("div", { class: "small muted", text: r.phone + " · total " + rupees(r.charged) + " · paid " + rupees(r.paid) + (r.pending ? " · " + rupees(r.pending) + " to verify" : "") }),
            el("div", { class: "acts" }, act("📞 Call", "ghost", function () { dial(r.phone); })));
        })) : el("p", { class: "muted", text: "No commission yet. It is added when riders complete rides." }));
      });
    },
    fares: function (c) {
      return api("GET", "/api/admin/fares").then(function (r) {
        c.innerHTML = "";
        c.appendChild(el("p", { class: "muted small", text: "Upfront fare = Base fare (covers the first included km) + extra km × per-km rate + platform fee. The per-minute rate is charged only in gridlock. SafeShe's share of every ride = Platform fee + Minimum (the rider pays it to your UPI ID after each ride; the minimum is waived while the rider has a pass). The fare is never below the Minimum. Night premium and long-pickup surcharge are set in Settings → Pricing. Changes apply to new bookings immediately." }));
        var inputs = [];
        var rows = r.fares.map(function (f) {
          var o = { vehicle: f.vehicle };
          function cell(k, type) { var i = el("input", { type: type || "number", step: "0.5", min: "0", value: f[k] }); o[k] = i; return el("td", null, i); }
          var chk = el("input", { type: "checkbox" }); chk.checked = !!f.active; o.active = chk;
          inputs.push(o);
          return el("tr", null, el("td", { text: VEH_ICON[f.vehicle] }), cell("name", "text"), cell("base"), cell("included_km"), cell("per_km"), cell("per_min"), cell("platform_fee"), cell("min_fare"), el("td", null, chk));
        });
        c.appendChild(el("div", { class: "tablewrap" }, el("table", { class: "fares" },
          el("tr", null, ["", "Name", "Base ₹", "Base covers km", "Per km ₹", "Per min ₹ (gridlock)", "Platform fee ₹", "Minimum ₹ (SafeShe share)", "Active"].map(function (h) { return el("th", { text: h }); })), rows)));
        c.appendChild(act("Save fares", "primary", function () {
          var body = { fares: inputs.map(function (o) { return { vehicle: o.vehicle, name: o.name.value, base: +o.base.value, included_km: +o.included_km.value, per_km: +o.per_km.value, per_min: +o.per_min.value, platform_fee: +o.platform_fee.value, min_fare: +o.min_fare.value, active: o.active.checked }; }) };
          return api("PUT", "/api/admin/fares", body).then(function () { toast("Fares saved"); });
        }));
      });
    },
    settings: function (c) {
      return Promise.all([api("GET", "/api/admin/otps"), api("GET", "/api/admin/sms-status").catch(function (e) { return { message: e.message }; })]).then(function (x) {
        var r = x[0], sms = x[1];
        c.innerHTML = "";
        var srcText = sms.source === "env" ? "Key from Vercel settings (TWOFACTOR_API_KEY) " + (sms.keyHint || "")
          : sms.source === "admin" ? "Key saved here in the admin panel " + (sms.keyHint || "") : "No key saved yet";
        var keyIn = el("input", { type: "password", autocomplete: "off", spellcheck: "false", placeholder: "Paste your 2Factor API key (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)" });
        var box = el("section", { class: "card" }, el("h3", { text: "Login OTP delivery (SMS)" }),
          el("p", { class: "small " + (sms.ok ? "" : "status bad"), text: (sms.ok ? "✅ " : "⚠️ ") + sms.message }),
          el("p", { class: "small muted", text: "This admin panel is connected to: " + (apiBase() || location.origin) + " · " + srcText }),
          sms.source !== "env" ? el("div", null,
            el("label", { class: "small muted", text: "2Factor API key (from 2factor.in → Account Summary). It's checked with 2Factor, then saved for every SafeShe server that uses this database." }),
            el("div", { class: "filters" }, keyIn,
              act("Save & check key", "primary", function () {
                if (!keyIn.value.trim()) { toast("Paste the key first"); return; }
                return api("PUT", "/api/admin/sms-key", { key: keyIn.value.trim() }).then(function (st) { keyIn.value = ""; toast(st.message, 5000); adminTab("settings", true); });
              }),
              sms.source === "admin" ? act("Remove key", "ghost", function () {
                if (!confirm("Remove the saved 2Factor key? Login codes will stop being sent by SMS.")) return;
                return api("PUT", "/api/admin/sms-key", { key: "" }).then(function () { adminTab("settings", true); });
              }) : null)) : null,
          r.testMode ? el("p", { class: "small muted", text: "Until a key is saved, login codes are not sent by SMS; the latest codes are listed below so you can still log people in." }) : null);
        if (!r.testMode) {
          var tp = el("input", { type: "tel", inputmode: "numeric", maxlength: "10", placeholder: "10-digit mobile number" });
          box.appendChild(el("div", { class: "filters" }, tp, act("Send test SMS", "primary", function () {
            return api("POST", "/api/admin/sms-test", { phone: tp.value }).then(function (t) { toast(t.message, 5000); });
          })));
        }
        if (r.testMode) box.appendChild(r.codes.length ? el("div", { class: "list" }, r.codes.map(function (x) { return el("div", { class: "small", text: x.phone + " → " + x.code + " · " + when(x.at) }); })) : el("p", { class: "muted small", text: "No codes requested yet." }));
        c.appendChild(box);
        // Pricing rules: night premium, long-pickup surcharge, gridlock trigger, rider plans (tiers)
        var pr = { night: {}, pickup: {}, gridlock: {}, tiers: { perRide: {}, half: {}, full: {} } };
        function nf(obj, key, label, step) {
          var i = el("input", { type: "number", step: step || "1", min: "0" });
          (nf.list = nf.list || []).push(function () { i.value = obj()[key]; });
          i.addEventListener("input", function () { obj()[key] = i.value === "" ? "" : +i.value; });
          return el("label", { class: "small muted" }, label, i);
        }
        nf.list = [];
        var nightOn = el("input", { type: "checkbox" });
        var pcard = el("section", { class: "card" }, el("h3", { text: "Pricing & rider plans" }),
          el("p", { class: "small muted", text: "Night premium multiplies base + distance + traffic charges (not the platform fee or pickup surcharge). Times are India time." }),
          el("label", { class: "check" }, nightOn, " Night premium on"),
          el("div", { class: "grid2" }, nf(function () { return pr.night; }, "multiplier", "Night multiplier (×)", "0.05"), nf(function () { return pr.night; }, "startHour", "Starts at hour (0–23)"), nf(function () { return pr.night; }, "endHour", "Ends at hour (0–23)")),
          el("p", { class: "small muted", text: "Long pickup surcharge: added when the rider is far from the passenger; 100% goes to the rider." }),
          el("div", { class: "grid2" }, nf(function () { return pr.pickup; }, "freeKm", "Free pickup distance (km)", "0.5"), nf(function () { return pr.pickup; }, "perKm", "₹ per extra pickup km", "0.5")),
          el("p", { class: "small muted", text: "Gridlock trigger: the per-minute rate is charged only while the vehicle is slower than this speed for longer than this many minutes." }),
          el("div", { class: "grid2" }, nf(function () { return pr.gridlock; }, "speedKmh", "Speed below (km/h)"), nf(function () { return pr.gridlock; }, "minMinutes", "For more than (minutes)")),
          el("p", { class: "small muted", text: "Rider plans. Tier 1 (pay per ride) pays SafeShe's share on every ride = Platform fee + Minimum, set per vehicle in Admin → Fares. A pass waives the Minimum." }),
          el("div", { class: "grid2" },
            nf(function () { return pr.tiers.half; }, "price", "Tier 2 · Half-Day Pass ₹"), nf(function () { return pr.tiers.half; }, "hours", "Half-Day Pass hours"),
            nf(function () { return pr.tiers.full; }, "price", "Tier 3 · Full-Day Pass ₹"), nf(function () { return pr.tiers.full; }, "hours", "Full-Day Pass hours")),
          act("Save pricing", "primary", function () {
            pr.night.enabled = nightOn.checked;
            return api("PUT", "/api/admin/pricing", pr).then(function (v) { pr = v; nf.list.forEach(function (f) { f(); }); toast("Pricing saved"); });
          }));
        c.appendChild(pcard);
        api("GET", "/api/admin/pricing").then(function (v) { pr = v; nightOn.checked = !!v.night.enabled; nf.list.forEach(function (f) { f(); }); }).catch(function () {});
        // Payments: the admin's UPI ID that riders pay their commission to
        var upi = el("input", { type: "text", autocomplete: "off", autocapitalize: "off", placeholder: "your UPI ID, e.g. yourname@okaxis" });
        var pname = el("input", { type: "text", placeholder: "Name shown in the UPI app (e.g. SafeShe)" });
        var lim = el("input", { type: "number", min: "0", step: "10", placeholder: "0 = no limit" });
        api("GET", "/api/admin/payment-settings").then(function (p) { upi.value = p.upiId; pname.value = p.payeeName; lim.value = p.duesLimit || ""; }).catch(function () {});
        c.appendChild(el("section", { class: "card" }, el("h3", { text: "Payments (UPI)" }),
          el("p", { class: "small muted", text: "Riders pay their SafeShe commission to this UPI ID. Use a UPI ID you own; a business/merchant UPI ID works best with all UPI apps." }),
          el("label", { class: "small muted", text: "UPI ID" }), upi, el("div", { style: "height:6px" }),
          el("label", { class: "small muted", text: "Payee name" }), pname, el("div", { style: "height:6px" }),
          el("label", { class: "small muted", text: "Block riders from going online when unpaid commission is above (₹)" }), lim, el("div", { style: "height:8px" }),
          act("Save payment settings", "primary", function () {
            return api("PUT", "/api/admin/payment-settings", { upiId: upi.value.trim(), payeeName: pname.value.trim(), duesLimit: lim.value === "" ? 0 : +lim.value })
              .then(function (p) { upi.value = p.upiId; toast(p.upiId ? "Saved. Riders will pay to " + p.upiId : "Saved (no UPI ID set)"); });
          })));
        var em = el("input", { type: "email", autocomplete: "email", placeholder: "admin email, e.g. name@gmail.com" });
        api("GET", "/api/admin/me").then(function (m) { em.value = (m.admin && m.admin.email) || ""; }).catch(function () {});
        c.appendChild(el("section", { class: "card" }, el("h3", { text: "Admin email" }),
          el("p", { class: "small muted", text: "You can log in with this email instead of the username “Administrator”." }), em, el("div", { style: "height:8px" }),
          act("Save email", "primary", function () {
            return api("PUT", "/api/admin/email", { email: em.value.trim() }).then(function (r) { em.value = r.email || ""; toast(r.email ? "Admin email saved: " + r.email : "Admin email removed"); });
          })));
        var cur = el("input", { type: "password", autocomplete: "current-password", placeholder: "Current password" });
        var nx = el("input", { type: "password", autocomplete: "new-password", placeholder: "New password (min 8 characters)" });
        c.appendChild(el("section", { class: "card" }, el("h3", { text: "Change admin password" }), cur, el("div", { style: "height:8px" }), nx, el("div", { style: "height:8px" }),
          act("Change password", "primary", function () { return api("POST", "/api/admin/password", { current: cur.value, next: nx.value }).then(function () { cur.value = nx.value = ""; toast("Password changed. Other admin sessions were logged out."); }); })));
        c.appendChild(el("section", { class: "card" }, el("h3", { text: "Server" }), el("p", { class: "small muted", text: "Connected to " + (apiBase() || location.origin) })));
      });
    },
  };

  // ============================================================ Android back + native events
  function handleBack() {
    if ($("sosModal").classList.contains("show")) { $("sosModal").classList.remove("show"); return true; }
    if ($("regionModal").classList.contains("show")) { $("regionModal").classList.remove("show"); return true; }
    if ($("settleModal").classList.contains("show")) return true; // rider must choose: received / submit / pay later
    if ($("drawer").classList.contains("show")) { openDrawer(false); return true; }
    if ([].some.call(document.querySelectorAll(".page"), function (p) { return !p.hidden; })) { closePages(); return true; }
    if (pickMode) { pickMode = null; sheet.style.transform = ""; return true; }
    if (!$("scr-login").hidden) { showScreen("scr-welcome"); return true; }
    if (role === "passenger" && !curRide && drop && !$("scr-main").hidden) { resetPassenger(); return true; }
    return false;
  }
  window.addEventListener("keydown", function (e) { if (e.key === "Escape") handleBack(); });
  window.SafeShe = {
    back: handleBack,
    onAppResumed: function (awayMs) {
      if (session && session.kind === "user") refreshActive();
      // Replay the opening animation when coming back after a while, but never during a ride or an emergency.
      var busy = curRide && ["requested", "accepted", "arrived", "started"].indexOf(curRide.status) >= 0;
      if (awayMs >= SPLASH_AGAIN_MS && !busy && !driverRide && !sosOpen() && !$("check").classList.contains("show")) playSplash();
      // The "Everything okay? / I'm safe" check is for passengers only, never for riders or the admin.
      if (!session || session.kind !== "user" || role !== "passenger") return;
      var onRide = curRide && ["accepted", "arrived", "started"].indexOf(curRide.status) >= 0 && tripMonitorOn;
      if (!(mon.checked || onRide) || awayMs < MIN_AWAY_MS) return;
      if (!$("check").classList.contains("show") && !sosOpen()) openCheck(awayMs);
    },
    onNative: function (ev, d) {
      switch (ev) {
        case "recStarted":
          recording = true; playing = false; hasTake = false; recStart = Date.now();
          clearInterval(recTick); recTick = setInterval(function () { $("recTimer").textContent = fmt(Date.now() - recStart); setRecUI(); }, 500);
          status("recStatus", "Recording… keep SafeShe open.", "good"); toast("Recording started"); break;
        case "recStopped":
          recording = false; hasTake = true; clearInterval(recTick); $("recTimer").textContent = fmt(d.durationMs);
          status("recStatus", "Recorded " + fmt(d.durationMs) + " (" + Math.round(d.bytes / 1024) + " KB). Play or download it in Safety centre."); toast("Recording saved in Safety centre"); break;
        case "recError": recording = false; clearInterval(recTick); status("recStatus", d.message, "bad"); toast(d.message); break;
        case "playStarted": playing = true; status("recStatus", "Playing…"); break;
        case "playStopped": playing = false; status("recStatus", "Playback stopped."); break;
        case "saveResult": status("recStatus", d.message, d.ok ? "good" : "bad"); toast(d.message); break;
        case "fileSaved": toast((d.ok ? "✅ " : "⚠️ ") + d.message + (d.ok && /\.png$/i.test(d.name || "") ? ". In your UPI app: Scan → gallery → pick this image." : ""), 7000);
          if (reportStatus && !/\.png$/i.test(d.name || "")) reportStatus(d.message, d.ok); break;
        case "location": resolveLoc(d); break;
        case "locError": if (sosOpen() && !sosLoc) renderSosLoc(d.message); resolveLoc(null, d.message); break;
        case "toast": toast(d.message); break;
      }
      setRecUI();
    }
  };

  // ============================================================ opening animation
  // Plays every time the app opens (≈2.5 s, tap to skip) and again after being away for over a minute.
  var SPLASH_MS = 2550, SPLASH_AGAIN_MS = 60000, splashTimer = null;
  function playSplash() {
    var s = $("splash"); if (!s) return;
    clearTimeout(splashTimer);
    s.classList.remove("gone", "out", "play"); void s.offsetWidth; s.classList.add("play"); // restart CSS animations
    var mv = document.getElementById("riderMove");
    if (mv && mv.beginElement) setTimeout(function () { try { mv.beginElement(); } catch (e) {} }, 300);
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    splashTimer = setTimeout(hideSplash, reduce ? 600 : SPLASH_MS);
  }
  function hideSplash() {
    var s = $("splash"); if (!s || s.classList.contains("gone")) return;
    clearTimeout(splashTimer);
    s.classList.add("out");
    setTimeout(function () { s.classList.add("gone"); s.classList.remove("play"); }, 460);
  }
  $("splash").addEventListener("click", hideSplash);
  window.SafeSheSplash = { play: playSplash, hide: hideSplash };

  playSplash();
  setRecUI();
  boot();
})();
