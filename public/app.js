'use strict';

/* global io, Cards */

const socket = io();
const $ = (id) => document.getElementById(id);
const { cardHtml, NAMES, WITH_ARTICLE } = Cards;

const OVERLAY_MS = 3000;
const ACK_TIMEOUT_MS = 8000;
const NO_ANSWER = 'Keine Antwort vom Server – bitte nochmals versuchen.';

let state = null;
let selectedCardId = null;
let selectedBid = null; // angetippte, aber noch nicht bestätigte Ansage
let bidPending = false; // Ansage gesendet, Antwort des Servers steht aus
let shownEventId = 0;
let eventsSynced = false; // erst nach dem ersten Spielzustand Ereignisse anzeigen
let overlayQueue = Promise.resolve();
let overlayGen = 0; // erhöht beim Verlassen des Raums: noch wartende Ergebnis-Fenster verfallen
let wasMyTurn = false;
let currentScreen = null;
let seenTableCards = new Set(); // nur neu gelegte Karten einblenden, nicht bei jedem Update alle

// ---------- Hilfsfunktionen ----------

const storage = (area) => ({
  get(k) { try { return window[area].getItem(k); } catch { return null; } },
  set(k, v) { try { window[area].setItem(k, v); } catch { /* privater Modus */ } },
  del(k) { try { window[area].removeItem(k); } catch { /* privater Modus */ } },
});
const store = storage('localStorage');
const tabStore = storage('sessionStorage');

// ---------- Sitzung (Token) ----------
//
// Jeder Tab hat sein eigenes Token: im Speicher und im sessionStorage (gilt nur für
// diesen Tab, übersteht ein Neuladen). Sonst würden sich mehrere Spieler im selben
// Browser ein Token teilen und alle als der zuletzt Beigetretene handeln.
// Zusätzlich liegt es im localStorage – für den Fall, dass das Handy die App im
// Hintergrund beendet: Ein neu geöffneter Tab übernimmt es aber nur, wenn kein
// anderer offener Tab es gerade benutzt.

const TOKEN_KEY = 'ftn_token';
let tabToken = null;
const token = () => tabToken;

function setToken(t) {
  tabToken = t;
  tabStore.set(TOKEN_KEY, t);
  store.set(TOKEN_KEY, t);
}

function clearToken() {
  if (store.get(TOKEN_KEY) === tabToken) store.del(TOKEN_KEY);
  tabStore.del(TOKEN_KEY);
  tabToken = null;
}

const tabs = 'BroadcastChannel' in window ? new BroadcastChannel('stichraten-tabs') : null;
if (tabs) {
  tabs.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'who-has' && tabToken && e.data.token === tabToken) {
      tabs.postMessage({ type: 'mine', token: tabToken });
    }
  });
}

/** Spielt gerade ein anderer offener Tab mit diesem Token? */
function tokenInUse(t) {
  if (!tabs) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onMessage = (e) => {
      if (e.data && e.data.type === 'mine' && e.data.token === t) finish(true);
    };
    const finish = (used) => {
      clearTimeout(timer);
      tabs.removeEventListener('message', onMessage);
      resolve(used);
    };
    const timer = setTimeout(() => finish(false), 250);
    tabs.addEventListener('message', onMessage);
    tabs.postMessage({ type: 'who-has', token: t });
  });
}

const tokenReady = (async () => {
  const own = tabStore.get(TOKEN_KEY);
  if (own) {
    // Derselbe Tab, neu geladen – oder ein duplizierter Tab, der den sessionStorage
    // mitkopiert hat: dann spielt das Original noch damit, und dieser Tab startet neu.
    if (!(await tokenInUse(own))) tabToken = own;
    else tabStore.del(TOKEN_KEY);
    return;
  }
  const shared = store.get(TOKEN_KEY);
  if (shared && !(await tokenInUse(shared))) setToken(shared);
})();

/**
 * Sendet an den Server. `done(res)` kommt garantiert – auch bei Verbindungsabbruch
 * oder Timeout. (Ein normaler Ack-Callback wird von socket.io beim Trennen still
 * verworfen; gesperrte Knöpfe blieben dann für immer gesperrt.)
 */
function request(event, data, done) {
  socket.timeout(ACK_TIMEOUT_MS).emit(event, data, (err, res) => {
    done(err || !res ? { ok: false, error: NO_ANSWER } : res);
  });
}

function send(event, data = {}, done = () => {}) {
  request(event, { token: token(), ...data }, (res) => {
    if (!res.ok) toast(res.error || 'Fehler');
    done(res);
  });
}

/** Wie send(), aber der Knopf bleibt bis zur Antwort gesperrt (gegen Doppeltipps). */
function sendFrom(btn, event, data = {}, done = () => {}) {
  if (btn.disabled) return;
  btn.disabled = true;
  send(event, data, (res) => {
    btn.disabled = false;
    done(res);
  });
}

let toastTimer = null;
function toast(msg, kind = 'error') {
  const el = $('toast');
  el.textContent = msg;
  el.className = kind === 'info' ? 'toast info' : 'toast';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}

function show(screenId) {
  if (screenId !== currentScreen) {
    // Fenster des alten Bildschirms (z. B. Verlauf) nicht über dem neuen stehen lassen
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    currentScreen = screenId;
  }
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== screenId);
  syncWakeLock();
}

/** Kurze Meldung für Screenreader; vorher leeren, damit auch Wiederholungen angesagt werden. */
function announce(text) {
  const el = $('live');
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 60);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function nameOf(pid) {
  const p = state && state.players.find((q) => q.id === pid);
  return p ? p.name : '?';
}

/** «Du» für den eigenen Spieler, sonst der Name (unescaped). */
const who = (pid) => (state && pid === state.youId ? 'Du' : nameOf(pid));

/** Reihenfolge für Sätze: «Du» zuerst («Du und Dani», nicht «Dani und Du»). */
function youFirst(list, idOf) {
  const me = state && state.youId;
  return list.slice().sort((a, b) => (idOf(b) === me) - (idOf(a) === me));
}

