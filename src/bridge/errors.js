'use strict';

const BROWSER_DISCONNECTED_MESSAGE = '抖音页面未连接。请打开并登录抖音，确认油猴脚本已启用，刷新页面后点击“检测状态”，再开始轮询。';
function translateBridgeError(error) {
  if (error?.code === 'BRIDGE_REJECTED' && error.message === 'Browser bridge is not connected') error.message = BROWSER_DISCONNECTED_MESSAGE;
  return error;
}
module.exports = { BROWSER_DISCONNECTED_MESSAGE, translateBridgeError };
