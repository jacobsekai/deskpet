// Hex color dialog for the theme (Electron has no built-in text prompt).
const hex = document.getElementById('hex');
const picker = document.getElementById('picker');
const normalize = (value) => {
  let s = String(value).trim().toUpperCase().replace(/^#/, '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return /^[0-9A-F]{6}$/.test(s) ? `#${s}` : null;
};

hex.value = new URLSearchParams(location.search).get('hex') || '';
if (normalize(hex.value)) picker.value = normalize(hex.value).toLowerCase();

hex.addEventListener('input', () => {
  const v = normalize(hex.value);
  hex.classList.toggle('invalid', !!hex.value && !v);
  if (v) picker.value = v.toLowerCase();
});
picker.addEventListener('input', () => { hex.value = picker.value.toUpperCase(); hex.classList.remove('invalid'); });

for (const color of ['#FF8FB1', '#FF6B6B', '#FFB347', '#7BD389', '#4FC3F7', '#9C88FF', '#2B2D42']) {
  const b = document.createElement('button');
  b.style.background = color;
  b.title = color;
  b.addEventListener('click', () => { hex.value = color; picker.value = color.toLowerCase(); hex.classList.remove('invalid'); });
  document.getElementById('swatches').appendChild(b);
}

const apply = () => {
  const v = normalize(hex.value);
  if (!v) { hex.classList.add('invalid'); hex.focus(); return; }
  window.deskpet.send('theme-result', { action: 'apply', hex: v });
};
document.getElementById('apply').addEventListener('click', apply);
document.getElementById('cancel').addEventListener('click', () => window.deskpet.send('theme-result', { action: 'cancel' }));
document.getElementById('default').addEventListener('click', () => window.deskpet.send('theme-result', { action: 'default' }));
hex.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') apply();
  if (e.key === 'Escape') window.deskpet.send('theme-result', { action: 'cancel' });
});
