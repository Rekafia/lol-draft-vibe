# LoL Draft (Vibe Coding)

Real-time pick/ban draft pro League of Legends — součást experimentu „LoL Draft Build-Off".

## Spuštění lokálně

```bash
npm install
npm start
```

Pak otevři http://localhost:3000.

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
