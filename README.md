# LoL Draft (Vibe Coding)

Real-time pick/ban draft pro League of Legends — součást experimentu „LoL Draft Build-Off".

## Spuštění lokálně

Potřeba: [Node.js](https://nodejs.org) 20.12 nebo novější.

```bash
npm install
npm start
```

Pak otevři http://localhost:3000.

## Nasazení na server

### Varianta A: Node.js

```bash
git clone https://github.com/Rekafia/lol-draft-vibe.git
cd lol-draft-vibe
npm install --omit=dev
npm start
```

Appka poběží na portu 3000. Jiný port: `PORT=8080 npm start`.
Aby běžela i po odhlášení / restartu serveru, spusť ji přes správce procesů, např. [pm2](https://pm2.keymetrics.io):

```bash
npm install -g pm2
pm2 start server.js --name lol-draft
pm2 save
pm2 startup
```

### Varianta B: Docker

```bash
git clone https://github.com/Rekafia/lol-draft-vibe.git
cd lol-draft-vibe
docker compose up -d --build
```

Appka poběží na portu 3000 a po pádu / restartu serveru se sama znovu spustí.

### Poznámky k serveru

- Server potřebuje přístup k internetu — při startu stahuje data šampionů z Data Dragonu.
- Port 3000 musí být otevřený ve firewallu, nebo appku dej za reverse proxy (nginx, Caddy…).
  Proxy musí propouštět **WebSockety** (živá synchronizace běží přes Socket.IO). Příklad pro Caddy:

  ```
  draft.tvoje-domena.cz {
      reverse_proxy localhost:3000
  }
  ```

## Kapitán

První hráč, který se připojí do lobby (vybere si tým), je **kapitán** 👑.
Jen kapitán může použít Force start (waiting room) a Terminate (draft, výsledek).
Když kapitán odejde, kapitánem se stane hráč, který se připojil nejdřív po něm.

## Stack

- Node.js + Express + Socket.IO (server drží stav, posílá změny všem klientům)
- Čisté HTML/CSS/JS ve složce `public/`
- Data šampionů, ikony a splash arty z Riot Data Dragonu
