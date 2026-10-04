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

// Draft = one simultaneous ban phase (everyone bans at once, like ranked),
// then picks in ranked order B R R B B R R B B R.
// `slot` = which player of the team picks (0..4, players sorted by role).
const PICK_ORDER = (() => {
  const raw = ['blue', 'red', 'red', 'blue', 'blue', 'red', 'red', 'blue', 'blue', 'red'];
  const counts = {};
  return raw.map((team) => {
    counts[team] = (counts[team] || 0) + 1;
    return { type: 'pick', team, slot: counts[team] - 1 };
  });
})();
const DRAFT_ORDER = [{ type: 'ban' }, ...PICK_ORDER];

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
  const { bans, picks, banLocked } = draft;
  return [...bans.blue, ...bans.red, ...picks.blue, ...picks.red, ...Object.values(banLocked)].includes(champId);
}

const isBanStage = () => phase === 'draft' && draft.order[draft.step].type === 'ban';
const inRoster = (id) => [...draft.roster.blue, ...draft.roster.red].some((p) => p.id === id);

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
    banHover: {}, // ban phase: playerId -> champion they are hovering
    banLocked: {}, // ban phase: playerId -> champion they locked
    hover: null, // pick phase: champion hovered by the picking player
    actor: null, // pick phase: who is picking
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
  draft.actor = step.type === 'pick' ? actorFor(step) : null;

  // team with nobody in it: random pick right away
  const ms = step.type === 'ban' || draft.actor ? TURN_MS : 1000;
  draft.deadline = Date.now() + ms;
  turnTimer = setTimeout(onTimeout, ms);
  broadcastState();
}

// time ran out without lock in -> random ban(s) / random pick
function onTimeout() {
  if (phase !== 'draft') return;
  if (isBanStage()) finishBans();
  else lockIn(randomFreeChampion());
}

// ---------- Simultaneous ban phase ----------

function lockBan(playerId, champId) {
  draft.banLocked[playerId] = champId;
  delete draft.banHover[playerId];
  // nobody else can ban the same champion anymore
  for (const [id, c] of Object.entries(draft.banHover)) if (c === champId) delete draft.banHover[id];

  const everyone = [...draft.roster.blue, ...draft.roster.red];
  if (everyone.every((p) => draft.banLocked[p.id])) finishBans();
  else broadcastState();
}

// end of ban phase: players who didn't ban get a random ban,
// ban slots without a player (team smaller than 5) get a random ban too
function finishBans() {
  for (const p of [...draft.roster.blue, ...draft.roster.red]) {
    if (!draft.banLocked[p.id]) draft.banLocked[p.id] = randomFreeChampion();
  }
  for (const team of ['blue', 'red']) {
    for (let i = 0; i < TEAM_SIZE; i++) {
      const p = draft.roster[team][i];
      draft.bans[team].push(p ? draft.banLocked[p.id] : randomFreeChampion());
    }
  }
  draft.banHover = {};
  draft.step++;
  startTurn();
}

// ---------- Picks ----------

function lockIn(champId) {
  const { team } = draft.order[draft.step];
  draft.picks[team].push(champId);
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
  return phase === 'draft' && !isBanStage() && draft.actor === socket.id;
}

function canBan(socket) {
  return isBanStage() && inRoster(socket.id) && !draft.banLocked[socket.id];
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
    if (phase !== 'draft' || !championIds.has(champId) || isTaken(champId)) return;
    if (canBan(socket)) draft.banHover[socket.id] = champId;
    else if (canAct(socket)) draft.hover = champId;
    else return;
    broadcastState();
  });

  socket.on('lockIn', () => {
    if (canBan(socket)) {
      const champ = draft.banHover[socket.id];
      if (champ && !isTaken(champ)) lockBan(socket.id, champ);
    } else if (canAct(socket) && draft.hover && !isTaken(draft.hover)) {
      lockIn(draft.hover);
    }
  });

  // random pick / random ban button
  socket.on('lockRandom', () => {
    if (canBan(socket)) lockBan(socket.id, randomFreeChampion());
    else if (canAct(socket)) lockIn(randomFreeChampion());
  });

  // end the draft / result page and kick everyone back to Choose your team
  socket.on('terminate', () => {
    if (phase === 'lobby') return;
    resetAll();
    players.clear();
    console.log('lobby terminated');
    broadcastState();
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
