'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanName, nameKey } = require('../server/index');
const { createDeck, shuffle } = require('../server/deck');
const { WindowCounter, tokenBucket, ipKey, clientIp } = require('../server/limits');

test('Namen: unsichtbare Steuer-, Format- und Füllzeichen werden entfernt', () => {
  assert.equal(cleanName('An\u200Bna'), 'Anna'); // Nullbreite
  assert.equal(cleanName('\u202EtsoH'), 'tsoH'); // Schreibrichtung umkehren
  assert.equal(cleanName(' Beni\u0007 '), 'Beni'); // Steuerzeichen
  assert.equal(cleanName('Cle\u3164o'), 'Cleo'); // Hangul-Füllzeichen
  assert.equal(cleanName('Dani \t  Dino'), 'Dani Dino');
});

test('Namen: unsichtbare oder fehlende Namen werden abgewiesen', () => {
  for (const bad of ['\u200B\u202E\u3164', '\u034F', '\u0301', '\u2800', '', null, 42, ['Anna'], { toString: 1 }]) {
    assert.throws(() => cleanName(bad), /Namen/, JSON.stringify(bad));
  }
});

test('Namen: NFC, Kürzen nach sichtbaren Zeichen, Emojis bleiben ganz', () => {
  assert.equal(cleanName('Zoe\u0301'), 'Zoé');
  assert.equal(cleanName('ABCDEFGHIJKLMNOPQRS'), 'ABCDEFGHIJKLMNOP');
  // Flaggen bestehen aus zwei Codepoints – keine wird halbiert
  assert.equal(cleanName('\u{1F1E8}\u{1F1ED}'.repeat(20)), '\u{1F1E8}\u{1F1ED}'.repeat(16));
  // Emoji mit Verbinder (Familie) und Tag-Zeichen (England-Flagge) bleiben erhalten
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
  const england = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
  assert.equal(cleanName(`Fam ${family}`), `Fam ${family}`);
  assert.equal(cleanName(`Eng ${england}`), `Eng ${england}`);
  // Gestapelte Akzente werden auf wenige pro Zeichen gekürzt
  assert.equal(cleanName(`Anna${'\u0301'.repeat(500)}`), `Anná${'\u0301'.repeat(4)}`);
});

test('Namen: Vergleichsform erkennt gleich aussehende Namen', () => {
  for (const same of ['ANNA', 'Ánna', 'Anna\u034F', 'An\u00ADna']) {
    assert.equal(nameKey(same), nameKey('Anna'), same);
  }
  assert.notEqual(nameKey('Anna'), nameKey('Anne'));
  // Vokalzeichen indischer Schriften zählen (Ram vs. Rama auf Devanagari)
  const dev = (...cps) => String.fromCodePoint(...cps);
  assert.notEqual(nameKey(dev(0x930, 0x93E, 0x92E)), nameKey(dev(0x930, 0x92E, 0x93E)));
});

test('Mischen: liefert eine Permutation des Decks', () => {
  const deck = createDeck();
  const shuffled = shuffle(deck);
  assert.equal(shuffled.length, 36);
  assert.deepEqual(shuffled.map((c) => c.id).sort(), deck.map((c) => c.id).sort());
  assert.notStrictEqual(shuffled, deck);
});

test('Limits: Zeitfenster-Zähler sperrt nach max Treffern und gibt danach wieder frei', () => {
  const c = new WindowCounter(2, 1000);
  c.hit('a', 0);
  assert.equal(c.isBlocked('a', 10), false);
  c.hit('a', 20);
  assert.equal(c.isBlocked('a', 30), true);
  assert.equal(c.isBlocked('b', 30), false);
  assert.equal(c.isBlocked('a', 1000), false);
  c.prune(1000);
  assert.equal(c.entries.size, 0);
});

test('Limits: Token-Bucket lässt eine Spitze zu, bremst und füllt sich wieder auf', () => {
  const allow = tokenBucket(3, 2);
  const t = 1e6;
  assert.deepEqual([allow(t), allow(t), allow(t), allow(t)], [true, true, true, false]);
  assert.equal(allow(t + 250), false); // erst ein halber Token
  assert.equal(allow(t + 500), true); // 2 pro Sekunde -> nach 0,5 s einer
  // Eine rückwärts gestellte Uhr sperrt nicht dauerhaft
  assert.equal(allow(t - 60000), false);
  assert.equal(allow(t + 1000), true);
});

test('Limits: IPv6 zählt pro /64-Netz, IPv4 pro Adresse', () => {
  assert.equal(ipKey('203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:db8:1:2:ffff:eeee:dddd:cccc'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:0db8::1'), '2001:db8:0:0::/64');
  assert.equal(ipKey('::1'), '0:0:0:0::/64');
});

test('Limits: Client-IP aus Verbindung oder Proxy-Header', () => {
  assert.equal(clientIp({}, '10.0.0.5', ''), '10.0.0.5');
  assert.equal(clientIp({ 'cf-connecting-ip': '203.0.113.7' }, '10.0.0.5', 'cf-connecting-ip'), '203.0.113.7');
  assert.equal(clientIp({ 'cf-connecting-ip': '2001:db8::1' }, '10.0.0.5', 'cf-connecting-ip'), '2001:db8:0:0::/64');
  // Fehlt der Header oder ist er ungültig, gilt die IP als unbekannt (nicht die des Proxys)
  assert.equal(clientIp({}, '10.0.0.5', 'cf-connecting-ip'), null);
  assert.equal(clientIp({ 'cf-connecting-ip': '1.2.3.4, 5.6.7.8' }, '10.0.0.5', 'cf-connecting-ip'), null);
});
