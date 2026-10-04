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
      name.textContent = p.name + (p.id === socket.id ? ' (ty)' : '');
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

// player in pick/ban slot i of a team (with fewer than 5 players they take turns)
function playerInSlot(draft, team, i) {
  const list = draft.roster[team];
  return list.length ? list[i % list.length] : null;
}

function playerLabel(p) {
  if (!p) return 'Nikdo (random)';
  return `${p.name}${p.id === socket.id ? ' (ty)' : ''} · ${ROLE_LABELS[p.role]}`;
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

function renderBans(team, draft, current) {
  const box = document.getElementById(`bans-${team}`);
  box.innerHTML = '';
  const bans = draft.bans[team];
  for (let i = 0; i < 5; i++) {
    const slot = document.createElement('div');
    slot.className = 'ban';
    let champ = bans[i];
    const isCurrent = current && current.type === 'ban' && current.team === team && i === bans.length;
    if (isCurrent) {
      slot.classList.add('active');
      champ = draft.hover;
      if (champ) slot.classList.add('preview');
    }
    const p = playerInSlot(draft, team, i);
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

function renderPicks(team, draft, current) {
  const list = document.getElementById(`picks-${team}`);
  list.innerHTML = '';
  const picks = draft.picks[team];
  for (let i = 0; i < 5; i++) {
    const li = document.createElement('li');
    li.className = 'pick';
    let champ = picks[i];
    const isCurrent = current && current.type === 'pick' && current.team === team && i === picks.length;
    if (isCurrent) {
      li.classList.add('active');
      champ = draft.hover;
      if (champ) li.classList.add('preview');
    }
    const p = playerInSlot(draft, team, i);
    if (p && p.id === socket.id) li.classList.add('me');

    const text = document.createElement('div');
    text.className = 'pick-text';
    const player = document.createElement('span');
    player.className = 'pick-player';
    player.textContent = playerLabel(p);
    const name = document.createElement('span');
    name.className = 'pick-name';
    if (champ) {
      li.style.backgroundImage = `url(${splashUrl(champ)})`;
      name.textContent = championsById[champ]?.name || champ;
    } else {
      name.textContent = isCurrent ? 'Vybírá…' : '';
    }
    text.append(player, name);
    li.append(text);
    list.append(li);
  }
}

function renderDraft(draft, serverNow) {
  const current = draft.order[draft.step];
  myTurn = draft.actor === socket.id;

  renderBans('blue', draft, current);
  renderBans('red', draft, current);
  renderPicks('blue', draft, current);
  renderPicks('red', draft, current);

  // champion grid: grey out banned/picked, highlight hovered
  const taken = new Set([...draft.bans.blue, ...draft.bans.red, ...draft.picks.blue, ...draft.picks.red]);
  for (const tile of grid.children) {
    tile.disabled = taken.has(tile.dataset.id);
    tile.classList.toggle('selected', tile.dataset.id === draft.hover);
  }
  grid.classList.toggle('inactive', !myTurn);

  const actor = [...draft.roster.blue, ...draft.roster.red].find((p) => p.id === draft.actor);
  const who = myTurn ? 'Ty' : actor ? actor.name : (current.team === 'blue' ? 'Blue team' : 'Red team');
  const isBan = current.type === 'ban';
  turnText.textContent = myTurn
    ? `Jsi na tahu — ${isBan ? 'banuj' : 'vyber šampiona'}!`
    : `${who} ${isBan ? 'banuje' : 'vybírá'}…`;
  turnText.className = `turn-text ${current.team}`;

  btnLock.disabled = !myTurn || !draft.hover;
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
      player.textContent = p ? p.name : 'Nikdo';
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

// Terminate (draft + result page): ends the lobby and kicks everyone back to Choose your team
const btnTerminate = document.getElementById('btn-terminate');
btnTerminate.addEventListener('click', () => socket.emit('terminate'));

socket.on('state', ({ phase, teamSize, roles, players, draft, serverNow }) => {
  const me = players.find((p) => p.id === socket.id);
  btnTerminate.hidden = phase === 'lobby';

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
