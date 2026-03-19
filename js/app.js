// ── IMPORTS ─────────────────────────────────────────────────────────────────
import { db } from "./firebase-config.js";
import {
  ref, set, onValue, runTransaction, push, get
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ── CONSTANTS ────────────────────────────────────────────────────────────────
const HOLES = 18;
const root  = ref(db, "golf");

const DEFAULT_INSTRUCTIONS = [
  { warn: false, text: "<strong>Tap your team tab</strong> at the top of the screen to open your scorecard." },
  { warn: false, text: "<strong>Tap a hole number</strong> to expand it, then enter a score for each player on your team." },
  { warn: false, text: "<strong>The lowest score</strong> among your players is automatically assigned as the team score for that hole. It highlights green." },
  { warn: false, text: "<strong>Check the Leaderboard</strong> tab at any time to see team standings and individual scores." },
  { warn: true,  text: "<strong>3-minute rule:</strong> Spend no more than 3 minutes looking for a lost ball. Pick up and move on." },
  { warn: true,  text: "<strong>Double bogey max:</strong> If a player reaches double bogey (2 over par for that hole), pick up the ball and record the double-bogey score. Keep the round moving." }
];

// ── STATE ────────────────────────────────────────────────────────────────────
let state        = defaultState();
let _instrDraft  = null;     // working copy while editing instructions
let tab          = "home";   // "home" | "setup" | "lb" | "archive" | 0..N
let openHole     = null;     // currently expanded hole index on scoring panel
let unlocked     = new Set(); // tabs unlocked this session
let pendingTab   = null;
let saveTimer    = null;
let remoteWrite  = false;
let lbThru       = 18;
let spectatorMode = false;

// ── PERFORMANCE: score write debounce ────────────────────────────────────────
// Key: `${t}-${h}-${p}`, value: pending timeout id
const _scoreDebounceTimers = {};

// ── PERFORMANCE: render debounce ─────────────────────────────────────────────
let _renderTimer = null;

// ── PERFORMANCE: leaderboard memoization ─────────────────────────────────────
const _teamTotalCache     = {};
const _teamTotalThruCache = {};

function _invalidateCache() {
  Object.keys(_teamTotalCache).forEach(k => delete _teamTotalCache[k]);
  Object.keys(_teamTotalThruCache).forEach(k => delete _teamTotalThruCache[k]);
}

// ── DEFAULTS ─────────────────────────────────────────────────────────────────
function defaultState() {
  return {
    config: {
      numTeams: 6,
      numPlayers: 4,
      tournamentName: "Men's Retreat Golf Tournament",
      par: [4,4,3,4,5,4,3,4,4, 4,3,5,4,4,3,4,4,5]
    },
    teams: Object.fromEntries(Array.from({length:6}, (_,t) => [t, {
      name: "Team " + (t+1),
      players: Object.fromEntries(Array.from({length:4}, (_,p) => [p, {name:"Player "+(p+1)}]))
    }])),
    scores: {}
  };
}

// ── FIREBASE ─────────────────────────────────────────────────────────────────
onValue(root, snap => {
  setStatus(true);
  const d = snap.val();
  if (d && d.config) {
    remoteWrite = true;
    state = d;
    normalise();
    _invalidateCache();
    // Don't re-render when user is actively on setup — would destroy inputs
    if (tab === "setup") {
      renderNav();
    } else {
      _scheduleRender();
    }
    remoteWrite = false;
  } else {
    state = defaultState();
    _invalidateCache();
    render();
  }
}, () => setStatus(false));

// Debounce re-render triggered by Firebase updates
function _scheduleRender() {
  clearTimeout(_renderTimer);
  _renderTimer = setTimeout(render, 150);
}

function setStatus(ok) {
  const dot = document.getElementById("dot");
  if (dot) dot.className = "dot" + (ok ? " on" : " err");
}

// ── NORMALISE ─────────────────────────────────────────────────────────────────
// Called once when data arrives from Firebase.
// par normalisation is done here, not on every render.
function normalise() {
  const nt = state.config.numTeams || 0;
  const np = state.config.numPlayers || 4;
  if (!state.teams)  state.teams  = {};
  if (!state.scores) state.scores = {};

  // Normalize par array (Firebase may return an object, not an array)
  if (state.config.par && !Array.isArray(state.config.par)) {
    state.config.par = Array.from({length:18}, (_,i) => +(state.config.par[i] ?? 4));
  }

  // Normalize instructions array (Firebase converts arrays to objects)
  if (state.instructions && !Array.isArray(state.instructions)) {
    state.instructions = Object.values(state.instructions);
  }
  if (!state.config.par || state.config.par.length !== 18) {
    state.config.par = [4,4,3,4,5,4,3,4,4, 4,3,5,4,4,3,4,4,5];
  }

  for (let t = 0; t < nt; t++) {
    if (!state.teams[t]) state.teams[t] = {name:"Team "+(t+1), players:{}};
    if (!state.teams[t].players) state.teams[t].players = {};
    for (let p = 0; p < np; p++) {
      if (!state.teams[t].players[p]) state.teams[t].players[p] = {name:"Player "+(p+1)};
    }
    if (!state.scores[t]) state.scores[t] = {};
  }
}

// ── WRITES ───────────────────────────────────────────────────────────────────
// Per-cell transaction — safe for simultaneous writes from multiple devices.
// Debounced 400 ms so rapid stepper taps don't flood Firebase.
function writeScore(t, h, p, val) {
  const key = `${t}-${h}-${p}`;
  clearTimeout(_scoreDebounceTimers[key]);
  _scoreDebounceTimers[key] = setTimeout(() => {
    const r = ref(db, `golf/scores/${t}/${h}/${p}`);
    const v = val === "" ? null : (isNaN(+val) ? null : +val);
    runTransaction(r, () => v);
    flash();
    delete _scoreDebounceTimers[key];
  }, 400);
}

function writeFull() {
  if (remoteWrite) return;
  clearTimeout(saveTimer);
  flash();
  saveTimer = setTimeout(() => set(root, state).catch(console.error), 700);
}

function flash() {
  const el = document.getElementById("savePill");
  if (!el) return;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 1800);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function tname(t)     { return state?.teams?.[t]?.name   || "Team "  + (t+1); }
function pname(t, p)  { return state?.teams?.[t]?.players?.[p]?.name || "Player " + (p+1); }
function tpin(t)      { return state?.teams?.[t]?.pin || ""; }
function score(t, h, p) {
  const v = state?.scores?.[t]?.[h]?.[p];
  return (v == null) ? "" : String(v);
}
function best(t, h) {
  const row = state?.scores?.[t]?.[h];
  if (!row) return null;
  const np = state.config.numPlayers || 4;
  const vals = [];
  for (let p = 0; p < np; p++) { const v = +row[p]; if (!isNaN(v) && v > 0) vals.push(v); }
  return vals.length ? Math.min(...vals) : null;
}
function holePar(h) {
  const p = state?.config?.par;
  return (p && p[h] != null) ? +p[h] : 4;
}
function coursePar() {
  return Array.from({length:18}, (_,h) => holePar(h)).reduce((a,b) => a+b, 0);
}
function fmtVsPar(s, par) {
  if (s == null || par == null || isNaN(s) || isNaN(par)) return "";
  const d = s - par;
  if (d === 0) return "E";
  return (d > 0 ? "+" : "") + d;
}
function teamParPlayed(t) {
  let p = 0;
  for (let h = 0; h < 18; h++) { if (best(t,h) !== null) p += holePar(h); }
  return p;
}
function esc(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// ── MEMOIZED LEADERBOARD HELPERS ─────────────────────────────────────────────
function teamTotal(t) {
  if (_teamTotalCache[t]) return _teamTotalCache[t];
  let total = 0, holes = 0;
  for (let h = 0; h < HOLES; h++) { const b = best(t,h); if (b!==null){total+=b;holes++;} }
  return (_teamTotalCache[t] = {total, holes});
}
function teamTotalThru(t, thru) {
  const key = `${t}-${thru}`;
  if (_teamTotalThruCache[key]) return _teamTotalThruCache[key];
  let total = 0, holes = 0;
  for (let h = 0; h < thru; h++) { const b = best(t,h); if (b!==null){total+=b;holes++;} }
  return (_teamTotalThruCache[key] = {total, holes});
}

// ── ADMIN PIN — stored in Firebase, not hardcoded ────────────────────────────
// Returns the PIN string from Firebase, or null if unset.
async function getAdminPin() {
  const snap = await get(ref(db, "golf/config/adminPin"));
  return snap.val() || null;
}

async function ensureAdminPin() {
  const existing = await getAdminPin();
  if (existing) return existing;
  // No PIN set — prompt to create one
  const pin = prompt("No admin PIN set. Enter a new admin PIN to secure this tournament:");
  if (!pin || !pin.trim()) return null;
  await set(ref(db, "golf/config/adminPin"), pin.trim());
  return pin.trim();
}

// ── SESSION PERSISTENCE ───────────────────────────────────────────────────────
// Restore unlocked set from sessionStorage so a page refresh doesn't log you out
function _loadSession() {
  try {
    const stored = sessionStorage.getItem("odcgolf_unlocked");
    if (stored) {
      JSON.parse(stored).forEach(v => {
        unlocked.add(typeof v === "number" ? v : v);
      });
    }
  } catch(e) { /* ignore */ }
}

function _saveSession() {
  try {
    sessionStorage.setItem("odcgolf_unlocked", JSON.stringify([...unlocked]));
  } catch(e) { /* ignore */ }
}

// ── RENDER ────────────────────────────────────────────────────────────────────
function render() {
  if (!state) return;
  const nt = state.config.numTeams || 0;
  // Redirect away from setup on first load if setup not yet unlocked
  if (tab === "setup" && nt > 0 && !unlocked.has("setup")) tab = "home";
  // Clamp numeric team tab if teams were removed
  if (typeof tab === "number" && tab >= nt) tab = nt > 0 ? Math.max(0, nt-1) : "home";
  renderNav();
  renderMain();
}

function renderNav() {
  const ttl  = document.getElementById("back-bar-title");
  const hbtn = document.getElementById("home-btn");
  if (tab === "home") {
    hbtn.style.visibility = "hidden";
    ttl.textContent = "";
  } else {
    hbtn.style.visibility = "visible";
    if      (tab === "setup")   ttl.textContent = "Setup";
    else if (tab === "lb")      ttl.textContent = "Leaderboard";
    else if (tab === "archive") ttl.textContent = "Archive";
    else                        ttl.textContent = "";
  }
}

function renderMain() {
  const el = document.getElementById("main");
  if (tab === "home")    { el.innerHTML = renderHome();  return; }
  if (tab === "setup")   { el.innerHTML = renderSetup(); return; }
  if (tab === "lb")      { el.innerHTML = renderLB();    return; }
  if (tab === "archive") {
    el.innerHTML = `<div class="lb-card"><div class="lb-head" style="background:var(--navy)"><h2>Archive</h2></div><div class="lb-empty">Loading…</div></div>`;
    renderArchive(el);
    return;
  }
  el.innerHTML = renderTeam(tab);
  // Re-attach open hole
  if (openHole !== null) {
    const card = el.querySelector(`.hole-card[data-hole="${openHole}"]`);
    if (card) card.classList.add("open");
  }
}

// ── SCORING PANEL ─────────────────────────────────────────────────────────────
function renderTeam(ti) {
  const np = state.config.numPlayers || 4;
  const { total, holes } = teamTotal(ti);

  // Player chips
  let chips = "";
  for (let p = 0; p < np; p++) {
    chips += `<div class="pchip"><span class="pchip-n">${p+1}</span>${esc(pname(ti,p))}</div>`;
  }

  // View-only banner
  const viewOnlyBanner = spectatorMode
    ? `<div class="spectator-bar">👁 Live view — scores update in real time</div>`
    : _viewOnly(ti) ? `
    <div class="view-only-bar">
      <span>👁 View only</span>
      <button class="unlock-score-btn" data-action="unlockTeam" data-t="${ti}">Enter PIN to Score</button>
    </div>` : "";

  // Hole cards
  let frontCards = "", backCards = "";
  let frontTotal = 0, frontHoles = 0, backTotal = 0, backHoles = 0;

  const readOnly = _isReadOnly(ti);
  for (let h = 0; h < HOLES; h++) {
    const b = best(ti, h);
    if (h < 9) { if (b!==null){frontTotal+=b;frontHoles++;} }
    else        { if (b!==null){backTotal+=b;backHoles++;} }

    let rows = "";
    for (let p = 0; p < np; p++) {
      const sc = score(ti, h, p);
      const isBest = sc !== "" && +sc === b && b !== null;
      if (spectatorMode) {
        rows += `<div class="score-row">
          <span class="score-pname${isBest?" best-p":""}">${esc(pname(ti,p))}</span>
          <input class="score-inp${isBest?" best":""}" type="number" inputmode="numeric"
            min="1" max="20" value="${esc(sc)}" placeholder="—"
            data-t="${ti}" data-h="${h}" data-p="${p}" disabled readonly>
        </div>`;
      } else {
        rows += `<div class="score-row">
          <span class="score-pname${isBest?" best-p":""}">${esc(pname(ti,p))}</span>
          <div class="score-stepper">
            <button class="score-step-btn" data-action="step" data-t="${ti}" data-h="${h}" data-p="${p}" data-delta="-1"${readOnly?' disabled':''}>−</button>
            <input class="score-inp stepped${isBest?" best":""}" type="number" inputmode="numeric" min="1" max="20" value="${esc(sc)}" placeholder="—" data-t="${ti}" data-h="${h}" data-p="${p}" data-action="scoreInput"${readOnly?' disabled readonly':''}>
            <button class="score-step-btn" data-action="step" data-t="${ti}" data-h="${h}" data-p="${p}" data-delta="1"${readOnly?' disabled':''}>+</button>
          </div>
        </div>`;
      }
    }

    const card = `<div class="hole-card${b!==null?" has-best":""}${openHole===h?" open":""}" data-hole="${h}" data-action="toggle">
      <div class="hole-top">
        <span class="hole-num">Hole <strong>${h+1}</strong></span>
        <span class="hole-par">par ${holePar(h)}</span>
        <span class="hole-best${b===null?" empty":""}">${b!==null?b:"—"}</span>
        <span class="hole-chevron">▼</span>
      </div>
      <div class="hole-scores" data-action="stopProp">${rows}</div>
    </div>`;

    if (h < 9) frontCards += card; else backCards += card;
  }

  const frontSum = frontHoles > 0 ? frontTotal : "—";
  const backSum  = backHoles  > 0 ? backTotal  : "—";

  return `<div class="card">
    <div class="card-head">
      <h2>${esc(tname(ti))}</h2>
      <div class="total">
        <div class="total-num">${holes>0?total:"—"}${holes>0?`<span class="total-stp">${fmtVsPar(total,teamParPlayed(ti))}</span>`:""}</div>
        <div class="total-sub">${holes}/18 holes</div>
      </div>
    </div>
    <div class="players-strip">${chips}</div>
    ${viewOnlyBanner}
    <div class="holes-list">
      <div class="nine-divider">Front 9</div>
      ${frontCards}
      <div class="nine-total"><span>Front 9 total</span><span>${frontSum}</span></div>
      <div class="nine-divider">Back 9</div>
      ${backCards}
      <div class="nine-total"><span>Back 9 total</span><span>${backSum}</span></div>
    </div>
  </div>`;
}

// ── HOLE TOGGLE ───────────────────────────────────────────────────────────────
function _toggle(h) {
  openHole = openHole === h ? null : h;
  document.querySelectorAll(".hole-card").forEach(c => {
    const ch = +c.dataset.hole;
    if (ch === h) {
      c.classList.toggle("open", openHole === h);
    } else {
      c.classList.remove("open");
    }
  });
}

// ── SCORE HANDLERS ────────────────────────────────────────────────────────────
function _sc(t, h, p, val) {
  if (!state.scores)    state.scores    = {};
  if (!state.scores[t]) state.scores[t] = {};
  if (!state.scores[t][h]) state.scores[t][h] = {};
  const parsed = val === "" ? null : (isNaN(+val) ? null : +val);
  state.scores[t][h][p] = parsed;
  _invalidateCache();
  writeScore(t, h, p, val);
  if (navigator.vibrate) navigator.vibrate(30);
  _refreshHole(t, h);
}

// Live highlight as user types (no Firebase write yet)
function _sci(t, h, p, val) {
  if (!state.scores)    state.scores    = {};
  if (!state.scores[t]) state.scores[t] = {};
  if (!state.scores[t][h]) state.scores[t][h] = {};
  state.scores[t][h][p] = val === "" ? null : (isNaN(+val) ? null : +val);
  _invalidateCache();
  _refreshHole(t, h);
}

function _step(t, h, p, delta) {
  const inp = document.querySelector(`.hole-card[data-hole="${h}"] input[data-p="${p}"]`);
  const cur  = inp ? (parseInt(inp.value, 10) || 0) : 0;
  const next = Math.max(1, Math.min(20, cur + delta));
  if (inp) { inp.value = next; }
  _sc(t, h, p, String(next));
}

// ── SURGICAL DOM UPDATE ───────────────────────────────────────────────────────
function _refreshHole(ti, h) {
  const b  = best(ti, h);
  const np = state.config.numPlayers || 4;

  const card = document.querySelector(`.hole-card[data-hole="${h}"]`);
  if (card) {
    card.classList.toggle("has-best", b !== null);
    const bestEl = card.querySelector(".hole-best");
    if (bestEl) { bestEl.textContent = b !== null ? b : "—"; bestEl.classList.toggle("empty", b===null); }
    for (let p = 0; p < np; p++) {
      const inp = card.querySelector(`input[data-p="${p}"]`);
      const lbl = card.querySelectorAll(".score-pname")[p];
      if (!inp) continue;
      const v = score(ti, h, p);
      const isBest = v !== "" && +v === b && b !== null;
      inp.classList.toggle("best", isBest);
      if (lbl) lbl.classList.toggle("best-p", isBest);
    }
  }

  // Update team header total
  const { total, holes } = teamTotal(ti);
  const totalNum = document.querySelector(".total-num");
  const totalSub = document.querySelector(".total-sub");
  if (totalNum) {
    totalNum.textContent = holes > 0 ? total : "—";
    if (holes > 0) {
      let stpSpan = totalNum.querySelector(".total-stp");
      if (!stpSpan) { stpSpan = document.createElement("span"); stpSpan.className = "total-stp"; totalNum.appendChild(stpSpan); }
      stpSpan.textContent = fmtVsPar(total, teamParPlayed(ti));
    } else {
      const stpSpan = totalNum.querySelector(".total-stp");
      if (stpSpan) stpSpan.remove();
    }
  }
  if (totalSub) totalSub.textContent = `${holes}/18 holes`;

  // Update nine totals
  let ft=0,fh=0,bt=0,bh=0;
  for (let i=0;i<9;i++)  { const v=best(ti,i);   if(v!==null){ft+=v;fh++;} }
  for (let i=9;i<18;i++) { const v=best(ti,i);   if(v!==null){bt+=v;bh++;} }
  const nineEls = document.querySelectorAll(".nine-total span:last-child");
  if (nineEls[0]) nineEls[0].textContent = fh > 0 ? ft : "—";
  if (nineEls[1]) nineEls[1].textContent = bh > 0 ? bt : "—";
}

// ── HOME SCREEN ───────────────────────────────────────────────────────────────
function renderHome() {
  const nt = state.config.numTeams || 0;
  const np = state.config.numPlayers || 4;

  let teamsHtml = "";
  for (let t = 0; t < nt; t++) {
    let playerChips = "";
    for (let p = 0; p < np; p++) {
      playerChips += `<span class="welcome-player">${esc(pname(t,p))}</span>`;
    }
    const {total: tileTotal, holes: tileHoles} = teamTotal(t);
    const stp = tileHoles > 0 ? fmtVsPar(tileTotal, teamParPlayed(t)) : null;
    const stpColor = stp === "E" ? "var(--gold-light)" : stp && stp[0]==="-" ? "#86efac" : stp ? "#fca5a5" : "";
    const badge = tileHoles > 0
      ? `<div class="team-tile-badge">Thru ${tileHoles} &bull; <span style="color:${stpColor};font-weight:800">${stp}</span></div>`
      : "";
    teamsHtml += `<button class="welcome-team" data-action="tab" data-tab="${t}">
      <div class="welcome-team-head">
        <h4>${esc(tname(t))}</h4>
        <span class="go-btn">Score →</span>
      </div>
      <div class="welcome-team-players">${playerChips}</div>
      ${badge}
    </button>`;
  }

  const setupPrompt = nt === 0 ? `<div class="welcome-section">
    <div class="rule-item" style="border-color:var(--blue);background:#eff6ff">
      <span class="rule-num" style="background:var(--navy)">★</span>
      <span class="rule-text"><strong>Admin:</strong> tap <strong>Setup</strong> below to configure teams and player names before the round begins.</span>
    </div>
  </div>` : "";

  return `<div class="welcome-card">
    <div class="welcome-hero">
      <h2>Welcome to the 1st Annual<br>Open Door Men's Retreat<br>Golf Tournament</h2>
      <p>Have fun &amp; play well</p>
    </div>
    <div class="welcome-body">

      ${setupPrompt}

      ${nt > 0 ? `<div class="welcome-section">
        <p class="tap-label">Tap Your Team to Score</p>
        <div class="teams-grid">${teamsHtml}</div>
      </div>` : ""}

      <div class="welcome-section">
        <h3>How to Score</h3>
        <div class="welcome-rules">
          ${_renderInstructions()}
        </div>
      </div>

      <div class="welcome-section action-section">
        <button class="action-tile" data-action="tab" data-tab="setup">
          <span class="action-icon">⚙</span>
          <span class="action-label">Setup</span>
          <span class="action-sub">Configure teams &amp; players</span>
        </button>
        <button class="action-tile" data-action="openAdmin">
          <span class="action-icon">✎</span>
          <span class="action-label">Edit Instructions</span>
          <span class="action-sub">Update home screen rules</span>
        </button>
        <button class="action-tile danger" data-action="openAdmin">
          <span class="action-icon">↺</span>
          <span class="action-label">Admin Reset</span>
          <span class="action-sub">Clear all scores</span>
        </button>
        <button class="action-tile" data-action="tab" data-tab="archive">
          <span class="action-icon">📋</span>
          <span class="action-label">Archive</span>
          <span class="action-sub">Past results</span>
        </button>
      </div>

    </div>
  </div>`;
}

// ── LEADERBOARD ───────────────────────────────────────────────────────────────
function renderLB() {
  const nt = state.config.numTeams || 0;
  const np = state.config.numPlayers || 4;

  const teamRows = Array.from({length:nt}, (_,i) => {
    const {total,holes} = teamTotalThru(i, lbThru);
    return {name:tname(i), total, holes, idx:i};
  }).sort((a,b) => {
    if (a.holes===0&&b.holes===0) return 0;
    if (a.holes===0) return 1; if (b.holes===0) return -1;
    return a.total - b.total;
  });

  const hasAny = teamRows.some(r => r.holes > 0);
  const rnkClass = i => i===0?"g":i===1?"s":i===2?"b":"";

  const teamHtml = teamRows.map((r,i) => {
    const stpStr = r.holes > 0 ? fmtVsPar(r.total, teamParPlayed(r.idx)) : "";
    const stpCls = stpStr === "E" ? "stp-even" : stpStr && stpStr[0]==="-" ? "stp-under" : "stp-over";
    return `<div class="lb-row${i===0&&r.holes>0?" leader":""}">
    <span class="lb-rank ${rnkClass(i)}">${i+1}</span>
    <span class="lb-name${i===0&&r.holes>0?" leader":""}">${esc(r.name)}${r.holes===18?'<span class="lb-complete">✓</span>':''}</span>
    <div class="lb-detail">
      ${r.holes>0 ? `<div class="lb-score${i===0?" leader":""}">${r.total}${stpStr?`<span class="stp-badge ${stpCls}">${stpStr}</span>`:""}</div>` : `<div class="lb-score pend">—</div>`}
      <div class="lb-holes">${r.holes}/18 holes</div>
    </div>
  </div>`;
  }).join("");

  // Individual player scores
  const players = [];
  for (let t = 0; t < nt; t++) {
    for (let p = 0; p < np; p++) {
      let total = 0, holes = 0, parPlayed = 0;
      for (let h = 0; h < HOLES; h++) {
        const v = state?.scores?.[t]?.[h]?.[p];
        const n = +v;
        if (v != null && !isNaN(n) && n > 0) { total += n; holes++; parPlayed += holePar(h); }
      }
      players.push({name:pname(t,p), team:tname(t), total, holes, parPlayed});
    }
  }
  players.sort((a,b) => {
    if (a.holes===0&&b.holes===0) return 0;
    if (a.holes===0) return 1; if (b.holes===0) return -1;
    return a.total - b.total;
  });
  const hasPlayerScores = players.some(p => p.holes > 0);

  const playerHtml = players.map((p,i) => {
    const isLeader = i===0 && p.holes>0;
    const pStpStr = p.holes > 0 ? fmtVsPar(p.total, p.parPlayed) : "";
    const pStpCls = pStpStr === "E" ? "stp-even" : pStpStr && pStpStr[0]==="-" ? "stp-under" : "stp-over";
    return `<div class="lb-player-row${isLeader?" p-leader":""}">
      <span class="lb-player-rank ${rnkClass(i)}">${i+1}</span>
      <div class="lb-player-info">
        <div class="lb-player-name${isLeader?" p-leader":""}">${esc(p.name)}</div>
        <div class="lb-player-team">${esc(p.team)}</div>
      </div>
      <div class="lb-player-score">
        ${p.holes>0 ? `<div class="lb-player-num${isLeader?" p-leader":""}">${p.total}${pStpStr?`<span class="stp-badge ${pStpCls}">${pStpStr}</span>`:""}</div>` : `<div class="lb-player-num pend">—</div>`}
        <div class="lb-player-holes">${p.holes}/18</div>
      </div>
    </div>`;
  }).join("");

  return `<div class="lb-card">
    <div class="lb-head">
      <h2>Leaderboard</h2>
      <span class="tname">${esc(state.config.tournamentName||"")}</span>
      <button class="lb-refresh-btn" data-action="lbRefresh" title="Refresh">↻</button>
    </div>
    <div class="lb-thru-bar">
      <span class="lb-thru-label">Through hole <strong>${lbThru}</strong></span>
      <input type="range" min="1" max="18" value="${lbThru}" class="lb-thru-slider" data-action="lbThru">
    </div>
    ${hasAny ? teamHtml : `<div class="lb-empty">No scores yet — tap a team tab to start.</div>`}
    <div class="lb-section-head"><h3>Individual scores</h3></div>
    ${hasPlayerScores ? playerHtml : `<div class="lb-empty">No individual scores yet.</div>`}
  </div>`;
}

// ── SETUP ─────────────────────────────────────────────────────────────────────
function renderSetup() {
  const cfg = state.config;
  const nt  = cfg.numTeams   || 6;
  const np  = cfg.numPlayers || 4;
  const tname_val = cfg.tournamentName || "";

  let teams = "";
  for (let t = 0; t < nt; t++) {
    let players = "";
    for (let p = 0; p < np; p++) {
      players += `<div class="player-row">
        <span class="player-idx">${p+1}.</span>
        <input class="player-inp" type="text" autocomplete="off" value="${esc(pname(t,p))}" placeholder="Player ${p+1}"
          data-action="setPlayerName" data-t="${t}" data-p="${p}">
      </div>`;
    }
    const pin = esc(tpin(t));
    teams += `<div class="tcard">
      <div class="tcard-head">
        <span class="tcard-idx">${t+1}</span>
        <input class="tcard-name-inp" type="text" autocomplete="off" value="${esc(tname(t))}" placeholder="Team ${t+1}"
          data-action="setTeamName" data-t="${t}">
      </div>
      <div class="tcard-body">
        ${players}
        <div class="pin-row">
          <label>Team PIN:</label>
          <input class="pin-inp" id="pin-inp-${t}" type="text" autocomplete="one-time-code" inputmode="numeric" maxlength="8" value="${pin}" placeholder="optional"
            data-action="setTeamPin" data-t="${t}">
          <button class="gen-pin-btn" data-action="genPin" data-t="${t}">🎲 Generate</button>
        </div>
      </div>
    </div>`;
  }

  const npOpts = [2,3,4,5,6].map(n=>`<option value="${n}"${n===np?" selected":""}>${n} players</option>`).join("");

  return `<div class="setup-card">
    <div class="setup-head"><h2>Tournament Setup</h2><p>Syncs live to all devices.</p></div>
    <div class="setup-body">
      <div class="form-row">
        <div class="form-group">
          <label>Tournament name</label>
          <input class="form-inp" type="text" autocomplete="off" value="${esc(tname_val)}" placeholder="e.g. Retreat 2026"
            data-action="setTournamentName">
        </div>
        <div class="form-group">
          <label>Players per team</label>
          <select class="form-inp" data-action="setNumPlayers">${npOpts}</select>
        </div>
      </div>
      <div class="row-btns">
        <span class="team-count">${nt} team${nt!==1?"s":""}</span>
        <button class="btn btn-outline" data-action="addTeam">+ Add Team</button>
        ${nt>1?`<button class="btn btn-danger" data-action="removeTeam">Remove Last</button>`:""}
      </div>
      <div class="team-grid">${teams}</div>
      <div class="par-section">
        <div class="par-section-head">
          <h3>Hole Par Settings</h3>
          <span class="par-total">Par <strong id="par-total-val">${coursePar()}</strong></span>
        </div>
        <div class="par-grid">
          <div class="nine-par-group">
            <div class="nine-par-label">Front 9</div>
            ${Array.from({length:9},(_,i)=>`<div class="par-row"><label>H${i+1}</label><input class="par-inp" type="number" inputmode="numeric" min="3" max="6" value="${holePar(i)}" data-h="${i}" data-action="setPar"></div>`).join('')}
          </div>
          <div class="nine-par-group">
            <div class="nine-par-label">Back 9</div>
            ${Array.from({length:9},(_,i)=>`<div class="par-row"><label>H${i+10}</label><input class="par-inp" type="number" inputmode="numeric" min="3" max="6" value="${holePar(i+9)}" data-h="${i+9}" data-action="setPar"></div>`).join('')}
          </div>
        </div>
      </div>
      <div class="setup-footer">
        <button class="btn btn-primary" data-action="saveSetup">Save &amp; Start Scoring</button>
      </div>
    </div>
  </div>`;
}

// ── TAB NAVIGATION ────────────────────────────────────────────────────────────
function _viewOnly(ti)    { return typeof ti === "number" && tpin(ti) && !unlocked.has(ti); }
function _isReadOnly(ti)  { return spectatorMode || _viewOnly(ti); }

function _unlockTeam(ti) {
  pendingTab = ti;
  showLock(tname(ti), "Enter the PIN to score for this team.");
}

function _tab(idx) {
  if (idx === "home") {
    tab = "home";
    openHole = null;
    renderNav();
    renderMain();
    return;
  }
  if (idx === "archive") {
    tab = "archive";
    openHole = null;
    renderNav();
    renderMain();
    return;
  }
  if (idx === "setup" && !unlocked.has("setup")) {
    pendingTab = idx;
    showLock("Setup Protected", "Enter the admin PIN to access Setup.");
    return;
  }
  if (typeof idx === "number" && !unlocked.has(idx)) {
    const p = tpin(idx);
    if (!p) unlocked.add(idx); // no PIN = full access
    // if PIN exists, fall through — loads in view-only mode
  }
  tab = idx;
  openHole = null;
  if (typeof idx === "number") {
    for (let h = 0; h < 18; h++) {
      if (best(idx, h) === null) { openHole = h; break; }
    }
  }
  _saveSession();
  renderNav();
  renderMain();
}

// ── SETUP HANDLERS ────────────────────────────────────────────────────────────
function _stn(t, v) {
  if (!state.teams[t]) state.teams[t] = {name:v, players:{}};
  state.teams[t].name = v || "Team " + (t+1);
  renderNav();
  writeFull();
}
function _spn(t, p, v) {
  if (!state.teams[t]) state.teams[t] = {name:"Team "+(t+1), players:{}};
  if (!state.teams[t].players[p]) state.teams[t].players[p] = {};
  state.teams[t].players[p].name = v || "Player " + (p+1);
  writeFull();
}
function _stp(t, v) {
  if (!state.teams[t]) state.teams[t] = {name:"Team "+(t+1), players:{}};
  state.teams[t].pin = v.trim();
  if (!v.trim()) unlocked.add(t);
  writeFull();
}
function _genPin(t) {
  const pin = String(Math.floor(1000 + Math.random() * 9000));
  if (!state.teams[t]) state.teams[t] = {name:"Team "+(t+1), players:{}};
  state.teams[t].pin = pin;
  unlocked.add(t);
  writeFull();
  const el = document.getElementById("pin-inp-"+t);
  if (el) { el.value = pin; el.style.background="#d1fae5"; setTimeout(()=>el.style.background="",1200); }
}
function _stname(v)  { state.config.tournamentName = v; writeFull(); }
function _snp(n)     { state.config.numPlayers = n; writeFull(); renderMain(); }
function _addTeam() {
  const t = state.config.numTeams;
  state.config.numTeams++;
  if (!state.teams[t]) state.teams[t] = {name:"Team "+(t+1), players:{}};
  writeFull();
  renderNav();
  renderMain();
}
function _removeTeam() {
  if (state.config.numTeams <= 1) return;
  const lastIdx = state.config.numTeams - 1;
  state.config.numTeams--;
  // Bug fix: remove orphaned score data for removed team
  if (state.scores && state.scores[lastIdx] !== undefined) {
    delete state.scores[lastIdx];
  }
  _invalidateCache();
  writeFull();
  if (typeof tab === "number" && tab >= state.config.numTeams) tab = state.config.numTeams - 1;
  renderNav();
  renderMain();
}
function _saveSetup() {
  writeFull();
  tab = "home";
  openHole = null;
  unlocked.add("setup");
  _saveSession();
  renderNav();
  renderMain();
}
function _spar(h, val) {
  const v = isNaN(val) ? 4 : Math.max(3, Math.min(6, val));
  if (!state.config.par) state.config.par = [4,4,3,4,5,4,3,4,4,4,3,5,4,4,3,4,4,5];
  state.config.par[h] = v;
  const tot = document.getElementById("par-total-val");
  if (tot) tot.textContent = coursePar();
  writeFull();
}

// ── ARCHIVE ───────────────────────────────────────────────────────────────────
async function saveArchive() {
  const nt = state.config.numTeams || 0;
  const teams = Array.from({length:nt}, (_,t) => {
    const {total, holes} = teamTotal(t);
    return {name:tname(t), total, holes, stp:fmtVsPar(total, teamParPlayed(t))};
  });
  const entry = {
    savedAt: new Date().toISOString(),
    name: state.config.tournamentName || "Tournament",
    coursePar: coursePar(),
    teams
  };
  await push(ref(db, "golf/archive"), entry);
}

async function renderArchive(container) {
  try {
    const snap = await get(ref(db, "golf/archive"));
    const data = snap.val();
    if (!data) {
      container.innerHTML = `<div class="lb-card"><div class="lb-head" style="background:var(--navy)"><h2>Archive</h2></div><div class="lb-empty">No archived tournaments yet.</div></div>`;
      return;
    }
    const entries = Object.entries(data).sort(([,a],[,b]) => b.savedAt.localeCompare(a.savedAt));
    let html = `<div class="lb-card">`;
    for (const [,entry] of entries) {
      html += `<div class="archive-entry"><div class="archive-entry-head">${esc(entry.name)} &mdash; ${esc(entry.savedAt.slice(0,10))}</div>`;
      (entry.teams||[]).sort((a,b) => a.total-b.total).forEach((t,i) => {
        const stpCls = !t.stp?"":t.stp==="E"?"stp-even":t.stp[0]==="-"?"stp-under":"stp-over";
        html += `<div class="lb-row"><span class="lb-rank ${i===0?"g":i===1?"s":i===2?"b":""}">${i+1}</span><span class="lb-name">${esc(t.name)}</span><div class="lb-detail"><div class="lb-score">${t.total}<span class="stp-badge ${stpCls}">${t.stp||""}</span></div><div class="lb-holes">${t.holes}/18</div></div></div>`;
      });
      html += `</div>`;
    }
    html += `</div>`;
    container.innerHTML = html;
  } catch(e) {
    container.innerHTML = `<div class="lb-card"><div class="lb-empty">Error loading archive.</div></div>`;
  }
}

// ── INSTRUCTIONS RENDERER ─────────────────────────────────────────────────────
function _renderInstructions() {
  const items = (state.instructions && state.instructions.length)
    ? state.instructions : DEFAULT_INSTRUCTIONS;
  let numCount = 0;
  return items.map(item => {
    const num = item.warn ? '!' : String(++numCount);
    return `<div class="rule-item">
      <span class="rule-num${item.warn ? ' warn' : ''}">${num}</span>
      <span class="rule-text">${item.text}</span>
    </div>`;
  }).join('');
}

// ── INSTRUCTIONS EDITOR ────────────────────────────────────────────────────────
async function openInstrEditor() {
  const entered = document.getElementById("adminPin").value.trim();
  const err     = document.getElementById("adminErr");
  const stored  = await getAdminPin();
  if (!stored) { err.textContent = "No admin PIN set. Please refresh and set one."; return; }
  if (entered !== stored) { err.textContent = "Incorrect PIN."; return; }
  closeAdmin();
  _instrDraft = JSON.parse(JSON.stringify(
    (state.instructions && state.instructions.length) ? state.instructions : DEFAULT_INSTRUCTIONS
  ));
  _renderInstrEditor();
  document.getElementById("instrModal").classList.add("open");
}

function closeInstr() {
  document.getElementById("instrModal").classList.remove("open");
  _instrDraft = null;
}

function _renderInstrEditor() {
  const list = document.getElementById("instrList");
  list.innerHTML = (_instrDraft || []).map((item, i) => `
    <div class="instr-item">
      <button class="instr-warn-btn${item.warn ? ' active' : ''}" data-action="toggleInstrWarn" data-idx="${i}" title="Toggle warning style">${item.warn ? '⚠' : '#'}</button>
      <textarea data-action="editInstrText" data-idx="${i}" rows="2">${esc(item.text)}</textarea>
      <button class="instr-del-btn" data-action="removeInstrItem" data-idx="${i}" title="Remove item">×</button>
    </div>
  `).join('');
}

function _addInstrItem() {
  if (!_instrDraft) return;
  _instrDraft.push({ warn: false, text: "" });
  _renderInstrEditor();
  const textareas = document.querySelectorAll("#instrList textarea");
  if (textareas.length) textareas[textareas.length - 1].focus();
}

function _removeInstrItem(idx) {
  if (!_instrDraft) return;
  _instrDraft.splice(idx, 1);
  _renderInstrEditor();
}

function _toggleInstrWarn(idx) {
  if (!_instrDraft || !_instrDraft[idx]) return;
  _instrDraft[idx].warn = !_instrDraft[idx].warn;
  _renderInstrEditor();
}

function _editInstrText(idx, val) {
  if (!_instrDraft || !_instrDraft[idx]) return;
  _instrDraft[idx].text = val;
}

function _resetInstr() {
  _instrDraft = JSON.parse(JSON.stringify(DEFAULT_INSTRUCTIONS));
  _renderInstrEditor();
}

async function saveInstr() {
  if (!_instrDraft) return;
  const err = document.getElementById("instrErr");
  const cleaned = _instrDraft.filter(item => item.text.trim());
  if (!cleaned.length) { err.textContent = "Add at least one item."; return; }
  state.instructions = cleaned;
  writeFull();
  closeInstr();
  renderMain();
}

// ── ADMIN MODAL ───────────────────────────────────────────────────────────────
function openAdmin() {
  document.getElementById("adminPin").value = "";
  document.getElementById("adminErr").textContent = "";
  document.getElementById("adminModal").classList.add("open");
  setTimeout(() => document.getElementById("adminPin").focus(), 100);
}
function closeAdmin() {
  document.getElementById("adminModal").classList.remove("open");
}
async function doReset() {
  const entered = document.getElementById("adminPin").value.trim();
  const err     = document.getElementById("adminErr");
  const stored  = await getAdminPin();
  if (!stored) {
    err.textContent = "No admin PIN set. Please refresh and set one.";
    return;
  }
  if (entered !== stored) { err.textContent = "Incorrect PIN."; return; }
  state.scores = {};
  _invalidateCache();
  unlocked.add("setup");
  _saveSession();
  writeFull();
  closeAdmin();
  renderMain();
}
async function doArchiveThenReset() {
  const entered = document.getElementById("adminPin").value.trim();
  const err     = document.getElementById("adminErr");
  const stored  = await getAdminPin();
  if (!stored) {
    err.textContent = "No admin PIN set. Please refresh and set one.";
    return;
  }
  if (entered !== stored) { err.textContent = "Incorrect PIN."; return; }
  err.textContent = "Saving archive…";
  try {
    await saveArchive();
    state.scores = {};
    _invalidateCache();
    writeFull();
    closeAdmin();
    renderMain();
  } catch(e) {
    err.textContent = "Archive failed. Try again.";
  }
}

// ── LOCK MODAL ────────────────────────────────────────────────────────────────
function showLock(title, desc) {
  document.getElementById("lockTitle").textContent   = title;
  document.getElementById("lockDesc").textContent    = desc;
  document.getElementById("lockPin").value           = "";
  document.getElementById("lockErr").textContent     = "";
  document.getElementById("lockModal").classList.add("open");
  setTimeout(() => document.getElementById("lockPin").focus(), 100);
}
function closeLock() {
  document.getElementById("lockModal").classList.remove("open");
  pendingTab = null;
}
async function doUnlock() {
  const entered = document.getElementById("lockPin").value;
  const target  = pendingTab;
  const storedAdmin = await getAdminPin();
  const teamPinMatch = typeof target === "number" && entered === tpin(target);
  const adminPinMatch = storedAdmin && entered === storedAdmin;
  if (adminPinMatch || teamPinMatch) {
    unlocked.add(target);
    _saveSession();
    if (typeof target === "number" && tab === target) { renderMain(); }
    document.getElementById("lockModal").classList.remove("open");
    tab = target;
    openHole = null;
    if (typeof target === "number") {
      for (let h = 0; h < 18; h++) {
        if (best(target, h) === null) { openHole = h; break; }
      }
    }
    renderNav();
    renderMain();
    return;
  }
  document.getElementById("lockErr").textContent = "Incorrect PIN.";
}

// ── EVENT DELEGATION ──────────────────────────────────────────────────────────
// Single listener on #main handles all interactive elements via data-action.
// The modals get their own delegation listeners below.

document.getElementById("main").addEventListener("click", e => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;

  if (action === "stopProp") { e.stopPropagation(); return; }
  if (action === "toggle") {
    // Clicking inside hole-scores should not toggle; stopProp handles that
    _toggle(+el.dataset.hole);
    return;
  }
  if (action === "tab") {
    // Parse tab value: numeric string → number, else string
    const raw = el.dataset.tab;
    _tab(isNaN(raw) ? raw : +raw);
    return;
  }
  if (action === "unlockTeam") { _unlockTeam(+el.dataset.t); return; }
  if (action === "openAdmin")  { openAdmin(); return; }
  if (action === "lbRefresh")  {
    const btn = el;
    btn.style.transform = "rotate(360deg)";
    btn.style.transition = "transform .4s";
    renderMain();
    setTimeout(() => { btn.style.transform=""; btn.style.transition=""; }, 500);
    return;
  }
  if (action === "step") {
    _step(+el.dataset.t, +el.dataset.h, +el.dataset.p, +el.dataset.delta);
    return;
  }
  if (action === "addTeam")    { _addTeam(); return; }
  if (action === "removeTeam") { _removeTeam(); return; }
  if (action === "saveSetup")  { _saveSetup(); return; }
  if (action === "genPin")     { _genPin(+el.dataset.t); return; }
});

document.getElementById("main").addEventListener("input", e => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;

  if (action === "scoreInput") {
    _sci(+el.dataset.t, +el.dataset.h, +el.dataset.p, el.value);
    return;
  }
  if (action === "lbThru") {
    lbThru = +el.value;
    renderMain();
    return;
  }
  if (action === "setTeamName")      { _stn(+el.dataset.t, el.value); return; }
  if (action === "setPlayerName")    { _spn(+el.dataset.t, +el.dataset.p, el.value); return; }
  if (action === "setTeamPin")       { _stp(+el.dataset.t, el.value); return; }
  if (action === "setTournamentName"){ _stname(el.value); return; }
  if (action === "setNumPlayers")    { _snp(+el.value); return; }
  if (action === "setPar")           { _spar(+el.dataset.h, +el.value); return; }
});

