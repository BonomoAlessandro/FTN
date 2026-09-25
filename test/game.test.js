'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, GameError, ROUND_PLAN } = require('../server/game');
const { createDeck } = require('../server/deck');

const PLAYERS = [
  { id: 'A', name: 'Anna' },
  { id: 'B', name: 'Beni' },
  { id: 'C', name: 'Cleo' },
];

const C = (suit, rank) => ({ id: `${suit}-${rank}`, suit, rank });

/** Deck so bauen, dass A/B/C genau diese Hände erhalten; Rest = Ziehstapel. */
function deckFor(handA, handB, handC, drawPile = []) {
  return [...handA, ...handB, ...handC, ...drawPile];
}

function newGame(deck, opts = {}) {
  return new Game(PLAYERS, { deckFactory: () => deck.slice(), ...opts });
}

test('Spielstart: Rundenplan, Phase und erster Ansager', () => {
  const g = newGame(createDeck());
  assert.equal(g.roundIndex, 0);
  assert.equal(g.cardsThisRound, 5);
  assert.equal(g.phase, 'bidding');
  assert.equal(g.currentBidderId, 'A');
  assert.deepEqual(ROUND_PLAN, [5, 4, 3, 2, 1, 1, 2, 3, 4, 5]);
});

test('Spieleranzahl wird validiert (3–7)', () => {
  assert.throws(() => new Game(PLAYERS.slice(0, 2)), GameError);
  const eight = Array.from({ length: 8 }, (_, i) => ({ id: `P${i}`, name: `P${i}` }));
  assert.throws(() => new Game(eight), GameError);
});

test('Regel 1: Summe der Ansagen darf nicht aufgehen (nur letzter Ansager)', () => {
  const g = newGame(createDeck());
  // Erste Ansager sind frei
  assert.deepEqual(g.allowedBids('A'), [0, 1, 2, 3, 4, 5]);
  g.bid('A', 2);
  g.bid('B', 2);
  // C ist letzter: 2+2+1 = 5 wäre die Kartenzahl -> 1 ist verboten
  assert.deepEqual(g.allowedBids('C'), [0, 2, 3, 4, 5]);
  assert.throws(() => g.bid('C', 1), GameError);
  g.bid('C', 0);
  assert.equal(g.phase, 'playing');
});

test('Ansagen: nur der Reihe nach', () => {
  const g = newGame(createDeck());
  assert.throws(() => g.bid('B', 0), GameError);
});

test('Regel 2: dieselbe Zahl ist nach 2x nacheinander gesperrt', () => {
  const g = newGame(createDeck());
  g.bidHistory.A = [1, 1];
  assert.equal(g.blockedBid('A'), 1);
  assert.deepEqual(g.allowedBids('A'), [0, 2, 3, 4, 5]);
  assert.throws(() => g.bid('A', 1), GameError);
  // Nach einer anderen Ansage ist die Zahl wieder frei
  g.bidHistory.A = [1, 1, 3];
  assert.equal(g.blockedBid('A'), null);
  assert.ok(g.allowedBids('A').includes(1));
});

