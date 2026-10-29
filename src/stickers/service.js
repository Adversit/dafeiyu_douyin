'use strict';

// Adapter for dsh-nekowhale-stickers/core. Search, selection metadata and GIF
// caching remain upstream; this layer limits what the comment sender may read.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const PACKS = Object.freeze(['大肥鱼', '大肥鱼和GPT娘']);
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

class StickerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'StickerError';
    this.code = code;
  }
}

function reject(code, message) {
  throw new StickerError(code, message);
}

function component(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240
    && value !== '.' && value !== '..' && !/[\\/\0:%]/u.test(value);
}

function exactId(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  return parts.length === 2 && parts.every(component) && PACKS.includes(parts[0]);
}

function safeSticker(sticker, maxBytes) {
  if (!sticker || !exactId(sticker.id) || !component(sticker.pack)
      || !component(sticker.stem) || !component(sticker.file)
      || sticker.id !== `${sticker.pack}/${sticker.stem}`
      || sticker.file !== `${sticker.stem}.gif`
      || (sticker.hash && !/^[a-f\d]{12}$/u.test(sticker.hash))) {
    reject('STICKER_INVALID_METADATA', '表情索引包含不安全的素材路径或标识');
  }
  if (!Number.isFinite(sticker.bytes) || sticker.bytes < 0 || sticker.bytes > maxBytes) {
    reject('STICKER_TOO_LARGE', '表情文件超过允许大小或缺少有效大小信息');
  }
  return sticker;
}

async function createUpstreamKit(options) {
  let core;
  let packageFile;
  try {
    core = await import('dsh-nekowhale-stickers/core');
    packageFile = require.resolve('dsh-nekowhale-stickers/package.json');
  } catch (cause) {
    throw new StickerError('STICKER_DEPENDENCY_MISSING',
      '表情依赖无法加载，请安装固定依赖 dsh-nekowhale-stickers@1.1.1；也可先关闭表情功能', { cause });
  }
  return new core.StickerKit({
    ...options,
    bundledMeta: path.join(path.dirname(packageFile), 'meta', 'nekowhale.json'),
  });
}

class StickerService {
  constructor({ enabled = false, cacheDir = './data/stickers', autoSync = 'lazy',
    mode = 'original', maxBytes = DEFAULT_MAX_BYTES } = {}, { kitFactory = createUpstreamKit } = {}) {
    if (mode !== 'original') reject('STICKER_INVALID_CONFIG', '首版仅支持 original 原素材模式');
    if (!['lazy', 'off'].includes(autoSync)) {
      reject('STICKER_INVALID_CONFIG', 'autoSync 仅支持 lazy 按需下载或 off 离线模式');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 6 || maxBytes > 32 * 1024 * 1024) {
      reject('STICKER_INVALID_CONFIG', 'maxBytes 必须为 6 至 33554432 之间的整数');
    }
    if (typeof cacheDir !== 'string' || !cacheDir || cacheDir.includes('\0')) {
      reject('STICKER_INVALID_CONFIG', 'cacheDir 必须是有效的本地目录');
    }
    this.enabled = Boolean(enabled);
    this.cacheDir = path.resolve(cacheDir);
    this.autoSync = autoSync;
    this.mode = mode;
    this.maxBytes = maxBytes;
    this.kitFactory = kitFactory;
    this._loading = undefined;
  }

  async _kit() {
    if (!this.enabled) reject('STICKERS_DISABLED', '表情功能未开启');
    if (!this._loading) {
      this._loading = (async () => {
        await fs.mkdir(this.cacheDir, { recursive: true, mode: 0o700 });
        const root = await fs.realpath(this.cacheDir);
        const kit = await this.kitFactory({ dataDir: root, autoSync: this.autoSync,
          packs: [...PACKS], banwords: true });
        await kit.ready();
        return { kit, root };
      })().catch((error) => { this._loading = undefined; throw error; });
    }
    return this._loading;
  }

  async search(query, { limit = 5, excludeIds = [] } = {}) {
    if (!this.enabled) return [];
    if (typeof query !== 'string' || !query.trim()) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      reject('STICKER_INVALID_QUERY', '检索数量必须为 1 至 50 的整数');
    }
    if (!Array.isArray(excludeIds)) reject('STICKER_INVALID_QUERY', 'excludeIds 必须是数组');
    const excluded = new Set(excludeIds);
    const { kit } = await this._kit();
    // The upstream matcher and scores are used unchanged. Request its bounded
    // maximum so exclusion does not discard otherwise useful candidates.
    const hits = await kit.search(query.trim().slice(0, 300), { limit: 50, shuffle: false });
    const result = [];
    for (const { sticker, score } of hits) {
      try { safeSticker(sticker, this.maxBytes); } catch (error) {
        if (error instanceof StickerError) continue;
        throw error;
      }
      if (excluded.has(sticker.id) || !kit.isEnabled(sticker)) continue;
      result.push({ id: sticker.id, name: sticker.name || sticker.stem,
        emotion: sticker.emotion || '', description: sticker.desc || '',
        use: sticker.use || '', tags: Array.isArray(sticker.tags) ? [...sticker.tags] : [], pack: sticker.pack,
        text: sticker.text || '', score, attribution: structuredClone(kit.attribution) });
      if (result.length === limit) break;
    }
    return result;
  }

  async _safeParents(root, sticker) {
    const parts = ['packs', sticker.pack, sticker.file];
    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]);
      try {
        const info = await fs.lstat(current);
        if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) {
          reject('STICKER_UNSAFE_PATH', '表情缓存目录不能包含符号链接或非目录项');
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return current;
  }

  async file(id) {
    if (!this.enabled) reject('STICKERS_DISABLED', '表情功能未开启');
    if (!exactId(id)) reject('STICKER_INVALID_ID', '必须使用检索返回的完整原素材 ID');
    const { kit, root } = await this._kit();
    const sticker = await kit.resolve(id);
    if (!sticker || sticker.id !== id || !kit.isEnabled(sticker)) {
      reject('STICKER_NOT_FOUND', '表情不存在或已停用');
    }
    safeSticker(sticker, this.maxBytes);
    const expected = await this._safeParents(root, sticker);
    const output = await kit.file(sticker);
    if (!output || typeof output.path !== 'string' || path.resolve(output.path) !== expected) {
      reject('STICKER_UNSAFE_PATH', '表情服务返回了缓存范围之外的文件');
    }
    await this._safeParents(root, sticker);
    const actual = await fs.realpath(output.path);
    if (actual !== expected) reject('STICKER_UNSAFE_PATH', '表情文件不在预期缓存位置');
    const handle = await fs.open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < 6 || info.size > this.maxBytes) {
        reject('STICKER_TOO_LARGE', '表情实际文件大小不符合限制');
      }
      const header = Buffer.alloc(6);
      await handle.read(header, 0, 6, 0);
      if (!['GIF87a', 'GIF89a'].includes(header.toString('ascii'))) {
        reject('STICKER_INVALID_FILE', '原素材必须为真实 GIF 文件');
      }
      return { id: sticker.id, path: actual, mime: 'image/gif', bytes: info.size,
        name: sticker.name || sticker.stem, width: sticker.w || 0,
        height: sticker.h || 0, animated: sticker.frames > 1,
        attribution: structuredClone(kit.attribution) };
    } finally {
      await handle.close();
    }
  }
}

module.exports = { StickerService, StickerError };
