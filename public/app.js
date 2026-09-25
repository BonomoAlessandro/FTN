'use strict';

/* global io, Cards */

const socket = io();
const $ = (id) => document.getElementById(id);
const { cardEl, cardHtml } = Cards;

const OVERLAY_MS = 2600;

let state = null;
let selectedCardId = null;
let shownEventId = 0;
let eventsSynced = false; // erst nach dem ersten Spielzustand Ereignisse anzeigen
let overlayQueue = Promise.resolve();
let wasMyTurn = false;

// ---------- Hilfsfunktionen ----------

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* privater Modus */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* privater Modus */ } },
};
const token = () => store.get('ftn_token');

function send(event, data = {}) {
  socket.emit(event, { token: token(), ...data }, (res) => {
    if (res && !res.ok) toast(res.error || 'Fehler');
  });
}

let toastTimer = null;
function toast(msg, kind = 'error') {
  const el = $('toast');
  el.textContent = msg;
  el.className = kind === 'info' ? 'info' : '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function show(screenId) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('hidden', s.id !== screenId);
  syncWakeLock();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function nameOf(pid) {
  const p = state && state.players.find((q) => q.id === pid);
  return p ? p.name : '?';
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

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

// ---------- Start & Lobby ----------

function renderHero() {
  const hero = $('hero-cards');
  const cards = [
    { suit: 'eicheln', rank: 12 },
    { suit: 'rosen', rank: 14 },
    { suit: 'schellen', rank: 13 },
  ];
  hero.innerHTML = '';
  cards.forEach((c, i) => {
    const el = cardEl(c);
    el.style.transform = `translateX(-50%) rotate(${(i - 1) * 14}deg)`;
    el.style.animationDelay = `${i * 90}ms`;
    hero.appendChild(el);
  });
}
renderHero();

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

function enterRoom(res) {
  if (!res.ok) return toast(res.error);
  store.set('ftn_token', res.token);
  history.replaceState(null, '', location.pathname);
}

$('btn-create').addEventListener('click', () => {
  const name = readName();
  if (name) socket.emit('createRoom', { name }, enterRoom);
});

$('form-start').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('input-code').value.trim().toUpperCase();
  if (code.length !== 4) {
    toast('Der Raum-Code hat 4 Zeichen.');
    $('input-code').focus();
    return;
  }
  const name = readName();
  if (name) socket.emit('joinRoom', { name, code }, enterRoom);
});

$('input-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

const openRules = () => $('rules-dialog').showModal();
$('btn-history').addEventListener('click', () => {
  $('history-dialog').showModal();
  renderHistory(true);
});
$('history-dialog').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close();
});
$('btn-rules').addEventListener('click', openRules);
$('btn-game-rules').addEventListener('click', openRules);
$('rules-dialog').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close(); // Tippen auf den Hintergrund
});

function leaveRoom() {
  send('leaveRoom');
  store.del('ftn_token');
  state = null;
  show('screen-start');
}
$('btn-leave').addEventListener('click', leaveRoom);

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

$('btn-close-game').addEventListener('click', () => {
  if (confirm('Raum wirklich für alle schliessen? Alle müssen neu beitreten.')) send('closeRoom');
});

function renderLobby(st) {
  show('screen-lobby');
  $('lobby-code').textContent = st.roomCode;
  $('lobby-count').textContent = `Spieler ${st.players.length}/${st.maxPlayers}`;
  $('lobby-players').innerHTML = st.players
    .map((p) =>
      `<li class="${p.connected ? '' : 'off'}"><span><span class="dot${p.connected ? '' : ' off'}"></span>` +
      `${esc(p.name)}${p.isYou ? ' <small>(du)</small>' : ''}</span>` +
      `${p.isHost ? '<span class="badge">Host</span>' : ''}</li>`)
    .join('');
  const action = $('lobby-action');
  if (st.isHost) {
    const missing = st.minPlayers - st.players.length;
    action.innerHTML = `<button id="btn-start" class="btn primary" ${missing > 0 ? 'disabled' : ''}>Spiel starten</button>` +
      (missing > 0 ? `<p class="hint" style="margin-top:8px">Es fehlen noch ${plural(missing, 'Spieler', 'Spieler')}.</p>` : '');
    const btn = $('btn-start');
    btn.addEventListener('click', () => send('startGame'));
  } else {
    action.innerHTML = '<p class="hint">Warte, bis der Host das Spiel startet …</p>';
  }
}

