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

test('E2E: 3 Clients spielen ein komplettes Spiel über den Server', { timeout: 20000 }, async () => {
  // Die Bots spielen in Sekundenbruchteilen – viel schneller als Menschen –
  // daher hier ohne Nachrichten-Limit.
  const { httpServer, io } = createApp({ clientIpHeader: '', limits: { eventBurst: Infinity } });
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

test('E2E: Reconnect mit Token stellt die Sitzung wieder her', { timeout: 10000 }, async () => {
  const { httpServer, io } = createApp({ clientIpHeader: '' });
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
  const ctx = createApp({ clientIpHeader: '', ...opts });
  await new Promise((resolve) => ctx.httpServer.listen(0, resolve));
  ctx.url = `http://localhost:${ctx.httpServer.address().port}`;
  ctx.sockets = [];
  ctx.connect = (clientOpts) => {
    const s = ioClient(ctx.url, clientOpts);
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

const connected = (socket) => new Promise((resolve, reject) => {
  if (socket.connected) return resolve();
  socket.once('connect', resolve);
  socket.once('connect_error', reject);
});

const fromIp = (ip) => ({ extraHeaders: { 'x-test-ip': ip } });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('E2E: Spieler-IDs bleiben eindeutig, auch wenn jemand die Lobby verlässt', { timeout: 10000 }, async () => {
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

test('E2E: Lobby hält den Platz während der Schonfrist frei', { timeout: 10000 }, async () => {
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

test('E2E: Ist der Host offline, darf ein anderer Spieler weiterschalten', { timeout: 10000 }, async () => {
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

test('E2E: Ein Socket gehört zu höchstens einem Raum (Doppeltipp)', { timeout: 10000 }, async () => {
  const ctx = await startServer();
  try {
    const a = ctx.connect();
    const created = await emitAsync(a, 'createRoom', { name: 'Anna' });
    assert.ok(created.ok, created.error);
    const again = await emitAsync(a, 'createRoom', { name: 'Anna' });
    assert.equal(again.ok, false);
    assert.equal(ctx.rooms.size, 1);

    const b = ctx.connect();
    await emitAsync(b, 'joinRoom', { name: 'Beni', code: created.code });
    assert.equal((await emitAsync(b, 'joinRoom', { name: 'Beni2', code: created.code })).ok, false);
    const c = ctx.connect();
    await emitAsync(c, 'joinRoom', { name: 'Cleo', code: created.code });
    await emitAsync(a, 'startGame', { token: created.token });

    // Trennt Anna, ist sie offline – und Beni übernimmt die Host-Knöpfe
    const promoted = nextState(b, (st) => st.isHost);
    a.close();
    const st = await promoted;
    assert.equal(st.players.find((p) => p.name === 'Anna').connected, false);
  } finally { ctx.stop(); }
});

test('E2E: Nach Spielende werden Offline-Spieler entfernt bzw. es geht zurück zur Lobby', { timeout: 10000 }, async () => {
  const ctx = await startServer();
  try {
    const [a, b, c, d] = [ctx.connect(), ctx.connect(), ctx.connect(), ctx.connect()];
    const created = await emitAsync(a, 'createRoom', { name: 'Anna' });
    const tok = created.token;
    await emitAsync(b, 'joinRoom', { name: 'Beni', code: created.code });
    await emitAsync(c, 'joinRoom', { name: 'Cleo', code: created.code });
    await emitAsync(d, 'joinRoom', { name: 'Dani', code: created.code });
    await emitAsync(a, 'startGame', { token: tok });
    const room = ctx.rooms.get(created.code);
    room.game._endGame();

    // Dani ist weg: «Nochmal spielen» startet ohne sie
    let offline = nextState(a, (st) => st.players.some((p) => !p.connected));
    d.close();
    await offline;
    const restarted = nextState(a, (st) => st.screen === 'game' && st.phase === 'bidding');
    assert.ok((await emitAsync(a, 'restartGame', { token: tok })).ok);
    assert.deepEqual((await restarted).players.map((p) => p.name), ['Anna', 'Beni', 'Cleo']);

    // Cleo ist auch weg: zu wenige online -> nur noch zurück zur Lobby
    room.game._endGame();
    offline = nextState(a, (st) => st.players.some((p) => !p.connected));
    c.close();
    await offline;
    const tooFew = await emitAsync(a, 'restartGame', { token: tok });
    assert.equal(tooFew.ok, false);
    assert.equal(room.game.phase, 'gameOver');

    const lobby = nextState(a, (st) => st.screen === 'lobby');
    assert.ok((await emitAsync(a, 'backToLobby', { token: tok })).ok);
    await lobby;
    const e = ctx.connect();
    assert.ok((await emitAsync(e, 'joinRoom', { name: 'Emil', code: created.code })).ok);

    // Cleo ist noch in der Schonfrist – der Start lässt sie weg
    const started = nextState(a, (st) => st.screen === 'game');
    assert.ok((await emitAsync(a, 'startGame', { token: tok })).ok);
    assert.deepEqual((await started).players.map((p) => p.name).sort(), ['Anna', 'Beni', 'Emil']);
  } finally { ctx.stop(); }
});

// ---------- Schutz vor Missbrauch (öffentlicher Server) ----------

test('E2E: Durchprobieren von Raum-Codes wird pro IP gebremst', { timeout: 10000 }, async () => {
  const ctx = await startServer({ clientIpHeader: 'x-test-ip', limits: { joinFailuresPerMinute: 3 } });
  try {
    const host = ctx.connect(fromIp('198.51.100.1'));
    const created = await emitAsync(host, 'createRoom', { name: 'Anna' });
    // I, O, 0 kommen in Raum-Codes nie vor – diese Codes gibt es sicher nicht
    const attacker = ctx.connect(fromIp('203.0.113.7'));
    for (const code of ['IIII', 'OOOO', '0000']) {
      assert.equal((await emitAsync(attacker, 'joinRoom', { name: 'Mallory', code })).error, 'Diesen Raum gibt es nicht.');
    }
    // Jetzt ist die IP gesperrt – auch mit neuer Verbindung und richtigem Code
    const again = ctx.connect(fromIp('203.0.113.7'));
    const blocked = await emitAsync(again, 'joinRoom', { name: 'Mallory', code: created.code });
    assert.match(blocked.error, /Zu viele falsche Raum-Codes/);
    // Andere IPs sind nicht betroffen
    const friend = ctx.connect(fromIp('198.51.100.2'));
    assert.ok((await emitAsync(friend, 'joinRoom', { name: 'Beni', code: created.code })).ok);
  } finally { ctx.stop(); }
});

test('E2E: Ohne verlässliche IP gilt das Limit pro Verbindung statt für alle', { timeout: 10000 }, async () => {
  // Header erwartet, aber nicht gesendet (z. B. Proxy ohne Header): Sonst würden
  // sich alle Spieler hinter dem Proxy ein einziges Limit teilen.
  const ctx = await startServer({ clientIpHeader: 'x-test-ip', limits: { joinFailuresPerMinute: 1 } });
  try {
    const a = ctx.connect();
    assert.equal((await emitAsync(a, 'joinRoom', { name: 'A', code: 'IIII' })).error, 'Diesen Raum gibt es nicht.');
    assert.match((await emitAsync(a, 'joinRoom', { name: 'A', code: 'IIII' })).error, /Zu viele falsche/);
    const b = ctx.connect();
    assert.equal((await emitAsync(b, 'joinRoom', { name: 'B', code: 'IIII' })).error, 'Diesen Raum gibt es nicht.');
  } finally { ctx.stop(); }
});


test('E2E: Gleichzeitige Verbindungen pro IP sind begrenzt', { timeout: 10000 }, async () => {
  const ctx = await startServer({ clientIpHeader: 'x-test-ip', limits: { maxConnectionsPerIp: 2 } });
  try {
    const first = ctx.connect(fromIp('203.0.113.7'));
    await connected(first);
    await connected(ctx.connect(fromIp('203.0.113.7')));
    await assert.rejects(connected(ctx.connect({ ...fromIp('203.0.113.7'), reconnection: false })));
    await connected(ctx.connect(fromIp('198.51.100.2')));

    // Wird eine Verbindung getrennt, ist wieder Platz
    first.close();
    while (ctx.io.engine.clientsCount > 2) await sleep(10);
    await connected(ctx.connect(fromIp('203.0.113.7')));
  } finally { ctx.stop(); }
});

test('E2E: Abgebrochene Verbindungen geben ihren Platz wieder frei', { timeout: 10000 }, async () => {
  const ctx = await startServer({ clientIpHeader: 'x-test-ip', limits: { maxConnectionsPerIp: 2 } });
  try {
    const base = `${ctx.url}/socket.io/?EIO=4&transport=polling`;
    for (let i = 0; i < 3; i++) {
      // Handshake, dann im selben Paket Namespace-CONNECT und sofortiges Schliessen –
      // die Verbindung endet, bevor ein Socket entsteht.
      const open = await (await fetch(base, { headers: { 'x-test-ip': '203.0.113.7' } })).text();
      const { sid } = JSON.parse(open.slice(1));
      await fetch(`${base}&sid=${sid}`, { method: 'POST', body: '40\x1e1' });
    }
    while (ctx.io.engine.clientsCount > 0) await sleep(10);
    await connected(ctx.connect({ ...fromIp('203.0.113.7'), reconnection: false }));
  } finally { ctx.stop(); }
});

test('E2E: Räume sind insgesamt und pro IP begrenzt', { timeout: 10000 }, async () => {
  const ctx = await startServer({ limits: { maxRooms: 3, roomsPerIpPer10Min: 2 } });
  try {
    assert.ok((await emitAsync(ctx.connect(), 'createRoom', { name: 'A' })).ok);
    assert.ok((await emitAsync(ctx.connect(), 'createRoom', { name: 'B' })).ok);
    assert.match((await emitAsync(ctx.connect(), 'createRoom', { name: 'C' })).error, /Zu viele neue Räume/);
    assert.equal(ctx.rooms.size, 2);
  } finally { ctx.stop(); }

  const full = await startServer({ limits: { maxRooms: 1 } });
  try {
    assert.ok((await emitAsync(full.connect(), 'createRoom', { name: 'A' })).ok);
    assert.match((await emitAsync(full.connect(), 'createRoom', { name: 'B' })).error, /alle Räume belegt/);
  } finally { full.stop(); }
});

test('E2E: Nachrichten-Flut wird gebremst, zu grosse Nachrichten trennen', { timeout: 10000 }, async () => {
  const ctx = await startServer({ limits: { eventBurst: 5, eventsPerSecond: 0, maxMessageBytes: 1000 } });
  try {
    const s = ctx.connect();
    const results = await Promise.all(Array.from({ length: 10 }, () => emitAsync(s, 'rejoin', { token: 'x' })));
    assert.equal(results.filter((r) => /Zu viele Anfragen/.test(r.error)).length, 5);

    const big = ctx.connect({ transports: ['websocket'], reconnection: false });
    await connected(big);
    const gone = new Promise((resolve) => big.once('disconnect', resolve));
    big.emit('createRoom', { name: 'x'.repeat(5000) });
    await gone;
    assert.equal(ctx.rooms.size, 0);
  } finally { ctx.stop(); }
});

test('E2E: Kaputte und fremde Eingaben werden sauber abgewiesen', { timeout: 10000 }, async () => {
  const ctx = await startServer({ limits: { eventBurst: Infinity } });
  const expectClean = (res, what) => {
    assert.equal(typeof res.ok, 'boolean', what);
    // Jede schlechte Eingabe wird erkannt – keine unerwartete Ausnahme
    assert.notEqual(res.error, 'Unbekannter Fehler.', what);
  };
  try {
    // Ohne Raum: Erstellen/Beitreten mit Namen und Codes, die keine Strings sind
    const fresh = ctx.connect();
    for (const p of [undefined, null, 42, 'text', [], { name: { toString: 1 } }, { name: ['Anna'] }, { name: 42 }]) {
      for (const ev of ['createRoom', 'joinRoom']) {
        const res = await emitAsync(fresh, ev, p);
        expectClean(res, `${ev} ${JSON.stringify(p)}`);
        assert.equal(res.ok, false);
      }
    }
    for (const code of [{ toString: 1 }, 42, ['ABCD']]) {
      expectClean(await emitAsync(fresh, 'joinRoom', { name: 'Ok', code }), `joinRoom code ${JSON.stringify(code)}`);
    }

    // Im laufenden Spiel: alle Aktionen mit kaputten oder fremden Daten
    const host = ctx.connect();
    const created = await emitAsync(host, 'createRoom', { name: 'Anna' });
    await emitAsync(ctx.connect(), 'joinRoom', { name: 'Beni', code: created.code });
    const m = ctx.connect();
    const mallory = await emitAsync(m, 'joinRoom', { name: 'Mallory', code: created.code });
    await emitAsync(host, 'startGame', { token: created.token });

    const tok = mallory.token;
    const payloads = [undefined, null, 42, 'text', [], [1, 2], { token: 123 }, { token: {} },
      { token: tok, value: '1' }, { token: tok, value: 1e9 }, { token: tok, cardId: { x: 1 } }, { token: tok, cardId: 'rosen-99' }];
    const events = ['createRoom', 'joinRoom', 'leaveRoom', 'closeRoom', 'startGame', 'bid', 'playCard',
      'duelPick', 'nextRound', 'restartGame', 'backToLobby', 'renamePlayer'];
    for (const ev of events) {
      for (const p of payloads) expectClean(await emitAsync(m, ev, p), `${ev} ${JSON.stringify(p)}`);
    }
    // Das Spiel läuft unverändert weiter
    const room = ctx.rooms.get(created.code);
    assert.equal(room.players.length, 3);
    assert.equal(room.game.phase, 'bidding');
  } finally { ctx.stop(); }
});

test('E2E: Gleich aussehende Namen gelten als doppelt', { timeout: 10000 }, async () => {
  const ctx = await startServer();
  try {
    const created = await emitAsync(ctx.connect(), 'createRoom', { name: 'Anna' });
    for (const name of ['ANNA', 'Anna\u034F', 'Ánna']) {
      const res = await emitAsync(ctx.connect(), 'joinRoom', { name, code: created.code });
      assert.equal(res.error, 'Dieser Name ist im Raum schon vergeben.', name);
    }
  } finally { ctx.stop(); }
});

test('E2E: Nur Alessandro kann im Spiel die Namen der anderen ändern', { timeout: 10000 }, async () => {
  const ctx = await startServer();
  try {
    const a = ctx.connect();
    const created = await emitAsync(a, 'createRoom', { name: 'Anna' });
    const b = ctx.connect();
    const jb = await emitAsync(b, 'joinRoom', { name: 'alessandro', code: created.code });
    const c = ctx.connect();
    const jc = await emitAsync(c, 'joinRoom', { name: 'Cleo', code: created.code });
    const room = ctx.rooms.get(created.code);
    const [anna, ale, cleo] = room.players;
    const rename = (playerId, name) => emitAsync(b, 'renamePlayer', { token: jb.token, playerId, name });

    assert.equal((await rename(anna.pid, 'Anni')).error, 'Das Spiel hat noch nicht begonnen.');

    const started = nextState(b, (st) => st.screen === 'game');
    const othersView = nextState(c, (st) => st.screen === 'game');
    await emitAsync(a, 'startGame', { token: created.token });
    // Die Schreibweise zählt nicht – «alessandro» genügt
    assert.equal((await started).canRename, true);
    assert.equal((await othersView).canRename, false);

    // Weder Mitspieler noch Host dürfen umbenennen
    assert.equal((await emitAsync(c, 'renamePlayer', { token: jc.token, playerId: anna.pid, name: 'Anni' })).error,
      'Nur Alessandro kann Namen ändern.');
    assert.equal((await emitAsync(a, 'renamePlayer', { token: created.token, playerId: cleo.pid, name: 'Cle' })).error,
      'Nur Alessandro kann Namen ändern.');

    assert.equal((await rename(ale.pid, 'Ale')).error, 'Deinen eigenen Namen kannst du nicht ändern.');
    assert.equal((await rename('p99', 'Anni')).error, 'Diesen Spieler gibt es nicht.');
    assert.equal((await rename(anna.pid, '\u200B')).error, 'Bitte gib einen Namen ein.');
    assert.equal((await rename(anna.pid, 'CLEO')).error, 'Dieser Name ist im Raum schon vergeben.');
    // Niemand sonst kann so zu «Alessandro» werden
    assert.equal((await rename(anna.pid, 'Alessandro')).error, 'Dieser Name ist im Raum schon vergeben.');
    // Kaputte Eingaben von Alessandro selbst werden sauber abgewiesen
    for (const bad of [{}, { playerId: {} }, { playerId: [anna.pid] }, { playerId: '__proto__' },
      { playerId: anna.pid, name: 42 }, { playerId: anna.pid, name: { toString: 1 } }, { playerId: anna.pid, name: ['x'] }]) {
      const res = await emitAsync(b, 'renamePlayer', { token: jb.token, ...bad });
      assert.equal(res.ok, false, JSON.stringify(bad));
      assert.notEqual(res.error, 'Unbekannter Fehler.', JSON.stringify(bad));
    }

    // Raum und Spiel führen den neuen Namen, alle sehen ihn sofort
    const seen = nextState(c, (st) => st.players.some((p) => p.name === 'Anni'));
    assert.ok((await rename(anna.pid, ' Anni ')).ok);
    assert.equal(anna.name, 'Anni');
    assert.equal(room.game.players.find((p) => p.id === anna.pid).name, 'Anni');
    await seen;
    // Nur die Schreibweise des eigenen Namens ändern geht
    assert.ok((await rename(cleo.pid, 'CLEO')).ok);

    // Nach Spielende: Wer gegangen ist, steht noch in der Rangliste – sein Name bleibt
    // belegt und lässt sich weiterhin ändern
    room.game._endGame();
    assert.ok((await emitAsync(c, 'leaveRoom', { token: jc.token })).ok);
    assert.equal((await rename(anna.pid, 'cleo')).error, 'Dieser Name ist im Raum schon vergeben.');
    assert.ok((await rename(cleo.pid, 'Cleopatra')).ok);
    assert.ok((await rename(anna.pid, 'Annina')).ok);
    assert.equal(anna.name, 'Annina');
    assert.deepEqual(room.game.ranking.map((r) => r.name).sort(), ['Annina', 'Cleopatra', 'alessandro']);
  } finally { ctx.stop(); }
});

// ---------- Sitzungen und Sockets ----------

test('E2E: Trennt der alte Socket nach einem Rejoin, bleibt der Spieler online', { timeout: 10000 }, async () => {
  const ctx = await startServer();
  try {
    const a = ctx.connect();
    const created = await emitAsync(a, 'createRoom', { name: 'Anna' });
    const a2 = ctx.connect();
    assert.ok((await emitAsync(a2, 'rejoin', { token: created.token })).ok);
    a.close();
    while (ctx.io.of('/').sockets.size > 1) await sleep(10);
    const anna = ctx.rooms.get(created.code).players[0];
    assert.equal(anna.connected, true);
    assert.equal(anna.socketId, a2.id);
  } finally { ctx.stop(); }
});

test('E2E: Rejoin auf einem Socket, der schon einen anderen Spieler steuert', { timeout: 10000 }, async () => {
  const ctx = await startServer();
  try {
    const created = await emitAsync(ctx.connect(), 'createRoom', { name: 'Anna' });
    const jb = await emitAsync(ctx.connect(), 'joinRoom', { name: 'Beni', code: created.code });
    const c = ctx.connect();
    await emitAsync(c, 'joinRoom', { name: 'Cleo', code: created.code });

    // Cleos Socket übernimmt Benis Sitzung: Cleo gilt als getrennt, Beni hängt an diesem Socket
    assert.ok((await emitAsync(c, 'rejoin', { token: jb.token })).ok);
    const players = ctx.rooms.get(created.code).players;
    const beni = players.find((p) => p.name === 'Beni');
    const cleo = players.find((p) => p.name === 'Cleo');
    assert.equal(beni.socketId, c.id);
    assert.equal(cleo.connected, false);
    assert.equal(cleo.socketId, null);
  } finally { ctx.stop(); }
});

test('E2E: Ist der Host beim Neustart offline, wird sein Vertreter neuer Host', { timeout: 10000 }, async () => {
  const ctx = await startServer();
  try {
    const a = ctx.connect();
    const created = await emitAsync(a, 'createRoom', { name: 'Anna' });
    const b = ctx.connect();
    const jb = await emitAsync(b, 'joinRoom', { name: 'Beni', code: created.code });
    await emitAsync(ctx.connect(), 'joinRoom', { name: 'Cleo', code: created.code });
    await emitAsync(ctx.connect(), 'joinRoom', { name: 'Dani', code: created.code });
    await emitAsync(a, 'startGame', { token: created.token });
    const room = ctx.rooms.get(created.code);
    room.game._endGame();

    const promoted = nextState(b, (st) => st.isHost);
    a.close();
    await promoted;
    const restarted = nextState(b, (st) => st.phase === 'bidding');
    assert.ok((await emitAsync(b, 'restartGame', { token: jb.token })).ok);
    const st = await restarted;
    assert.deepEqual(room.players.map((p) => p.name), ['Beni', 'Cleo', 'Dani']);
    assert.equal(room.hostToken, jb.token);
    assert.equal(st.isHost, true);
  } finally { ctx.stop(); }
});
