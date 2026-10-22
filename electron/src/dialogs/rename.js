const call = (action, payload) => window.deskpetDialog.call(action, payload || {});
const $ = (id) => document.getElementById(id);
call('names-get').then((n) => { $('pet').value = n.petName; $('owner').value = n.ownerName; $('pet').focus(); $('pet').select(); });
const save = () => call('names-save', { petName: $('pet').value, ownerName: $('owner').value });
$('save').addEventListener('click', save);
$('cancel').addEventListener('click', () => call('close'));
document.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') call('close'); });
