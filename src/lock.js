'use strict';
// Exclusive process lock follows the pre-action lock pattern in MIT dsh_douyin_tools.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

function acquireLock(filename) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const nonce = crypto.randomUUID();
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(filename, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce })); } finally { fs.closeSync(fd); }
      return () => {
        try { if (JSON.parse(fs.readFileSync(filename, 'utf8')).nonce === nonce) fs.unlinkSync(filename); } catch { /* already released */ }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let old;
      try { old = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { throw new Error('执行锁内容异常，请确认没有运行中的进程后检查 runtime/worker.lock'); }
      if (!Number.isInteger(old.pid) || old.pid < 1) throw new Error('执行锁 PID 无效');
      try { process.kill(old.pid, 0); } catch (e) {
        if (e.code === 'ESRCH') throw new Error('存在已退出进程的执行锁；确认没有 worker 运行后，手动删除 runtime/worker.lock 再启动');
        throw new Error('无法确认现有执行进程状态');
      }
      throw new Error(`已有 worker 运行中（PID ${old.pid}）`);
    }
  }
  throw new Error('无法获取执行锁');
}

module.exports = { acquireLock };
