'use strict';

/**
 * Jasskarten als HTML. Weil im Spiel nur der Wert zählt, steht er gross oben
 * links; die Farbe ist Dekoration (Symbol aus dem SVG-Sprite in index.html),
 * der Balken unten zeigt die Stärke 1–9. Grösse über die Klasse card-sm|md|lg|xl.
 */
(function () {
  const LABEL = { 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'U', 12: 'O', 13: 'K', 14: 'A' };
  const NAMES = { 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'Under', 12: 'Ober', 13: 'König', 14: 'Ass' };
  // Mit Artikel, für Sätze wie «Der Ober schlägt …»
  const WITH_ARTICLE = {
    6: 'Die 6', 7: 'Die 7', 8: 'Die 8', 9: 'Die 9', 10: 'Die 10',
    11: 'Der Under', 12: 'Der Ober', 13: 'Der König', 14: 'Das Ass',
  };
  const SUITS = { rosen: 'Rosen', schellen: 'Schellen', eicheln: 'Eicheln', schilten: 'Schilten' };

  /**
   * @param {{rank:number, suit:string}|null} card  null oder {hidden:true} = Rückseite
   * @param {{size?:string, selected?:boolean, lead?:boolean, dim?:boolean, enter?:boolean}} [opts]
   */
  function cardHtml(card, opts = {}) {
    const cls = ['card', `card-${opts.size || 'md'}`,
      opts.selected && 'is-selected', opts.lead && 'is-lead', opts.dim && 'is-dim', opts.enter && 'is-enter']
      .filter(Boolean).join(' ');
    if (!card || card.hidden || !LABEL[card.rank] || !SUITS[card.suit]) {
      return `<div class="${cls} card-back" role="img" aria-label="verdeckte Karte"><span class="card-cross"></span></div>`;
    }
    const strength = card.rank - 5;
    const big = opts.size === 'lg' || opts.size === 'xl';
    const word = big && card.rank >= 11 ? `<span class="card-word">${NAMES[card.rank]}</span>` : '';
    const bar = opts.size === 'sm' ? '' : '<span class="card-bar" aria-hidden="true">' +
      '<i class="on"></i>'.repeat(strength) + '<i></i>'.repeat(9 - strength) + '</span>';
    return `<div class="${cls}${word ? ' has-word' : ''}" role="img" aria-label="${SUITS[card.suit]} ${NAMES[card.rank]}">` +
      `<span class="card-rank${card.rank === 10 ? ' is-ten' : ''}">${LABEL[card.rank]}</span>` +
      `<svg class="card-suit" viewBox="0 0 40 40" aria-hidden="true"><use href="#suit-${card.suit}"></use></svg>` +
      word + bar + '</div>';
  }

  window.Cards = { cardHtml, NAMES, WITH_ARTICLE };
})();