// ---------- Spiel ----------

function renderGame(st) {
  show('screen-game');
  if ($('history-dialog').open) renderHistory();
  renderHeader(st);
  renderPlayersBar(st);
  renderTable(st);
  renderStatus(st);
  renderActions(st);
  renderHand(st);
}

function renderHeader(st) {
  let html = `<span class="pill round">Runde ${st.roundNumber}/${st.totalRounds}</span>`;
  if (st.cardsThisRound !== null) html += `<span class="pill">${plural(st.cardsThisRound, 'Karte', 'Karten')}</span>`;
  if (st.blind) html += '<span class="pill blind">🙈 Blind</span>';
  $('round-info').innerHTML = html;
  $('btn-close-game').classList.toggle('hidden', !st.isHost);
}

function chipMeta(st, p) {
  if (st.phase === 'gameOver') return '';
  if (p.bid === null) return st.phase === 'bidding' ? 'Ansage …' : '&nbsp;';
  if (st.phase === 'bidding') return `Ansage <b>${p.bid}</b>`;
  const cls = p.tricksWon === p.bid ? 'hit' : p.tricksWon > p.bid ? 'over' : '';
  return `Stiche <b class="${cls}">${p.tricksWon}/${p.bid}</b>`;
}

function renderPlayersBar(st) {
  const bar = $('players-bar');
  const n = st.players.length;
  bar.style.setProperty('--cols', n <= 4 ? n : Math.ceil(n / 2));
  bar.innerHTML = st.players.map((p) => {
    const isTurn = p.id === st.currentBidderId || p.id === st.currentPlayerId ||
      (st.phase === 'duel' && !p.duelPicked);
    let flag = '';
    if (st.duel) flag = p.duelPicked ? '✅' : (p.duelParticipant ? '⚔️' : '🗑️');
    else if (p.isHost) flag = '👑';
    const cls = ['chip', isTurn && 'turn', p.id === st.youId && 'you', !p.connected && 'off'].filter(Boolean).join(' ');
    return `<div class="${cls}">` +
      (flag ? `<span class="flag">${flag}</span>` : '') +
      `<div class="name">${p.connected ? '' : '📵 '}${esc(p.name)}</div>` +
      `<div class="meta">${chipMeta(st, p)}</div>` +
      `<div class="score">${p.score} Pkt.</div>` +
      '</div>';
  }).join('');
}

