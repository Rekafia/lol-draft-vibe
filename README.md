# LoL Draft (Vibe Coding)

Real-time pick/ban draft pro League of Legends — součást experimentu „LoL Draft Build-Off".

## Spuštění lokálně

```bash
npm install
npm start
```

Pak otevři http://localhost:3000.

## Stack

- Node.js + Express + Socket.IO (server drží stav, posílá změny všem klientům)
- Čisté HTML/CSS/JS ve složce `public/`
