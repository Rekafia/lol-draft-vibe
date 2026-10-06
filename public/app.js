const socket = io();
const connEl = document.getElementById('conn');
const statusEl = document.getElementById('status');

const nameInput = document.getElementById('name-input');
const errorEl = document.getElementById('join-error');
const btnBlue = document.getElementById('btn-blue');
const btnRed = document.getElementById('btn-red');
const btnRandom = document.getElementById('btn-random');

const views = {
  choose: document.getElementById('view-choose'),
  waiting: document.getElementById('view-waiting'),
  draft: document.getElementById('view-draft'),
  result: document.getElementById('view-result'),
};

const ROLE_LABELS = { top: 'Top', jungle: 'Jungle', mid: 'Mid', adc: 'ADC', support: 'Support' };

// crown in front of the captain's name
const crown = (p) => (p && p.id === captainId ? '👑 ' : '');

socket.on('connect', () => {
  connEl.className = 'conn online';
  statusEl.textContent = 'Připojeno';
});

socket.on('disconnect', () => {
  connEl.className = 'conn offline';
  statusEl.textContent = 'Odpojeno — zkouším znovu…';
});

// ---------- Choose your team ----------

// team: 'blue' | 'red' | 'random'
function joinTeam(team) {
  errorEl.textContent = '';
  socket.emit('joinTeam', { name: nameInput.value.trim(), team });
}

btnRandom.addEventListener('click', () => joinTeam('random'));
btnBlue.addEventListener('click', () => joinTeam('blue'));
btnRed.addEventListener('click', () => joinTeam('red'));

socket.on('joinError', (msg) => { errorEl.textContent = msg; });

// ---------- Waiting room ----------

// clicking the logo leaves the waiting room and goes back to Choose your team
document.getElementById('brand').addEventListener('click', () => {
  socket.emit('leaveTeam');
});

document.getElementById('btn-force').addEventListener('click', () => {
  socket.emit('forceStart');
});

function renderTeam(team, players, teamSize) {
  const list = document.getElementById(`slots-${team}`);
  const members = players.filter((p) => p.team === team);
  document.getElementById(`count-${team}`).textContent = `${members.length}/${teamSize}`;

  list.innerHTML = '';
  for (let i = 0; i < teamSize; i++) {
    const li = document.createElement('li');
    const p = members[i];
    if (p) {
      li.className = 'slot filled' + (p.id === socket.id ? ' me' : '');
      const name = document.createElement('span');
      name.textContent = crown(p) + p.name + (p.id === socket.id ? ' (ty)' : '');
      const role = document.createElement('span');
      role.className = 'slot-role' + (p.role ? '' : ' none');
      role.textContent = p.role ? ROLE_LABELS[p.role] : 'bez role';
      li.append(name, role);
    } else {
      li.className = 'slot empty';
      li.textContent = 'Čeká se na hráče…';
    }
    list.append(li);
  }
}

// role picker: each role once per team
const roleButtons = document.getElementById('role-buttons');

roleButtons.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn && !btn.disabled) socket.emit('setRole', btn.dataset.role);
});
document.getElementById('btn-random-role').addEventListener('click', () => socket.emit('setRole', 'random'));

function renderRolePicker(roles, players, me) {
  const takenByTeammates = players
    .filter((p) => p.team === me.team && p.id !== me.id && p.role)
    .map((p) => p.role);
  roleButtons.innerHTML = '';
  for (const role of roles) {
    const btn = document.createElement('button');
    btn.className = 'btn role-btn' + (me.role === role ? ' selected' : '');
    btn.dataset.role = role;
    btn.textContent = ROLE_LABELS[role];
    btn.disabled = takenByTeammates.includes(role);
    roleButtons.append(btn);
  }
}

// ---------- Draft ----------

const DD = 'https://ddragon.leagueoflegends.com/cdn';
let ddVersion = null;
let championsById = {};
const iconUrl = (id) => `${DD}/${ddVersion}/img/champion/${id}.png`;
const splashUrl = (id) => `${DD}/img/champion/splash/${id}_0.jpg`;

const grid = document.getElementById('champ-grid');
const searchInput = document.getElementById('champ-search');
const btnLock = document.getElementById('btn-lock');
const timerEl = document.getElementById('timer');
const timerFill = document.getElementById('timer-fill');
const turnText = document.getElementById('turn-text');

