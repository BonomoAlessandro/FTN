'use strict';

const { createDeck, shuffle } = require('./deck');

const ROUND_PLAN = [5, 4, 3, 2, 1, 1, 2, 3, 4, 5];

class GameError extends Error {}

/**
 * Server-autoritative Spiellogik als Zustandsmaschine.
 * Phasen: bidding -> playing -> (duel)* -> roundEnd -> ... -> gameOver
 *
 * Invariante: Jeder Stich (inkl. Duell-Wiederholungen und Abwürfen) kostet
 * jeden Spieler genau eine Handkarte. Dadurch bleiben die Hände synchron und
 * die Gesamtzahl der vergebenen Stiche entspricht der Kartenzahl der Runde.
 */
class Game {
  constructor(players, opts = {}) {
    if (players.length < 3 || players.length > 7) {
      throw new GameError('Das Spiel braucht 3 bis 7 Spieler.');
    }
    this.players = players.map((p) => ({ id: p.id, name: p.name }));
    this.opts = opts;
    this.startOffset = Number.isInteger(opts.startOffset) ? opts.startOffset : 0;
    this.scores = {};
    this.bidHistory = {};
    for (const p of this.players) {
      this.scores[p.id] = 0;
      this.bidHistory[p.id] = [];
    }
    this.eventId = 0;
    this.roundIndex = -1;
    this.ranking = null;
    // Verlauf aller Runden: Ansagen und Ergebnis jedes Spielers.
    this.history = [];
    this._startRound();
  }

  get n() { return this.players.length; }
  get totalRounds() { return ROUND_PLAN.length; }
  get cardsThisRound() { return ROUND_PLAN[this.roundIndex]; }
  get isBlind() { return this.cardsThisRound === 1; }

  _startRound() {
    this.roundIndex += 1;
    if (this.roundIndex >= ROUND_PLAN.length) return this._endGame();
    const deck = this.opts.deckFactory
      ? this.opts.deckFactory(this.roundIndex).slice()
      : shuffle(createDeck());
    this.hands = {};
    for (const p of this.players) this.hands[p.id] = deck.splice(0, this.cardsThisRound);
    this.deck = deck;
    this.discardPile = [];
    this.starterIndex = (this.roundIndex + this.startOffset) % this.n;
    this.bids = {};
    this.tricksWon = {};
    for (const p of this.players) {
      this.bids[p.id] = null;
      this.tricksWon[p.id] = 0;
    }
    this.phase = 'bidding';
    this.currentTrick = [];
    this.trickLeaderIndex = this.starterIndex;
    this.stake = 1;
    this.duel = null;
    this.lastTrick = null;
    this.lastDuel = null;
    this.lastDraw = null;
    this.roundResults = null;
    this.history.push({ roundNumber: this.roundIndex + 1, cards: this.cardsThisRound, results: null });
  }

  // ---------- Ansagen ----------

  get _bidsPlaced() {
    return this.players.filter((p) => this.bids[p.id] !== null).length;
  }

  get currentBidderId() {
    if (this.phase !== 'bidding') return null;
    return this.players[(this.starterIndex + this._bidsPlaced) % this.n].id;
  }

  /** Regel 2: Zahl ist gesperrt, wenn sie in den letzten zwei Runden angesagt wurde. */
  blockedBid(playerId) {
    const h = this.bidHistory[playerId];
    if (h.length >= 2 && h[h.length - 1] === h[h.length - 2]) return h[h.length - 1];
    return null;
  }

  allowedBids(playerId) {
    if (this.phase !== 'bidding' || this.currentBidderId !== playerId) return [];
    const c = this.cardsThisRound;
    const blocked = this.blockedBid(playerId);
    const isLastBidder = this._bidsPlaced === this.n - 1;
    let sumSoFar = 0;
    for (const p of this.players) sumSoFar += this.bids[p.id] || 0;
    const allowed = [];
    for (let v = 0; v <= c; v++) {
      if (v === blocked) continue;
      // Regel 1: Summe darf nicht aufgehen – gilt nicht in Blindrunden.
      if (!this.isBlind && isLastBidder && sumSoFar + v === c) continue;
      allowed.push(v);
    }
    return allowed;
  }

