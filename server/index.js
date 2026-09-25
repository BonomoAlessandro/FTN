'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const express = require('express');
const { Server } = require('socket.io');
const { Game, GameError } = require('./game');

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 7;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * @param {object} [opts]
 * @param {number} [opts.lobbyGraceMs] Wie lange ein getrennter Spieler in der Lobby
 *   seinen Platz behält (Bildschirmsperre, App-Wechsel), bevor er entfernt wird.
 */
function createApp(opts = {}) {
  const lobbyGraceMs = opts.lobbyGraceMs ?? 90 * 1000;

  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const httpServer = http.createServer(app);
  const io = new Server(httpServer);

  /**
   * code -> { code, hostToken, nextPid, players: [{token, pid, name, socketId, connected}], game }
   */
  const rooms = new Map();

  function makeCode() {
    let code;
    do {
      code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
    } while (rooms.has(code));
    return code;
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

  function addPlayer(room, name, socket) {
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new GameError('Dieser Name ist im Raum schon vergeben.');
    }
    const player = {
      token: crypto.randomBytes(16).toString('hex'),
      pid: `p${room.nextPid++}`,
      name,
      socketId: socket.id,
      connected: true,
      leaveTimer: null,
    };
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

  function cleanName(name) {
    const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
    if (!n) throw new GameError('Bitte gib einen Namen ein.');
    return n;
  }

  function newGame(room) {
    room.game = new Game(
      room.players.map((p) => ({ id: p.pid, name: p.name })),
      { startOffset: room.startOffset },
    );
  }

  io.on('connection', (socket) => {
    const fail = (ack, err) => {
      const msg = err instanceof GameError ? err.message : 'Unbekannter Fehler.';
      if (!(err instanceof GameError)) console.error(err);
      if (typeof ack === 'function') ack({ ok: false, error: msg });
    };
    const ok = (ack, extra = {}) => {
      if (typeof ack === 'function') ack({ ok: true, ...extra });
    };

    socket.on('createRoom', (data, ack) => {
      try {
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
        ok(ack, { token: player.token, code: room.code });
        broadcast(room);
      } catch (err) { fail(ack, err); }
    });

    socket.on('joinRoom', (data, ack) => {
      try {
        const name = cleanName(data && data.name);
        const code = String((data && data.code) || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) throw new GameError('Diesen Raum gibt es nicht.');
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
        if (!found) throw new GameError('Sitzung nicht gefunden.');
        clearTimeout(found.player.leaveTimer);
        found.player.leaveTimer = null;
        found.player.socketId = socket.id;
        found.player.connected = true;
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

    socket.on('startGame', gameAction((room, player) => {
      if (!isHost(room, player)) throw new GameError('Nur der Host kann das Spiel starten.');
      if (room.game) throw new GameError('Das Spiel läuft bereits.');
      if (room.players.length < MIN_PLAYERS) throw new GameError(`Es braucht mindestens ${MIN_PLAYERS} Spieler.`);
      // Das allererste Spiel startet ein zufälliger Spieler (nicht zwingend der Host).
      room.startOffset = Math.floor(Math.random() * room.players.length);
      for (const p of room.players) clearTimeout(p.leaveTimer);
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
      if (!room.game || room.game.phase !== 'gameOver') throw new GameError('Das Spiel ist noch nicht zu Ende.');
      if (!isHost(room, player)) throw new GameError('Nur der Host kann ein neues Spiel starten.');
      if (room.players.length < MIN_PLAYERS) throw new GameError(`Es braucht mindestens ${MIN_PLAYERS} Spieler.`);
      // Jedes weitere Spiel rückt den Startspieler um einen Platz weiter.
      room.startOffset = (room.startOffset + 1) % room.players.length;
      newGame(room);
    }));

    socket.on('disconnect', () => {
      for (const room of rooms.values()) {
        const player = room.players.find((p) => p.socketId === socket.id);
        if (!player) continue;
        player.socketId = null;
        player.connected = false;
        if (!room.game) {
          // In der Lobby wird ein Getrennter erst nach einer Schonfrist entfernt,
          // damit eine kurze Bildschirmsperre nicht den Platz kostet.
          clearTimeout(player.leaveTimer);
          player.leaveTimer = setTimeout(() => {
            player.leaveTimer = null;
            if (rooms.get(room.code) === room && !room.game && !player.connected) {
              removePlayer(room, player);
            }
          }, lobbyGraceMs);
          player.leaveTimer.unref();
        }
        broadcast(room);
        break;
      }
    });
  });

  // Verwaiste Räume (alle offline) nach einer Stunde aufräumen.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.players.every((p) => !p.connected)) {
        room.emptySince = room.emptySince || now;
        if (now - room.emptySince > 60 * 60 * 1000) {
          for (const p of room.players) clearTimeout(p.leaveTimer);
          rooms.delete(code);
        }
      } else {
        room.emptySince = null;
      }
    }
  }, 10 * 60 * 1000);
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

module.exports = { createApp };
