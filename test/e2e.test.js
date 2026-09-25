'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');
const { createApp } = require('../server/index');

function emitAsync(socket, event, data) {
  return new Promise((resolve) => socket.emit(event, data, resolve));
}

/**
 * Bot-Client: reagiert auf jeden State mit der jeweils ersten legalen Aktion.
 * Dedupliziert über Signaturen, damit wiederholte Broadcasts desselben
 * Zustands keine Doppel-Aktionen auslösen.
 */
function createBot(socket, getToken, onGameOver) {
  const acted = new Set();
  const seen = { phases: [], roundCards: new Map() };

  socket.on('state', (st) => {
    if (st.screen !== 'game') return;
    if (st.phase === 'gameOver') {
      onGameOver(st);
      return;
    }
    seen.roundCards.set(st.roundNumber, st.cardsThisRound);
    const token = getToken();
    if (st.phase === 'bidding' && st.currentBidderId === st.youId && st.allowedBids) {
      const key = `bid:${st.roundNumber}`;
      if (acted.has(key)) return;
      acted.add(key);
      socket.emit('bid', { token, value: st.allowedBids[0] }, () => {});
    } else if (st.phase === 'playing' && st.currentPlayerId === st.youId && st.hand.length && st.hand[0].id) {
      const key = `play:${st.roundNumber}:${st.hand.length}`;
      if (acted.has(key)) return;
      acted.add(key);
      socket.emit('playCard', { token, cardId: st.hand[0].id }, () => {});
    } else if (st.phase === 'duel' && st.duel && st.duel.needsYourPick) {
      const key = `duel:${st.roundNumber}:${st.hand.length}`;
      if (acted.has(key)) return;
      acted.add(key);
      socket.emit('duelPick', { token, cardId: st.hand[0].id }, () => {});
    } else if (st.phase === 'roundEnd' && st.isHost) {
      const key = `next:${st.roundNumber}`;
      if (acted.has(key)) return;
      acted.add(key);
      socket.emit('nextRound', { token }, () => {});
    }
  });

  return seen;
}

test('E2E: 3 Clients spielen ein komplettes Spiel über den Server', async () => {
  const { httpServer, io } = createApp();
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const url = `http://localhost:${port}`;

  const sockets = [ioClient(url), ioClient(url), ioClient(url)];
  try {
    const tokens = [null, null, null];
    const finals = sockets.map(() => null);
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const maybeDone = () => { if (finals.every(Boolean)) resolveDone(); };

    const seens = sockets.map((s, i) =>
      createBot(s, () => tokens[i], (st) => { finals[i] = st; maybeDone(); }));

    // Raum erstellen + beitreten
    const created = await emitAsync(sockets[0], 'createRoom', { name: 'Anna' });
    assert.ok(created.ok, created.error);
    tokens[0] = created.token;

    const join1 = await emitAsync(sockets[1], 'joinRoom', { name: 'Beni', code: created.code });
    assert.ok(join1.ok, join1.error);
    tokens[1] = join1.token;

    // Falscher Code wird abgewiesen
    const bad = await emitAsync(sockets[2], 'joinRoom', { name: 'Cleo', code: 'XXXX' });
    assert.equal(bad.ok, false);

    const join2 = await emitAsync(sockets[2], 'joinRoom', { name: 'Cleo', code: created.code });
    assert.ok(join2.ok, join2.error);
    tokens[2] = join2.token;

    // Nur der Host darf starten
    const notHost = await emitAsync(sockets[1], 'startGame', { token: tokens[1] });
    assert.equal(notHost.ok, false);

    const started = await emitAsync(sockets[0], 'startGame', { token: tokens[0] });
    assert.ok(started.ok, started.error);

    // Bots spielen das Spiel komplett durch
    await done;

    // Alle sehen denselben Endstand mit 3 Spielern
    for (const st of finals) {
      assert.equal(st.phase, 'gameOver');
      assert.equal(st.ranking.length, 3);
      assert.ok(st.ranking[0].score >= st.ranking[2].score);
    }
    // Rundenplan wurde durchlaufen: 10 Runden, 5-4-3-2-1-1-2-3-4-5
    const cards = Array.from({ length: 10 }, (_, i) => seens[0].roundCards.get(i + 1));
    assert.deepEqual(cards, [5, 4, 3, 2, 1, 1, 2, 3, 4, 5]);
  } finally {
    for (const s of sockets) s.close();
    io.close();
    httpServer.close();
  }
});