test('Komplette Runde mit Stich-Duell und Abwurf der Unbeteiligten', () => {
  // A: Rosen 6-10, B: Rosen 11-14 + Schellen 6, C: Schellen 7-11
  const g = newGame(createDeck());
  assert.deepEqual(g.hands.A.map((c) => c.id), ['rosen-6', 'rosen-7', 'rosen-8', 'rosen-9', 'rosen-10']);

  g.bid('A', 0);
  g.bid('B', 0);
  g.bid('C', 0); // Summe 0 != 5, ok

  // Stich 1: B gewinnt mit Under (11)
  g.playCard('A', 'rosen-10');
  g.playCard('B', 'rosen-11');
  g.playCard('C', 'schellen-7');
  assert.equal(g.tricksWon.B, 1);
  assert.equal(g.currentPlayerId, 'B'); // Stichgewinner spielt aus

  // Stich 2: Gleichstand C (Schellen 8) und A (Rosen 8)
  g.playCard('B', 'schellen-6');
  g.playCard('C', 'schellen-8');
  g.playCard('A', 'rosen-8');
  assert.equal(g.phase, 'duel');
  assert.equal(g.stake, 2);
  assert.deepEqual(g.duel.participants.sort(), ['A', 'C']);

  // Alle wählen verdeckt: Beteiligte spielen, B (unbeteiligt) wirft ab
  g.duelPick('A', 'rosen-9');
  g.duelPick('C', 'schellen-10');
  assert.equal(g.phase, 'duel'); // B fehlt noch
  g.duelPick('B', 'rosen-12');
  // C gewinnt das Duell -> 2 Stiche
  assert.equal(g.tricksWon.C, 2);
  assert.equal(g.phase, 'playing');
  assert.equal(g.currentPlayerId, 'C');
  // Hände bleiben synchron (alle haben gleich viele Karten)
  assert.equal(g.hands.A.length, 2);
  assert.equal(g.hands.B.length, 2);
  assert.equal(g.hands.C.length, 2);
  // Abgeworfene Karte zählt für niemanden
  assert.equal(g.tricksWon.B, 1);

  // Stich 3: B gewinnt mit König
  g.playCard('C', 'schellen-9');
  g.playCard('A', 'rosen-6');
  g.playCard('B', 'rosen-13');
  assert.equal(g.tricksWon.B, 2);

  // Stich 4 (letzter): B gewinnt mit Ass
  g.playCard('B', 'rosen-14');
  g.playCard('C', 'schellen-11');
  g.playCard('A', 'rosen-7');
  assert.equal(g.tricksWon.B, 3);

  // Runde fertig: Gesamtstiche = Kartenzahl (5)
  assert.equal(g.phase, 'roundEnd');
  assert.equal(g.tricksWon.A + g.tricksWon.B + g.tricksWon.C, 5);
  const res = Object.fromEntries(g.roundResults.map((r) => [r.playerId, r]));
  assert.equal(res.A.points, 10); // 0 angesagt, 0 gemacht -> 10
  assert.equal(res.B.points, -15); // 0 angesagt, 3 gemacht -> -15
  assert.equal(res.C.points, -10); // 0 angesagt, 2 gemacht -> -10

  // Nächste Runde: 4 Karten, Startspieler rotiert zu B
  g.nextRound();
  assert.equal(g.cardsThisRound, 4);
  assert.equal(g.currentBidderId, 'B');
  // Ansage-Historie wurde fortgeschrieben
  assert.deepEqual(g.bidHistory.A, [0]);
});

test('Mehrfaches Duell: Einsatz steigt pro Wiederholung', () => {
  const g = newGame(createDeck());
  g.bid('A', 1);
  g.bid('B', 1);
  g.bid('C', 0); // Summe 2 != 5

  // Stich 1: Gleichstand A (Rosen 8) / C (Schellen 8)
  g.playCard('A', 'rosen-8');
  g.playCard('B', 'schellen-6');
  g.playCard('C', 'schellen-8');
  assert.equal(g.stake, 2);

  // Duell 1: wieder Gleichstand (Rosen 9 / Schellen 9)
  g.duelPick('A', 'rosen-9');
  g.duelPick('C', 'schellen-9');
  g.duelPick('B', 'rosen-11');
  assert.equal(g.phase, 'duel');
  assert.equal(g.stake, 3);
  assert.deepEqual(g.duel.participants.sort(), ['A', 'C']);

  // Duell 2: C gewinnt -> 3 Stiche aufs Mal
  g.duelPick('A', 'rosen-7');
  g.duelPick('C', 'schellen-10');
  g.duelPick('B', 'rosen-12');
  assert.equal(g.tricksWon.C, 3);
  assert.equal(g.phase, 'playing');
  assert.equal(g.hands.A.length, 2);
  assert.equal(g.hands.B.length, 2);
  assert.equal(g.hands.C.length, 2);
});

