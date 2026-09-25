'use strict';

/**
 * Jasskarten als skalierbare SVGs (viewBox 100 × 140).
 * Die Farbsymbole liegen als <symbol> im SVG-Sprite von index.html.
 */
(function () {
  const SUITS = {
    rosen: { name: 'Rosen', color: '#b3261e', tint: '#fbe9e7' },
    schellen: { name: 'Schellen', color: '#8a5a00', tint: '#fff5d6' },
    eicheln: { name: 'Eicheln', color: '#2e6b2f', tint: '#e9f3e4' },
    schilten: { name: 'Schilten', color: '#1d4f91', tint: '#e6eefa' },
  };
  const RANK_NAMES = {
    6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
    11: 'Under', 12: 'Ober', 13: 'König', 14: 'Ass',
  };
  const RANK_SHORT = { 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'U', 12: 'O', 13: 'K', 14: 'A' };

  // Pip-Positionen (Mittelpunkte) für die Zahlenkarten.
  const PIPS = {
    6: { size: 18, at: [[35, 36], [65, 36], [35, 70], [65, 70], [35, 104], [65, 104]] },
    7: { size: 18, at: [[35, 34], [65, 34], [50, 52], [35, 72], [65, 72], [35, 106], [65, 106]] },
    8: { size: 17, at: [[35, 33], [65, 33], [50, 51], [35, 70], [65, 70], [50, 89], [35, 107], [65, 107]] },
    9: { size: 16, at: [[34, 32], [66, 32], [34, 57], [66, 57], [50, 70], [34, 83], [66, 83], [34, 108], [66, 108]] },
    10: { size: 16, at: [[34, 32], [66, 32], [50, 45], [34, 57], [66, 57], [34, 83], [66, 83], [50, 95], [34, 108], [66, 108]] },
  };

  const use = (suit, cx, cy, size, flip) =>
    `<use href="#suit-${suit}" x="${cx - size / 2}" y="${cy - size / 2}" width="${size}" height="${size}"` +
    (flip ? ` transform="rotate(180 ${cx} ${cy})"` : '') + '/>';

  function corner(card, s) {
    const r = RANK_SHORT[card.rank];
    return `<text x="13" y="25" class="cr" fill="${s.color}" font-size="${r.length > 1 ? 18 : 21}">${r}</text>` +
      use(card.suit, 13, 36, 14);
  }

  function figure(hy, s) {
    return `<circle cx="50" cy="${hy}" r="7.5" fill="#f3d9bf" stroke="${s.color}" stroke-width="1.5"/>` +
      `<path d="M33 ${hy + 32} C33 ${hy + 15} 40 ${hy + 9} 50 ${hy + 9} C60 ${hy + 9} 67 ${hy + 15} 67 ${hy + 32} Z" fill="${s.color}"/>`;
  }

  function center(card, s) {
    const { rank, suit } = card;
    if (PIPS[rank]) {
      const { size, at } = PIPS[rank];
      return at.map(([x, y]) => use(suit, x, y, size)).join('');
    }
    if (rank === 14) {
      return `<circle cx="50" cy="70" r="30" fill="${s.tint}" stroke="${s.color}" stroke-opacity=".35" stroke-width="1.5"/>` +
        `<circle cx="50" cy="70" r="24" fill="none" stroke="${s.color}" stroke-opacity=".2" stroke-dasharray="2 3"/>` +
        use(suit, 50, 70, 44);
    }
    // Bildkarten: Ober trägt das Farbzeichen oben, Under unten (wie im Schweizer Blatt).
    const panel = `<rect x="24" y="17" width="52" height="106" rx="6" fill="${s.tint}" stroke="${s.color}" stroke-opacity=".5"/>`;
    const label = (y) => `<text x="50" y="${y}" class="cl" fill="${s.color}">${RANK_NAMES[rank]}</text>`;
    if (rank === 12) return panel + use(suit, 50, 36, 24) + figure(62, s) + label(115);
    if (rank === 11) return panel + label(31) + figure(46, s) + use(suit, 50, 101, 24);
    // König mit Krone
    return panel +
      `<path d="M39 44 L41 30 L46 37 L50 27 L54 37 L59 30 L61 44 Z" fill="#e8b923" stroke="#8a6400" stroke-width="1.2" stroke-linejoin="round"/>` +
      figure(53, s) +
      `<circle cx="50" cy="78" r="9.5" fill="#fff" stroke="${s.color}" stroke-width="1"/>` + use(suit, 50, 78, 14) +
      label(115);
  }

  function cardSvg(card) {
    if (!card || card.hidden) {
      return '<svg viewBox="0 0 100 140" aria-label="verdeckte Karte" role="img">' +
        '<rect x=".75" y=".75" width="98.5" height="138.5" rx="8" fill="#7a1d22" stroke="#4a0f13" stroke-width="1.5"/>' +
        '<rect x="7" y="7" width="86" height="126" rx="5" fill="url(#card-back-pattern)" stroke="#e3b95a" stroke-opacity=".7"/>' +
        '<rect x="33" y="53" width="34" height="34" rx="7" fill="#d52b1e" stroke="#fff" stroke-width="2"/>' +
        '<path d="M46 59 H54 V66 H61 V74 H54 V81 H46 V74 H39 V66 H46 Z" fill="#fff"/>' +
        '</svg>';
    }
    const s = SUITS[card.suit];
    const label = `${s.name} ${RANK_NAMES[card.rank]}`;
    return `<svg viewBox="0 0 100 140" role="img" aria-label="${label}">` +
      '<rect x=".75" y=".75" width="98.5" height="138.5" rx="8" fill="url(#card-paper)" stroke="#c9bf9f" stroke-width="1.5"/>' +
      `<rect x="5" y="5" width="90" height="130" rx="5" fill="none" stroke="${s.color}" stroke-opacity=".22"/>` +
      corner(card, s) +
      `<g transform="rotate(180 50 70)">${corner(card, s)}</g>` +
      center(card, s) +
      '</svg>';
  }

  function cardEl(card, opts = {}) {
    const el = document.createElement('div');
    el.className = 'card' + (card && !card.hidden ? '' : ' back') +
      (opts.size ? ` ${opts.size}` : '') + (opts.winner ? ' winner' : '');
    el.innerHTML = cardSvg(card);
    return el;
  }

  const cardHtml = (card, opts) => cardEl(card, opts).outerHTML;

  window.Cards = { SUITS, RANK_NAMES, cardSvg, cardEl, cardHtml };
})();
