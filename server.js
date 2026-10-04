const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

const TEAM_SIZE = 5;

// socket.id -> { name, team }
const players = new Map();
// 'lobby' = choose team + waiting room, 'draft' = draft in progress
let phase = 'lobby';

function autoName() {
  return `Hráč-${Math.floor(10 + Math.random() * 90)}`;
}

function teamCount(team) {
  let n = 0;
  for (const p of players.values()) if (p.team === team) n++;
  return n;
}

function broadcastState() {
  io.emit('state', {
    phase,
    teamSize: TEAM_SIZE,
    players: [...players].map(([id, p]) => ({ id, name: p.name, team: p.team })),
  });
}

function startDraft() {
  if (phase !== 'lobby') return;
  phase = 'draft';
  console.log('draft started');
  broadcastState();
}

io.on('connection', (socket) => {
  console.log('client connected', socket.id);
  broadcastState();

  socket.on('joinTeam', ({ name, team } = {}) => {
    if (phase !== 'lobby') return;
    const cleanName = String(name || '').trim().slice(0, 20) || autoName();

    // switching teams: don't count yourself
    players.delete(socket.id);
    const blueFree = teamCount('blue') < TEAM_SIZE;
    const redFree = teamCount('red') < TEAM_SIZE;

    let chosen = team;
    if (chosen === 'random') {
      if (blueFree && redFree) chosen = Math.random() < 0.5 ? 'blue' : 'red';
      else chosen = blueFree ? 'blue' : redFree ? 'red' : null;
    }
    if (chosen !== 'blue' && chosen !== 'red') return socket.emit('joinError', 'Oba týmy jsou plné.');
    if ((chosen === 'blue' && !blueFree) || (chosen === 'red' && !redFree)) {
      return socket.emit('joinError', 'Tenhle tým je plný.');
    }

    players.set(socket.id, { name: cleanName, team: chosen });
    broadcastState();

    if (teamCount('blue') === TEAM_SIZE && teamCount('red') === TEAM_SIZE) startDraft();
  });

  socket.on('leaveTeam', () => {
    if (phase !== 'lobby' || !players.has(socket.id)) return;
    players.delete(socket.id);
    broadcastState();
  });

  socket.on('forceStart', () => {
    if (!players.has(socket.id)) return;
    startDraft();
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    // nobody left -> reset so the next group starts from the lobby
    if (io.of('/').sockets.size === 0) phase = 'lobby';
    broadcastState();
    console.log('client disconnected', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`LoL Draft running on http://localhost:${PORT}`);
});
