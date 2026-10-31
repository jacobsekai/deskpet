// Updates: streamed downloads with progress, and clear failures instead of a silent hang.
// Run: node test/updater.test.js (the Windows swap script itself runs in the Windows CI workflow).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-updater-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { downloadTo, swapScript } = require('../src/extras');

const response = (chunks, { status = 200, length } = {}) => ({
  ok: status < 400, status,
  headers: { get: (k) => (k.toLowerCase() === 'content-length' && length !== undefined ? String(length) : null) },
  body: (async function* () { for (const c of chunks) yield Buffer.from(c); })(),
});

let checks = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { checks++; console.log(`ok - ${name}`); });

(async () => {
  await ok('download: streams to disk and reports progress', async () => {
    const file = path.join(home, 'a.zip');
    const seen = [];
    await downloadTo('https://x/a.zip', file, (f) => seen.push(f), async () => response(['ab', 'cd'], { length: 4 }));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'abcd');
    assert.deepStrictEqual(seen, [0.5, 1]);
  });

  await ok('download: HTTP errors and cut-short downloads fail with a reason', async () => {
    await assert.rejects(downloadTo('https://x', path.join(home, 'b'), () => {}, async () => response([], { status: 404 })), /HTTP 404/);
    await assert.rejects(downloadTo('https://x', path.join(home, 'c'), () => {}, async () => response(['ab'], { length: 10 })), /cut short/);
  });

  await ok('download: a stalled connection gives up instead of hanging', async () => {
    const stalled = async (_url, { signal }) => ({
      ok: true, status: 200, headers: { get: () => null },
      body: (async function* () { yield Buffer.from('a'); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))); })(),
    });
    await assert.rejects(downloadTo('https://x', path.join(home, 'd'), () => {}, stalled, 50), /stalled/);
  });

  await ok('swap script: copies without mirroring, logs, and always relaunches', () => {
    const script = swapScript({ exe: 'C:\\Apps\\DeskPet\\DeskPet.exe', zip: 'C:\\T\\u.zip', work: 'C:\\T', log: 'C:\\Users\\l\\.deskpet\\update.log' });
    assert(!/\/MIR/.test(script) && /robocopy .* \/E /.test(script));
    assert(/tar\.exe -xf/.test(script) && /Expand-Archive/.test(script));
    assert(/Start-Process 'C:\\Apps\\DeskPet\\DeskPet\.exe'/.test(script.split("Log 'done'")[0].split('Remove-Item')[0]));
    assert(!/Start-Process/.test(swapScript({ exe: 'C:\\a\\DeskPet.exe', zip: 'z', work: 'w', log: 'l', relaunch: false })));
  });

  console.log(`\n${checks} checks passed`);
  fs.rmSync(home, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
