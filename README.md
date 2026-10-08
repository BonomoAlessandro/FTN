# Stichraten

Online-Multiplayer-Kartenspiel mit **Schweizer Jasskarten** für **3 bis 7 Spieler**. Jeder
Spieler sagt vor jeder Runde an, wie viele Stiche er machen wird – wer richtig liegt, punktet.
Gespielt wird im Browser über einen gemeinsamen Raum-Code, ideal mit dem Handy am selben Tisch.

Die vollständigen Spielregeln stehen in [SPIELANLEITUNG.md](SPIELANLEITUNG.md) und sind auch
im Spiel über den Knopf **Spielregeln** abrufbar.

## Funktionen

- **Echtzeit-Multiplayer** über WebSockets (Socket.io) – jeder spielt auf seinem eigenen Gerät.
- **Raum-System**: Ein Spieler erstellt einen Raum, die anderen treten mit einem 4-stelligen Code bei
  – oder direkt über den Einladungslink (`/?code=ABCD`), der sich aus der Lobby teilen lässt.
- **Server-autoritative Spiellogik**: Der Server hält den gesamten Spielzustand; Karten der
  Mitspieler bleiben verdeckt und können nicht ausgelesen werden.
- **Automatischer Reconnect**: Nach Bildschirmsperre, App-Wechsel oder Seiten-Reload kommt man
  per Sitzungs-Token zurück ins laufende Spiel. In der Lobby bleibt der Platz 90 Sekunden reserviert.
- **Host-Vertretung**: Ist der Host offline, übernimmt der nächste verbundene Spieler dessen Knöpfe
  (z. B. «Nächste Runde»), damit das Spiel nie hängen bleibt.
- **Neues Spiel ohne Abwesende**: «Spiel starten» und «Nochmal spielen» lassen Spieler, die offline
  sind, nach Rückfrage weg. Sind nach Spielende zu wenige online, führt «Zurück zur Lobby» in den
  Warteraum, wo Neue beitreten können.
- **Vollständige Spielmechanik**: Ansage-Regeln, Stich-Duelle bei Gleichstand, Blindrunden
  (1-Karten-Runden) und Zufallsziehen beim letzten Stich.
- **Mobile-first**: Reine HTML/CSS/JS-Oberfläche ohne Build-Schritt, optimiert für Handys
  (Safe-Areas, Vibration wenn man dran ist, Bildschirm bleibt während des Spiels wach).
  Alles, was man gerade tun muss, liegt im Bedienfeld unten im Daumenbereich; im Querformat
  steht es rechts neben dem Tisch. Lässt sich als App auf den Homescreen legen.
- **Hilfen beim Spielen**: Gesperrte Ansagen nennen den Grund («mit 2 ergäbe die Summe genau 5»),
  beim Antippen einer Karte steht sofort, ob sie die Führung übernimmt, und der Rundenplan
  oben zeigt jederzeit, welche Runde läuft und wann die Blindrunden kommen.
- **Punkte & Verlauf**: Zwischenstand und für jede der 10 Runden, wer wie viele Stiche angesagt
  und gemacht hat – inkl. Hinweis, welche Zahl nach Regel 2 gesperrt ist. Treffer und
  Fehlschläge sind mit Symbol und Farbe markiert.
- **Jasskarten mit Schweizer Farbzeichen** (Rosen, Schellen, Eicheln, Schilten): Weil nur der Wert
  zählt, steht er gross auf der Karte, ein Balken zeigt die Stärke von 6 bis Ass.

## Technologie

- **Node.js** mit **Express 5** (HTTP-Server, Auslieferung der statischen Dateien)
- **Socket.io 4** (Echtzeit-Kommunikation zwischen Server und Clients)
- **Vanilla JavaScript** im Browser – kein Framework, kein Bundler
- Tests mit dem eingebauten **`node:test`**-Runner

## Voraussetzungen