test('Letzter Stich mit Gleichstand: zufällige Karten entscheiden (auch mehrstufig)', () => {
  const deck = deckFor(
    [C('rosen', 6), C('rosen', 7), C('rosen', 8), C('rosen', 9), C('rosen', 14)],
    [C('schellen', 6), C('schellen', 7), C('schellen', 8), C('schellen', 9), C('schellen', 14)],
    [C('eicheln', 6), C('eicheln', 7), C('eicheln', 8), C('eicheln', 10), C('eicheln', 11)],
    // Ziehstapel: erste Ziehrunde 11 vs 11 (wieder gleich), zweite 12 vs 13
    [C('rosen', 11), C('schilten', 11), C('rosen', 12), C('schilten', 13)]
  );
  const g = newGame(deck);
  g.bid('A', 1);
  g.bid('B', 2);
  assert.deepEqual(g.allowedBids('C'), [0, 1, 3, 4, 5]); // 2 würde Summe 5 ergeben
  g.bid('C', 3);

  // 4 Stiche ohne Gleichstand
  g.playCard('A', 'rosen-6');
  g.playCard('B', 'schellen-7');
  g.playCard('C', 'eicheln-8'); // C gewinnt
  g.playCard('C', 'eicheln-6');
  g.playCard('A', 'rosen-7');
  g.playCard('B', 'schellen-6'); // A gewinnt
  g.playCard('A', 'rosen-8');
  g.playCard('B', 'schellen-9');
  g.playCard('C', 'eicheln-7'); // B gewinnt
  g.playCard('B', 'schellen-8');
  g.playCard('C', 'eicheln-10');
  g.playCard('A', 'rosen-9'); // C gewinnt

  // Letzter Stich: A (Ass) und B (Ass) gleich, keine Handkarten mehr
  g.playCard('C', 'eicheln-11');
  g.playCard('A', 'rosen-14');
  g.playCard('B', 'schellen-14');

  // Ziehen: Runde 1 beide 11 -> Runde 2: A=12, B=13 -> B gewinnt
  assert.equal(g.phase, 'roundEnd');
  assert.equal(g.lastDraw.rounds.length, 2);
  assert.equal(g.lastDraw.winnerId, 'B');
  assert.equal(g.tricksWon.B, 2);

  const res = Object.fromEntries(g.roundResults.map((r) => [r.playerId, r]));
  assert.equal(res.A.points, 11); // 1 angesagt, 1 gemacht -> 10 + 1
  assert.equal(res.B.points, 14); // 2 angesagt, 2 gemacht -> 10 + 4 (Beispiel aus der Anleitung)
  assert.equal(res.C.points, -5); // 3 angesagt, 2 gemacht -> -5
});

test('Blindrunde: eigene Karte verdeckt, Summe darf aufgehen, Autoplay', () => {
  const deck = deckFor(
    [C('rosen', 10)],
    [C('schellen', 10)],
    [C('eicheln', 6)],
    [C('eicheln', 7), C('eicheln', 8)]
  );
  const g = newGame(createDeck());
  // Zur ersten Blindrunde (Index 4) vorspulen
  g.opts.deckFactory = () => deck.slice();
  g.roundIndex = 3;
  g._startRound();
  assert.equal(g.cardsThisRound, 1);
  assert.ok(g.isBlind);
  assert.equal(g.currentBidderId, 'B'); // Startspieler rotiert: Runde 5 -> Index 4 % 3 = 1

  // Sicht: eigene Karte verdeckt (ohne ID!), Gegnerkarten sichtbar
  const viewA = g.viewFor('A');
  assert.deepEqual(viewA.hand, [{ hidden: true }]);
  const others = Object.fromEntries(viewA.players.map((p) => [p.id, p.visibleCard]));
  assert.equal(others.A, null);
  assert.equal(others.B.id, 'schellen-10');
  assert.equal(others.C.id, 'eicheln-6');

  // Summe darf aufgehen: B=1, C=0, A=0 -> Summe 1 bei 1 Stich ist erlaubt
  assert.deepEqual(g.allowedBids('B'), [0, 1]);
  g.bid('B', 1);
  g.bid('C', 0);
  assert.deepEqual(g.allowedBids('A'), [0, 1]); // letzter Ansager, trotzdem frei
  g.bid('A', 0);

  // Autoplay: A (Rosen 10) und B (Schellen 10) gleich. Spielreihenfolge ab
  // Startspieler B -> B zieht zuerst (7), dann A (8) -> A gewinnt den Stich.
  assert.equal(g.phase, 'roundEnd');
  assert.equal(g.lastDraw.winnerId, 'A');
  const res = Object.fromEntries(g.roundResults.map((r) => [r.playerId, r]));
  assert.equal(res.A.points, -5); // 0 angesagt, 1 gemacht
  assert.equal(res.B.points, -5); // 1 angesagt, 0 gemacht
  assert.equal(res.C.points, 10); // 0 angesagt, 0 gemacht
});

