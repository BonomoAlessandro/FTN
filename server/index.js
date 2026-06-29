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

function createApp() {
  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const httpServer = http.createServer(app);
  const io = new Server(httpServer);

  /** code -> { code, hostToken, players: [{token, pid, name, socketId, connected}], game } */
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

  function lobbyPayload(room, viewer) {
    return {
      screen: 'lobby',
      roomCode: room.code,
      isHost: viewer.token === room.hostToken,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      players: room.players.map((p) => ({
        name: p.name,
        connected: p.connected,
        isHost: p.token === room.hostToken,
        isYou: p.token === viewer.token,
      })),
    };
  }

  function gamePayload(room, viewer) {
    const view = room.game.viewFor(viewer.pid);
    view.screen = 'game';
    view.roomCode = room.code;
    view.isHost = viewer.token === room.hostToken;
    for (const pl of view.players) {
      const rp = room.players.find((q) => q.pid === pl.id);
      pl.connected = rp ? rp.connected : false;
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
    const n = String(name || '').trim().slice(0, 16);
    if (!n) throw new GameError('Bitte gib einen Namen ein.');
    return n;
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
          players: [],
          game: null,
        };
        const player = {
          token: crypto.randomBytes(16).toString('hex'),
          pid: 'p1',
          name,
          socketId: socket.id,
          connected: true,
        };
        room.hostToken = player.token;
        room.players.push(player);
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
        if (room.players.length >= MAX_PLAYERS) throw new GameError('Der Raum ist voll (max. 7).');
        const player = {
          token: crypto.randomBytes(16).toString('hex'),
          pid: `p${room.players.length + 1}`,
          name,
          socketId: socket.id,
          connected: true,
        };
        room.players.push(player);
        ok(ack, { token: player.token, code: room.code });
        broadcast(room);
      } catch (err) { fail(ack, err); }
    });

    // Reconnect nach Bildschirmsperre / App-Wechsel / Seiten-Reload
    socket.on('rejoin', (data, ack) => {
      try {
        const found = findByToken(data && data.token);
        if (!found) throw new GameError('Sitzung nicht gefunden.');
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
        const { room, player } = found;
        room.players = room.players.filter((p) => p !== player);
        if (room.players.length === 0) {
          rooms.delete(room.code);
        } else {
          if (room.hostToken === player.token) room.hostToken = room.players[0].token;
          broadcast(room);
        }
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

    socket.on('startGame', gameAction((room, player) => {
      if (player.token !== room.hostToken) throw new GameError('Nur der Host kann das Spiel starten.');
      if (room.game) throw new GameError('Das Spiel läuft bereits.');
      if (room.players.length < MIN_PLAYERS) throw new GameError(`Es braucht mindestens ${MIN_PLAYERS} Spieler.`);
      room.game = new Game(room.players.map((p) => ({ id: p.pid, name: p.name })));
    }));

    socket.on('bid', gameAction((room, player, data) => {
      if (!room.game) throw new GameError('Das Spiel hat noch nicht begonnen.');
      room.game.bid(player.pid, data.value);
    }));

    socket.on('playCard', gameAction((room, player, data) => {
      if (!room.game) throw new GameError('Das Spiel hat noch nicht begonnen.');
      room.game.playCard(player.pid, data.cardId);
    }));

    socket.on('duelPick', gameAction((room, player, data) => {
      if (!room.game) throw new GameError('Das Spiel hat noch nicht begonnen.');
      room.game.duelPick(player.pid, data.cardId);
    }));

    socket.on('nextRound', gameAction((room, player) => {
      if (!room.game) throw new GameError('Das Spiel hat noch nicht begonnen.');
      if (player.token !== room.hostToken) throw new GameError('Nur der Host kann weiterschalten.');
      room.game.nextRound();
    }));

    socket.on('restartGame', gameAction((room, player) => {
      if (!room.game || room.game.phase !== 'gameOver') throw new GameError('Das Spiel ist noch nicht zu Ende.');
      if (player.token !== room.hostToken) throw new GameError('Nur der Host kann ein neues Spiel starten.');
      room.game = new Game(room.players.map((p) => ({ id: p.pid, name: p.name })));
    }));

    socket.on('disconnect', () => {
      for (const room of rooms.values()) {
        const player = room.players.find((p) => p.socketId === socket.id);
        if (!player) continue;
        player.socketId = null;
        player.connected = false;
        if (!room.game) {
          // In der Lobby fliegen Getrennte raus, damit kein Geisterplatz blockiert.
          room.players = room.players.filter((p) => p !== player);
          if (room.players.length === 0) rooms.delete(room.code);
          else {
            if (room.hostToken === player.token) room.hostToken = room.players[0].token;
            broadcast(room);
          }
        } else {
          broadcast(room);
        }
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
        if (now - room.emptySince > 60 * 60 * 1000) rooms.delete(code);
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
