'use strict';

// A closed command protocol: callers can never supply JavaScript or a URL to execute.
const RULES = {
  'identity.get': [],
  'video.get': ['videoId'],
  'comments.list': ['videoId'],
  'comments.replies': ['videoId', 'rootCid'],
  'comments.delete': ['videoId', 'rootCid', 'commentCid'],
  'images.begin': ['uploadId'],
  'images.append': ['uploadId'],
  'images.upload': ['uploadId'],
  'images.reset': ['uploadId'],
  'comments.publish': ['videoId', 'targetCid'],
};
const COMMANDS = Object.freeze(Object.keys(RULES));
const WRITE_COMMANDS = new Set(['comments.publish', 'comments.delete', 'images.upload']);
function id(value, name) {
  if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) throw new Error(`${name} must be a decimal ID string`);
  return value;
}
function validateCommand(command, args) {
  if (!COMMANDS.includes(command)) throw new Error('Unsupported bridge command');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Command args must be an object');
  id(args.accountUid, 'accountUid');
  for (const key of RULES[command]) {
    if (key === 'uploadId') {
      if (typeof args[key] !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(args[key])) throw new Error('Invalid uploadId');
    } else id(args[key], key);
  }
  if (command === 'comments.list' || command === 'comments.replies') {
    if (args.cursor !== undefined && (typeof args.cursor !== 'string' || !/^\d{1,30}$/.test(args.cursor))) throw new Error('Invalid cursor');
    if (args.count !== undefined && (!Number.isInteger(args.count) || args.count < 1 || args.count > 20)) throw new Error('Invalid page size');
  }
  if (command === 'comments.delete' && (args.commentCid === args.rootCid || [args.videoId, args.rootCid, args.commentCid].some(value => /^0+$/.test(value)))) throw new Error('Invalid reply delete target');
  if (command === 'images.begin' && (!Number.isInteger(args.expectedLength) || args.expectedLength < 1 || args.expectedLength > 14 * 1024 * 1024)) throw new Error('Invalid image size');
  if (command === 'images.append' && (typeof args.chunk !== 'string' || args.chunk.length > 512 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(args.chunk))) throw new Error('Invalid image chunk');
  if (command === 'comments.publish') {
    if (args.rootCid != null) id(args.rootCid, 'rootCid');
    if (typeof args.text !== 'string' || args.text.length > 3000) throw new Error('Invalid reply text (max 3000 characters)');
    if (!Array.isArray(args.images) || args.images.length > 9) throw new Error('Invalid reply images');
    if (!args.text.trim() && !args.images.length) throw new Error('Reply text or image is required');
    for (const image of args.images) {
      if (!image || typeof image.uri !== 'string' || !/^[A-Za-z0-9_./-]{1,1024}$/.test(image.uri)) throw new Error('Invalid image URI');
      if (!['gif', 'jpeg', 'png', 'webp', 'bmp', 'heic'].includes(image.format)) throw new Error('Invalid image format');
      if (![image.width, image.height].every(n => Number.isInteger(n) && n > 0 && n <= 50000)) throw new Error('Invalid image dimensions');
    }
  }
  return { command, args };
}
module.exports = { COMMANDS, WRITE_COMMANDS, validateCommand, id };