  bid(playerId, value) {
    if (this.phase !== 'bidding') throw new GameError('Jetzt wird nicht angesagt.');
    if (this.currentBidderId !== playerId) throw new GameError('Du bist nicht an der Reihe.');
    if (!Number.isInteger(value) || !this.allowedBids(playerId).includes(value)) {
      throw new GameError('Diese Ansage ist nicht erlaubt.');
    }
    this.bids[playerId] = value;
    if (this._bidsPlaced === this.n) {
      this.phase = 'playing';
      if (this.isBlind) this._autoplayBlind();
    }
  }

  // ---------- Stiche spielen ----------

  get currentPlayerId() {
    if (this.phase !== 'playing') return null;
    return this.players[(this.trickLeaderIndex + this.currentTrick.length) % this.n].id;
  }

  playCard(playerId, cardId) {
    if (this.phase !== 'playing') throw new GameError('Jetzt wird keine Karte gespielt.');
    if (this.currentPlayerId !== playerId) throw new GameError('Du bist nicht an der Reihe.');
    const card = this._takeFromHand(playerId, cardId);
    this.currentTrick.push({ playerId, card });
    if (this.currentTrick.length === this.n) this._resolveTrick();
  }

  _takeFromHand(playerId, cardId) {
    const hand = this.hands[playerId];
    const idx = hand.findIndex((c) => c.id === cardId);
    if (idx === -1) throw new GameError('Diese Karte ist nicht in deiner Hand.');
    return hand.splice(idx, 1)[0];
  }

  /** Blindrunde: jeder hat genau eine Karte, sie wird automatisch gespielt. */
  _autoplayBlind() {
    for (let i = 0; i < this.n; i++) {
      const p = this.players[(this.starterIndex + i) % this.n];
      this.currentTrick.push({ playerId: p.id, card: this.hands[p.id].pop() });
    }
    this._resolveTrick();
  }

  _resolveTrick() {
    const max = Math.max(...this.currentTrick.map((t) => t.card.rank));
    const winners = this.currentTrick
      .filter((t) => t.card.rank === max)
      .map((t) => t.playerId);
    this.lastTrick = {
      eventId: ++this.eventId,
      cards: this.currentTrick.slice(),
      winnerIds: winners,
      stake: this.stake,
    };
    this.discardPile.push(...this.currentTrick.map((t) => t.card));
    this.currentTrick = [];
    if (winners.length === 1) this._awardTricks(winners[0]);
    else this._tieBreak(winners);
  }

  _tieBreak(tiedIds) {
    const handsEmpty = this.hands[this.players[0].id].length === 0;
    if (handsEmpty) {
      this._resolveByDraw(tiedIds);
    } else {
      this.stake += 1;
      this.phase = 'duel';
      this.duel = { participants: tiedIds, picks: {} };
    }
  }

  duelPick(playerId, cardId) {
    if (this.phase !== 'duel') throw new GameError('Es läuft kein Duell.');
    if (this.duel.picks[playerId]) throw new GameError('Du hast bereits eine Karte gewählt.');
    const card = this._takeFromHand(playerId, cardId);
    this.duel.picks[playerId] = card;
    if (Object.keys(this.duel.picks).length === this.n) this._resolveDuel();
  }

  _resolveDuel() {
    const { participants, picks } = this.duel;
    const max = Math.max(...participants.map((id) => picks[id].rank));
    const winners = participants.filter((id) => picks[id].rank === max);
    this.lastDuel = {
      eventId: ++this.eventId,
      reveals: this.players.map((p) => ({
        playerId: p.id,
        card: picks[p.id],
        participant: participants.includes(p.id),
      })),
      winnerIds: winners,
      stake: this.stake,
    };
    this.discardPile.push(...Object.values(picks));
    this.duel = null;
    if (winners.length === 1) this._awardTricks(winners[0]);
    else this._tieBreak(winners);
  }