/** «A», «A und B», «A, B und C» – Namen werden escaped. */
function joinNames(names) {
  const e = names.map(esc);
  return e.length <= 1 ? e.join('') : `${e.slice(0, -1).join(', ')} und ${e[e.length - 1]}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const fmt = (n) => (n < 0 ? `−${Math.abs(n)}` : String(n));
const signed = (n) => (n > 0 ? `+${n}` : fmt(n));
const initialOf = (name) => (Array.from(String(name).trim())[0] || '?').toUpperCase();

const ICON_PATHS = {
  trophy: '<path d="M8 21h8"/><path d="M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 6h3v1a3 3 0 0 1-3 3"/><path d="M7 6H4v1a3 3 0 0 0 3 3"/>',
  crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>',
  wifiOff: '<path d="M2 2l20 20"/><path d="M8.5 16.4a5 5 0 0 1 7 0"/><path d="M5 12.9a10 10 0 0 1 4.2-2.5"/><path d="M14.8 10.4A10 10 0 0 1 19 12.9"/><path d="M2 8.8a15 15 0 0 1 4.6-2.9"/><path d="M10.7 5.1A15 15 0 0 1 22 8.8"/><path d="M12 20h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 4.2A10 10 0 0 1 12 4c5 0 9 4.5 10 8a12 12 0 0 1-2.9 4.3"/><path d="M6.6 6.6C4.4 8 2.8 10 2 12c1 3.5 5 8 10 8a10 10 0 0 0 4.9-1.3"/>',
  swords: '<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/><path d="M14.5 6.5 18 3h3v3l-3.5 3.5"/><path d="m5 14 4 4"/><path d="m7 17-3 3"/><path d="m3 19 2 2"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  arrowUp: '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  shuffle: '<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/>',
};

function icon(name, size = 20, stroke = 2.2) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}

/** Hinweiszeile mit Symbol; `html` muss bereits escaped sein. */
const note = (kind, iconName, html) => `<p class="note is-${kind}">${icon(iconName, 16, 2.4)}<span>${html}</span></p>`;

function dockTitle(text, { idle = false, side = '' } = {}) {
  return `<div class="dock-title"><span class="dot${idle ? ' is-idle' : ''}" aria-hidden="true"></span><h2>${text}</h2>` +
    (side ? `<span class="side">${side}</span>` : '') + '</div>';
}

function avatarHtml(name, { you = false, top = '', topTitle = '', bottom = '', bottomTitle = '', extra = '' } = {}) {
  return `<span class="avatar${you ? ' is-you' : ''}">${esc(initialOf(name))}` +
    (top ? `<span class="badge-top" title="${topTitle}">${top}</span>` : '') +
    (bottom ? `<span class="badge-bottom" title="${bottomTitle}">${bottom}</span>` : '') + extra + '</span>';
}

// Bildschirm während des Spiels wach halten (sonst trennt das Handy ständig die Verbindung)
let wakeLock = null;
async function syncWakeLock() {
  const want = state && state.screen === 'game' && document.visibilityState === 'visible';
  try {
    if (want && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* nicht unterstützt oder verweigert */ }
}
document.addEventListener('visibilitychange', syncWakeLock);

function buzz() {
  if (navigator.vibrate) {
    try { navigator.vibrate(60); } catch { /* ignorieren */ }
  }
}

// ---------- Start ----------

$('hero-cards').innerHTML = [
  { rank: 12, suit: 'eicheln' },
  { rank: 13, suit: 'schellen' },
  { rank: 14, suit: 'rosen' },
].map((c) => cardHtml(c, { size: 'xl' })).join('');

$('rules-scale').innerHTML = [6, 7, 8, 9, 10, 11, 12, 13, 14]
  .map((rank, i) => cardHtml({ rank, suit: ['rosen', 'schellen', 'eicheln', 'schilten'][i % 4] }, { size: 'sm' }))
  .join('');

$('input-name').value = store.get('ftn_name') || '';
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) $('input-code').value = urlCode.slice(0, 4).toUpperCase();

function readName() {
  const name = $('input-name').value.trim();
  if (!name) {
    toast('Bitte gib einen Namen ein.');
    $('input-name').focus();
    return null;
  }
  store.set('ftn_name', name);
  return name;
}

/**
 * Raum erstellen oder beitreten; beide Knöpfe sind bis zur Antwort gesperrt.
 * Bewusst ohne request(): Auch eine verspätete Antwort muss das Token noch
 * speichern, sonst sässe man ohne Token im Raum. Der Timer gibt nur die Knöpfe frei.
 */
function enterRoom(event, data) {
  const buttons = [$('btn-create'), $('btn-join')];
  if (buttons.some((b) => b.disabled)) return;
  const unlock = () => { for (const b of buttons) b.disabled = false; };
  for (const b of buttons) b.disabled = true;
  const timer = setTimeout(() => { unlock(); toast(NO_ANSWER); }, ACK_TIMEOUT_MS);
  socket.emit(event, data, (res) => {
    clearTimeout(timer);
    unlock();
    if (!res.ok) return toast(res.error);
    setToken(res.token);
    history.replaceState(null, '', location.pathname);
  });
}

function createRoom() {
  const name = readName();
  if (name) enterRoom('createRoom', { name });
}

function joinRoom() {
  if ($('btn-join').disabled) return;
  const code = $('input-code').value.trim().toUpperCase();
  if (code.length !== 4) {
    toast('Der Raum-Code hat 4 Zeichen.');
    $('input-code').focus();
    return;
  }
  const name = readName();
  if (name) enterRoom('joinRoom', { name, code });
}

$('btn-create').addEventListener('click', createRoom);
$('form-join').addEventListener('submit', (e) => {
  e.preventDefault();
  joinRoom();
});
// Enter im Namensfeld: mit Code beitreten, sonst einen Raum erstellen
$('input-name').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if ($('input-code').value.trim().length === 4) joinRoom();
  else createRoom();
});
$('input-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

// ---------- Fenster (Sheets) ----------

function openSheet(dialog) {
  if (dialog.open) return;
  dialog.classList.remove('closing');
  dialog.showModal();
  const body = dialog.querySelector('.sheet-body');
  if (body) body.scrollTop = 0;
}

/** Schliesst mit kurzer Ausblend-Animation. */
function closeSheet(dialog) {
  if (!dialog.open || dialog.classList.contains('closing')) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return dialog.close();
  dialog.classList.add('closing');
  setTimeout(() => {
    dialog.classList.remove('closing');
    dialog.close();
  }, 170);
}

for (const dialog of document.querySelectorAll('dialog.sheet')) {
  // Tippen auf den abgedunkelten Hintergrund schliesst
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeSheet(dialog); });
  // Escape bzw. Zurück-Geste: ebenfalls mit Animation
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); closeSheet(dialog); });
  for (const btn of dialog.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => closeSheet(dialog));
  }
}

/** Gestaltete Rückfrage statt window.confirm(); liefert true bei Bestätigung. */
function askConfirm({ iconName = 'info', title, text, ok }) {
  const dialog = $('confirm-dialog');
  $('confirm-icon').innerHTML = icon(iconName, 28);
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  $('confirm-ok').textContent = ok;
  openSheet(dialog);
  return new Promise((resolve) => {
    const okBtn = $('confirm-ok');
    const done = (result) => {
      okBtn.removeEventListener('click', onOk);
      dialog.removeEventListener('close', onClose);
      resolve(result);
    };
    const onOk = () => { done(true); closeSheet(dialog); };
    const onClose = () => done(false);
    okBtn.addEventListener('click', onOk);
    dialog.addEventListener('close', onClose);
  });
}

const openRules = () => openSheet($('rules-dialog'));
const openHistory = () => {
  renderHistory();
  openSheet($('history-dialog'));
};
$('btn-rules').addEventListener('click', openRules);
$('btn-lobby-rules').addEventListener('click', openRules);
$('btn-game-rules').addEventListener('click', openRules);
$('btn-history').addEventListener('click', openHistory);
$('btn-menu').addEventListener('click', () => {
  renderMenu();
  openSheet($('menu-dialog'));
});

/** Erst austreten, wenn der Server zustimmt – lehnt er ab (Spiel läuft schon), bleibt man drin. */
function leaveRoom(e) {
  sendFrom(e.currentTarget, 'leaveRoom', {}, (res) => {
    if (!res.ok) return;
    clearToken();
    state = null;
    resetOverlays();
    show('screen-start');
  });
}
$('btn-leave').addEventListener('click', leaveRoom);

/** Startet ein (neues) Spiel. Wer offline ist, würde es blockieren und wird nach Rückfrage entfernt. */
async function startGameFrom(btn, event, st) {
  const offline = st.players.filter((p) => !p.connected).map((p) => p.name);
  if (offline.length) {
    const names = offline.join(' & ');
    const one = offline.length === 1;
    const yes = await askConfirm({
      iconName: 'wifiOff',
      title: `Ohne ${names} spielen?`,
      text: `${names} ${one ? 'ist' : 'sind'} offline und ${one ? 'wird' : 'werden'} aus dem Raum entfernt.`,
      ok: 'Starten',
    });
    if (!yes) return;
  }
  sendFrom(btn, event);
}

// ---------- Warteraum ----------

$('btn-share').addEventListener('click', async () => {
  if (!state) return;
  const url = `${location.origin}/?code=${state.roomCode}`;
  const text = `Spiel mit bei Stichraten! Raum-Code: ${state.roomCode}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Stichraten', text, url });
    } else {
      await navigator.clipboard.writeText(url);
      toast('Link kopiert', 'info');
    }
  } catch (err) {
    if (err && err.name !== 'AbortError') toast(`Link: ${url}`, 'info');
  }
});

