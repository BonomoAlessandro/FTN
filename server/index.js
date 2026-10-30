'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');
const { Game, GameError } = require('./game');
const { DEFAULT_LIMITS, WindowCounter, tokenBucket, clientIp } = require('./limits');

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 7;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_NAME_CHARS = 16; // sichtbare Zeichen
const MAX_NAME_UNITS = 64; // Obergrenze in UTF-16-Einheiten
const MAX_MARKS = 4; // Akzente pro Zeichen (gegen hoch gestapelte «Zalgo»-Namen)
const EMPTY_ROOM_TTL_MS = 30 * 60 * 1000; // Räume, in denen alle offline sind
const RENAMER_NAME = 'Alessandro'; // Wer so heisst, darf im Spiel die Namen der anderen ändern

const graphemes = new Intl.Segmenter('de', { granularity: 'grapheme' });

// Unsichtbares: Steuer- und Formatzeichen (z. B. Nullbreite, Schreibrichtung umkehren)
// sowie Füllzeichen, die als Buchstaben gelten. Ausgenommen sind der Emoji-Verbinder
// (ZWJ) und Tag-Zeichen – sonst zerfallen Emojis wie Familien oder Regionalflaggen.
const INVISIBLE = /(?![\u200D\u{E0020}-\u{E007F}])[\p{C}\u115F\u1160\u2800\u3164\uFFA0]/gu;
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;

/**
 * Bereinigt einen Spielernamen, damit niemand leere oder irreführende Namen
 * vortäuschen kann. Gekürzt wird nach sichtbaren Zeichen, damit kein Emoji
 * halbiert wird.
 */
function cleanName(name) {
  const n = (typeof name === 'string' ? name : '')
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(/\s+/g, ' ')
    .trim();
  let out = '';
  let count = 0;
  for (const { segment } of graphemes.segment(n)) {
    let marks = 0;
    const capped = segment.replace(/\p{M}/gu, (m) => (++marks <= MAX_MARKS ? m : ''));
    if (count === MAX_NAME_CHARS || out.length + capped.length > MAX_NAME_UNITS) break;
    out += capped;
    count += 1;
  }
  out = out.trim();
  if (!VISIBLE.test(out)) throw new GameError('Bitte gib einen Namen ein.');
  return out;
}

/**
 * Vergleichsform für doppelte Namen: Gross/klein, Akzente und Unsichtbares zählen
 * nicht – «Anna», «ANNA», «Ánna» und «Anna» mit unsichtbarem Zusatz gelten als gleich.
 */
function nameKey(name) {
  // Nur nicht-spacing Zeichen (Akzente) entfernen: Spacing-Marks sind z. B. in
  // indischen Schriften eigenständige Vokalzeichen (Ram und Rama auf Devanagari).
  return name.normalize('NFKD').replace(/[\p{Mn}\p{Me}\p{Default_Ignorable_Code_Point}]/gu, '').toLowerCase();
}

/**
 * @param {object} [opts]
 * @param {number} [opts.lobbyGraceMs] Wie lange ein getrennter Spieler in der Lobby
 *   seinen Platz behält (Bildschirmsperre, App-Wechsel), bevor er entfernt wird.
 * @param {object} [opts.limits] Überschreibt einzelne Werte aus DEFAULT_LIMITS.
 * @param {string} [opts.clientIpHeader] Header mit der echten Client-IP hinter einem
 *   Proxy. Standard: CLIENT_IP_HEADER, auf Render (RENDER=true) cf-connecting-ip,
 *   sonst die Adresse der Verbindung selbst.
 */
