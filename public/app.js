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
};

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
      li.textContent = p.name + (p.id === socket.id ? ' (ty)' : '');
    } else {
      li.className = 'slot empty';
      li.textContent = 'Čeká se na hráče…';
    }
    list.append(li);
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
    } else if (i < bans.length && !champ) {
      slot.classList.add('skipped');
    }
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
    const name = document.createElement('span');
    name.className = 'pick-name';
    if (champ) {
      li.style.backgroundImage = `url(${splashUrl(champ)})`;
      name.textContent = championsById[champ]?.name || champ;
    } else {
      name.textContent = isCurrent ? 'Vybírá…' : '';
    }
    li.append(name);
    list.append(li);
  }
}

function renderDraft(phase, draft, me, serverNow) {
  const done = phase === 'done';
  const current = done ? null : draft.order[draft.step];
  myTurn = !done && !!me && me.team === current.team;

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
  document.querySelector('.champ-area').hidden = done;

  if (done) {
    stopTimer();
    turnText.textContent = 'Draft dokončen';
    turnText.className = 'turn-text';
    timerEl.textContent = '';
    timerFill.style.width = '0';
    return;
  }

  const teamLabel = current.team === 'blue' ? 'Blue team' : 'Red team';
  const action = current.type === 'ban' ? 'banuje' : 'vybírá';
  turnText.textContent = `${teamLabel} ${action}` + (myTurn ? ' — jsi na tahu!' : '');
  turnText.className = `turn-text ${current.team}`;

  btnLock.disabled = !myTurn || !draft.hover;
  btnLock.textContent = current.type === 'ban' ? 'Ban' : 'Lock in';
  btnLock.classList.toggle('ban-mode', current.type === 'ban');

  startTimer(draft.deadline, draft.turnMs, serverNow);
}

// ---------- State from server ----------

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

socket.on('state', ({ phase, teamSize, players, draft, serverNow }) => {
  const me = players.find((p) => p.id === socket.id);

  if (phase === 'draft' || phase === 'done') {
    showView('draft');
    renderDraft(phase, draft, me, serverNow);
    return;
  }
  stopTimer();

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
  const missing = teamSize * 2 - players.filter((p) => p.team).length;
  document.getElementById('waiting-info').textContent =
    `Čeká se na ${missing} ${missing === 1 ? 'hráče' : 'hráčů'}…`;
});