$('btn-copy').addEventListener('click', async () => {
  if (!state) return;
  try {
    await navigator.clipboard.writeText(state.roomCode);
    toast('Code kopiert', 'info');
  } catch {
    toast(`Raum-Code: ${state.roomCode}`, 'info');
  }
});

function renderLobby(st) {
  show('screen-lobby');
  $('lobby-code').textContent = st.roomCode;
  $('lobby-count').textContent = `${st.players.length} von ${st.maxPlayers}`;
  const free = st.maxPlayers - st.players.length;
  $('lobby-players').innerHTML = st.players.map((p) =>
    `<li class="${p.connected ? '' : 'is-off'}">${avatarHtml(p.name, { you: p.isYou })}` +
    '<div class="who"><div class="name-row">' +
    `<span class="name">${esc(p.name)}</span>` +
    (p.isYou ? '<span class="tag tag-you">Du</span>' : '') +
    (p.isHost ? `<span class="tag tag-host">${icon('crown', 12, 2.4)}Host</span>` : '') +
    '</div>' +
    (p.connected
      ? '<span class="presence"><span class="online"></span>bereit</span>'
      : `<span class="presence is-off">${icon('wifiOff', 14)}getrennt – Platz bleibt kurz reserviert</span>`) +
    '</div></li>').join('') +
    (free > 0 ? `<li class="slot-free">${icon('plus', 18)}${plural(free, 'Platz', 'Plätze')} frei</li>` : '');

  const dock = $('lobby-dock');
  const online = st.players.filter((p) => p.connected).length;
  if (st.isHost) {
    const offline = st.players.filter((p) => !p.connected).map((p) => p.name);
    const one = offline.length === 1;
    const missing = st.minPlayers - online;
    dock.innerHTML =
      (offline.length
        ? note('warn', 'wifiOff', `${joinNames(offline)} ${one ? 'ist' : 'sind'} gerade offline. ` +
          `Startest du jetzt, ${one ? 'spielt' : 'spielen'} ${one ? esc(offline[0]) : 'sie'} nicht mit.`)
        : '') +
      `<button id="btn-start" type="button" class="btn btn-primary" ${missing > 0 ? 'disabled' : ''}>Spiel starten</button>` +
      `<p class="caption">${missing > 0 ? `Es fehlen noch ${plural(missing, 'Spieler', 'Spieler')}` : `Ab ${st.minPlayers} Spielern startklar`} · ${online} online</p>`;
    const btn = $('btn-start');
    btn.addEventListener('click', () => startGameFrom(btn, 'startGame', st));
  } else {
    const host = st.players.find((p) => p.isHost);
    dock.innerHTML = dockTitle(`Warte auf ${host ? esc(host.name) : 'den Host'} …`, { idle: true }) +
      '<p class="caption">Der Host startet das Spiel, sobald alle da sind.</p>';
  }
}

// ---------- Spiel ----------

function renderGame(st) {
  show('screen-game');
  if (st.table && st.table.length === 0) seenTableCards = new Set();
  renderHeader(st);
  renderTrack(st);
  renderBody(st);
  renderDock(st);
  if ($('history-dialog').open) renderHistory();
  if ($('menu-dialog').open) renderMenu();
}

function renderHeader(st) {
  if (st.phase === 'gameOver') {
    $('round-name').textContent = 'Spiel beendet';
    $('round-sub').textContent = `${st.totalRounds} Runden gespielt`;
    return;
  }
  $('round-name').innerHTML = `Runde ${st.roundNumber}` +
    (st.blind ? ` <span class="tag-blind">${icon('eyeOff', 13)}Blind</span>` : '');
  $('round-sub').textContent = st.phase === 'roundEnd'
    ? `von ${st.totalRounds} · Wertung`
    : `von ${st.totalRounds} · ${plural(st.cardsThisRound, 'Karte', 'Karten')} pro Spieler`;
}

function renderTrack(st) {
  // Nach Spielende braucht es den Rundenplan nicht mehr
  if (st.phase === 'gameOver') {
    $('round-track').innerHTML = '';
    return;
  }
  const cur = st.roundNumber - 1;
  $('round-track').innerHTML = st.roundPlan.map((cards, i) => {
    const cls = i < cur ? 'is-done' : i === cur ? 'is-current' : '';
    const label = cards === 1 ? icon('eyeOff', 13) : cards;
    const aria = `Runde ${i + 1}: ${cards === 1 ? 'Blindrunde' : plural(cards, 'Karte', 'Karten')}`;
    return `<li class="${cls}" aria-label="${aria}"${i === cur ? ' aria-current="step"' : ''}>${label}</li>`;
  }).join('');
}

function renderBody(st) {
  const body = $('game-body');
  if (st.phase === 'roundEnd') {
    body.className = 'game-body is-scroll';
    body.innerHTML = resultsHtml(st);
    return;
  }
  if (st.phase === 'gameOver') {
    body.className = 'game-body is-scroll';
    body.innerHTML = finalHtml(st);
    return;
  }
  body.className = 'game-body';
  body.innerHTML = stripHtml(st) + `<main class="table" aria-label="Tisch">${tableHtml(st)}</main>`;
}

/** Spieler in Sitzreihenfolge, beginnend bei `id`. */
function fromSeat(st, id) {
  const i = Math.max(0, st.players.findIndex((p) => p.id === id));
  return st.players.slice(i).concat(st.players.slice(0, i));
}

function playerTurn(st, p) {
  if (st.phase === 'bidding') return st.currentBidderId === p.id;
  if (st.phase === 'playing') return st.currentPlayerId === p.id;
  if (st.phase === 'duel') return !p.duelPicked;
  return false;
}

function statOf(st, p, you, dense) {
  if (st.phase === 'bidding') {
    if (you && st.currentBidderId === p.id) return { kind: 'now', text: 'dran' };
    // «Ansage» entfällt bei vielen Spielern und im Querformat (CSS), die Zahl bleibt
    if (p.bid !== null) return { kind: 'plain', label: 'Ansage', text: String(p.bid), title: 'Ansage' };
    return { kind: 'wait', text: '…' };
  }
  if (st.phase === 'duel') {
    // Bei vielen Spielern ist die Spalte zu schmal für «fertig»/«wählt»
    if (p.duelPicked) return { kind: 'ok', text: dense ? '' : 'fertig', icon: 'check', title: 'hat gewählt' };
    if (you) return { kind: 'now', text: 'dran' };
    return { kind: 'plain', text: dense ? '…' : 'wählt', title: 'wählt noch' };
  }
  const text = `${p.tricksWon}/${p.bid}`;
  if (p.tricksWon === p.bid) return { kind: 'ok', text, icon: 'check', title: 'Stiche / Ansage – erfüllt' };
  if (p.tricksWon > p.bid) return { kind: 'over', text, icon: 'x', title: 'Mehr Stiche als angesagt' };
  return { kind: 'plain', text, title: 'Stiche / Ansage' };
}

function stripHtml(st) {
  const dense = st.players.length > 5;
  const items = st.players.map((p) => {
    const you = p.id === st.youId;
    const stat = statOf(st, p, you, dense);
    const inDuel = st.phase === 'duel' && p.duelParticipant;
    const avatar = avatarHtml(p.name, {
      you,
      top: inDuel ? icon('swords', 13, 2.4) : p.isHost ? icon('crown', 13, 2.4) : '',
      topTitle: inDuel ? 'Im Duell' : 'Host',
      bottom: p.connected ? '' : icon('wifiOff', 13, 2.4),
      bottomTitle: 'Offline',
    });
    const cls = ['strip-item', playerTurn(st, p) && 'is-turn', !p.connected && 'is-off'].filter(Boolean).join(' ');
    return `<li class="${cls}">${avatar}<span class="strip-text"><span class="strip-name">${you ? 'Du' : esc(p.name)}</span>` +
      `<span class="pill pill-${stat.kind}"${stat.title ? ` title="${stat.title}"` : ''}>` +
      `${stat.icon ? icon(stat.icon, 11, 3.4) : ''}${stat.label ? `<span class="pill-label">${stat.label}&nbsp;</span>` : ''}` +
      `${esc(stat.text)}</span></span></li>`;
  });
  return `<ul class="strip${dense ? ' is-dense' : ''}" aria-label="Spieler">${items.join('')}</ul>`;
}