function createApp(opts = {}) {
  const lobbyGraceMs = opts.lobbyGraceMs ?? 90 * 1000;
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const ipHeader = (opts.clientIpHeader ?? process.env.CLIENT_IP_HEADER ??
    (process.env.RENDER === 'true' ? 'cf-connecting-ip' : '')).toLowerCase();

  const connectionsPerIp = new Map();
  const roomCreations = new WindowCounter(limits.roomsPerIpPer10Min, 10 * 60 * 1000);
  const joinFailures = new WindowCounter(limits.joinFailuresPerMinute, 60 * 1000);

  let warnedMissingHeader = false;
  function ipOf(req) {
    const ip = clientIp(req.headers, req.socket && req.socket.remoteAddress, ipHeader);
    if (!ip && ipHeader && !warnedMissingHeader) {
      warnedMissingHeader = true;
      console.warn(`Header «${ipHeader}» fehlt – Limits gelten pro Verbindung statt pro IP.`);
    }
    return ip;
  }

  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    maxHttpBufferSize: limits.maxMessageBytes,
    // Gleichzeitige Verbindungen pro IP begrenzen (sonst hält eine IP beliebig viele
    // Sockets und damit Räume offen). Geprüft beim Verbindungsaufbau …
    allowRequest: (req, callback) => {
      const ip = ipOf(req);
      callback(null, !ip || (connectionsPerIp.get(ip) || 0) < limits.maxConnectionsPerIp);
    },
  });
  // … und gezählt auf Ebene der Engine: Dort endet jede Verbindung mit genau einem
  // 'close', auch wenn sie abbricht, bevor ein Socket entsteht.
  io.engine.on('connection', (conn) => {
    const ip = ipOf(conn.request);
    if (!ip) return;
    connectionsPerIp.set(ip, (connectionsPerIp.get(ip) || 0) + 1);
    conn.once('close', () => {
      const left = connectionsPerIp.get(ip) - 1;
      if (left > 0) connectionsPerIp.set(ip, left);
      else connectionsPerIp.delete(ip);
    });
  });

  /**
   * code -> { code, hostToken, nextPid, players: [{token, pid, name, socketId, connected}], game }
   */
  const rooms = new Map();

  function makeCode() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
      if (!rooms.has(code)) return code;
    }
    throw new GameError('Gerade sind keine Räume frei. Bitte später nochmals versuchen.');
  }

  function findByToken(token) {
    if (!token) return null;
    for (const room of rooms.values()) {
      const player = room.players.find((p) => p.token === token);
      if (player) return { room, player };
    }
    return null;
  }

  /**
   * Der eigentliche Host – oder, solange dieser offline ist, der erste verbundene
   * Spieler. So bleibt das Spiel nicht hängen, wenn das Handy des Hosts schläft.
   */
  function hostOf(room) {
    const host = room.players.find((p) => p.token === room.hostToken);
    if (host && host.connected) return host;
    return room.players.find((p) => p.connected) || host;
  }

  function isHost(room, player) {
    return hostOf(room) === player;
  }

  /**
   * Der Spieler, den dieser Socket gerade steuert (höchstens einer). Ungültig, sobald
   * der Raum weg ist, der Spieler entfernt wurde oder ein neuerer Socket übernommen hat.
   */
  function memberOf(socket) {
    const m = socket.data.member;
    if (!m || rooms.get(m.room.code) !== m.room) return null;
    if (!m.room.players.includes(m.player) || m.player.socketId !== socket.id) return null;
    return m;
  }

  function bindSocket(socket, room, player) {
    clearTimeout(player.leaveTimer);
    player.leaveTimer = null;
    player.socketId = socket.id;
    player.connected = true;
    socket.data.member = { room, player };
  }

  /** Wirft, wenn ein anderer Spieler in `players` (ausser `except`) schon gleich heisst. */
  function requireFreeName(players, name, except = null) {
    if (players.some((p) => p !== except && nameKey(p.name) === nameKey(name))) {
      throw new GameError('Dieser Name ist im Raum schon vergeben.');
    }
  }

  /** Das Recht hängt allein am Namen – wer «Alessandro» heisst, darf umbenennen. */
  function canRename(player) {
    return nameKey(player.name) === nameKey(RENAMER_NAME);
  }

  function addPlayer(room, name, socket) {
    requireFreeName(room.players, name);
    const player = {
      token: crypto.randomBytes(16).toString('hex'),
      pid: `p${room.nextPid++}`,
      name,
      socketId: null,
      connected: false,
      leaveTimer: null,
    };
    bindSocket(socket, room, player);
    room.players.push(player);
    return player;
  }

  function removePlayer(room, player) {
    clearTimeout(player.leaveTimer);
    room.players = room.players.filter((p) => p !== player);
    if (room.players.length === 0) {
      rooms.delete(room.code);
      return;
    }
    if (room.hostToken === player.token) room.hostToken = room.players[0].token;
    broadcast(room);
  }

  /**
   * In der Lobby wird ein Getrennter erst nach einer Schonfrist entfernt,
   * damit eine kurze Bildschirmsperre nicht den Platz kostet.
   */
  function scheduleLobbyLeave(room, player) {
    clearTimeout(player.leaveTimer);
    player.leaveTimer = setTimeout(() => {
      player.leaveTimer = null;
      if (rooms.get(room.code) === room && !room.game && !player.connected) {
        removePlayer(room, player);
      }
    }, lobbyGraceMs);
    player.leaveTimer.unref();
  }

  function markOffline(room, player) {
    player.socketId = null;
    player.connected = false;
    if (!room.game) scheduleLobbyLeave(room, player);
    broadcast(room);
  }

  /**
   * Vor einem neuen Spiel: Wer offline ist, würde das Spiel blockieren (alle warten
   * auf seine Ansage) – er wird aus dem Raum entfernt. `actor` ist der aktive Host.
   */
  function dropOffline(room, actor) {
    const online = room.players.filter((p) => p.connected);
    if (online.length < MIN_PLAYERS) {
      throw new GameError(`Es braucht mindestens ${MIN_PLAYERS} Spieler, die online sind.`);
    }
    for (const p of room.players) clearTimeout(p.leaveTimer);
    if (!online.some((p) => p.token === room.hostToken)) room.hostToken = actor.token;
    room.players = online;
  }

  function lobbyPayload(room, viewer) {
    const host = hostOf(room);
    return {
      screen: 'lobby',
      roomCode: room.code,
      isHost: viewer === host,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      players: room.players.map((p) => ({
        name: p.name,
        connected: p.connected,
        isHost: p === host,
        isYou: p === viewer,
      })),
    };
  }

  function gamePayload(room, viewer) {
    const host = hostOf(room);
    const view = room.game.viewFor(viewer.pid);
    view.screen = 'game';
    view.roomCode = room.code;
    view.isHost = viewer === host;
    view.canRename = canRename(viewer);
    view.minPlayers = MIN_PLAYERS;
    for (const pl of view.players) {
      const rp = room.players.find((q) => q.pid === pl.id);
      pl.connected = rp ? rp.connected : false;
      pl.isHost = rp === host;
    }
    return view;
  }

  function broadcast(room) {
    for (const p of room.players) {
      if (!p.socketId) continue;
      io.to(p.socketId).emit('state', room.game ? gamePayload(room, p) : lobbyPayload(room, p));
    }
  }

  function newGame(room) {
    room.game = new Game(
      room.players.map((p) => ({ id: p.pid, name: p.name })),
      { startOffset: room.startOffset },
    );
  }

  io.on('connection', (socket) => {
    // Schlüssel für Limits pro IP; ist die IP unbekannt, gilt das Limit pro Verbindung.
    const limitKey = ipOf(socket.request) || socket.id;

    // Nachrichten-Flut bremsen: Was über dem Limit liegt, wird abgewiesen.
    const allowEvent = tokenBucket(limits.eventBurst, limits.eventsPerSecond);
    socket.use((packet, next) => {
      if (allowEvent()) return next();
      const ack = packet[packet.length - 1];
      if (typeof ack === 'function') ack({ ok: false, error: 'Zu viele Anfragen – bitte kurz warten.' });
    });

    const fail = (ack, err) => {
      const msg = err instanceof GameError ? err.message : 'Unbekannter Fehler.';
      if (!(err instanceof GameError)) console.error(err);
      if (typeof ack === 'function') ack({ ok: false, error: msg });
    };
    const ok = (ack, extra = {}) => {
      if (typeof ack === 'function') ack({ ok: true, ...extra });
    };

    // Ein Socket gehört zu höchstens einem Raum. Sonst würde z. B. ein Doppeltipp
    // auf «Raum erstellen» einen zweiten Raum anlegen, und beim Trennen bliebe der
    // Spieler im ersten Raum für immer «online» (keine Host-Vertretung).
    const requireNoRoom = () => {
      if (memberOf(socket)) throw new GameError('Du bist bereits in einem Raum.');
    };

    socket.on('createRoom', (data, ack) => {
      try {
        requireNoRoom();
        if (rooms.size >= limits.maxRooms) throw new GameError('Gerade sind alle Räume belegt. Bitte später nochmals versuchen.');
        if (roomCreations.isBlocked(limitKey)) throw new GameError('Zu viele neue Räume – bitte später nochmals versuchen.');
        const name = cleanName(data && data.name);
        const room = {
          code: makeCode(),
          hostToken: null,
          nextPid: 1,
          players: [],
          game: null,
          startOffset: 0,
        };
        const player = addPlayer(room, name, socket);
        room.hostToken = player.token;
        rooms.set(room.code, room);
        roomCreations.hit(limitKey);
        ok(ack, { token: player.token, code: room.code });
        broadcast(room);
      } catch (err) { fail(ack, err); }
    });

    socket.on('joinRoom', (data, ack) => {
      try {
        requireNoRoom();
        // Gegen das Durchprobieren von Raum-Codes
        if (joinFailures.isBlocked(limitKey)) throw new GameError('Zu viele falsche Raum-Codes – bitte warte eine Minute.');
        const name = cleanName(data && data.name);
        const code = data && typeof data.code === 'string' ? data.code.trim().toUpperCase() : '';
        const room = rooms.get(code);
        if (!room) {
          joinFailures.hit(limitKey);
          throw new GameError('Diesen Raum gibt es nicht.');
        }
        if (room.game) throw new GameError('Das Spiel hat bereits begonnen.');
        if (room.players.length >= MAX_PLAYERS) throw new GameError(`Der Raum ist voll (max. ${MAX_PLAYERS}).`);
        const player = addPlayer(room, name, socket);
        ok(ack, { token: player.token, code: room.code });
        broadcast(room);
      } catch (err) { fail(ack, err); }
    });

    // Reconnect nach Bildschirmsperre / App-Wechsel / Seiten-Reload
    socket.on('rejoin', (data, ack) => {
      try {
        const found = findByToken(data && data.token);
        // `gone`: Die Sitzung gibt es nicht mehr – nur dann verwirft der Client sein Token
        // (nicht bei vorübergehenden Fehlern wie «Zu viele Anfragen»).
        if (!found) {
          if (typeof ack === 'function') ack({ ok: false, gone: true, error: 'Sitzung nicht gefunden.' });
          return;
        }
        const previous = memberOf(socket);
        if (previous && previous.player !== found.player) markOffline(previous.room, previous.player);
        bindSocket(socket, found.room, found.player);
        ok(ack, { code: found.room.code });
        broadcast(found.room);
      } catch (err) { fail(ack, err); }
    });

    socket.on('leaveRoom', (data, ack) => {
      try {
        const found = findByToken(data && data.token);
        if (!found) return ok(ack);
        // Mitten im Spiel würde ein fehlender Spieler die Runde blockieren.
        const { game } = found.room;
        if (game && game.phase !== 'gameOver') throw new GameError('Das Spiel läuft – nur der Host kann den Raum schliessen.');
        removePlayer(found.room, found.player);
        ok(ack);
      } catch (err) { fail(ack, err); }
    });

    // Host kann den ganzen Raum schliessen (z. B. wenn etwas hängt). Alle landen
    // wieder auf dem Startbildschirm und müssen neu beitreten.
    socket.on('closeRoom', (data, ack) => {
      try {
        const found = findByToken(data && data.token);
        if (!found) throw new GameError('Sitzung nicht gefunden.');
        const { room, player } = found;
        if (!isHost(room, player)) throw new GameError('Nur der Host kann den Raum schliessen.');
        for (const p of room.players) {
          clearTimeout(p.leaveTimer);
          if (p.socketId) io.to(p.socketId).emit('roomClosed');
        }
        rooms.delete(room.code);
        ok(ack);
      } catch (err) { fail(ack, err); }
    });

    const gameAction = (handler) => (data, ack) => {
      try {
        const found = findByToken(data && data.token);
        if (!found) throw new GameError('Sitzung nicht gefunden.');
        handler(found.room, found.player, data || {});
        ok(ack);
        broadcast(found.room);
      } catch (err) { fail(ack, err); }
    };

    const requireGame = (room) => {
      if (!room.game) throw new GameError('Das Spiel hat noch nicht begonnen.');
    };

    const requireGameOver = (room) => {
      if (!room.game || room.game.phase !== 'gameOver') throw new GameError('Das Spiel ist noch nicht zu Ende.');
    };

    socket.on('startGame', gameAction((room, player) => {
      if (!isHost(room, player)) throw new GameError('Nur der Host kann das Spiel starten.');
      if (room.game) throw new GameError('Das Spiel läuft bereits.');
      dropOffline(room, player);
      // Das allererste Spiel startet ein zufälliger Spieler (nicht zwingend der Host).
      room.startOffset = crypto.randomInt(room.players.length);
      newGame(room);
    }));

    socket.on('bid', gameAction((room, player, data) => {
      requireGame(room);
      room.game.bid(player.pid, data.value);
    }));

    socket.on('playCard', gameAction((room, player, data) => {
      requireGame(room);
      room.game.playCard(player.pid, data.cardId);
    }));

    socket.on('duelPick', gameAction((room, player, data) => {
      requireGame(room);
      room.game.duelPick(player.pid, data.cardId);
    }));

    socket.on('nextRound', gameAction((room, player) => {
      requireGame(room);
      if (!isHost(room, player)) throw new GameError('Nur der Host kann weiterschalten.');
      room.game.nextRound();
    }));

    socket.on('restartGame', gameAction((room, player) => {
      requireGameOver(room);
      if (!isHost(room, player)) throw new GameError('Nur der Host kann ein neues Spiel starten.');
      dropOffline(room, player);
      // Jedes weitere Spiel rückt den Startspieler um einen Platz weiter.
      room.startOffset = (room.startOffset + 1) % room.players.length;
      newGame(room);
    }));

    // Alessandro kann während des Spiels die Namen der anderen ändern. Weil Namen im
    // Raum eindeutig sind, kann er niemandem sonst den Namen «Alessandro» geben.
    socket.on('renamePlayer', gameAction((room, player, data) => {
      requireGame(room);
      if (!canRename(player)) throw new GameError(`Nur ${RENAMER_NAME} kann Namen ändern.`);
      // Die Spieler des Spiels: alle im Raum und dazu, wer nach Spielende gegangen ist
      // und noch in der Rangliste steht.
      const players = room.game.players;
      const target = players.find((p) => p.id === data.playerId);
      if (!target) throw new GameError('Diesen Spieler gibt es nicht.');
      if (target.id === player.pid) throw new GameError('Deinen eigenen Namen kannst du nicht ändern.');
      const name = cleanName(data.name);
      requireFreeName(players, name, target);
      room.game.renamePlayer(target.id, name);
      const member = room.players.find((p) => p.pid === target.id);
      if (member) member.name = name;
    }));

    // Nach Spielende zurück in die Lobby, z. B. wenn zu wenige online sind:
    // Dort können Neue beitreten, Offline-Spieler fallen nach der Schonfrist raus.
    socket.on('backToLobby', gameAction((room, player) => {
      requireGameOver(room);
      if (!isHost(room, player)) throw new GameError('Nur der Host kann zurück zur Lobby.');
      room.game = null;
      for (const p of room.players) {
        if (!p.connected) scheduleLobbyLeave(room, p);
      }
    }));

    socket.on('disconnect', () => {
      const m = memberOf(socket);
      if (m) markOffline(m.room, m.player);
    });
  });

  // Verwaiste Räume (alle offline) nach einer halben Stunde aufräumen – so lange
  // belegen sie auch einen Platz der Obergrenze für Räume.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.players.every((p) => !p.connected)) {
        room.emptySince = room.emptySince || now;
        if (now - room.emptySince > EMPTY_ROOM_TTL_MS) {
          for (const p of room.players) clearTimeout(p.leaveTimer);
          rooms.delete(code);
        }
      } else {
        room.emptySince = null;
      }
    }
    roomCreations.prune(now);
    joinFailures.prune(now);
  }, 5 * 60 * 1000);
  sweeper.unref();

  return { app, httpServer, io, rooms };
}

if (require.main === module) {
  const { httpServer } = createApp();
  const port = process.env.PORT || 3000;
  httpServer.listen(port, () => {
    console.log('Stichraten läuft:');
    console.log(`  Lokal:    http://localhost:${port}`);
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const iface of ifaces || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          console.log(`  Im WLAN:  http://${iface.address}:${port}  (für die Handys)`);
        }
      }
    }
  });
}

module.exports = { createApp, cleanName, nameKey };
