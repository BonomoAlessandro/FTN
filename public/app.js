'use strict';

/* global io */

const socket = io();
const $ = (id) => document.getElementById(id);

const SUIT_INFO = {
  rosen: { symbol: '✿', color: '#c0392b' },
  schellen: { symbol: '🔔', color: '#b8860b' },
  eicheln: { symbol: '🌰', color: '#1e7a3c' },
  schilten: { symbol: '🛡', color: '#2c5aa0' },
};
const RANK_NAMES = {
  6: '6', 7: '7', 8: '8', 9: '9',
  10: 'Banner', 11: 'Under', 12: 'Ober', 13: 'König', 14: 'Ass',
};
const RANK_SHORT = { 6: '6', 7: '7', 8: '8', 9: '9', 10: 'B', 11: 'U', 12: 'O', 13: 'K', 14: 'A' };

let state = null;
let selectedCardId = null;
let shownEventId = 0;
let overlayQueue = Promise.resolve();

// ---------- Hilfsfunktionen ----------

function token() { return localStorage.getItem('ftn_token'); }

function send(event, data = {}) {
  socket.emit(event, { token: token(), ...data }, (res) => {
    if (res && !res.ok) toast(res.error || 'Fehler');
  });
}

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2500);
}

function show(screenId) {
  for (const s of document.querySelectorAll('.screen')) s.classList.add('hidden');
  $(screenId).classList.remove('hidden');
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function nameOf(pid) {
  const p = state && state.players.find((q) => q.id === pid);
  return p ? p.name : '?';
}

function cardEl(card, opts = {}) {
  const el = document.createElement('div');
  el.className = 'card' + (opts.big ? ' big' : '') + (opts.winner ? ' winner' : '');
  if (!card || card.hidden) {
    el.classList.add('back');
    return el;
  }
  const suit = SUIT_INFO[card.suit] || { symbol: '?', color: '#222' };
  el.style.color = suit.color;
  el.innerHTML =
    `<div class="rank">${RANK_SHORT[card.rank]}</div>` +
    `<div class="suit">${suit.symbol}</div>` +
    `<div class="rank-name">${RANK_NAMES[card.rank]}</div>`;
  return el;
}

function cardHtml(card, opts = {}) {
  return cardEl(card, opts).outerHTML;
}

// ---------- Start & Lobby ----------

$('input-name').value = localStorage.getItem('ftn_name') || '';

$('btn-create').addEventListener('click', () => {
  const name = $('input-name').value.trim();
  if (!name) return toast('Bitte gib einen Namen ein.');
  localStorage.setItem('ftn_name', name);
  socket.emit('createRoom', { name }, (res) => {
    if (!res.ok) return toast(res.error);
    localStorage.setItem('ftn_token', res.token);
  });
});

$('btn-join').addEventListener('click', () => {
  const name = $('input-name').value.trim();
  const code = $('input-code').value.trim().toUpperCase();
  if (!name) return toast('Bitte gib einen Namen ein.');
  if (code.length !== 4) return toast('Der Code hat 4 Zeichen.');
  localStorage.setItem('ftn_name', name);
  socket.emit('joinRoom', { name, code }, (res) => {
    if (!res.ok) return toast(res.error);
    localStorage.setItem('ftn_token', res.token);
  });
});

$('btn-rules').addEventListener('click', () => $('rules-dialog').showModal());

$('btn-leave').addEventListener('click', () => {
  send('leaveRoom');
  localStorage.removeItem('ftn_token');
  show('screen-start');
});

function closeRoom() {
  if (!confirm('Raum wirklich für alle schliessen? Alle müssen neu beitreten.')) return;
  send('closeRoom');
}

function renderLobby(st) {
  show('screen-lobby');
  $('lobby-code').textContent = st.roomCode;
  $('lobby-players').innerHTML = st.players
    .map((p) =>
      `<li><span><span class="dot${p.connected ? '' : ' off'}"></span>${esc(p.name)}${p.isYou ? ' (du)' : ''}</span>` +
      `${p.isHost ? '<span class="badge">Host</span>' : ''}</li>`)
    .join('');
  const action = $('lobby-action');
  if (st.isHost) {
    const enough = st.players.length >= st.minPlayers;
    action.innerHTML = `<button id="btn-start" class="btn primary" ${enough ? '' : 'disabled'}>Spiel starten</button>` +
      (enough ? '' : `<p class="hint">Mindestens ${st.minPlayers} Spieler nötig (${st.players.length}/${st.minPlayers})</p>`);
    const btn = $('btn-start');
    if (btn) btn.addEventListener('click', () => send('startGame'));
  } else {
    action.innerHTML = '<p class="hint">Warte, bis der Host das Spiel startet …</p>';
  }
}

// ---------- Spiel ----------

function renderGame(st) {
  show('screen-game');
  renderHeader(st);
  renderPlayersBar(st);
  renderTable(st);
  renderStatus(st);
  renderActions(st);
  renderHand(st);
}

function renderHeader(st) {
  const blind = st.blind ? '<span class="blind-badge">🙈 Blindrunde</span>' : '';
  const cards = st.cardsThisRound !== null
    ? `${st.cardsThisRound} Karte${st.cardsThisRound === 1 ? '' : 'n'}`
    : '';
  const closeBtn = st.isHost
    ? '<button id="btn-close-game" class="btn danger small" title="Raum schliessen" aria-label="Raum schliessen">🚪</button>'
    : '';
  $('game-header').innerHTML =
    `<span class="round">Runde ${st.roundNumber}/${st.totalRounds}</span>` +
    `<span>${cards} ${blind}</span>` +
    `<span class="header-right">${closeBtn}<span>Raum ${esc(st.roomCode)}</span></span>`;
  const cb = $('btn-close-game');
  if (cb) cb.addEventListener('click', closeRoom);
}

function renderPlayersBar(st) {
  $('players-bar').innerHTML = st.players.map((p) => {
    const isTurn = p.id === st.currentBidderId || p.id === st.currentPlayerId;
    const bid = p.bid === null ? '–' : p.bid;
    let duelFlag = '';
    if (st.duel) {
      duelFlag = `<span class="duel-flag">${p.duelPicked ? '✅' : (p.duelParticipant ? '⚔️' : '🗑️')}</span>`;
    }
    return `<div class="chip${isTurn ? ' turn' : ''}${p.id === st.youId ? ' you' : ''}">` +
      duelFlag +
      `<div class="name">${p.connected ? '' : '<span class="off-dot">●</span> '}${esc(p.name)}</div>` +
      `<div class="meta">Ansage ${bid} · Stiche ${p.tricksWon}</div>` +
      `<div class="score">${p.score} Pkt.</div>` +
      `</div>`;
  }).join('');
}

function renderTable(st) {
  const area = $('table-area');

  if (st.phase === 'roundEnd' && st.roundResults) {
    area.innerHTML = '<h3 style="margin:0">Rundenwertung</h3>' + resultTableHtml(st.roundResults);
    return;
  }
  if (st.phase === 'gameOver' && st.ranking) {
    area.innerHTML = '<h3 style="margin:0">🏆 Endstand</h3>' +
      `<table class="result-table"><tr><th></th><th>Spieler</th><th>Punkte</th></tr>` +
      st.ranking.map((r, i) =>
        `<tr><td class="pos">${i + 1}.</td><td>${esc(r.name)}${i === 0 ? ' 🏆' : ''}</td><td>${r.score}</td></tr>`).join('') +
      '</table>';
    return;
  }

  // Blindrunde während der Ansage: Karten der anderen gross anzeigen
  if (st.blind && st.phase === 'bidding') {
    const opps = st.players.filter((p) => p.id !== st.youId);
    area.innerHTML = '<p class="hint">Du siehst die Karten der anderen – deine eigene ist verdeckt!</p>' +
      `<div class="blind-grid">` +
      opps.map((p) => `<div class="opp">${cardHtml(p.visibleCard, { big: true })}<span>${esc(p.name)}</span></div>`).join('') +
      `</div>`;
    return;
  }

  if (st.phase === 'duel') {
    const waiting = st.players.filter((p) => !p.duelPicked).map((p) => esc(p.name));
    area.innerHTML = `<h3 style="margin:0">⚔️ Stich-Duell um ${st.stake} Stiche!</h3>` +
      `<p class="hint">Duell: ${st.duel.participants.map((id) => esc(nameOf(id))).join(' vs. ')}<br>` +
      `Alle wählen verdeckt eine Karte.</p>` +
      (waiting.length ? `<p class="hint">Warte auf: ${waiting.join(', ')}</p>` : '');
    return;
  }

  // Normale Spielphase: gespielte Karten des aktuellen Stichs
  const cards = st.table.map((t) =>
    `<div class="played">${cardHtml(t.card)}<span>${esc(nameOf(t.playerId))}</span></div>`).join('');
  area.innerHTML = `<div class="table-cards">${cards || '<p class="hint">Noch keine Karte gespielt.</p>'}</div>`;
}

function resultTableHtml(results) {
  return `<table class="result-table">` +
    `<tr><th>Spieler</th><th>Ansage</th><th>Stiche</th><th>Punkte</th><th>Total</th></tr>` +
    results.map((r) =>
      `<tr><td>${esc(nameOf(r.playerId))}</td><td>${r.bid}</td><td>${r.won}</td>` +
      `<td class="${r.points >= 0 ? 'plus' : 'minus'}">${r.points >= 0 ? '+' : ''}${r.points}</td>` +
      `<td><b>${r.total}</b></td></tr>`).join('') +
    `</table>`;
}

function renderStatus(st) {
  const you = st.youId;
  let msg = '';
  if (st.phase === 'bidding') {
    msg = st.currentBidderId === you
      ? 'Wie viele Stiche machst du?'
      : `${esc(nameOf(st.currentBidderId))} sagt an …`;
  } else if (st.phase === 'playing') {
    msg = st.currentPlayerId === you
      ? 'Du bist dran – spiele eine Karte!'
      : `${esc(nameOf(st.currentPlayerId))} spielt …`;
  } else if (st.phase === 'duel') {
    if (st.duel.needsYourPick) {
      msg = st.duel.youParticipate
        ? '⚔️ Wähle verdeckt deine Duell-Karte!'
        : '🗑️ Wähle eine Karte zum Abwerfen.';
    } else {
      msg = 'Warte auf die anderen …';
    }
  } else if (st.phase === 'roundEnd') {
    msg = st.roundNumber < st.totalRounds ? 'Runde beendet.' : 'Letzte Runde beendet!';
  } else if (st.phase === 'gameOver') {
    msg = `🎉 ${esc(state.ranking[0].name)} gewinnt!`;
  }
  $('status').innerHTML = msg;
}

function renderActions(st) {
  const area = $('action-area');
  area.innerHTML = '';

  if (st.phase === 'bidding' && st.allowedBids) {
    const c = st.cardsThisRound;
    let buttons = '';
    for (let v = 0; v <= c; v++) {
      const allowed = st.allowedBids.includes(v);
      buttons += `<button class="bid-btn" data-bid="${v}" ${allowed ? '' : 'disabled'}>${v}</button>`;
    }
    let note = '';
    const forbidden = [];
    for (let v = 0; v <= c; v++) {
      if (st.allowedBids.includes(v)) continue;
      if (v === st.blockedBid) forbidden.push(`${v} gesperrt (2× nacheinander angesagt)`);
      else forbidden.push(`${v} verboten (Summe darf nicht aufgehen)`);
    }
    if (forbidden.length) note = `<div class="bid-note">${forbidden.join(' · ')}</div>`;
    area.innerHTML = `<div class="bid-buttons">${buttons}</div>${note}`;
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
    $('btn-confirm').addEventListener('click', () => {
      const cardId = selectedCardId;
      selectedCardId = null;
      send(st.phase === 'duel' ? 'duelPick' : 'playCard', { cardId });
    });
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

  if (st.phase === 'gameOver' && st.isHost) {
    area.innerHTML = '<button id="btn-restart" class="btn primary">Nochmal spielen</button>';
    $('btn-restart').addEventListener('click', () => send('restartGame'));
  }
}

function canPickCard(st) {
  if (st.phase === 'playing') return st.currentPlayerId === st.youId;
  if (st.phase === 'duel') return st.duel && st.duel.needsYourPick;
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
  if (st.blind && st.phase === 'bidding') label = 'Deine Karte (verdeckt – nur die anderen sehen sie)';
  else if (pickable && st.phase === 'duel') label = st.duel.youParticipate ? 'Wähle deine Duell-Karte' : 'Wähle eine Abwurf-Karte';

  area.innerHTML = `<div class="hand-label">${label}</div><div class="hand-cards"></div>`;
  const wrap = area.querySelector('.hand-cards');
  const sorted = st.hand.slice().sort((a, b) => (a.rank || 0) - (b.rank || 0));
  for (const card of sorted) {
    const el = cardEl(card);
    if (card.id && pickable) {
      el.classList.add('playable');
      if (card.id === selectedCardId) el.classList.add('selected');
      el.addEventListener('click', () => {
        selectedCardId = selectedCardId === card.id ? null : card.id;
        renderActions(st);
        renderHand(st);
      });
    }
    wrap.appendChild(el);
  }
}

// ---------- Ereignis-Overlays ----------

function queueEvents(st) {
  const events = [
    st.lastTrick && { ...st.lastTrick, type: 'trick' },
    st.lastDuel && { ...st.lastDuel, type: 'duel' },
    st.lastDraw && { ...st.lastDraw, type: 'draw' },
  ].filter((e) => e && e.eventId > shownEventId)
    .sort((a, b) => a.eventId - b.eventId);

  for (const e of events) {
    shownEventId = e.eventId;
    overlayQueue = overlayQueue.then(() => showEventOverlay(e));
  }
}

function showEventOverlay(e) {
  return new Promise((resolve) => {
    let html = '';
    if (e.type === 'trick') {
      const tie = e.winnerIds.length > 1;
      html = `<h3>${tie ? '⚔️ Gleichstand – Stich-Duell!' : `${esc(nameOf(e.winnerIds[0]))} gewinnt den Stich`}</h3>` +
        `<div class="table-cards">` +
        e.cards.map((t) =>
          `<div class="played">${cardHtml(t.card, { winner: e.winnerIds.includes(t.playerId) })}<span>${esc(nameOf(t.playerId))}</span></div>`).join('') +
        `</div>` +
        (tie ? `<p class="hint">${e.winnerIds.map((id) => esc(nameOf(id))).join(' & ')} duellieren sich!</p>` : '');
    } else if (e.type === 'duel') {
      const tie = e.winnerIds.length > 1;
      html = `<h3>${tie ? '⚔️ Schon wieder Gleichstand!' : `⚔️ ${esc(nameOf(e.winnerIds[0]))} gewinnt ${e.stake} Stiche!`}</h3>` +
        `<div class="table-cards">` +
        e.reveals.map((r) =>
          `<div class="played">${cardHtml(r.card, { winner: e.winnerIds.includes(r.playerId) })}` +
          `<span>${esc(nameOf(r.playerId))}${r.participant ? '' : ' 🗑️'}</span></div>`).join('') +
        `</div>` +
        `<p class="hint">🗑️ = abgeworfen (zählt nicht)</p>`;
    } else if (e.type === 'draw') {
      html = `<h3>🎴 Zufallskarten entscheiden: ${esc(nameOf(e.winnerId))} gewinnt!</h3>` +
        e.rounds.map((round, i) =>
          `<p class="hint">Ziehung ${i + 1}</p><div class="table-cards">` +
          round.map((d) =>
            `<div class="played">${cardHtml(d.card)}<span>${esc(nameOf(d.playerId))}</span></div>`).join('') +
          `</div>`).join('');
    }
    $('overlay-content').innerHTML = html;
    $('overlay').classList.remove('hidden');
    setTimeout(() => {
      $('overlay').classList.add('hidden');
      resolve();
    }, 2600);
  });
}

// ---------- Socket ----------

socket.on('connect', () => {
  if (token()) {
    socket.emit('rejoin', { token: token() }, (res) => {
      if (!res.ok) {
        localStorage.removeItem('ftn_token');
        show('screen-start');
      }
    });
  }
});

socket.on('state', (st) => {
  const prev = state;
  state = st;
  // Auswahl zurücksetzen, wenn sich die Phase ändert
  if (!prev || prev.phase !== st.phase || prev.screen !== st.screen) selectedCardId = null;
  // Neues Spiel ("Nochmal spielen"): Event-Zähler beginnt wieder bei 1
  if (prev && prev.phase === 'gameOver' && st.phase === 'bidding') shownEventId = 0;
  if (st.screen === 'lobby') {
    shownEventId = 0;
    renderLobby(st);
  } else {
    queueEvents(st);
    renderGame(st);
  }
});

socket.on('disconnect', () => {
  toast('Verbindung unterbrochen – verbinde neu …');
});

socket.on('roomClosed', () => {
  localStorage.removeItem('ftn_token');
  state = null;
  show('screen-start');
  toast('Der Host hat den Raum geschlossen.');
});