function tableHtml(st) {
  if (st.phase === 'bidding') return st.blind ? blindTableHtml(st) : bidTableHtml(st);
  if (st.phase === 'duel') return duelTableHtml(st);
  return trickTableHtml(st);
}

function bidTableHtml(st) {
  const cards = st.cardsThisRound;
  const sum = st.players.reduce((s, p) => s + (p.bid || 0), 0);
  const open = st.players.filter((p) => p.bid === null).length;
  const starter = who(st.starterId);
  const nobody = open === st.players.length;
  const side = st.starterId === st.youId
    ? (nobody ? 'Du beginnst' : 'Du hast begonnen')
    : `${esc(starter)} ${nobody ? 'beginnt' : 'hat begonnen'}`;
  const meter = Array.from({ length: cards }, (_, i) => `<i${i < Math.min(sum, cards) ? ' class="on"' : ''}></i>`).join('');
  const order = fromSeat(st, st.starterId).map((p) => {
    const label = p.id === st.youId ? 'Du' : esc(p.name);
    if (p.bid !== null) return `<li class="is-done"><span>${label}</span><b>${p.bid}</b></li>`;
    if (p.id === st.currentBidderId) return `<li class="is-now"><span>${label}</span><span>?</span></li>`;
    return `<li><span>${label}</span></li>`;
  }).join('');
  let hint = '';
  if (open === 1 && st.currentBidderId !== st.youId) {
    const forbidden = cards - sum;
    if (forbidden >= 0) {
      hint = `<p class="table-text">${esc(nameOf(st.currentBidderId))} sagt zuletzt an und darf nicht ${forbidden} wählen – sonst ginge die Summe genau auf.</p>`;
    }
  }
  return `<div class="table-head"><h2>Ansagen</h2><span class="side">${side}</span></div>` +
    '<div class="table-stack">' +
    `<div class="sum"><b>${sum}</b><span>von ${plural(cards, 'Stich', 'Stichen')} angesagt</span></div>` +
    `<div class="meter" aria-hidden="true">${meter}</div>` +
    `<ol class="order" aria-label="Reihenfolge der Ansagen">${order}</ol>${hint}` +
    '</div>';
}

function blindTableHtml(st) {
  const others = st.players.filter((p) => p.id !== st.youId).map((p) =>
    `<div class="slot">${cardHtml(p.visibleCard, { size: 'md' })}` +
    `<span class="slot-name">${esc(p.name)}${p.bid !== null ? ` <b>· ${p.bid}</b>` : ''}</span></div>`).join('');
  return `<div class="table-head"><h2>${icon('eyeOff', 18)}Du siehst nur die Karten der anderen</h2></div>` +
    `<div class="table-stack"><div class="blind-grid">${others}</div></div>`;
}

function trickTableHtml(st) {
  const cards = st.cardsThisRound;
  const maxHand = Math.max(...st.players.map((p) => p.handCount));
  const trickNo = Math.min(cards, Math.max(1, cards - maxHand + 1));
  const leaderId = st.table.length ? st.table[0].playerId : st.currentPlayerId;
  const leaderYou = leaderId === st.youId;
  const side = st.table.length
    ? (leaderYou ? 'Du hast ausgespielt' : `${esc(nameOf(leaderId))} hat ausgespielt`)
    : (leaderYou ? 'Du spielst aus' : `${esc(nameOf(leaderId))} spielt aus`);
  const max = Math.max(0, ...st.table.map((t) => t.card.rank));
  const tied = st.table.filter((t) => t.card.rank === max).length > 1;
  // Der Stich läuft ab dem Ausspieler reihum: Platz i gehört dem i-ten Spieler ab ihm
  const slots = fromSeat(st, leaderId).map((p, i) => {
    const name = p.id === st.youId ? 'Du' : esc(p.name);
    const played = st.table[i];
    if (played) {
      const lead = played.card.rank === max;
      const enter = !seenTableCards.has(played.card.id);
      seenTableCards.add(played.card.id);
      return `<div class="slot">${cardHtml(played.card, { size: 'md', lead, enter })}<span class="slot-name">${name}</span>` +
        (lead ? `<span class="lead-badge">${tied ? 'gleichauf' : 'führt'}</span>` : '') + '</div>';
    }
    const now = p.id === st.currentPlayerId;
    return `<div class="slot"><div class="slot-wait${now ? ' is-now' : ''}">${now ? 'dran' : '…'}</div>` +
      `<span class="slot-name">${name}</span></div>`;
  }).join('');
  return `<div class="table-head"><h2>Stich ${trickNo} von ${cards}</h2><span class="side">${side}</span></div>` +
    `<div class="table-center"><div class="slots${st.players.length > 5 ? ' is-dense' : ''}">${slots}</div></div>`;
}

/** Die gleich hohen Karten, die zum laufenden Duell geführt haben. */
function duelCause(st) {
  const parts = st.duel.participants;
  if (st.lastDuel && st.lastTrick && st.lastDuel.eventId > st.lastTrick.eventId) {
    return st.lastDuel.reveals.filter((r) => parts.includes(r.playerId));
  }
  return st.lastTrick ? st.lastTrick.cards.filter((t) => parts.includes(t.playerId)) : [];
}

function duelTableHtml(st) {
  // Die gleich hohen Karten mit «=» dazwischen zeigen, wer sich duelliert
  const tie = youFirst(duelCause(st), (t) => t.playerId).map((t, i) =>
    (i ? '<span class="eq" aria-hidden="true">=</span>' : '') +
    `<div class="slot">${cardHtml(t.card, { size: 'md', lead: true })}<span class="slot-name">${esc(who(t.playerId))}</span></div>`).join('');
  const picked = st.players.filter((p) => p.duelPicked).length;
  const picks = st.players.map((p) =>
    `<div class="slot">${p.duelPicked ? cardHtml(null, { size: 'sm' }) : '<div class="slot-wait sm"></div>'}` +
    `<span class="slot-name">${p.id === st.youId ? 'Du' : esc(p.name)}</span></div>`).join('');
  return `<div class="table-head"><h2>${icon('swords', 20)}Stich-Duell</h2><span class="stake">um ${plural(st.stake, 'Stich', 'Stiche')}</span></div>` +
    '<div class="table-stack">' +
    (tie ? `<div class="tie">${tie}</div>` : '') +
    `<div class="table-label">Verdeckt gewählt<span>${picked} von ${st.players.length}</span></div>` +
    `<div class="picks${st.players.length > 5 ? ' is-dense' : ''}">${picks}</div>` +
    '</div>';
}

