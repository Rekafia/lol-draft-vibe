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
const ROLES = ['top', 'jungle', 'mid', 'adc', 'support'];

// Tournament draft order: 6 bans, 6 picks, 4 bans, 4 picks.
// `slot` = which player of the team acts (0..4, players sorted by role).
const DRAFT_ORDER = (() => {
  const raw = [
    ['ban', 'blue'], ['ban', 'red'], ['ban', 'blue'], ['ban', 'red'], ['ban', 'blue'], ['ban', 'red'],
    ['pick', 'blue'], ['pick', 'red'], ['pick', 'red'], ['pick', 'blue'], ['pick', 'blue'], ['pick', 'red'],
    ['ban', 'red'], ['ban', 'blue'], ['ban', 'red'], ['ban', 'blue'],
    ['pick', 'red'], ['pick', 'blue'], ['pick', 'blue'], ['pick', 'red'],
  ];
  const counts = {};
  return raw.map(([type, team]) => {
    const key = type + team;
    counts[key] = (counts[key] || 0) + 1;
    return { type, team, slot: counts[key] - 1 };
  });
})();

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

// socket.id -> { name, team, role }
const players = new Map();
// 'lobby' = choose team + waiting room, 'draft' = draft in progress, 'done' = result page
let phase = 'lobby';
let draft = null;
let turnTimer = null;

const randomOf = (arr) => arr[Math.floor(Math.random() * arr.length)];

function autoName() {
  return `Hráč-${Math.floor(10 + Math.random() * 90)}`;
}

function teamMembers(team) {
  return [...players].filter(([, p]) => p.team === team);
}

function freeRoles(team, exceptId) {
  const used = teamMembers(team).filter(([id]) => id !== exceptId).map(([, p]) => p.role);
  return ROLES.filter((r) => !used.includes(r));
}

function broadcastState() {
  io.emit('state', {
    phase,
    teamSize: TEAM_SIZE,
    roles: ROLES,
    players: [...players].map(([id, p]) => ({ id, name: p.name, team: p.team, role: p.role })),
    draft,
    serverNow: Date.now(),
  });
}

// 5v5 and everybody picked a role -> start automatically
function checkAutoStart() {
  const all = [...players.values()];
  const full = teamMembers('blue').length === TEAM_SIZE && teamMembers('red').length === TEAM_SIZE;
  if (full && all.every((p) => p.role)) startDraft();
}

// ---------- Draft ----------

function isTaken(champId) {
  const { bans, picks } = draft;
  return [...bans.blue, ...bans.red, ...picks.blue, ...picks.red].includes(champId);
}

function randomFreeChampion() {
  return randomOf(champions.filter((c) => !isTaken(c.id))).id;
}

function startDraft() {
  if (phase !== 'lobby' || !ddVersion) return;

  // players without a role get a random free one
  for (const [id, p] of players) {
    if (!p.role) p.role = randomOf(freeRoles(p.team, id));
  }

  // roster snapshot, sorted by role (top -> support)
  const roster = {};
  for (const team of ['blue', 'red']) {
    roster[team] = teamMembers(team)
      .map(([id, p]) => ({ id, name: p.name, role: p.role }))
      .sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role));
  }

  phase = 'draft';
  draft = {
    order: DRAFT_ORDER,
    roster,
    step: 0,
    bans: { blue: [], red: [] },
    picks: { blue: [], red: [] },
    hover: null,
    actor: null,
    deadline: 0,
    turnMs: TURN_MS,
  };
  console.log('draft started');
  startTurn();
}

// who acts on this step; with fewer than 5 players in a team they take turns
function actorFor(step) {
  const list = draft.roster[step.team];
  return list.length ? list[step.slot % list.length].id : null;
}

function startTurn() {
  clearTimeout(turnTimer);
  const step = draft.order[draft.step];
  draft.hover = null;
  draft.actor = actorFor(step);

  // team with nobody in it: random ban/pick right away
  const ms = draft.actor ? TURN_MS : 1000;
  draft.deadline = Date.now() + ms;
  turnTimer = setTimeout(onTimeout, ms);
  broadcastState();
}

// time ran out without lock in -> random ban / random pick
function onTimeout() {
  if (phase !== 'draft') return;
  lockIn(randomFreeChampion());
}

function lockIn(champId) {
  const { type, team } = draft.order[draft.step];
  (type === 'ban' ? draft.bans : draft.picks)[team].push(champId);
  draft.step++;

  if (draft.step >= draft.order.length) {
    clearTimeout(turnTimer);
    phase = 'done';
    draft.hover = null;
    draft.actor = null;
    console.log('draft finished');
    broadcastState();
    return;
  }
  startTurn();
}

function canAct(socket) {
  return phase === 'draft' && draft.actor === socket.id;
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
    const blueFree = teamMembers('blue').length < TEAM_SIZE;
    const redFree = teamMembers('red').length < TEAM_SIZE;

    let chosen = team;
    if (chosen === 'random') {
      if (blueFree && redFree) chosen = Math.random() < 0.5 ? 'blue' : 'red';
      else chosen = blueFree ? 'blue' : redFree ? 'red' : null;
    }
    if (chosen !== 'blue' && chosen !== 'red') return socket.emit('joinError', 'Oba týmy jsou plné.');
    if ((chosen === 'blue' && !blueFree) || (chosen === 'red' && !redFree)) {
      return socket.emit('joinError', 'Tenhle tým je plný.');
    }

    players.set(socket.id, { name: cleanName, team: chosen, role: null });
    broadcastState();
  });

  // role: one of ROLES or 'random'; each role only once per team
  socket.on('setRole', (role) => {
    const p = players.get(socket.id);
    if (phase !== 'lobby' || !p) return;
    const free = freeRoles(p.team, socket.id);
    if (role === 'random') role = randomOf(free.filter((r) => r !== p.role)) || p.role;
    if (!free.includes(role)) return;
    p.role = role;
    broadcastState();
    checkAutoStart();
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

  // random pick / random ban button
  socket.on('lockRandom', () => {
    if (!canAct(socket)) return;
    lockIn(randomFreeChampion());
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