function renderTable(st) {
  const area = $('table-area');

  if (st.phase === 'roundEnd' && st.roundResults) {
    area.innerHTML = `<h3>Wertung Runde ${st.roundNumber}</h3>` + resultTableHtml(st.roundResults);
    return;
  }
  if (st.phase === 'gameOver' && st.ranking) {
    const medals = ['🥇', '🥈', '🥉'];
    area.innerHTML = '<h3>🏆 Endstand</h3>' +
      '<table class="result-table"><tr><th></th><th class="name">Spieler</th><th>Punkte</th></tr>' +
      st.ranking.map((r, i) =>
        `<tr class="${i === 0 ? 'first' : ''}"><td class="medal">${medals[i] || `${i + 1}.`}</td>` +
        `<td class="name">${esc(r.name)}</td><td><b>${r.score}</b></td></tr>`).join('') +
      '</table>';
    return;
  }

  // Blindrunde während der Ansage: Karten der anderen gross anzeigen
  if (st.blind && st.phase === 'bidding') {
    const opps = st.players.filter((p) => p.id !== st.youId);
    area.innerHTML = '<p class="hint">Du siehst nur die Karten der anderen – deine eigene ist verdeckt!</p>' +
      '<div class="blind-grid">' +
      opps.map((p) => `<div class="opp">${cardHtml(p.visibleCard, { size: 'lg' })}<span>${esc(p.name)}</span></div>`).join('') +
      '</div>' + bidSummaryHtml(st);
    return;
  }

  if (st.phase === 'bidding') {
    area.innerHTML = `<div class="felt-ring"><h3>Ansagen</h3>${bidSummaryHtml(st)}</div>`;
    return;
  }

  if (st.phase === 'duel') {
    const picked = st.players.filter((p) => p.duelPicked);
    area.innerHTML = '<div class="felt-ring">' +
      `<h3>⚔️ Duell um ${plural(st.stake, 'Stich', 'Stiche')}</h3>` +
      `<p class="hint">${st.duel.participants.map((id) => `<b>${esc(nameOf(id))}</b>`).join(' vs. ')}<br>` +
      'Alle wählen verdeckt eine Karte – Unbeteiligte werfen ab.</p>' +
      '<div class="table-cards">' +
      (picked.length
        ? picked.map((p) => `<div class="played">${cardHtml(null)}<span>${esc(p.name)}</span></div>`).join('')
        : '') +
      '</div></div>';
    return;
  }

  // Normale Spielphase: gespielte Karten des aktuellen Stichs, führende Karte markiert
  const max = Math.max(0, ...st.table.map((t) => t.card.rank));
  const cards = st.table.map((t) => {
    const lead = t.card.rank === max;
    return `<div class="played${lead ? ' lead' : ''}">${cardHtml(t.card, { winner: lead })}<span>${esc(nameOf(t.playerId))}</span></div>`;
  }).join('');
  area.innerHTML = '<div class="felt-ring">' +
    (cards
      ? `<div class="table-cards">${cards}</div>`
      : `<p class="hint">${st.currentPlayerId === st.youId ? 'Du spielst aus.' : `${esc(nameOf(st.currentPlayerId))} spielt aus.`}</p>`) +
    '</div>';
}

function bidSummaryHtml(st) {
  const sum = st.players.reduce((s, p) => s + (p.bid || 0), 0);
  const open = st.players.filter((p) => p.bid === null).length;
  let html = '<div class="bid-summary">' +
    `<span class="pill">Angesagt <b>${sum}</b> von ${plural(st.cardsThisRound, 'Stich', 'Stichen')}</span>` +
    (open ? `<span class="pill">${open} offen</span>` : '') +
    '</div>';
  if (!st.blind && open === 1) {
    const forbidden = st.cardsThisRound - sum;
    if (forbidden >= 0) html += `<p class="hint">Letzte Ansage darf nicht <b>${forbidden}</b> sein – die Summe darf nicht aufgehen.</p>`;
  }
  return html;
}

function resultTableHtml(results) {
  return '<table class="result-table">' +
    '<tr><th>Spieler</th><th>Ansage</th><th>Stiche</th><th>Punkte</th><th>Total</th></tr>' +
    results.map((r) =>
      `<tr><td class="name">${esc(nameOf(r.playerId))}</td><td>${r.bid}</td><td>${r.won}</td>` +
      `<td class="${r.points >= 0 ? 'plus' : 'minus'}">${r.points >= 0 ? '+' : ''}${r.points}</td>` +
      `<td><b>${r.total}</b></td></tr>`).join('') +
    '</table>';
}

function isMyTurn(st) {
  if (st.phase === 'bidding') return st.currentBidderId === st.youId;
  return canPickCard(st);
}

function renderStatus(st) {
  const you = st.youId;
  let msg = '';
  if (st.phase === 'bidding') {
    msg = st.currentBidderId === you ? 'Wie viele Stiche machst du?' : `${esc(nameOf(st.currentBidderId))} sagt an …`;
  } else if (st.phase === 'playing') {
    msg = st.currentPlayerId === you ? 'Du bist dran – spiele eine Karte!' : `${esc(nameOf(st.currentPlayerId))} spielt …`;
  } else if (st.phase === 'duel') {
    if (st.duel.needsYourPick) {
      msg = st.duel.youParticipate ? '⚔️ Wähle verdeckt deine Duell-Karte!' : '🗑️ Wähle eine Karte zum Abwerfen.';
    } else {
      msg = 'Warte auf die anderen …';
    }
  } else if (st.phase === 'roundEnd') {
    msg = st.roundNumber < st.totalRounds ? 'Runde beendet.' : 'Letzte Runde beendet!';
  } else if (st.phase === 'gameOver') {
    msg = `🎉 ${esc(st.ranking[0].name)} gewinnt!`;
  }
  const el = $('status');
  el.classList.toggle('yours', isMyTurn(st));
  el.innerHTML = `<span>${msg}</span>`;
}

