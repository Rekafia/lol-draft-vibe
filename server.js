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
const TURN_MS = 30 * 1000; // 30 s per ban/pick, same as LoL champ select

// Tournament draft order: 6 bans, 6 picks, 4 bans, 4 picks
const DRAFT_ORDER = [
  ['ban', 'blue'], ['ban', 'red'], ['ban', 'blue'], ['ban', 'red'], ['ban', 'blue'], ['ban', 'red'],
  ['pick', 'blue'], ['pick', 'red'], ['pick', 'red'], ['pick', 'blue'], ['pick', 'blue'], ['pick', 'red'],
  ['ban', 'red'], ['ban', 'blue'], ['ban', 'red'], ['ban', 'blue'],
  ['pick', 'red'], ['pick', 'blue'], ['pick', 'blue'], ['pick', 'red'],
].map(([type, team]) => ({ type, team }));

// ---------- Champion data (Data Dragon) ----------

let ddVersion = null;
let champions = []; // [{ id, name }]
let championIds = new Set();

async function loadChampions() {
  try {
    const versions = await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json();
    const version = versions[0];
    const data = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`)).json();
    champions = Object.values(data.data)
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    championIds = new Set(champions.map((c) => c.id));
    ddVersion = version;
    console.log(`Loaded ${champions.length} champions (Data Dragon ${version})`);
    io.emit('champions', { version: ddVersion, champions });
  } catch (err) {
    console.error('Failed to load champions, retrying in 10 s:', err.message, err.cause?.code || '');
    setTimeout(loadChampions, 10000);
  }
}
loadChampions();

// ---------- Lobby state ----------

// socket.id -> { name, team }
const players = new Map();
// 'lobby' = choose team + waiting room, 'draft' = draft in progress, 'done' = draft finished
let phase = 'lobby';
let draft = null;
let turnTimer = null;

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
    draft,
    serverNow: Date.now(),
  });
}

// ---------- Draft ----------

function isTaken(champId) {
  const { bans, picks } = draft;
  return [...bans.blue, ...bans.red, ...picks.blue, ...picks.red].includes(champId);
}

function startDraft() {
  if (phase !== 'lobby' || !ddVersion) return;
  phase = 'draft';
  draft = {
    order: DRAFT_ORDER,
    step: 0,
    bans: { blue: [], red: [] },
    picks: { blue: [], red: [] },
    hover: null,
    deadline: 0,
    turnMs: TURN_MS,
  };
  console.log('draft started');
  startTurn();
}

function startTurn() {
  clearTimeout(turnTimer);
  draft.hover = null;
  draft.deadline = Date.now() + TURN_MS;
  turnTimer = setTimeout(onTimeout, TURN_MS);
  broadcastState();
}

// Time ran out: lock the hovered champion; otherwise skip the ban / pick a random champion
function onTimeout() {
  if (phase !== 'draft') return;
  const { type } = draft.order[draft.step];
  let champ = draft.hover && !isTaken(draft.hover) ? draft.hover : null;
  if (!champ && type === 'pick') {
    const free = champions.filter((c) => !isTaken(c.id));
    champ = free[Math.floor(Math.random() * free.length)].id;
  }
  lockIn(champ);
}

function lockIn(champId) {
  const { type, team } = draft.order[draft.step];
  (type === 'ban' ? draft.bans : draft.picks)[team].push(champId);
  draft.step++;

  if (draft.step >= draft.order.length) {
    clearTimeout(turnTimer);
    phase = 'done';
    draft.hover = null;
    console.log('draft finished');
    broadcastState();
    return;
  }
  startTurn();
}

// is it this socket's team's turn?
function canAct(socket) {
  if (phase !== 'draft') return false;
  const p = players.get(socket.id);
  return p && p.team === draft.order[draft.step].team;
}

function resetAll() {
  clearTimeout(turnTimer);
  phase = 'lobby';
  draft = null;
}

// ---------- Socket handlers ----------

io.on('connection', (socket) => {
  console.log('client connected', socket.id);
  if (ddVersion) socket.emit('champions', { version: ddVersion, champions });
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
    if (!ddVersion) return socket.emit('joinError', 'Data šampionů se ještě načítají, zkus to za chvíli.');
    startDraft();
  });

  // select a champion (visible to everyone before lock in)
  socket.on('hover', (champId) => {
    if (!canAct(socket) || !championIds.has(champId) || isTaken(champId)) return;
    draft.hover = champId;
    broadcastState();
  });

  socket.on('lockIn', () => {
    if (!canAct(socket) || !draft.hover || isTaken(draft.hover)) return;
    lockIn(draft.hover);
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    // nobody left -> reset so the next group starts from the lobby
    if (io.of('/').sockets.size === 0) resetAll();
    broadcastState();
    console.log('client disconnected', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`LoL Draft running on http://localhost:${PORT}`);
});