  /** Letzter Stich: Beteiligte ziehen zufällig vom Reststapel, bis es einen Sieger gibt. */
  _resolveByDraw(tiedIds) {
    const rounds = [];
    let contenders = tiedIds;
    let winnerId = null;
    while (!winnerId) {
      const draws = contenders.map((id) => {
        if (this.deck.length === 0) {
          this.deck = shuffle(this.discardPile);
          this.discardPile = [];
        }
        return { playerId: id, card: this.deck.shift() };
      });
      rounds.push(draws);
      this.discardPile.push(...draws.map((d) => d.card));
      const max = Math.max(...draws.map((d) => d.card.rank));
      const top = draws.filter((d) => d.card.rank === max).map((d) => d.playerId);
      if (top.length === 1) winnerId = top[0];
      else contenders = top;
    }
    this.lastDraw = { eventId: ++this.eventId, rounds, winnerId, stake: this.stake };
    this._awardTricks(winnerId);
  }

  _awardTricks(winnerId) {
    this.tricksWon[winnerId] += this.stake;
    this.stake = 1;
    const handsEmpty = this.hands[this.players[0].id].length === 0;
    if (handsEmpty) {
      this._endRound();
    } else {
      this.trickLeaderIndex = this.players.findIndex((p) => p.id === winnerId);
      this.phase = 'playing';
    }
  }

  // ---------- Wertung ----------

  _endRound() {
    this.roundResults = this.players.map((p) => {
      const bid = this.bids[p.id];
      const won = this.tricksWon[p.id];
      const points = bid === won ? 10 + won * won : -5 * Math.abs(bid - won);
      this.scores[p.id] += points;
      this.bidHistory[p.id].push(bid);
      return { playerId: p.id, bid, won, points, total: this.scores[p.id] };
    });
    this.history[this.history.length - 1].results = this.roundResults;
    this.phase = 'roundEnd';
  }

  nextRound() {
    if (this.phase !== 'roundEnd') throw new GameError('Die Runde ist noch nicht zu Ende.');
    this._startRound();
  }

  _endGame() {
    this.phase = 'gameOver';
    this.ranking = this.players
      .map((p) => ({ playerId: p.id, name: p.name, score: this.scores[p.id] }))
      .sort((a, b) => b.score - a.score);
  }

  // ---------- Personalisierte Sicht ----------

  viewFor(viewerId) {
    const over = this.phase === 'gameOver';
    const blindBidding = !over && this.isBlind && this.phase === 'bidding';
    let hand = [];
    if (!over) {
      // In der Blindrunde darf die eigene Karte nicht erkennbar sein
      // (auch nicht über die Karten-ID) – nur ein verdeckter Platzhalter.
      hand = blindBidding
        ? this.hands[viewerId].map(() => ({ hidden: true }))
        : this.hands[viewerId].slice();
    }
    return {
      phase: this.phase,
      roundNumber: Math.min(this.roundIndex + 1, this.totalRounds),
      totalRounds: this.totalRounds,
      cardsThisRound: over ? null : this.cardsThisRound,
      blind: !over && this.isBlind,
      stake: this.stake,
      youId: viewerId,
      starterId: over ? null : this.players[this.starterIndex].id,
      currentBidderId: this.currentBidderId,
      currentPlayerId: this.currentPlayerId,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        score: this.scores[p.id],
        bid: this.bids[p.id],
        tricksWon: this.tricksWon[p.id],
        handCount: over ? 0 : this.hands[p.id].length,
        visibleCard: blindBidding && p.id !== viewerId ? this.hands[p.id][0] : null,
        duelParticipant: this.duel ? this.duel.participants.includes(p.id) : false,
        duelPicked: this.duel ? Boolean(this.duel.picks[p.id]) : false,
      })),
      hand,
      allowedBids:
        this.phase === 'bidding' && this.currentBidderId === viewerId
          ? this.allowedBids(viewerId)
          : null,
      blockedBid: this.phase === 'bidding' ? this.blockedBid(viewerId) : null,
      table: this.currentTrick.slice(),
      duel: this.duel
        ? {
            participants: this.duel.participants,
            picked: Object.keys(this.duel.picks),
            youParticipate: this.duel.participants.includes(viewerId),
            needsYourPick: !this.duel.picks[viewerId],
          }
        : null,
      lastTrick: this.lastTrick,
      lastDuel: this.lastDuel,
      lastDraw: this.lastDraw,
      roundPlan: ROUND_PLAN,
      history: this.history,
      roundResults: this.roundResults,
      ranking: this.ranking,
    };
  }
}

module.exports = { Game, GameError, ROUND_PLAN };
