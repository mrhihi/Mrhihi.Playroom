import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { createDatabase } from '../dist/db.js';
import { registerHttp } from '../dist/http.js';
import { RoomService } from '../dist/rooms.js';
import { loadAdsense } from '../dist/ui/adsense.js';

test('AdSense requires production, opt-in, and nonempty private snippets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'playroom-adsense-'));
  const head = join(dir, 'head.html');
  const unit = join(dir, 'unit.html');
  writeFileSync(head, '<script data-test="adsense-head"></script>');
  writeFileSync(unit, '<ins data-test="adsense-unit"></ins>');
  const env = { NODE_ENV: 'production', ADSENSE_ENABLED: '1', ADSENSE_HEAD_FILE: head, ADSENSE_UNIT_FILE: unit };
  assert.equal(loadAdsense({ ...env, NODE_ENV: 'development' }), null);
  assert.equal(loadAdsense({ ...env, ADSENSE_ENABLED: '0' }), null);
  assert.deepEqual(loadAdsense(env), {
    head: '<script data-test="adsense-head"></script>',
    unit: '<ins data-test="adsense-unit"></ins>',
  });
  assert.throws(() => loadAdsense({ ...env, ADSENSE_HEAD_FILE: '' }), /ADSENSE_HEAD_FILE/);
  writeFileSync(unit, '   ');
  assert.throws(() => loadAdsense(env), /ADSENSE_UNIT_FILE is empty/);
});

test('AdSense appears once on the home page and four game lobbies only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'playroom-adsense-http-'));
  const head = join(dir, 'head.html');
  const unit = join(dir, 'unit.html');
  writeFileSync(head, '<script data-test="adsense-head"></script>');
  writeFileSync(unit, '<ins data-test="adsense-unit"></ins>');
  const keys = ['NODE_ENV', 'ADSENSE_ENABLED', 'ADSENSE_HEAD_FILE', 'ADSENSE_UNIT_FILE'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { NODE_ENV: 'production', ADSENSE_ENABLED: '1', ADSENSE_HEAD_FILE: head, ADSENSE_UNIT_FILE: unit });
  const app = Fastify();
  try {
    registerHttp(app, new RoomService(createDatabase(':memory:')));
    for (const path of ['/', '/games/race', '/games/old-maid', '/games/poll', '/games/tetris', '/games/tetris?from=home']) {
      const html = (await app.inject(path)).body;
      assert.equal(html.split('data-test="adsense-head"').length - 1, 1, path);
      assert.equal(html.split('data-test="adsense-unit"').length - 1, 1, path);
      assert.ok(html.indexOf('<main id="app"') < html.indexOf('<aside class="adsense-placement"'), path);
    }
    for (const path of ['/games/tetris/solo', '/rooms/example', '/results/example', '/admin', '/unknown']) {
      const html = (await app.inject(path)).body;
      assert.doesNotMatch(html, /data-test="adsense-(head|unit)"/, path);
    }
  } finally {
    await app.close();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
