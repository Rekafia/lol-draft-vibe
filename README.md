# LoL Draft (Vibe Coding)

Real-time pick/ban draft pro League of Legends — součást experimentu „LoL Draft Build-Off".

## Spuštění lokálně

```bash
npm install
npm start
```

Pak otevři http://localhost:3000.

## Admin heslo

Force start (waiting room) a Terminate (draft, výsledek) může použít jen admin.
Admin se přihlásí kliknutím na indikátor **Připojeno** (tečku) v hlavičce. Heslo se nastaví při spuštění serveru:

```bash
ADMIN_PASSWORD=tvoje-heslo npm start
```

V PowerShellu: `$env:ADMIN_PASSWORD="tvoje-heslo"; npm start`

Když heslo nenastavíš, server si vygeneruje náhodné a vypíše ho do konzole při startu.
V Dockeru ho nastav v souboru `.env` vedle `docker-compose.yml` (`ADMIN_PASSWORD=tvoje-heslo`).

## Spuštění v Dockeru

```bash
docker compose up --build
```

nebo bez compose:

```bash
docker build -t lol-draft-vibe .
docker run -p 3000:3000 lol-draft-vibe
```

Pak otevři http://localhost:3000. Server potřebuje přístup k internetu (stahuje data šampionů z Data Dragonu).

## Stack

- Node.js + Express + Socket.IO (server drží stav, posílá změny všem klientům)
- Čisté HTML/CSS/JS ve složce `public/`
