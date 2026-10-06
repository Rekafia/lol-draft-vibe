const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

// optional .env file (PORT)
try { process.loadEnvFile(); } catch { /* no .env */ }

const PORT = process.env.PORT || 9020;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

const TEAM_SIZE = 5;
const TURN_MS = 30 * 1000; // 30 s per ban/pick, same as LoL champ select
const ROLES = ['top', 'jungle', 'mid', 'adc', 'support'];

// Draft = one simultaneous ban phase (everyone bans at once, like ranked),
// then picks in ranked order 1-2-2-2-2-1 (first, second, second, first, first, ...).
// Which side gets first pick is random.
// Only players who are really there ban/pick: with e.g. 3v4 each team keeps
// just its first 3 / 4 turns of the order.
// `slot` = position in the team's pick order (random at start, players can trade it).
const RANKED_PICKS = [0, 1, 1, 0, 0, 1, 1, 0, 0, 1]; // 0 = first-pick side, 1 = the other side

function draftOrder(blueCount, redCount) {
  const sides = Math.random() < 0.5 ? ['blue', 'red'] : ['red', 'blue'];
  const limit = { blue: blueCount, red: redCount };
  const counts = { blue: 0, red: 0 };
  const picks = [];
  for (const team of RANKED_PICKS.map((i) => sides[i])) {
    if (counts[team] < limit[team]) picks.push({ type: 'pick', team, slot: counts[team]++ });
  }
  return [{ type: 'ban' }, ...picks];
}

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

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

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

// Captain = the first player who joined the lobby. Only the captain can Force start and Terminate.
// When the captain leaves, the next player who joined earliest becomes captain.
let captainId = null;

function currentCaptain() {
  if (!players.has(captainId)) captainId = players.keys().next().value ?? null;
  return captainId;
}

function broadcastState() {
  io.emit('state', {
    phase,
    captain: currentCaptain(),
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

  // roster snapshot in random order = pick order inside the team (players can trade it later)
  const roster = {};
  for (const team of ['blue', 'red']) {
    roster[team] = shuffle(teamMembers(team).map(([id, p]) => ({ id, name: p.name, role: p.role })));
  }

  phase = 'draft';
  draft = {
    order: draftOrder(roster.blue.length, roster.red.length),
    roster,
    step: 0,
    bans: { blue: [], red: [] },
    picks: { blue: [], red: [] },
    banHover: {}, // ban phase: playerId -> champion they are hovering
    banLocked: {}, // ban phase: playerId -> champion they locked
    hover: null, // pick phase: champion hovered by the picking player
    actor: null, // pick phase: who is picking
    trades: [], // pending pick order trade requests: [{ from, to }]
    deadline: 0,
    turnMs: TURN_MS,
  };
  console.log('draft started');
  startTurn();
}

function startTurn() {
  clearTimeout(turnTimer);
  const step = draft.order[draft.step];
  draft.hover = null;
  draft.actor = step.type === 'pick' ? draft.roster[step.team][step.slot].id : null;
  draft.trades = draft.trades.filter((t) => canTrade(t.from, t.to)); // drop trades that are no longer possible
  draft.deadline = Date.now() + TURN_MS;
  turnTimer = setTimeout(onTimeout, TURN_MS);
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

// end of ban phase: players who didn't ban get a random ban
function finishBans() {
  for (const team of ['blue', 'red']) {
    for (const p of draft.roster[team]) {
      if (!draft.banLocked[p.id]) draft.banLocked[p.id] = randomFreeChampion();
      draft.bans[team].push(draft.banLocked[p.id]);
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

// ---------- Pick order trades (like in LoL) ----------

// position of a player in their team's pick order -> { team, index }
function rosterPos(id) {
  for (const team of ['blue', 'red']) {
    const index = draft.roster[team].findIndex((p) => p.id === id);
    if (index !== -1) return { team, index };
  }
  return null;
}

// teammates can trade pick order while neither of them has picked yet and neither is picking right now
function canTrade(a, b) {
  if (phase !== 'draft' || a === b) return false;
  const pa = rosterPos(a);
  const pb = rosterPos(b);
  if (!pa || !pb || pa.team !== pb.team) return false;
  const picked = draft.picks[pa.team].length;
  return pa.index >= picked && pb.index >= picked && a !== draft.actor && b !== draft.actor;
}

function swapPickOrder(a, b) {
  const pa = rosterPos(a);
  const pb = rosterPos(b);
  const list = draft.roster[pa.team];
  [list[pa.index], list[pb.index]] = [list[pb.index], list[pa.index]];
  draft.trades = draft.trades.filter((t) => ![a, b].includes(t.from) && ![a, b].includes(t.to));
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
    const others = (t) => teamMembers(t).filter(([id]) => id !== socket.id).length;
    const blueFree = others('blue') < TEAM_SIZE;
    const redFree = others('red') < TEAM_SIZE;

    let chosen = team;
    if (chosen === 'random') {
      if (blueFree && redFree) chosen = Math.random() < 0.5 ? 'blue' : 'red';
      else chosen = blueFree ? 'blue' : redFree ? 'red' : null;
    }
    if (chosen !== 'blue' && chosen !== 'red') return socket.emit('joinError', 'Oba týmy jsou plné.');
    if ((chosen === 'blue' && !blueFree) || (chosen === 'red' && !redFree)) {
      return socket.emit('joinError', 'Tenhle tým je plný.');
    }

    players.set(socket.id, { name: cleanName, team: chosen, role: null }); // keeps join order when switching
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

  // captain only
  socket.on('forceStart', () => {
    if (socket.id !== currentCaptain() || phase !== 'lobby') return;
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
  // ----- pick order trades -----
  socket.on('tradeRequest', (to) => {
    if (!canTrade(socket.id, to)) return;
    // one outgoing request at a time
    draft.trades = draft.trades.filter((t) => t.from !== socket.id);
    draft.trades.push({ from: socket.id, to });
    broadcastState();
  });

  socket.on('tradeCancel', () => {
    if (phase !== 'draft') return;
    draft.trades = draft.trades.filter((t) => t.from !== socket.id);
    broadcastState();
  });

  socket.on('tradeAnswer', ({ from, accept } = {}) => {
    if (phase !== 'draft') return;
    const exists = draft.trades.some((t) => t.from === from && t.to === socket.id);
    if (!exists) return;
    if (accept && canTrade(from, socket.id)) swapPickOrder(from, socket.id);
    else draft.trades = draft.trades.filter((t) => !(t.from === from && t.to === socket.id));
    broadcastState();
  });

  socket.on('lockRandom', () => {
    if (canBan(socket)) lockBan(socket.id, randomFreeChampion());
    else if (canAct(socket)) lockIn(randomFreeChampion());
  });

  // end the draft / result page and kick everyone back to Choose your team
  // captain only
  socket.on('terminate', () => {
    if (socket.id !== currentCaptain() || phase === 'lobby') return;
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
  console.log(`LoL Draft running on http://localhost:${PORT}`);});
