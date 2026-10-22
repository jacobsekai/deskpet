const call = (action, payload) => window.deskpetDialog.call(action, payload || {});
const $ = (id) => document.getElementById(id);
const note = (id, text, kind) => { $(id).textContent = text; $(id).className = `note ${kind || ''}`; };

function show(tab) {
  $('export').hidden = tab !== 'export';
  $('import').hidden = tab !== 'import';
  $('tab-export').classList.toggle('on', tab === 'export');
  $('tab-import').classList.toggle('on', tab === 'import');
}
$('tab-export').addEventListener('click', () => show('export'));
$('tab-import').addEventListener('click', () => show('import'));
if (new URLSearchParams(location.search).get('tab') === 'import') show('import');

call('transfer-export').then(({ key }) => { $('key').value = key; });
$('copy').addEventListener('click', async () => { await call('copy', { text: $('key').value }); note('export-note', 'Copied! 📋', 'ok'); });
$('save').addEventListener('click', async () => { if ((await call('save-key', { key: $('key').value })).ok) note('export-note', 'Saved 💾', 'ok'); });
$('done').addEventListener('click', () => call('close'));

let confirmed = false;
$('paste').addEventListener('input', () => { confirmed = false; $('apply').textContent = 'Import'; note('import-note', ''); });
$('open').addEventListener('click', async () => { const r = await call('open-key'); if (r.key) { $('paste').value = r.key; $('paste').dispatchEvent(new Event('input')); } });
$('cancel').addEventListener('click', () => call('close'));
$('apply').addEventListener('click', async () => {
  if (!confirmed) {
    const preview = await call('transfer-preview', { key: $('paste').value });
    if (!preview.ok) return note('import-note', preview.error, 'error');
    confirmed = true;
    $('apply').textContent = 'Replace and import';
    return note('import-note', `Found ${preview.summary}. Click again to replace this device's data.`, 'ok');
  }
  const result = await call('transfer-import', { key: $('paste').value });
  if (!result.ok) note('import-note', result.error, 'error');
});