- [Node.js](https://nodejs.org/) **22 bis 24** (siehe `engines` in `package.json`; Render wählt daraus die neueste Version)

## Installation & Start

```bash
# Abhängigkeiten installieren
npm install

# Server starten
npm start
```

Der Server läuft danach auf **http://localhost:3000**. Beim Start werden zusätzlich die
WLAN-Adressen ausgegeben (z. B. `http://192.168.x.x:3000`) – darüber können sich Handys im
selben Netzwerk verbinden.

Der Port lässt sich über die Umgebungsvariable `PORT` ändern:

```bash
PORT=8080 npm start
```

> **Hinweis:** Die Spiellogik läuft im Node-Server. Änderungen am Server-Code werden erst nach
> einem **Neustart des Prozesses** wirksam – ein Neuladen der Browser-Seite genügt nicht.

### Öffentlicher Betrieb

Der Server begrenzt Missbrauch: gleichzeitige Verbindungen und neue Räume pro IP, falsche
Raum-Codes pro IP (gegen Durchprobieren), Nachrichten pro Verbindung, Nachrichtengrösse und
die Anzahl Räume insgesamt. Die Werte stehen in `server/limits.js`.

Hinter einem Proxy sieht der Server nur dessen Adresse. Die echte Client-IP liest er dann aus
dem Header in `CLIENT_IP_HEADER`. Auf **Render** (`RENDER=true`) ist das automatisch
`cf-connecting-ip`, den Cloudflare vor Render setzt. Fehlt der Header, gelten die Limits pro
Verbindung statt pro IP.

## Spielen

1. Server starten und die Adresse im Browser öffnen.
2. Namen eingeben und **Raum erstellen** – der Ersteller ist der Host.
3. Mitspieler öffnen dieselbe Adresse und treten mit dem angezeigten **4-stelligen Code** bei.
4. Sobald mindestens 3 Spieler im Raum sind, startet der Host das Spiel.
5. Es werden 10 Runden gespielt – nach der letzten Runde gewinnt, wer die meisten Punkte hat.

## Spielregeln in Kürze

- **36 Jasskarten**, nur der Wert zählt: `6 < 7 < 8 < 9 < 10 < Under < Ober < König < Ass`.
  Kein Trumpf, kein Bedienzwang.
- **10 Runden** mit `5 → 4 → 3 → 2 → 1 → 1 → 2 → 3 → 4 → 5` Karten pro Spieler.
- Jede Runde: **Ansagen → Stiche spielen → Punkte werten**.
- **Ansage korrekt:** `10 + Stiche²` Punkte. **Ansage falsch:** `−5` Punkte pro Stich Abweichung.
- Bei Gleichstand der höchsten Karte gibt es ein **Stich-Duell**; die 1-Karten-Runden sind
  **Blindrunden** (man sieht nur die Karten der anderen).

Ausführlich: siehe [SPIELANLEITUNG.md](SPIELANLEITUNG.md).

## Projektstruktur

```
FTN/
├── server/
│   ├── index.js   # Express- + Socket.io-Server: Räume, Verbindungen, Events
│   ├── game.js    # Spiellogik als Zustandsmaschine (Ansagen, Stiche, Wertung)
│   ├── deck.js    # 36-Karten-Deck und Mischen
│   └── limits.js  # Grenzen gegen Missbrauch (Verbindungen, Räume, Nachrichten)
├── public/
│   ├── index.html # Single-Page-Client (Start, Lobby, Spiel)
│   ├── app.js     # Client-Logik und Socket.io-Anbindung
│   ├── cards.js   # Jasskarten (Farbzeichen-Sprite liegt in index.html)
│   ├── style.css  # Mobile-first-Styling inkl. Querformat
│   ├── fonts/     # Figtree und Bricolage Grotesque (selbst gehostet, SIL Open Font License)
│   ├── icon.svg   # App-Icon
│   └── manifest.webmanifest # «Zum Home-Bildschirm» (PWA-Manifest)
├── test/
│   ├── game.test.js   # Unit-Tests der Spiellogik
│   ├── server.test.js # Unit-Tests für Namen, Mischen und Limits
│   └── e2e.test.js    # End-to-End-Tests über den echten Server
├── SPIELANLEITUNG.md
└── package.json
```

## Tests

```bash
npm test
```

Führt die Unit-Tests (`test/game.test.js`, `test/server.test.js`) sowie die End-to-End-Tests
über den echten Server aus (`test/e2e.test.js`): ein komplettes Spiel mit drei Clients,
Reconnect, Host-Vertretung, Spielende mit Offline-Spielern und die Limits gegen Missbrauch.
