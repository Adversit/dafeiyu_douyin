'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StickerService } = require('../src/stickers/service');

const CREDIT = { author: '上游作者', text: '上游原始署名', links: [{ label: '官网', url: 'https://kiriyuki.com' }] };
const STICKER = { id: '大肥鱼/10N01_开心', pack: '大肥鱼', stem: '10N01_开心',
  name: '开心', file: '10N01_开心.gif', bytes: 6, hash: '', emotion: '开心',
  desc: '开心的动作', use: '打招呼', tags: ['开心'], text: '', w: 32, h: 32, frames: 2 };

async function fixture(t, { sticker = STICKER, payload = Buffer.from('GIF89a'), outputPath } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dafeiyu-stickers-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = { factory: 0, search: [], file: 0 };
  let options;
  const kit = {
    attribution: CREDIT,
    async ready() {},
    isEnabled: () => true,
    async search(query, opts) { calls.search.push({ query, opts }); return [{ sticker, score: 8 }]; },
    async resolve(id) { return id === sticker.id ? sticker : undefined; },
    async file(s) {
      calls.file += 1;
      const local = outputPath || path.join(options.dataDir, 'packs', s.pack, s.file);
      await fs.mkdir(path.dirname(local), { recursive: true });
      await fs.writeFile(local, payload);
      return { path: local, sticker: s };
    },
  };
  const service = new StickerService({ enabled: true, cacheDir: path.join(dir, 'cache'), autoSync: 'off' }, {
    kitFactory: async (opts) => { calls.factory += 1; options = opts; return kit; },
  });
  return { service, kit, dir, calls, options: () => options };
}

test('disabled stickers do not load a plugin, create a cache or affect text operation', async (t) => {
  const f = await fixture(t);
  const service = new StickerService({ enabled: false, cacheDir: path.join(f.dir, 'disabled') }, {
    kitFactory() { assert.fail('must not load upstream'); },
  });
  assert.deepEqual(await service.search('开心'), []);
  await assert.rejects(service.file(STICKER.id), { code: 'STICKERS_DISABLED' });
  await assert.rejects(fs.stat(path.join(f.dir, 'disabled')), { code: 'ENOENT' });
});

test('search delegates scores to the real kit contract and preserves attribution', async (t) => {
  const f = await fixture(t);
  assert.equal(f.calls.factory, 0);
  const candidates = await f.service.search(' 开心 ', { limit: 1 });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].id, STICKER.id);
  assert.equal(candidates[0].description, STICKER.desc);
  assert.equal(candidates[0].score, 8);
  assert.deepEqual(candidates[0].attribution, CREDIT);
  assert.deepEqual(f.calls.search[0], { query: '开心', opts: { limit: 50, shuffle: false } });
  assert.equal(f.options().autoSync, 'off');
  assert.deepEqual(f.options().packs, ['大肥鱼', '大肥鱼和GPT娘']);
  candidates[0].tags.push('changed');
  candidates[0].attribution.text = 'changed';
  assert.deepEqual(STICKER.tags, ['开心']);
  assert.equal(CREDIT.text, '上游原始署名');
});

test('empty queries skip loading, excluded or disabled candidates are omitted', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.service.search(' '), []);
  assert.equal(f.calls.factory, 0);
  assert.deepEqual(await f.service.search('开心', { excludeIds: [STICKER.id] }), []);
  f.kit.isEnabled = () => false;
  assert.deepEqual(await f.service.search('开心'), []);
});

test('file returns a real local GIF and original attribution', async (t) => {
  const f = await fixture(t);
  const result = await f.service.file(STICKER.id);
  assert.equal(result.path, await fs.realpath(result.path));
  assert.equal(result.mime, 'image/gif');
  assert.equal(result.bytes, 6);
  assert.equal(result.animated, true);
  assert.deepEqual(result.attribution, CREDIT);
  assert.equal(f.calls.file, 1);
});

test('user paths, aliases and template identifiers cannot become file requests', async (t) => {
  const f = await fixture(t);
  for (const id of ['../../secrets', '/private/tmp/file.gif', '开心', '大肥鱼:think',
    '大肥鱼/../secret', '大肥鱼/%2e%2e', '大肥鱼/a\\b', '大肥鱼/.']) {
    await assert.rejects(f.service.file(id), { code: 'STICKER_INVALID_ID' });
  }
  assert.equal(f.calls.factory, 0);
});

test('malicious catalog paths and hash names are rejected before kit.file', async (t) => {
  for (const change of [{ file: '../../secret.gif' }, { pack: '..' }, { hash: '../../bad' }]) {
    const f = await fixture(t, { sticker: { ...STICKER, ...change } });
    assert.deepEqual(await f.service.search('开心'), []);
    await assert.rejects(f.service.file(STICKER.id), { code: 'STICKER_INVALID_METADATA' });
    assert.equal(f.calls.file, 0);
  }
});

test('oversized catalog entries are excluded before any GIF download', async (t) => {
  const f = await fixture(t, { sticker: { ...STICKER, bytes: 9 * 1024 * 1024 } });
  assert.deepEqual(await f.service.search('开心'), []);
  await assert.rejects(f.service.file(STICKER.id), { code: 'STICKER_TOO_LARGE' });
  assert.equal(f.calls.file, 0);
});

test('actual file size is checked even when metadata understates it', async (t) => {
  const f = await fixture(t, { payload: Buffer.alloc(8 * 1024 * 1024 + 1) });
  await assert.rejects(f.service.file(STICKER.id), { code: 'STICKER_TOO_LARGE' });
});

test('an HTML error saved as .gif is rejected', async (t) => {
  const f = await fixture(t, { payload: Buffer.from('<html>error</html>') });
  await assert.rejects(f.service.file(STICKER.id), { code: 'STICKER_INVALID_FILE' });
});

test('symlink cache directories cannot redirect an upstream material write', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.dir, 'outside');
  await fs.mkdir(outside);
  await f.service.search('开心');
  await fs.symlink(outside, path.join(f.options().dataDir, 'packs'));
  await assert.rejects(f.service.file(STICKER.id), { code: 'STICKER_UNSAFE_PATH' });
  assert.equal(f.calls.file, 0);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('upstream output must match the resolved safe catalog path', async (t) => {
  const f = await fixture(t);
  const wrong = path.join(f.dir, 'different.gif');
  f.kit.file = async () => { await fs.writeFile(wrong, 'GIF89a'); return { path: wrong }; };
  await assert.rejects(f.service.file(STICKER.id), { code: 'STICKER_UNSAFE_PATH' });
});

test('invalid modes and request limits fail explicitly', async (t) => {
  assert.throws(() => new StickerService({ mode: 'template' }), { code: 'STICKER_INVALID_CONFIG' });
  assert.throws(() => new StickerService({ autoSync: 'startup' }), { code: 'STICKER_INVALID_CONFIG' });
  const f = await fixture(t);
  await assert.rejects(f.service.search('开心', { limit: 0 }), { code: 'STICKER_INVALID_QUERY' });
  assert.equal(f.calls.factory, 0);
});
