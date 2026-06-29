# Stichraten

Online-Multiplayer-Kartenspiel mit **Schweizer Jasskarten** für **3 bis 7 Spieler**. Jeder
Spieler sagt vor jeder Runde an, wie viele Stiche er machen wird – wer richtig liegt, punktet.
Gespielt wird im Browser über einen gemeinsamen Raum-Code, ideal mit dem Handy am selben Tisch.

Die vollständigen Spielregeln stehen in [SPIELANLEITUNG.md](SPIELANLEITUNG.md) und sind auch
im Spiel über den Button **📖 Spielanleitung** abrufbar.

## Funktionen

- **Echtzeit-Multiplayer** über WebSockets (Socket.io) – jeder spielt auf seinem eigenen Gerät.
- **Raum-System**: Ein Spieler erstellt einen Raum, die anderen treten mit einem 4-stelligen Code bei.
- **Server-autoritative Spiellogik**: Der Server hält den gesamten Spielzustand; Karten der
  Mitspieler bleiben verdeckt und können nicht ausgelesen werden.
- **Automatischer Reconnect**: Nach Bildschirmsperre, App-Wechsel oder Seiten-Reload kommt man
  per Sitzungs-Token zurück ins laufende Spiel.
- **Vollständige Spielmechanik**: Ansage-Regeln, Stich-Duelle bei Gleichstand, Blindrunden
  (1-Karten-Runden) und Zufallsziehen beim letzten Stich.
- **Mobile-first**: Reine HTML/CSS/JS-Oberfläche ohne Build-Schritt.

## Technologie

- **Node.js** mit **Express 5** (HTTP-Server, Auslieferung der statischen Dateien)
- **Socket.io 4** (Echtzeit-Kommunikation zwischen Server und Clients)
- **Vanilla JavaScript** im Browser – kein Framework, kein Bundler
- Tests mit dem eingebauten **`node:test`**-Runner

## Voraussetzungen

- [Node.js](https://nodejs.org/) **18 oder neuer** (Express 5 setzt Node ≥ 18 voraus)

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
│   └── deck.js    # 36-Karten-Deck und Mischen
├── public/
│   ├── index.html # Single-Page-Client (Start, Lobby, Spiel)
│   ├── app.js     # Client-Logik und Socket.io-Anbindung
│   └── style.css  # Mobile-first-Styling
├── test/
│   ├── game.test.js # Unit-Tests der Spiellogik
│   └── e2e.test.js  # End-to-End-Test über den echten Server
├── SPIELANLEITUNG.md
└── package.json
```

## Tests

```bash
npm test
```

Führt die Unit-Tests der Spiellogik (`test/game.test.js`) sowie den End-to-End-Test aus, der
drei Clients über den echten Server ein komplettes Spiel durchspielen lässt (`test/e2e.test.js`).
