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

// ---------- State from server ----------

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
}

socket.on('state', ({ phase, teamSize, players }) => {
  const me = players.find((p) => p.id === socket.id);

  if (phase === 'draft') {
    showView('draft');
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
  const missing = teamSize * 2 - players.filter((p) => p.team).length;
  document.getElementById('waiting-info').textContent =
    `Čeká se na ${missing} ${missing === 1 ? 'hráče' : 'hráčů'}…`;
});