function renderActions(st) {
  const area = $('action-area');
  area.innerHTML = '';

  if (st.phase === 'bidding' && st.allowedBids) {
    const c = st.cardsThisRound;
    let buttons = '';
    const forbidden = [];
    for (let v = 0; v <= c; v++) {
      const allowed = st.allowedBids.includes(v);
      buttons += `<button class="bid-btn" data-bid="${v}" ${allowed ? '' : 'disabled'} aria-label="${v} Stiche ansagen">${v}</button>`;
      if (allowed) continue;
      forbidden.push(v === st.blockedBid ? `${v} gesperrt (2× nacheinander)` : `${v} verboten (Summe darf nicht aufgehen)`);
    }
    area.innerHTML = `<div class="bid-buttons">${buttons}</div>` +
      (forbidden.length ? `<div class="bid-note">${forbidden.join(' · ')}</div>` : '');
    for (const btn of area.querySelectorAll('.bid-btn:not([disabled])')) {
      btn.addEventListener('click', () => send('bid', { value: Number(btn.dataset.bid) }));
    }
    return;
  }

  // Karten-Bestätigung (gegen Vertipper auf dem Handy)
  if (selectedCardId && canPickCard(st)) {
    const label = st.phase === 'duel'
      ? (st.duel.youParticipate ? '⚔️ Verdeckt spielen' : '🗑️ Abwerfen')
      : 'Karte spielen';
    area.innerHTML = `<button id="btn-confirm" class="btn primary">${label}</button>`;
    $('btn-confirm').addEventListener('click', () => playSelected(st));
    return;
  }

  if (st.phase === 'roundEnd') {
    if (st.isHost) {
      const last = st.roundNumber >= st.totalRounds;
      area.innerHTML = `<button id="btn-next" class="btn primary">${last ? 'Endstand anzeigen' : 'Nächste Runde'}</button>`;
      $('btn-next').addEventListener('click', () => send('nextRound'));
    } else {
      area.innerHTML = '<p class="hint">Warte auf den Host …</p>';
    }
    return;
  }

  if (st.phase === 'gameOver') {
    area.innerHTML = (st.isHost ? '<button id="btn-restart" class="btn primary">Nochmal spielen</button>' : '') +
      '<button id="btn-exit" class="btn ghost small">Raum verlassen</button>';
    if (st.isHost) $('btn-restart').addEventListener('click', () => send('restartGame'));
    $('btn-exit').addEventListener('click', leaveRoom);
  }
}

function playSelected(st) {
  const cardId = selectedCardId;
  if (!cardId) return;
  selectedCardId = null;
  send(st.phase === 'duel' ? 'duelPick' : 'playCard', { cardId });
}

function canPickCard(st) {
  if (st.phase === 'playing') return st.currentPlayerId === st.youId;
  if (st.phase === 'duel') return Boolean(st.duel && st.duel.needsYourPick);
  return false;
}

