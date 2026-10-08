'use strict';

const net = require('net');
const { performance } = require('perf_hooks');

/**
 * Grenzen gegen Missbrauch des öffentlichen Servers. Bewusst grosszügig: Hinter einer
 * IP können viele echte Spieler stecken (gemeinsames WLAN, NAT im Mobilfunknetz).
 */
const DEFAULT_LIMITS = {
  maxRooms: 5000, // Räume insgesamt (ein Raum braucht nur wenige KB)
  maxConnectionsPerIp: 50, // gleichzeitige Verbindungen pro IP
  roomsPerIpPer10Min: 20, // neu erstellte Räume pro IP
  joinFailuresPerMinute: 20, // falsche Raum-Codes pro IP (gegen Durchprobieren)
  eventBurst: 40, // Nachrichten pro Socket: kurze Spitze …
  eventsPerSecond: 20, // … und Dauerrate
  maxMessageBytes: 10_000, // grösste Nachricht eines Clients
};

/** Zählt Ereignisse pro Schlüssel (z. B. IP) in einem festen Zeitfenster. */
class WindowCounter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.entries = new Map();
  }

  isBlocked(key, now = Date.now()) {
    const e = this.entries.get(key);
    return Boolean(e) && now < e.resetAt && e.count >= this.max;
  }

  hit(key, now = Date.now()) {
    let e = this.entries.get(key);
    if (!e || now >= e.resetAt) {
      e = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(key, e);
    }
    e.count += 1;
  }

  /** Abgelaufene Einträge entfernen, damit die Map nicht unbegrenzt wächst. */
  prune(now = Date.now()) {
    for (const [key, e] of this.entries) {
      if (now >= e.resetAt) this.entries.delete(key);
    }
  }
}

/**
 * Token-Bucket: erlaubt kurze Spitzen, begrenzt aber die Dauerrate. Misst mit der
 * monotonen Uhr, damit eine verstellte Systemzeit nicht alle Sockets sperrt.
 */
function tokenBucket(capacity, refillPerSecond) {
  let tokens = capacity;
  let last = performance.now();
  return (now = performance.now()) => {
    tokens = Math.min(capacity, tokens + (Math.max(0, now - last) / 1000) * refillPerSecond);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

/**
 * Schlüssel für Limits pro Adresse. IPv6-Anschlüsse bekommen meist ein ganzes
 * /64-Netz – pro Einzeladresse zu zählen, liesse sich trivial umgehen.
 */
function ipKey(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (net.isIPv4(ip)) return ip;
  const [head, tail] = ip.split('%')[0].split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined
    ? left
    : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/**
 * Limit-Schlüssel des Clients oder null, wenn seine Adresse nicht verlässlich bekannt
 * ist. Hinter einem Proxy (Render → Cloudflare) sieht der Server nur die Adresse des
 * Proxys; die echte IP steht dann in `header` (z. B. cf-connecting-ip). Fehlt dieser
 * Header, gibt es null – sonst würden sich alle Spieler ein Limit teilen.
 */
function clientIp(headers, address, header) {
  const value = header ? String(headers[header] || '').trim() : String(address || '');
  return net.isIP(value) ? ipKey(value) : null;
}

module.exports = { DEFAULT_LIMITS, WindowCounter, tokenBucket, ipKey, clientIp };