function resultsHtml(st) {
  const results = st.roundResults || [];
  const hits = results.filter((r) => r.bid === r.won).length;
  const summary = hits === 0
    ? 'Niemand hat die Ansage genau getroffen.'
    : `${hits} von ${results.length} ${hits === 1 ? 'hat' : 'haben'} die Ansage genau getroffen.`;
  const rows = st.players.map((p) => {
    const r = results.find((x) => x.playerId === p.id);
    if (!r) return '';
    const hit = r.bid === r.won;
    const you = p.id === st.youId;
    const mark = `<span class="mark ${hit ? 'is-hit' : 'is-miss'}" title="${hit ? 'Ansage erfüllt' : 'Ansage verfehlt'}">` +
      `${icon(hit ? 'check' : 'x', hit ? 11 : 10, 3.6)}</span>`;
    return `<li class="result-row">${avatarHtml(p.name, { you, extra: mark })}` +
      `<div class="who"><span class="name">${you ? 'Du' : esc(p.name)}</span><span class="detail">Ansage ${r.bid} · gemacht ${r.won}</span></div>` +
      `<span class="num ${hit ? 'is-hit' : 'is-miss'}">${signed(r.points)}</span>` +
      `<span class="total">${fmt(r.total)}</span></li>`;
  }).join('');
  return '<div class="results">' +
    `<div class="results-head"><h1>Runde ${st.roundNumber} ausgewertet</h1><p>${summary}</p></div>` +
    '<div class="results-cols" aria-hidden="true"><span>Spieler</span><span class="num">Runde</span><span class="total">Total</span></div>' +
    `<ul class="result-list">${rows}</ul></div>`;
}

/** Rangliste mit geteilten Plätzen (gleiche Punkte = gleicher Platz). */
function rankedPlayers(list) {
  return list.map((r) => ({ ...r, place: 1 + list.filter((q) => q.score > r.score).length }));
}

function finalHtml(st) {
  const ranked = rankedPlayers(st.ranking || []);
  if (!ranked.length) return '';
  const winners = ranked.filter((r) => r.place === 1);
  const youWin = winners.some((w) => w.playerId === st.youId);
  const top = winners[0].score;
  let title;
  let sub;
  if (winners.length === 1) {
    title = youWin ? 'Du gewinnst!' : `${esc(winners[0].name)} gewinnt!`;
    const second = ranked.find((r) => r.place > 1);
    sub = second ? `${top} Punkte – ${top - second.score} vor dem zweiten Platz.` : `${top} Punkte.`;
  } else {
    title = youWin ? 'Geteilter Sieg!' : 'Gleichstand!';
    const names = joinNames(youFirst(winners, (w) => w.playerId).map((w) => who(w.playerId)));
    sub = `${names} ${youWin ? 'teilt euch' : 'teilen sich'} den Sieg mit ${top} Punkten.`;
  }
  const shared = (place) => ranked.filter((r) => r.place === place).length > 1;
  const podiumEntry = (r) => {
    if (!r) return '';
    const you = r.playerId === st.youId;
    const place = Math.min(r.place, 3);
    return `<li>${avatarHtml(r.name, { you })}` +
      `<div class="who"><span class="name">${you ? 'Du' : esc(r.name)}</span><span class="score">${fmt(r.score)} Pkt.</span></div>` +
      `<div class="block place-${place}">${r.place}.${shared(r.place) ? '<small>geteilt</small>' : ''}</div></li>`;
  };
  const offlineIds = new Set(st.players.filter((p) => !p.connected).map((p) => p.id));
  const rest = ranked.slice(3).map((r) =>
    `<li><span class="rank">${r.place}.</span><span class="name">${r.playerId === st.youId ? 'Du' : esc(r.name)}</span>` +
    (offlineIds.has(r.playerId) ? `<span title="Offline">${icon('wifiOff', 16)}</span>` : '') +
    `<span class="score">${fmt(r.score)}</span></li>`).join('');
  return '<div class="final">' +
    `<div class="final-hero"><div class="trophy">${icon('trophy', 34, 2)}</div><h1>${title}</h1><p>${sub}</p></div>` +
    `<ol class="podium" aria-label="Podest">${podiumEntry(ranked[1])}${podiumEntry(ranked[0])}${podiumEntry(ranked[2])}</ol>` +
    '<div class="podium-base"></div>' +
    (rest ? `<ol class="rest-list" aria-label="Weitere Plätze">${rest}</ol>` : '') +
    '</div>';
}

// ---------- Bedienfeld ----------

function canPickCard(st) {
  if (st.phase === 'playing') return st.currentPlayerId === st.youId;
  if (st.phase === 'duel') return Boolean(st.duel && st.duel.needsYourPick);
  return false;
}

function isMyTurn(st) {
  if (st.phase === 'bidding') return st.currentBidderId === st.youId;
  return canPickCard(st);
}

function sortedHand(st) {
  return (st.hand || []).slice().sort((a, b) => (a.rank || 0) - (b.rank || 0) || String(a.suit).localeCompare(b.suit));
}

function handHtml(st, { size, pickable = false }) {
  const cards = sortedHand(st);
  if (!cards.length) return '';
  const cls = `hand${pickable ? ' is-pickable' : ''}${cards.length >= 5 ? ' is-tight' : ''}`;
  if (!pickable) {
    return `<div class="${cls}" aria-label="Deine Karten">${cards.map((c) => cardHtml(c, { size })).join('')}</div>`;
  }
  return `<div class="${cls}" aria-label="Deine Karten">` + cards.map((c) => {
    const sel = c.id === selectedCardId;
    return `<button type="button" class="hand-btn" data-card="${esc(c.id)}" aria-pressed="${sel}" ` +
      `aria-label="${esc(NAMES[c.rank])}${sel ? ', ausgewählt – nochmals tippen spielt sie' : ''}">` +
      `${cardHtml(c, { size, selected: sel })}</button>`;
  }).join('') + '</div>';
}

const selectedCard = (st) => (st.hand || []).find((c) => c.id === selectedCardId) || null;

/** Selektor für das fokussierte Element im Bedienfeld, damit es das Neuzeichnen überlebt. */
function focusedSelector(dock) {
  const el = document.activeElement;
  if (!el || !dock.contains(el)) return null;
  if (el.dataset.card) return `.hand-btn[data-card="${CSS.escape(el.dataset.card)}"]`;
  if (el.dataset.bid) return `.bid[data-bid="${CSS.escape(el.dataset.bid)}"]`;
  return el.id ? `#${CSS.escape(el.id)}` : null;
}

function renderDock(st) {
  const dock = $('dock');
  const focusSel = focusedSelector(dock);
  if (st.phase === 'bidding') {
    if (st.currentBidderId === st.youId && st.allowedBids) bidDock(st, dock);
    else waitBidDock(st, dock);
  } else if (st.phase === 'playing') playDock(st, dock);
  else if (st.phase === 'duel') duelDock(st, dock);
  else if (st.phase === 'roundEnd') roundEndDock(st, dock);
  else if (st.phase === 'gameOver') gameOverDock(st, dock);
  else dock.innerHTML = '';
  refocus(dock, focusSel);
}

/** Nach dem Neuzeichnen den Fokus auf denselben Knopf zurücksetzen (Tastatur). */
function refocus(dock, selector) {
  const el = selector && dock.querySelector(selector);
  if (el) el.focus({ preventScroll: true });
}

function ownBlindHtml(title, text, idle) {
  return '<div class="own-blind">' +
    `<div class="card-wrap">${cardHtml(null, { size: 'md' })}<span class="q" aria-hidden="true">?</span></div>` +
    `<div class="text">${dockTitle(title, { idle })}<p class="note">${text}</p></div></div>`;
}

