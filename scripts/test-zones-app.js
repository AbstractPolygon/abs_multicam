'use strict';
// Motion zones end to end: zones are drawn with real pointer events on the tile, saved per camera, and decide which
// movement starts a recording. Both cameras see the same small moving square (in the top third of the picture).
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const electron = require('electron');

function run(name, plan, userdataSettings) {
  return new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `multicam-zone-${name}-`));
    fs.mkdirSync(path.join(dir, 'userdata'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'userdata', 'settings.json'), JSON.stringify({ motion: true, motionLevel: 1, ...userdataSettings }));
    const env = { ...process.env, MULTICAM_FAKE: '2', MULTICAM_SMOKE: "24", MULTICAM_SMOKE_DIR: dir, MULTICAM_SMOKE_FEED: 'small', MULTICAM_SMOKE_ZONES: JSON.stringify(plan) };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, ['.'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
    const killer = setTimeout(() => child.kill(), 70000);
    child.on('exit', () => {
      clearTimeout(killer);
      const out = path.join(dir, 'out'), segs = {};
      if (fs.existsSync(out)) for (const c of fs.readdirSync(out)) segs[c] = fs.readdirSync(path.join(out, c)).filter((f) => f.endsWith('.webm') || f.endsWith('.mp4')).length;
      const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
      const saved = JSON.parse(fs.readFileSync(path.join(dir, 'userdata', 'settings.json'), 'utf8')).cameras || {};
      resolve({ segs, result, saved, dir });
    });
  });
}
let ok = true;
const check = (n, c, x = '') => { console.log(`${c ? 'ok  ' : 'FAIL'} ${n} ${x}`); if (!c) ok = false; };
const band = [0, 0.15, 1, 0.3], bottom = [0, 0.6, 1, 0.4];      // the square moves inside the band