test('Verdeckte Karten leaken nicht in fremde Sichten', () => {
  const g = newGame(createDeck());
  const viewA = g.viewFor('A');
  const playerB = viewA.players.find((p) => p.id === 'B');
  assert.equal(playerB.visibleCard, null);
  assert.equal(playerB.handCount, 5);
  assert.equal(viewA.hand.length, 5);
  assert.ok(viewA.hand[0].id); // eigene Karten normal sichtbar
});

test('Komplettes Spiel über alle 10 Runden mit Zufallsdecks und Bot-Strategie', () => {
  const g = new Game(PLAYERS);
  const cardCounts = [];
  const starters = [];
  let safety = 0;
  while (g.phase !== 'gameOver') {
    assert.ok(++safety < 10000, 'Spiel terminiert nicht');
    if (g.phase === 'bidding') {
      if (g.bids[g.currentBidderId] === null && cardCounts.length < g.roundIndex + 1) {
        cardCounts.push(g.cardsThisRound);
        starters.push(g.starterIndex);
      }
      const who = g.currentBidderId;
      g.bid(who, g.allowedBids(who)[0]);
    } else if (g.phase === 'playing') {
      const who = g.currentPlayerId;
      g.playCard(who, g.hands[who][0].id);
    } else if (g.phase === 'duel') {
      const who = g.players.find((p) => !g.duel.picks[p.id]).id;
      g.duelPick(who, g.hands[who][0].id);
    } else if (g.phase === 'roundEnd') {
      // Pro Runde: Gesamtstiche = Kartenzahl
      const total = Object.values(g.tricksWon).reduce((a, b) => a + b, 0);
      assert.equal(total, ROUND_PLAN[g.roundIndex]);
      g.nextRound();
    }
  }
  assert.deepEqual(cardCounts, ROUND_PLAN);
  assert.deepEqual(starters, ROUND_PLAN.map((_, i) => i % 3));
  assert.equal(g.ranking.length, 3);
  assert.ok(g.ranking[0].score >= g.ranking[1].score);
});

test('Verlauf: jede abgeschlossene Runde speichert Ansage und Stiche aller Spieler', () => {
  const { Game } = require('../server/game');
  const g = new Game([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }]);
  const step = () => {
    if (g.phase === 'bidding') g.bid(g.currentBidderId, g.allowedBids(g.currentBidderId)[0]);
    else if (g.phase === 'playing') g.playCard(g.currentPlayerId, g.hands[g.currentPlayerId][0].id);
    else if (g.phase === 'duel') {
      const p = g.players.find((q) => !g.duel.picks[q.id]);
      g.duelPick(p.id, g.hands[p.id][0].id);
    } else if (g.phase === 'roundEnd') g.nextRound();
  };
  // Laufende Runde hat noch kein Ergebnis
  assert.deepEqual(g.viewFor('a').history, [{ roundNumber: 1, cards: 5, results: null }]);
  assert.deepEqual(g.viewFor('a').roundPlan, [5, 4, 3, 2, 1, 1, 2, 3, 4, 5]);
  while (g.phase !== 'gameOver') step();
  const h = g.viewFor('b').history;
  assert.deepEqual(h.map((r) => r.cards), [5, 4, 3, 2, 1, 1, 2, 3, 4, 5]);
  for (const p of g.players) {
    // Verlauf deckt sich mit der intern geführten Ansage-Historie (Regel 2)
    assert.deepEqual(h.map((r) => r.results.find((x) => x.playerId === p.id).bid), g.bidHistory[p.id]);
  }
});