function bidDock(st, dock, focusSel) {
  const cards = st.cardsThisRound;
  const allowed = st.allowedBids;
  if (!allowed.includes(selectedBid)) selectedBid = null;
  const top = st.blind
    ? ownBlindHtml('Deine Karte bleibt verdeckt', 'Schätze anhand der anderen Karten: 0 oder 1? In Blindrunden darf die Summe aufgehen.')
    : dockTitle('Wie viele Stiche machst du?') + handHtml(st, { size: 'md' });
  const buttons = [];
  const reasons = [];
  for (let v = 0; v <= cards; v++) {
    const ok = allowed.includes(v);
    const sel = v === selectedBid;
    if (!ok) {
      reasons.push(v === st.blockedBid
        ? `${v} ist gesperrt: Du hast zweimal hintereinander ${v} angesagt.`
        : `${v} geht nicht: Du sagst zuletzt an, und mit ${v} ergäbe die Summe genau ${cards}.`);
    }
    buttons.push(`<button type="button" class="bid${sel ? ' is-selected' : ''}" data-bid="${v}" aria-pressed="${sel}" ` +
      `aria-label="${ok ? `${plural(v, 'Stich', 'Stiche')} ansagen` : `${v} – nicht erlaubt`}"${ok ? '' : ' disabled'}>` +
      `${v}${ok ? '' : `<span class="lock">${icon('lock', 12, 2.6)}</span>`}</button>`);
  }
  const label = bidPending ? 'Wird gesendet …'
    : selectedBid === null ? 'Zahl antippen' : `${plural(selectedBid, 'Stich', 'Stiche')} ansagen`;
  dock.innerHTML = top + `<div class="bids">${buttons.join('')}</div>` +
    reasons.map((r) => note('warn', 'lock', esc(r))).join('') +
    `<button id="btn-bid-confirm" type="button" class="btn btn-primary"${selectedBid === null || bidPending ? ' disabled' : ''}>${label}</button>`;

  for (const btn of dock.querySelectorAll('.bid:not(:disabled)')) {
    btn.addEventListener('click', () => {
      if (bidPending) return;
      selectedBid = Number(btn.dataset.bid);
      bidDock(st, dock, `.bid[data-bid="${selectedBid}"]`);
    });
  }
  $('btn-bid-confirm').addEventListener('click', () => {
    if (bidPending || selectedBid === null) return;
    bidPending = true;
    bidDock(st, dock);
    send('bid', { value: selectedBid }, (res) => {
      bidPending = false;
      if (res.ok) selectedBid = null;
      else if (state) renderDock(state);
    });
  });
  refocus(dock, focusSel);
}

function waitBidDock(st, dock) {
  const me = st.players.find((p) => p.id === st.youId);
  const title = `${esc(nameOf(st.currentBidderId))} sagt an …`;
  const mine = me && me.bid !== null ? note('info', 'info', `Du hast ${plural(me.bid, 'Stich', 'Stiche')} angesagt.`) : '';
  dock.innerHTML = st.blind
    ? ownBlindHtml(title, 'Nur die anderen sehen deine Karte.', true) + mine
    : dockTitle(title, { idle: true }) + handHtml(st, { size: 'md' }) + mine;
}

function playHint(st, card) {
  if (!card) {
    return note('info', 'info', st.table.length
      ? 'Tippe eine Karte an – nochmals tippen spielt sie sofort.'
      : 'Du spielst aus. Tippe eine Karte an – nochmals tippen spielt sie sofort.');
  }
  const name = WITH_ARTICLE[card.rank];
  if (!st.table.length) return note('info', 'info', `${name} eröffnet den Stich.`);
  const max = Math.max(...st.table.map((t) => t.card.rank));
  const leaders = st.table.filter((t) => t.card.rank === max);
  if (card.rank > max) return note('good', 'arrowUp', `${name} ist höher als alles auf dem Tisch – du übernimmst die Führung.`);
  if (card.rank === max) {
    // Beim letzten Stich gibt es kein Duell mehr, dann entscheidet eine gezogene Karte
    return note('warn', 'swords', (st.hand || []).length === 1
      ? `${name} ist gleich hoch wie die höchste Karte – beim letzten Stich entscheidet dann eine zufällig gezogene Karte.`
      : `${name} ist gleich hoch wie die höchste Karte – es käme zum Stich-Duell.`);
  }
  const ahead = leaders.length === 1 ? `${esc(nameOf(leaders[0].playerId))} bleibt` : 'die Führenden bleiben';
  return note('info', 'info', `${name} ist zu tief – ${ahead} vorne.`);
}

function bindHand(st, dock, rerender) {
  for (const btn of dock.querySelectorAll('.hand-btn')) {
    btn.addEventListener('click', () => {
      const id = btn.dataset.card;
      if (selectedCardId === id) return playSelected(st);
      selectedCardId = id;
      rerender(`.hand-btn[data-card="${CSS.escape(id)}"]`);
    });
  }
}

function playDock(st, dock, focusSel) {
  if (st.currentPlayerId !== st.youId) {
    const rest = (st.hand || []).length ? '' : note('info', 'info', 'Du hast alle Karten dieser Runde gespielt.');
    dock.innerHTML = dockTitle(`${esc(nameOf(st.currentPlayerId))} ist dran`, { idle: true }) + handHtml(st, { size: 'lg' }) + rest;
    return;
  }
  const card = selectedCard(st);
  dock.innerHTML = dockTitle('Du bist dran', { side: 'Wähle eine Karte' }) +
    handHtml(st, { size: 'lg', pickable: true }) + playHint(st, card) +
    `<button id="btn-play" type="button" class="btn btn-primary"${card ? '' : ' disabled'}>${card ? `${NAMES[card.rank]} spielen` : 'Karte wählen'}</button>`;
  bindHand(st, dock, (sel) => playDock(st, dock, sel));
  $('btn-play').addEventListener('click', () => playSelected(st));
  refocus(dock, focusSel);
}

function duelDock(st, dock, focusSel) {
  if (!st.duel.needsYourPick) {
    const picked = st.players.filter((p) => p.duelPicked).length;
    dock.innerHTML = dockTitle('Warte auf die anderen …', { idle: true }) + handHtml(st, { size: 'lg' }) +
      note('info', 'info', `${picked} von ${st.players.length} haben gewählt.`);
    return;
  }
  const part = st.duel.youParticipate;
  const card = selectedCard(st);
  const action = part ? 'verdeckt spielen' : 'abwerfen';
  dock.innerHTML = dockTitle(part ? 'Wähle verdeckt deine Duell-Karte' : 'Wähle eine Karte zum Abwerfen') +
    handHtml(st, { size: 'lg', pickable: true }) +
    note('info', 'info', part
      ? `Die höhere Karte gewinnt alle ${st.stake} Stiche. Alle anderen werfen eine Karte ab.`
      : 'Du bist nicht im Duell – deine Karte wird nur abgeworfen und zählt nicht.') +
    `<button id="btn-play" type="button" class="btn btn-primary"${card ? '' : ' disabled'}>${card ? `${NAMES[card.rank]} ${action}` : 'Karte wählen'}</button>`;
  bindHand(st, dock, (sel) => duelDock(st, dock, sel));
  $('btn-play').addEventListener('click', () => playSelected(st));
  refocus(dock, focusSel);
}

function playSelected(st) {
  const cardId = selectedCardId;
  if (!cardId) return;
  selectedCardId = null;
  send(st.phase === 'duel' ? 'duelPick' : 'playCard', { cardId }, (res) => {
    // Abgelehnt (z. B. Verbindung weg): Auswahl ist zurückgesetzt – Bedienfeld neu zeichnen
    if (!res.ok && state && state.screen === 'game') renderDock(state);
  });
}

function roundEndDock(st, dock) {
  const historyBtn = `<button id="btn-dock-history" type="button" class="btn btn-outline btn-sm">${icon('trophy', 18)}Punkte &amp; Verlauf</button>`;
  if (st.isHost) {
    const last = st.roundNumber >= st.totalRounds;
    const nextCards = st.roundPlan[st.roundNumber];
    const what = nextCards === 1 ? 'Blindrunde' : plural(nextCards, 'Karte', 'Karten');
    const label = last ? 'Endstand anzeigen'
      : st.roundNumber + 1 === st.totalRounds ? `Letzte Runde · ${what}` : `Nächste Runde · ${what}`;
    dock.innerHTML = `<button id="btn-next" type="button" class="btn btn-primary">${label}${icon('arrowRight', 20, 2.4)}</button>` + historyBtn;
    $('btn-next').addEventListener('click', (e) => sendFrom(e.currentTarget, 'nextRound'));
  } else {
    const host = st.players.find((p) => p.isHost);
    dock.innerHTML = dockTitle(`Warte auf ${host ? esc(host.name) : 'den Host'} …`, { idle: true }) + historyBtn;
  }
  $('btn-dock-history').addEventListener('click', openHistory);
}