function renderHand(st) {
  const area = $('hand-area');
  if (st.phase === 'gameOver' || !st.hand || st.hand.length === 0) {
    area.innerHTML = '';
    return;
  }
  const pickable = canPickCard(st);
  let label = 'Deine Karten';
  if (st.blind && st.phase === 'bidding') label = 'Deine Karte – nur die anderen sehen sie';
  else if (pickable && st.phase === 'duel') label = st.duel.youParticipate ? 'Wähle deine Duell-Karte' : 'Wähle eine Abwurf-Karte';
  else if (pickable) label = 'Tippe eine Karte an – nochmals tippen spielt sie';

  area.innerHTML = `<div class="hand-label">${label}</div>` +
    `<div class="hand-cards${pickable ? ' pickable' : ' waiting'}"></div>`;
  const wrap = area.querySelector('.hand-cards');
  const sorted = st.hand.slice().sort((a, b) => (a.rank || 0) - (b.rank || 0) || String(a.suit).localeCompare(b.suit));
  const mid = (sorted.length - 1) / 2;
  sorted.forEach((card, i) => {
    const el = cardEl(card);
    // leichter Fächer
    const off = i - mid;
    el.style.setProperty('--rot', `${off * 3}deg`);
    el.style.setProperty('--dy', `${Math.abs(off) * Math.abs(off) * 2}px`);
    if (card.id && pickable) {
      el.classList.add('playable');
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      if (card.id === selectedCardId) el.classList.add('selected');
      el.addEventListener('click', () => {
        if (selectedCardId === card.id) return playSelected(st);
        selectedCardId = card.id;
        renderActions(st);
        renderHand(st);
      });
    }
    wrap.appendChild(el);
  });
}

// ---------- Verlauf der Ansagen ----------

/** Zahl, die ein Spieler nach Regel 2 gerade nicht ansagen darf (2× nacheinander angesagt). */
function lockedBid(done, pid) {
  const bids = done.map((r) => r.results.find((x) => x.playerId === pid).bid);
  const n = bids.length;
  return n >= 2 && bids[n - 1] === bids[n - 2] ? bids[n - 1] : null;
}

function renderHistory(scrollToCurrent = false) {
  const st = state;
  if (!st || !st.history) return;
  const plan = st.roundPlan || [];
  const done = st.history.filter((r) => r.results);
  const current = st.phase === 'gameOver' ? null : st.history.find((r) => !r.results);

  const head = '<tr><th class="who">Spieler</th>' +
    plan.map((cards, i) => {
      const cls = current && current.roundNumber === i + 1 ? ' class="now-col"' : '';
      return `<th${cls}>R${i + 1}<small>${cards} K.</small></th>`;
    }).join('') +
    '<th class="total">Pkt.</th></tr>';

  const rows = st.players.map((p) => {
    const cells = plan.map((_, i) => {
      const nr = i + 1;
      const r = done.find((x) => x.roundNumber === nr);
      if (r) {
        const res = r.results.find((x) => x.playerId === p.id);
        const cls = res.bid === res.won ? 'hit' : 'miss';
        return `<td><span class="bid-cell ${cls}" title="Ansage ${res.bid}, gemacht ${res.won}">` +
          `<b>${res.bid}</b><small>${res.won}</small></span></td>`;
      }
      if (current && current.roundNumber === nr) {
        if (p.bid !== null) {
          return `<td class="now"><span class="bid-cell" title="Ansage ${p.bid}"><b>${p.bid}</b>` +
            `<small>${st.phase === 'bidding' ? '&nbsp;' : p.tricksWon}</small></span></td>`;
        }
        const lock = lockedBid(done, p.id);
        return '<td class="now"><span class="bid-cell open"><b>…</b>' +
          (lock !== null ? `<span class="lock" title="${lock} ist gesperrt">≠${lock}</span>` : '<small>&nbsp;</small>') +
          '</span></td>';
      }
      return '<td><span class="bid-cell open"><b>·</b></span></td>';
    }).join('');
    return `<tr><td class="who">${esc(p.name)}${p.id === st.youId ? ' (du)' : ''}</td>${cells}` +
      `<td class="total">${p.score}</td></tr>`;
  }).join('');

  $('history-body').innerHTML = '<div class="history-scroll"><table class="history-table">' + head + rows + '</table></div>';
  // Beim Öffnen die aktuelle Runde ins Blickfeld scrollen (nicht bei Live-Updates)
  const col = scrollToCurrent && $('history-body').querySelector('.now-col');
  if (col) {
    // so scrollen, dass die zwei Runden davor noch ganz sichtbar sind
    const scroller = $('history-body').querySelector('.history-scroll');
    const who = scroller.querySelector('.who').offsetWidth;
    scroller.scrollLeft = Math.max(0, col.offsetLeft - who - 2 * col.offsetWidth);
  }
}

