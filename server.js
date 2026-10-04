const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

// socket.id -> { name, team }
const players = new Map();

function autoName() {
  return `Hráč-${Math.floor(10 + Math.random() * 90)}`;
}

io.on('connection', (socket) => {
  console.log('client connected', socket.id);

  socket.on('joinTeam', ({ name, team } = {}) => {
    const cleanName = String(name || '').trim().slice(0, 20) || autoName();
    let chosen = team;
    if (chosen === 'random') chosen = Math.random() < 0.5 ? 'blue' : 'red';
    if (chosen !== 'blue' && chosen !== 'red') return;

    players.set(socket.id, { name: cleanName, team: chosen });
    socket.emit('joined', { name: cleanName, team: chosen });
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    console.log('client disconnected', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`LoL Draft running on http://localhost:${PORT}`);
});