function gameOverDock(st, dock) {
  const offline = st.players.filter((p) => !p.connected).map((p) => p.name);
  const one = offline.length === 1;
  let html = offline.length
    ? note('warn', 'wifiOff', `${joinNames(offline)} ${one ? 'ist' : 'sind'} offline. ` +
      `Bei «Nochmal spielen» ${one ? 'spielt' : 'spielen'} ${one ? esc(offline[0]) : 'sie'} nicht mit.`)
    : '';
  if (st.isHost) {
    const enough = st.players.filter((p) => p.connected).length >= st.minPlayers;
    html += `<button id="btn-restart" type="button" class="btn btn-primary"${enough ? '' : ' disabled'}>Nochmal spielen</button>` +
      (enough ? '' : '<p class="caption">Zu wenige Spieler online – in der Lobby können Neue beitreten.</p>') +
      '<div class="btn-row"><button id="btn-lobby" type="button" class="btn btn-outline btn-sm">Zur Lobby</button>' +
      '<button id="btn-exit" type="button" class="btn btn-outline btn-sm">Raum verlassen</button></div>';
  } else {
    html += note('info', 'info', 'Der Host kann ein neues Spiel starten.') +
      '<button id="btn-exit" type="button" class="btn btn-outline btn-sm">Raum verlassen</button>';
  }
  dock.innerHTML = html;
  if (st.isHost) {
    const restart = $('btn-restart');
    restart.addEventListener('click', () => startGameFrom(restart, 'restartGame', st));
    $('btn-lobby').addEventListener('click', (e) => sendFrom(e.currentTarget, 'backToLobby'));
  }
  $('btn-exit').addEventListener('click', leaveRoom);
}

// ---------- Menü ----------

function renderMenu() {
  const st = state;
  if (!st || st.screen !== 'game') return;
  $('menu-body').innerHTML = `<div class="menu-code"><span>Raum-Code</span><b>${esc(st.roomCode)}</b></div>` +
    (st.isHost
      ? '<button id="btn-close-room" type="button" class="btn btn-danger">Raum für alle schliessen</button>' +
        '<p class="hint">Das Spiel endet für alle. Alle landen wieder auf dem Startbildschirm und müssen neu beitreten.</p>'
      : '<p class="hint">Nur der Host kann den Raum schliessen. Mitten im Spiel kann niemand austreten – sonst bliebe das Spiel stehen.</p>');
  const btn = $('btn-close-room');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    closeSheet($('menu-dialog'));
    const yes = await askConfirm({
      iconName: 'logout',
      title: 'Raum schliessen?',
      text: 'Das Spiel wird für alle beendet. Alle landen wieder auf dem Startbildschirm und müssen neu beitreten.',
      ok: 'Schliessen',
    });
    if (yes) send('closeRoom');
  });
}

// ---------- Punkte & Verlauf ----------

/** Zahl, die ein Spieler nach Regel 2 gerade nicht ansagen darf (2× nacheinander angesagt). */
function lockedBid(done, pid) {
  const bids = done.map((r) => r.results.find((x) => x.playerId === pid).bid);
  const n = bids.length;
  return n >= 2 && bids[n - 1] === bids[n - 2] ? bids[n - 1] : null;
}

function renderHistory() {
  const st = state;
  if (!st || !st.history) return;
  const done = st.history.filter((r) => r.results);
  const current = st.phase === 'gameOver' ? null : st.history.find((r) => !r.results);

  const standings = rankedPlayers(st.players.map((p) => ({ playerId: p.id, name: p.name, score: p.score })))
    .sort((a, b) => a.place - b.place);
  $('standings').innerHTML = standings.map((s) =>
    `<li class="${s.place === 1 ? 'is-top' : ''}"><span class="rank">${s.place}.</span>` +
    `<span class="name">${s.playerId === st.youId ? 'Du' : esc(s.name)}</span><span class="score">${fmt(s.score)}</span></li>`).join('');

  const head = '<div class="h-row h-head"><span>Runde</span>' +
    st.players.map((p) => `<span>${p.id === st.youId ? 'Du' : esc(p.name)}</span>`).join('') + '</div>';
  const rows = st.roundPlan.map((cards, i) => {
    const nr = i + 1;
    const label = `<span>R${nr} · ${cards}</span>`;
    const r = done.find((x) => x.roundNumber === nr);
    if (r) {
      return '<div class="h-row">' + label + st.players.map((p) => {
        const res = r.results.find((x) => x.playerId === p.id);
        if (!res) return '<span>–</span>';
        const hit = res.bid === res.won;
        return `<span class="${hit ? 'hit' : 'miss'}" title="Ansage ${res.bid}, gemacht ${res.won}">` +
          `${icon(hit ? 'check' : 'x', hit ? 10 : 9, 3.6)}${res.bid}/${res.won}</span>`;
      }).join('') + '</div>';
    }
    if (current && current.roundNumber === nr) {
      return '<div class="h-row is-current" aria-current="step">' + label + st.players.map((p) => {
        if (p.bid !== null) {
          return st.phase === 'bidding'
            ? `<span title="Ansage ${p.bid}">${p.bid}</span>`
            : `<span title="Ansage ${p.bid}, bisher ${p.tricksWon}">${p.bid}/${p.tricksWon}</span>`;
        }
        const lock = lockedBid(done, p.id);
        return lock !== null
          ? `<span class="miss" title="${lock} ist gesperrt">${icon('lock', 11, 2.8)}≠${lock}</span>`
          : '<span class="wait">…</span>';
      }).join('') + '</div>';
    }
    return '<div class="h-row is-future">' + label + st.players.map(() => '<span>·</span>').join('') + '</div>';
  }).join('');
  const totals = '<div class="h-row h-total"><span>Total</span>' +
    st.players.map((p) => `<span>${fmt(p.score)}</span>`).join('') + '</div>';
  const body = $('history-body');
  body.style.setProperty('--cols', st.players.length);
  body.innerHTML = head + rows + totals;
}

// ---------- Ergebnis-Fenster ----------

function eventsOf(st) {
  return [
    st.lastTrick && { ...st.lastTrick, type: 'trick' },
    st.lastDuel && { ...st.lastDuel, type: 'duel' },
    st.lastDraw && { ...st.lastDraw, type: 'draw' },
  ].filter(Boolean).sort((a, b) => a.eventId - b.eventId);
}

function queueEvents(st) {
  const events = eventsOf(st);
  if (!eventsSynced) {
    // Nach einem Reload nicht die alten Stiche nochmals abspielen
    eventsSynced = true;
    shownEventId = Math.max(shownEventId, ...events.map((e) => e.eventId), 0);
    return;
  }
  for (const e of events) {
    if (e.eventId <= shownEventId) continue;
    shownEventId = e.eventId;
    // Folgt direkt eine Ziehung, war der Gleichstand beim letzten Stich: dann kein Duell
    const drawNext = Boolean(st.lastDraw && st.lastDraw.eventId === e.eventId + 1);
    // Mit dem Zustand von jetzt anzeigen – später kann `state` schon null sein (Raum verlassen)
    const view = { youId: st.youId, players: st.players, drawNext };
    const gen = overlayGen;
    overlayQueue = overlayQueue
      .then(() => (gen === overlayGen ? showEventOverlay(e, view) : null))
      .catch(() => {});
  }
}