(async () => {
  // A: inside zones. cam1 watches only the bottom (movement is elsewhere), cam2 watches only the band.
  let r = await run('inside', { cam1: { mode: 'inside', draw: [bottom] }, cam2: { mode: 'inside', draw: [band] } });
  check('zones were drawn on the tiles', r.result.zoneCount && r.result.zoneCount.cam1 === 1 && r.result.zoneCount.cam2 === 1, JSON.stringify(r.result.zoneCount));
  check('inside mode: camera watching an empty area does not record', !r.segs.cam1, JSON.stringify(r.segs));
  check('inside mode: camera watching the moving area records', r.segs.cam2 >= 1, JSON.stringify(r.segs));
  const saved = Object.values(r.saved);
  const z1 = saved.find((c) => c.folder === 'cam1'), z2 = saved.find((c) => c.folder === 'cam2');
  check('zones and mode are saved per camera', z1 && z1.zones && z1.zones.length === 1 && z1.zoneMode === 'inside' && z2 && z2.zones.length === 1, JSON.stringify([z1 && z1.zones, z1 && z1.zoneMode]));
  check('saved zone matches what was drawn (bottom 40%)', z1 && Math.abs(z1.zones[0].y - 0.6) < 0.03 && Math.abs(z1.zones[0].h - 0.4) < 0.03 && z1.zones[0].w > 0.95, JSON.stringify(z1 && z1.zones));

  // B: outside zones. cam1 ignores the band (the movement), cam2 ignores the bottom.
  r = await run('outside', { cam1: { mode: 'outside', draw: [band] }, cam2: { mode: 'outside', draw: [bottom] } });
  check('outside mode: camera ignoring the moving area does not record', !r.segs.cam1, JSON.stringify(r.segs));
  check('outside mode: camera ignoring an empty area still records', r.segs.cam2 >= 1, JSON.stringify(r.segs));

  // C: a click selects a zone, the Delete key removes the selected zone; Clear removes all zones of a camera
  r = await run('edit', {
    cam1: { ops: [['draw', ...band], ['draw', ...bottom], ['click', 0.5, 0.2], ['probe'], ['key', 'Delete'], ['probe']] },
    cam2: { ops: [['draw', ...band], ['clear']] }
  });
  const pr = (r.result.zoneProbe || {}).cam1 || [];
  check('clicking a zone selects it (one zone highlighted, 8 handles, a delete button)', pr[0] && pr[0].selEls === 1 && pr[0].handles === 8 && pr[0].del && pr[0].zones.length === 2, JSON.stringify(pr[0]));
  check('Delete key removes just the selected zone', pr[1] && pr[1].zones.length === 1 && pr[1].zones[0].y > 0.5 && pr[1].sel === -1, JSON.stringify(pr[1]));
  const e1 = Object.values(r.saved).find((c) => c.folder === 'cam1'), e2 = Object.values(r.saved).find((c) => c.folder === 'cam2');
  check('the removal is saved', e1 && e1.zones && e1.zones.length === 1 && e1.zones[0].y > 0.5, JSON.stringify(e1 && e1.zones));
  check('Clear removes all zones of a camera', e2 && !e2.zones, JSON.stringify(e2 && e2.zones));

  // G: move, resize, limits, deselect and the delete button
  r = await run('shape', {
    cam1: { ops: [
      ['draw', 0.2, 0.2, 0.3, 0.3], ['probe'],                       // 0: a new zone is selected right away
      ['move', 0.1, 0.05], ['probe'],                                // 1: moved
      ['resize', 'se', 0.2, 0.2], ['probe'],                         // 2: bottom-right handle dragged out
      ['resize', 'nw', 0.9, 0.9], ['probe'],                         // 3: top-left dragged past the opposite corner: minimum size, no flip
      ['move', 2, 2], ['probe'],                                     // 4: dragged far outside: stays inside the picture
      ['click', 0.02, 0.02], ['probe'],                              // 5: click on empty space deselects
      ['click', 0.99, 0.99], ['probe'],                              // 6: (the zone is in the bottom-right corner now) selects it again
      ['delbtn'], ['probe']                                          // 7: the red x deletes it
    ] }
  });
  const g = (r.result.zoneProbe || {}).cam1 || [];
  const near = (a, b) => Math.abs(a - b) < 0.02;
  check('a newly drawn zone is selected right away', g[0] && g[0].sel === 0 && g[0].handles === 8 && near(g[0].zones[0].x, 0.2) && near(g[0].zones[0].w, 0.3), JSON.stringify(g[0]));
  check('dragging the zone moves it, size unchanged', g[1] && near(g[1].zones[0].x, 0.3) && near(g[1].zones[0].y, 0.25) && near(g[1].zones[0].w, 0.3) && near(g[1].zones[0].h, 0.3), JSON.stringify(g[1] && g[1].zones));
  check('dragging the bottom-right handle resizes it, top-left stays', g[2] && near(g[2].zones[0].x, 0.3) && near(g[2].zones[0].y, 0.25) && near(g[2].zones[0].w, 0.5) && near(g[2].zones[0].h, 0.5), JSON.stringify(g[2] && g[2].zones));
  check('dragging a handle past the opposite side keeps a minimum size (no flip)', g[3] && g[3].zones[0].w >= 0.019 && g[3].zones[0].h >= 0.019 && g[3].zones[0].w < 0.05, JSON.stringify(g[3] && g[3].zones));
  check('a zone cannot be moved outside the picture', g[4] && g[4].zones[0].x >= 0 && g[4].zones[0].y >= 0 && g[4].zones[0].x + g[4].zones[0].w <= 1.0001 && g[4].zones[0].y + g[4].zones[0].h <= 1.0001, JSON.stringify(g[4] && g[4].zones));
  check('clicking empty space deselects (no handles, no delete button)', g[5] && g[5].sel === -1 && g[5].handles === 0 && !g[5].del, JSON.stringify(g[5]));
  check('clicking a zone selects it again', g[6] && g[6].sel === 0 && g[6].selEls === 1, JSON.stringify(g[6]));
  check('the red x deletes the selected zone', g[7] && g[7].zones.length === 0, JSON.stringify(g[7]));

  // D: testing zones while editing. Both cameras stay in edit mode. cam1's zone covers the movement, cam2's does not.
  r = await run('test', { cam1: { mode: 'inside', draw: [band], watch: true, stay: true }, cam2: { mode: 'inside', draw: [bottom], watch: true, stay: true } });
  const zh = r.result.zoneHit || {};
  check('editing: the zone with movement in it lights up and shows "Movement"', zh.cam1 && zh.cam1.hit && zh.cam1.badge, JSON.stringify(zh.cam1));
  check('editing: the zone without movement stays dark', zh.cam2 && !zh.cam2.hit && !zh.cam2.badge, JSON.stringify(zh.cam2));
  check('editing: no recording starts, even for the zone that sees movement', !r.segs.cam1 && !r.segs.cam2, JSON.stringify(r.segs));

  // E: "outside" mode lights up for movement outside the zones, not inside them
  r = await run('test-out', { cam1: { mode: 'outside', draw: [band], watch: true, stay: true }, cam2: { mode: 'outside', draw: [bottom], watch: true, stay: true } });
  const zo = r.result.zoneHit || {};
  check('outside mode: movement inside an ignored zone does not light up', zo.cam1 && !zo.cam1.hit, JSON.stringify(zo.cam1));
  check('outside mode: movement outside the ignored zone lights up', zo.cam2 && zo.cam2.hit && zo.cam2.badge, JSON.stringify(zo.cam2));

  // F: after pressing Done the camera records again on movement
  r = await run('done', { cam1: { mode: 'inside', draw: [band], watch: true } });
  check('after Done the same zone starts a recording as usual', r.segs.cam1 >= 1, JSON.stringify(r.segs));
  console.log(ok ? 'PASS' : 'FAIL');
  process.exit(ok ? 0 : 1);
})();