// ---------- Ereignis-Overlays ----------

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
    overlayQueue = overlayQueue.then(() => showEventOverlay(e));
  }
}

function playedRow(items) {
  return '<div class="table-cards">' + items.map(({ card, pid, winner, note }) =>
    `<div class="played">${cardHtml(card, { winner })}<span>${esc(nameOf(pid))}${note || ''}</span></div>`).join('') +
    '</div>';
}

function showEventOverlay(e) {
  return new Promise((resolve) => {
    let html = '';
    if (e.type === 'trick') {
      const tie = e.winnerIds.length > 1;
      html = `<h3>${tie ? '⚔️ Gleichstand – Stich-Duell!' : `${esc(nameOf(e.winnerIds[0]))} gewinnt den Stich`}</h3>` +
        playedRow(e.cards.map((t) => ({ card: t.card, pid: t.playerId, winner: e.winnerIds.includes(t.playerId) }))) +
        (tie ? `<p class="hint" style="margin-top:10px">${e.winnerIds.map((id) => esc(nameOf(id))).join(' & ')} duellieren sich!</p>` : '');
    } else if (e.type === 'duel') {
      const tie = e.winnerIds.length > 1;
      html = `<h3>${tie ? '⚔️ Schon wieder Gleichstand!' : `⚔️ ${esc(nameOf(e.winnerIds[0]))} gewinnt ${e.stake} Stiche!`}</h3>` +
        playedRow(e.reveals.map((r) => ({
          card: r.card, pid: r.playerId, winner: e.winnerIds.includes(r.playerId), note: r.participant ? '' : ' 🗑️',
        }))) +
        '<p class="hint" style="margin-top:10px">🗑️ = abgeworfen (zählt nicht)</p>';
    } else if (e.type === 'draw') {
      html = `<h3>🎴 Zufallskarten: ${esc(nameOf(e.winnerId))} gewinnt!</h3>` +
        e.rounds.map((round, i) => {
          const max = Math.max(...round.map((d) => d.card.rank));
          return `<p class="hint">Ziehung ${i + 1}</p>` +
            playedRow(round.map((d) => ({ card: d.card, pid: d.playerId, winner: d.card.rank === max })));
        }).join('');
    }
    const overlay = $('overlay');
    $('overlay-content').innerHTML = html +
      '<p class="tap">Tippen zum Schliessen</p>' +
      `<div class="timer" style="animation-duration:${OVERLAY_MS}ms"></div>`;
    overlay.classList.remove('hidden');
    let done = false;
    const close = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      overlay.removeEventListener('click', close);
      overlay.classList.add('hidden');
      resolve();
    };
    const timer = setTimeout(close, OVERLAY_MS);
    overlay.addEventListener('click', close);
  });
}

// ---------- Socket ----------

socket.on('connect', () => {
  $('conn-banner').classList.add('hidden');
  if (!token()) {
    if (!state) show('screen-start');
    return;
  }
  socket.emit('rejoin', { token: token() }, (res) => {
    if (!res.ok) {
      store.del('ftn_token');
      state = null;
      show('screen-start');
    }
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
  if (st.screen === 'lobby') {
    shownEventId = 0;
    eventsSynced = true;
    wasMyTurn = false;
    renderLobby(st);
    return;
  }
  // Neues Spiel ("Nochmal spielen"): Event-Zähler beginnt wieder bei 1
  if (prev && prev.phase === 'gameOver' && st.phase !== 'gameOver') shownEventId = 0;
  queueEvents(st);
  renderGame(st);
  const mine = isMyTurn(st);
  if (mine && !wasMyTurn) buzz();
  wasMyTurn = mine;
});

socket.on('disconnect', () => {
  if (state) $('conn-banner').classList.remove('hidden');
});

socket.on('roomClosed', () => {
  store.del('ftn_token');
  state = null;
  show('screen-start');
  toast('Der Host hat den Raum geschlossen.', 'info');
});