document.getElementById("main").addEventListener("change", e => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;

  // change fires after blur for inputs — treat same as input for these fields
  if (action === "scoreInput") {
    _sc(+el.dataset.t, +el.dataset.h, +el.dataset.p, el.value);
    return;
  }
  if (action === "setTeamName")      { _stn(+el.dataset.t, el.value); return; }
  if (action === "setPlayerName")    { _spn(+el.dataset.t, +el.dataset.p, el.value); return; }
  if (action === "setTeamPin")       { _stp(+el.dataset.t, el.value); return; }
  if (action === "setTournamentName"){ _stname(el.value); return; }
  if (action === "setNumPlayers")    { _snp(+el.value); return; }
  if (action === "setPar")           { _spar(+el.dataset.h, +el.value); return; }
});

// Header buttons (back-bar) — outside #main
document.getElementById("home-btn").addEventListener("click", () => _tab("home"));
document.querySelector(".lb-hbtn").addEventListener("click", () => _tab("lb"));

// Admin modal
document.getElementById("adminModal").addEventListener("click", e => {
  if (e.target === document.getElementById("adminModal")) closeAdmin();
});
document.getElementById("adminModal").addEventListener("click", e => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  if (el.dataset.action === "closeAdmin")         closeAdmin();
  if (el.dataset.action === "doReset")            doReset();
  if (el.dataset.action === "doArchiveThenReset") doArchiveThenReset();
  if (el.dataset.action === "openInstrEditor")    openInstrEditor();
});
document.getElementById("adminPin").addEventListener("keydown", e => {
  if (e.key === "Enter") doReset();
});