/** Wartende Ergebnis-Fenster verwerfen und ein offenes schliessen (Raum verlassen o. Ä.). */
function resetOverlays() {
  overlayGen += 1;
  const overlay = $('overlay');
  if (overlay.open) overlay.close();
}

function overlayHtml(e, view) {
  const name = (pid) => {
    const p = view.players.find((q) => q.id === pid);
    return p ? p.name : '?';
  };
  const whoV = (pid) => (pid === view.youId ? 'Du' : name(pid));
  const names = (ids) => joinNames(youFirst(ids, (id) => id).map(whoV));
  const wins = (pid, rest) => (pid === view.youId ? `Du gewinnst ${rest}` : `${esc(name(pid))} gewinnt ${rest}`);
  const toWhom = (pid) => (pid === view.youId ? 'dich' : esc(name(pid)));
  const cardsRow = (items) => '<div class="overlay-cards">' + items.map(({ card, pid, lead, note: extra }) =>
    `<div class="slot">${cardHtml(card, { size: 'md', lead, dim: !lead })}` +
    `<span class="slot-name">${esc(whoV(pid))}</span>${extra ? `<span class="slot-note">${extra}</span>` : ''}</div>`).join('') + '</div>';
  const head = (iconName, title, sub) =>
    `<div class="overlay-head"><div class="overlay-icon">${icon(iconName, 28, 2.2)}</div>` +
    `<div><h2 id="overlay-title">${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div></div>`;
  const nextStep = view.drawNext
    ? 'Weil es der letzte Stich war, entscheidet eine zufällig gezogene Karte.'
    : `Jetzt geht es um ${e.stake + 1} Stiche.`;

  if (e.type === 'trick') {
    const max = Math.max(...e.cards.map((t) => t.card.rank));
    const row = cardsRow(e.cards.map((t) => ({ card: t.card, pid: t.playerId, lead: e.winnerIds.includes(t.playerId) })));
    if (e.winnerIds.length > 1) {
      const youIn = e.winnerIds.includes(view.youId);
      return head('swords', view.drawNext ? 'Gleichstand!' : 'Gleichstand – Duell!',
        `${names(e.winnerIds)} ${youIn ? 'habt' : 'haben'} gleich hoch gespielt. ${nextStep}`) + row;
    }
    const winner = e.winnerIds[0];
    return head('trophy', wins(winner, 'den Stich'), `${WITH_ARTICLE[max]} war die höchste Karte.`) + row +
      `<div class="result-chip"><span class="dot-icon hit">${icon('check', 14, 3.2)}</span>` +
      `<span>+${plural(e.stake, 'Stich', 'Stiche')} für ${toWhom(winner)}</span></div>`;
  }
  if (e.type === 'duel') {
    const row = cardsRow(e.reveals.map((r) => ({
      card: r.card, pid: r.playerId, lead: e.winnerIds.includes(r.playerId), note: r.participant ? '' : 'abgeworfen',
    })));
    if (e.winnerIds.length > 1) return head('swords', 'Schon wieder Gleichstand!', nextStep) + row;
    return head('trophy', wins(e.winnerIds[0], 'das Duell'),
      `${plural(e.stake, 'Stich geht', 'Stiche gehen')} an ${toWhom(e.winnerIds[0])}.`) + row;
  }
  // Letzter Stich mit Gleichstand: zufällig gezogene Karten entscheiden
  const rounds = e.rounds.map((round, i) => {
    const max = Math.max(...round.map((d) => d.card.rank));
    return `<p class="overlay-label">Ziehung ${i + 1}</p>` +
      cardsRow(round.map((d) => ({ card: d.card, pid: d.playerId, lead: d.card.rank === max })));
  }).join('');
  return head('shuffle', `Zufallskarten: ${wins(e.winnerId, '')}`.trim(),
    `${plural(e.stake, 'Stich geht', 'Stiche gehen')} an ${toWhom(e.winnerId)}.`) + rounds;
}

function showEventOverlay(e, view) {
  return new Promise((resolve) => {
    const overlay = $('overlay');
    $('overlay-content').innerHTML = overlayHtml(e, view);
    const bar = $('overlay-bar');
    bar.style.animation = 'none';
    void bar.offsetWidth; // Animation neu starten
    bar.style.animation = '';
    bar.style.animationDuration = `${OVERLAY_MS}ms`;
    // Als modaler Dialog: liegt auch über offenen Fenstern, Fokus und Escape gibt es dazu
    overlay.showModal();
    const finish = () => {
      clearTimeout(timer);
      overlay.removeEventListener('click', close);
      overlay.removeEventListener('close', finish);
      resolve();
    };
    const close = () => { if (overlay.open) overlay.close(); };
    const timer = setTimeout(close, OVERLAY_MS);
    // Tippen irgendwo (auch auf «Weiter») schliesst; Escape schliesst über 'close'
    overlay.addEventListener('click', close);
    overlay.addEventListener('close', finish);
  });
}

// ---------- Socket ----------

function rejoin() {
  // Bewusst ohne request(): Ein Timeout darf das Token nicht löschen – geht die
  // Antwort verloren, versucht es der nächste 'connect' ohnehin erneut.
  socket.emit('rejoin', { token: token() }, (res) => {
    if (res.ok) return;
    if (!res.gone) {
      // Vorübergehender Fehler (z. B. zu viele Anfragen): gleich nochmals versuchen
      setTimeout(() => { if (socket.connected && token()) rejoin(); }, 3000);
      return;
    }
    clearToken();
    if (state) toast('Du bist nicht mehr im Raum.', 'info');
    state = null;
    resetOverlays();
    show('screen-start');
  });
}

socket.on('connect', () => {
  $('conn-banner').classList.add('hidden');
  // Erst wissen, welches Token zu diesem Tab gehört (Abfrage an andere Tabs läuft evtl. noch)
  tokenReady.then(() => {
    if (token()) rejoin();
    else if (!state) show('screen-start');
  });
});

socket.on('state', (st) => {
  const prev = state;
  state = st;
  // Auswahl zurücksetzen, wenn sich die Phase ändert oder die Karte weg ist
  if (!prev || prev.phase !== st.phase || prev.screen !== st.screen ||
      (st.hand && !st.hand.some((c) => c.id === selectedCardId))) {
    selectedCardId = null;
  }
  // Angetippte Ansage verwerfen, sobald man nicht mehr am Ansagen ist
  if (!(st.phase === 'bidding' && st.allowedBids) ||
      (prev && prev.roundNumber !== st.roundNumber)) {
    selectedBid = null;
  }
  if (st.screen === 'lobby') {
    shownEventId = 0;
    eventsSynced = true;
    wasMyTurn = false;
    if (prev && prev.screen === 'game') resetOverlays();
    renderLobby(st);
    return;
  }
  // Neues Spiel ("Nochmal spielen"): Event-Zähler beginnt wieder bei 1
  if (prev && prev.phase === 'gameOver' && st.phase !== 'gameOver') shownEventId = 0;
  queueEvents(st);
  renderGame(st);
  const mine = isMyTurn(st);
  if (mine && !wasMyTurn) {
    buzz();
    announce('Du bist dran.');
  }
  wasMyTurn = mine;
});

socket.on('disconnect', () => {
  if (state) $('conn-banner').classList.remove('hidden');
});

// Server nicht erreichbar oder Verbindung abgelehnt (z. B. zu viele Verbindungen):
// socket.io versucht es selbst erneut – ohne Hinweis würde «Verbinde …» aber
// endlos drehen. Mitten im Spiel zeigt schon das Verbindungs-Banner den Zustand.
socket.on('connect_error', () => {
  if (!state) toast('Keine Verbindung zum Server – neuer Versuch läuft …', 'info');
});

socket.on('roomClosed', () => {
  clearToken();
  state = null;
  resetOverlays();
  show('screen-start');
  toast('Der Host hat den Raum geschlossen.', 'info');
});
