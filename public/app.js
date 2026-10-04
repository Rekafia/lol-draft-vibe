const socket = io();
const connEl = document.getElementById('conn');
const statusEl = document.getElementById('status');

const nameInput = document.getElementById('name-input');
const resultEl = document.getElementById('join-result');

socket.on('connect', () => {
  connEl.className = 'conn online';
  statusEl.textContent = 'Připojeno';
});

socket.on('disconnect', () => {
  connEl.className = 'conn offline';
  statusEl.textContent = 'Odpojeno — zkouším znovu…';
});

// team: 'blue' | 'red' | 'random'
function joinTeam(team) {
  socket.emit('joinTeam', { name: nameInput.value.trim(), team });
}

document.getElementById('btn-random').addEventListener('click', () => joinTeam('random'));
document.getElementById('btn-blue').addEventListener('click', () => joinTeam('blue'));
document.getElementById('btn-red').addEventListener('click', () => joinTeam('red'));

socket.on('joined', ({ name, team }) => {
  nameInput.value = name;
  const label = team === 'blue' ? 'Blue team' : 'Red team';
  resultEl.innerHTML = '';
  resultEl.append(`${name}, jsi v týmu `);
  const span = document.createElement('span');
  span.className = team;
  span.textContent = label;
  resultEl.append(span);
});