// Lock modal
document.getElementById("lockModal").addEventListener("click", e => {
  if (e.target === document.getElementById("lockModal")) closeLock();
});
document.getElementById("lockModal").addEventListener("click", e => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  if (el.dataset.action === "closeLock") closeLock();
  if (el.dataset.action === "doUnlock")  doUnlock();
});
document.getElementById("lockPin").addEventListener("keydown", e => {
  if (e.key === "Enter") doUnlock();
});

// Instructions editor modal
document.getElementById("instrModal").addEventListener("click", e => {
  if (e.target === document.getElementById("instrModal")) closeInstr();
});
document.getElementById("instrModal").addEventListener("click", e => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const idx = +el.dataset.idx;
  if (el.dataset.action === "closeInstr")       closeInstr();
  if (el.dataset.action === "addInstrItem")     _addInstrItem();
  if (el.dataset.action === "removeInstrItem")  _removeInstrItem(idx);
  if (el.dataset.action === "toggleInstrWarn")  _toggleInstrWarn(idx);
  if (el.dataset.action === "saveInstr")        saveInstr();
  if (el.dataset.action === "resetInstr")       _resetInstr();
});
document.getElementById("instrModal").addEventListener("input", e => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  if (el.dataset.action === "editInstrText") _editInstrText(+el.dataset.idx, el.value);
});

// ── SERVICE WORKER ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/odcgolf/sw.js', {scope:'/odcgolf/'}).catch(() => {});
}

// ── INIT ──────────────────────────────────────────────────────────────────────
_loadSession();
// Ensure admin PIN exists in Firebase; prompt to create if not
ensureAdminPin().catch(() => {/* non-fatal; user can still use team PINs */});
// Render immediately so page is never blank
render();