test('E2E: Reconnect mit Token stellt die Sitzung wieder her', async () => {
  const { httpServer, io } = createApp();
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const port = httpServer.address().port;
  const url = `http://localhost:${port}`;

  const s1 = ioClient(url);
  let s2 = ioClient(url);
  const s3 = ioClient(url);
  const extra = [];
  try {
    const created = await emitAsync(s1, 'createRoom', { name: 'Anna' });
    const join1 = await emitAsync(s2, 'joinRoom', { name: 'Beni', code: created.code });
    await emitAsync(s3, 'joinRoom', { name: 'Cleo', code: created.code });
    await emitAsync(s1, 'startGame', { token: created.token });

    // Beni verliert die Verbindung (Bildschirmsperre) und kommt zurück
    s2.close();
    const s2b = ioClient(url);
    extra.push(s2b);
    const statePromise = new Promise((resolve) => s2b.once('state', resolve));
    const rejoined = await emitAsync(s2b, 'rejoin', { token: join1.token });
    assert.ok(rejoined.ok, rejoined.error);
    assert.equal(rejoined.code, created.code);

    // Er bekommt sofort den vollen Spielzustand seiner Sitzung
    const st = await statePromise;
    assert.equal(st.screen, 'game');
    assert.equal(st.phase, 'bidding');
    const me = st.players.find((p) => p.id === st.youId);
    assert.equal(me.name, 'Beni');

    // Ungültiges Token wird abgewiesen
    const sBad = ioClient(url);
    extra.push(sBad);
    const badRejoin = await emitAsync(sBad, 'rejoin', { token: 'gibtsnicht' });
    assert.equal(badRejoin.ok, false);
  } finally {
    for (const s of [s1, s3, ...extra]) s.close();
    io.close();
    httpServer.close();
  }
});

async function startServer(opts) {
  const ctx = createApp(opts);
  await new Promise((resolve) => ctx.httpServer.listen(0, resolve));
  ctx.url = `http://localhost:${ctx.httpServer.address().port}`;
  ctx.sockets = [];
  ctx.connect = () => {
    const s = ioClient(ctx.url);
    ctx.sockets.push(s);
    return s;
  };
  ctx.stop = () => {
    for (const s of ctx.sockets) s.close();
    ctx.io.close();
    ctx.httpServer.close();
  };
  return ctx;
}

const nextState = (socket, pred = () => true) => new Promise((resolve) => {
  const h = (st) => { if (pred(st)) { socket.off('state', h); resolve(st); } };
  socket.on('state', h);
});

test('E2E: Spieler-IDs bleiben eindeutig, auch wenn jemand die Lobby verlässt', async () => {
  const ctx = await startServer();
  try {
    const [a, b, c, d] = [ctx.connect(), ctx.connect(), ctx.connect(), ctx.connect()];
    const created = await emitAsync(a, 'createRoom', { name: 'Anna' });
    const jb = await emitAsync(b, 'joinRoom', { name: 'Beni', code: created.code });
    await emitAsync(c, 'joinRoom', { name: 'Cleo', code: created.code });
    await emitAsync(b, 'leaveRoom', { token: jb.token });
    await emitAsync(d, 'joinRoom', { name: 'Dani', code: created.code });
    // Doppelter Name wird abgewiesen
    const dup = await emitAsync(ctx.connect(), 'joinRoom', { name: 'anna', code: created.code });
    assert.equal(dup.ok, false);

    const statePromise = nextState(a, (st) => st.screen === 'game');
    await emitAsync(a, 'startGame', { token: created.token });
    const st = await statePromise;
    const ids = st.players.map((p) => p.id);
    assert.equal(new Set(ids).size, 3);
    assert.deepEqual(st.players.map((p) => p.name).sort(), ['Anna', 'Cleo', 'Dani']);
  } finally { ctx.stop(); }
});

test('E2E: Lobby hält den Platz während der Schonfrist frei', async () => {
  const ctx = await startServer({ lobbyGraceMs: 150 });
  try {
    const a = ctx.connect();
    const created = await emitAsync(a, 'createRoom', { name: 'Anna' });
    const b = ctx.connect();
    const jb = await emitAsync(b, 'joinRoom', { name: 'Beni', code: created.code });
    const c = ctx.connect();
    await emitAsync(c, 'joinRoom', { name: 'Cleo', code: created.code });

    // Beni kurz weg und innerhalb der Frist zurück -> bleibt im Raum
    b.close();
    await new Promise((r) => setTimeout(r, 50));
    const b2 = ctx.connect();
    assert.ok((await emitAsync(b2, 'rejoin', { token: jb.token })).ok);
    await new Promise((r) => setTimeout(r, 200));
    const room = ctx.rooms.get(created.code);
    assert.equal(room.players.length, 3);

    // Cleo bleibt weg -> wird nach der Frist entfernt
    c.close();
    await new Promise((r) => setTimeout(r, 250));
    assert.deepEqual(room.players.map((p) => p.name), ['Anna', 'Beni']);
  } finally { ctx.stop(); }
});

test('E2E: Ist der Host offline, darf ein anderer Spieler weiterschalten', async () => {
  const ctx = await startServer();
  try {
    const a = ctx.connect();
    const created = await emitAsync(a, 'createRoom', { name: 'Anna' });
    const b = ctx.connect();
    const jb = await emitAsync(b, 'joinRoom', { name: 'Beni', code: created.code });
    const c = ctx.connect();
    await emitAsync(c, 'joinRoom', { name: 'Cleo', code: created.code });
    await emitAsync(a, 'startGame', { token: created.token });

    // Beni ist (noch) nicht Host
    assert.equal((await emitAsync(b, 'nextRound', { token: jb.token })).error, 'Nur der Host kann weiterschalten.');

    const promoted = nextState(b, (st) => st.isHost);
    a.close();
    const st = await promoted;
    assert.equal(st.players.find((p) => p.name === 'Beni').isHost, true);
    // Während des Spiels darf niemand einfach den Raum verlassen
    assert.equal((await emitAsync(b, 'leaveRoom', { token: jb.token })).ok, false);
  } finally { ctx.stop(); }
});