let timerInterval = null;
let myTurn = false;

socket.on('champions', ({ version, champions }) => {
  ddVersion = version;
  championsById = Object.fromEntries(champions.map((c) => [c.id, c]));
  grid.innerHTML = '';
  for (const c of champions) {
    const tile = document.createElement('button');
    tile.className = 'champ';
    tile.dataset.id = c.id;
    tile.dataset.name = c.name.toLowerCase();
    tile.title = c.name;
    const img = document.createElement('img');
    img.src = iconUrl(c.id);
    img.alt = c.name;
    img.loading = 'lazy';
    const label = document.createElement('span');
    label.textContent = c.name;
    tile.append(img, label);
    grid.append(tile);
  }
});

grid.addEventListener('click', (e) => {
  const tile = e.target.closest('.champ');
  if (!tile || tile.disabled || !myTurn) return;
  socket.emit('hover', tile.dataset.id);
});

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  for (const tile of grid.children) tile.hidden = q && !tile.dataset.name.includes(q);
});

btnLock.addEventListener('click', () => socket.emit('lockIn'));
const btnRandomChamp = document.getElementById('btn-random-champ');
btnRandomChamp.addEventListener('click', () => socket.emit('lockRandom'));

// player in pick/ban slot i of a team (one slot per player that is really there)
function playerInSlot(draft, team, i) {
  return draft.roster[team][i] || null;
}

