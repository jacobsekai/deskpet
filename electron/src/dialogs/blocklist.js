const call = (action, payload) => window.deskpetDialog.call(action, payload || {});
const $ = (id) => document.getElementById(id);
call('blocklist-get').then((s) => {
  $('list').value = s.list.join('\n');
  $('enabled').checked = s.enabled;
  $('strict').checked = s.strict;
  $('reset').addEventListener('click', () => { $('list').value = s.defaults.join('\n'); });
});
$('save').addEventListener('click', () => call('blocklist-save', { text: $('list').value, enabled: $('enabled').checked, strict: $('strict').checked }));
$('cancel').addEventListener('click', () => call('close'));
