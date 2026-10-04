const socket = io();
const statusEl = document.getElementById('status');

socket.on('connect', () => { statusEl.textContent = 'Připojeno k serveru'; });
socket.on('disconnect', () => { statusEl.textContent = 'Odpojeno — zkouším znovu…'; });