function playerLabel(p) {
  if (!p) return 'Nikdo (random)';
  return `${crown(p)}${p.name}${p.id === socket.id ? ' (ty)' : ''} · ${ROLE_LABELS[p.role]}`;
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function startTimer(deadline, turnMs, serverNow) {
  stopTimer();
  const offset = serverNow - Date.now(); // server clock vs. local clock
  const tick = () => {
    const left = Math.max(0, deadline - (Date.now() + offset));
    timerEl.textContent = Math.ceil(left / 1000);
    timerFill.style.width = `${(left / turnMs) * 100}%`;
    timerEl.classList.toggle('urgent', left < 10000);
  };
  tick();
  timerInterval = setInterval(tick, 200);
}

// ban phase: what player p is banning -> { champ, locked }
function banOf(draft, p) {
  if (!p) return { champ: null, locked: false };
  if (draft.banLocked[p.id]) return { champ: draft.banLocked[p.id], locked: true };
  return { champ: draft.banHover[p.id] || null, locked: false };
}

function renderBans(team, draft, banStage) {
  const box = document.getElementById(`bans-${team}`);
  box.innerHTML = '';
  for (let i = 0; i < draft.roster[team].length; i++) {
    const slot = document.createElement('div');
    slot.className = 'ban';
    const p = draft.roster[team][i]; // each player bans once
    let champ = draft.banLocked[p.id]; // follows the player when pick order is traded
    if (banStage) {
      const ban = banOf(draft, p);
      champ = ban.champ;
      if (p && !ban.locked) slot.classList.add('active');
      if (champ && !ban.locked) slot.classList.add('preview');
    }
    slot.title = p ? `Ban: ${p.name}` : 'Ban: random';
    if (champ) {
      const img = document.createElement('img');
      img.src = iconUrl(champ);
      img.alt = championsById[champ]?.name || champ;
      slot.append(img);
    }
    box.append(slot);
  }
}

function renderPicks(team, draft, current, banStage) {
  const list = document.getElementById(`picks-${team}`);
  list.innerHTML = '';
  const picks = draft.picks[team];
  const firstPick = draft.order[1]; // first step after the ban phase

  for (let i = 0; i < draft.roster[team].length; i++) {
    const li = document.createElement('li');
    li.className = 'pick';
    let champ = picks[i];
    let banLabel = '';
    const isCurrent = current.type === 'pick' && current.team === team && i === picks.length;
    if (isCurrent) {
      li.classList.add('active');
      champ = draft.hover;
      if (champ) li.classList.add('preview');
    }
    // ban phase: every player's slot shows the champion they are banning in red
    if (banStage) {
      const ban = banOf(draft, draft.roster[team][i]);
      champ = ban.champ;
      if (champ) {
        li.classList.add('ban-preview');
        banLabel = ban.locked ? 'Zabanováno: ' : 'Ban: ';
      }
      if (!ban.locked) li.classList.add('active');
    }
    const p = playerInSlot(draft, team, i);
    if (p && p.id === socket.id) li.classList.add('me');

    const text = document.createElement('div');
    text.className = 'pick-text';
    const player = document.createElement('span');
    player.className = 'pick-player';
    player.textContent = playerLabel(p);
    if (firstPick && firstPick.team === team && firstPick.slot === i) {
      const fp = document.createElement('span');
      fp.className = 'first-pick';
      fp.textContent = 'First pick';
      player.append(' ', fp);
    }
    const name = document.createElement('span');
    name.className = 'pick-name';
    if (champ) {
      li.style.backgroundImage = `url(${splashUrl(champ)})`;
      name.textContent = banLabel + (championsById[champ]?.name || champ);
    } else {
      name.textContent = isCurrent ? 'Vybírá…' : '';
    }
    text.append(player, name);
    li.append(text);
    const trade = tradeControls(draft, team, i, p);
    if (trade) li.append(trade);
    list.append(li);
  }
}

// ---------- Pick order trades ----------

// same rule as on the server: teammates who haven't picked yet and aren't picking right now
function canTrade(draft, a, b) {
  if (!a || !b || a === b) return false;
  for (const team of ['blue', 'red']) {
    const ids = draft.roster[team].map((p) => p.id);
    const ia = ids.indexOf(a);
    const ib = ids.indexOf(b);
    if (ia === -1 || ib === -1) continue;
    const picked = draft.picks[team].length;
    return ia >= picked && ib >= picked && a !== draft.actor && b !== draft.actor;
  }
  return false;
}

// trade buttons shown in a teammate's slot
function tradeControls(draft, team, i, p) {
  if (!p || p.id === socket.id) return null;
  const incoming = draft.trades.find((t) => t.from === p.id && t.to === socket.id);
  const outgoing = draft.trades.find((t) => t.from === socket.id && t.to === p.id);
  if (!incoming && !outgoing && !canTrade(draft, socket.id, p.id)) return null;

  const box = document.createElement('div');
  box.className = 'trade';
  const mk = (label, cls, onClick) => {
    const b = document.createElement('button');
    b.className = `trade-btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', onClick);
    box.append(b);
  };

  if (incoming) {
    const note = document.createElement('span');
    note.className = 'trade-note';
    note.textContent = 'Chce vyměnit pořadí';
    box.append(note);
    mk('✓ Přijmout', 'accept', () => socket.emit('tradeAnswer', { from: p.id, accept: true }));
    mk('✕', 'decline', () => socket.emit('tradeAnswer', { from: p.id, accept: false }));
  } else if (outgoing) {
    const note = document.createElement('span');
    note.className = 'trade-note';
    note.textContent = 'Čeká na odpověď…';
    box.append(note);
    mk('✕', 'decline', () => socket.emit('tradeCancel'));
  } else {
    mk('⇄ Trade', '', () => socket.emit('tradeRequest', p.id));
  }
  return box;
}

function renderDraft(draft, serverNow) {
  const current = draft.order[draft.step];
  const isBan = current.type === 'ban';
  const everyone = [...draft.roster.blue, ...draft.roster.red];
  const iAmIn = everyone.some((p) => p.id === socket.id);
  const myBanLocked = !!draft.banLocked[socket.id];
  myTurn = isBan ? iAmIn && !myBanLocked : draft.actor === socket.id;
  const myHover = isBan ? draft.banHover[socket.id] : draft.hover;

  renderBans('blue', draft, isBan);
  renderBans('red', draft, isBan);
  renderPicks('blue', draft, current, isBan);
  renderPicks('red', draft, current, isBan);

  // champion grid: grey out banned/picked, highlight hovered
  const taken = new Set([
    ...draft.bans.blue, ...draft.bans.red, ...draft.picks.blue, ...draft.picks.red,
    ...Object.values(draft.banLocked),
  ]);
  for (const tile of grid.children) {
    tile.disabled = taken.has(tile.dataset.id);
    tile.classList.toggle('selected', tile.dataset.id === myHover);
  }
  grid.classList.toggle('inactive', !myTurn);

  if (isBan) {
    const left = everyone.filter((p) => !draft.banLocked[p.id]).length;
    turnText.textContent = !iAmIn ? `Všichni banují… (zbývá ${left})`
      : myBanLocked ? `Ban potvrzen — čeká se na ostatní (${left})…`
      : 'Všichni banují — vyber ban!';
    turnText.className = 'turn-text';
  } else {
    const actor = everyone.find((p) => p.id === draft.actor);
    const who = actor ? actor.name : (current.team === 'blue' ? 'Blue team' : 'Red team');
    turnText.textContent = myTurn ? 'Jsi na tahu — vyber šampiona!' : `${who} vybírá…`;
    turnText.className = `turn-text ${current.team}`;
  }

  btnLock.disabled = !myTurn || !myHover;
  btnLock.textContent = isBan ? 'Ban' : 'Lock in';
  btnLock.classList.toggle('ban-mode', isBan);
  btnRandomChamp.disabled = !myTurn;
  btnRandomChamp.textContent = isBan ? 'Random ban' : 'Random pick';

  startTimer(draft.deadline, draft.turnMs, serverNow);
}

// ---------- Result ----------

function renderResult(draft) {
  for (const team of ['blue', 'red']) {
    const list = document.getElementById(`result-${team}`);
    list.innerHTML = '';
    draft.picks[team].forEach((champ, i) => {
      const p = playerInSlot(draft, team, i);
      const li = document.createElement('li');
      li.className = 'result-row' + (p && p.id === socket.id ? ' me' : '');
      li.style.backgroundImage = `url(${splashUrl(champ)})`;

      const role = document.createElement('span');
      role.className = 'result-role';
      role.textContent = p ? ROLE_LABELS[p.role] : '—';
      const player = document.createElement('span');
      player.className = 'result-player';
      player.textContent = p ? crown(p) + p.name : 'Nikdo';
      const name = document.createElement('span');
      name.className = 'result-champ';
      name.textContent = championsById[champ]?.name || champ;

      li.append(role, player, name);
      list.append(li);
    });
  }
}

// ---------- State from server ----------

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

// ---------- Captain ----------
// The first player who joined the lobby is the captain: only they can Force start and Terminate.

let isCaptain = false;
let captainId = null;
let currentPhase = 'lobby';
const btnForce = document.getElementById('btn-force');

// show captain-only controls
function updateCaptainUi() {
  btnForce.hidden = !isCaptain;
  document.getElementById('force-info').hidden = isCaptain;
  btnTerminate.hidden = !isCaptain || currentPhase === 'lobby';
  if (btnTerminate.hidden) terminateModal.hidden = true;
}

// Terminate (draft + result page): ends the lobby and kicks everyone back to Choose your team
const btnTerminate = document.getElementById('btn-terminate');
const terminateModal = document.getElementById('terminate-modal');
btnTerminate.addEventListener('click', () => { terminateModal.hidden = false; });
document.getElementById('terminate-cancel').addEventListener('click', () => { terminateModal.hidden = true; });
document.getElementById('terminate-confirm').addEventListener('click', () => {
  terminateModal.hidden = true;
  socket.emit('terminate');
});
// click outside the dialog or Esc = cancel
terminateModal.addEventListener('click', (e) => { if (e.target === terminateModal) terminateModal.hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') terminateModal.hidden = true; });

socket.on('state', ({ phase, captain, teamSize, roles, players, draft, serverNow }) => {
  const me = players.find((p) => p.id === socket.id);
  currentPhase = phase;
  captainId = captain;
  isCaptain = captain === socket.id;
  updateCaptainUi();

  if (phase === 'draft') {
    showView('draft');
    renderDraft(draft, serverNow);
    return;
  }
  stopTimer();

  if (phase === 'done') {
    showView('result');
    renderResult(draft);
    return;
  }

  const blueCount = players.filter((p) => p.team === 'blue').length;
  const redCount = players.filter((p) => p.team === 'red').length;
  btnBlue.disabled = blueCount >= teamSize;
  btnRed.disabled = redCount >= teamSize;
  btnRandom.disabled = blueCount >= teamSize && redCount >= teamSize;

  if (!me) {
    showView('choose');
    return;
  }

  showView('waiting');
  renderTeam('blue', players, teamSize);
  renderTeam('red', players, teamSize);
  renderRolePicker(roles, players, me);
  const missing = teamSize * 2 - players.filter((p) => p.team).length;
  document.getElementById('waiting-info').textContent = missing > 0
    ? `Čeká se na ${missing} ${missing === 1 ? 'hráče' : 'hráčů'}…`
    : 'Čeká se, až si všichni vyberou roli…';
});
