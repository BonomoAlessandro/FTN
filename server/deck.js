'use strict';

const SUITS = [
  { key: 'rosen', name: 'Rosen', symbol: '✿', color: '#c0392b' },
  { key: 'schellen', name: 'Schellen', symbol: '🔔', color: '#b8860b' },
  { key: 'eicheln', name: 'Eicheln', symbol: '🌰', color: '#1e7a3c' },
  { key: 'schilten', name: 'Schilten', symbol: '🛡', color: '#2c5aa0' },
];

const RANK_NAMES = {
  6: '6', 7: '7', 8: '8', 9: '9',
  10: 'Banner', 11: 'Under', 12: 'Ober', 13: 'König', 14: 'Ass',
};

function createDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (let rank = 6; rank <= 14; rank++) {
      deck.push({ id: `${s.key}-${rank}`, suit: s.key, rank });
    }
  }
  return deck;
}

function shuffle(cards) {
  const a = cards.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { SUITS, RANK_NAMES, createDeck, shuffle };
