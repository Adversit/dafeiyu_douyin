// ==UserScript==
// @name         大肥鱼 Douyin Bridge
// @namespace    dafeiyu-douyin-local
// @version      0.1.0
// @license      MIT
// @match        https://www.douyin.com/*
// @match        https://douyin.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

// MIT portions: Yht20927/douyin-cli @4073159bea585de6d33a4747a475669440737932.
// See vendor/douyin-cli/LICENSE and NOTICE.md. No external eval command is exposed.
/*
MIT License
Copyright (c) 2026 Yht20927

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
(function () {
  'use strict';
  const SERVER = 'http://127.0.0.1:19422';
  let token = GM_getValue('dafeiyu_bridge_token', '');
  GM_registerMenuCommand('配置本地 Bridge Token', () => {
    const next = prompt('输入本地配置中的 bridge.token（仅保存到本机油猴存储）', '');
    if (next && next.trim()) { GM_setValue('dafeiyu_bridge_token', next.trim()); location.reload(); }
  });
  if (!token) { console.info('[大肥鱼] 请在油猴菜单配置 Bridge Token 后刷新'); return; }

  const page = unsafeWindow;
  const fetch = (...args) => page.fetch(...args);
  const document = page.document;
  const navigator = page.navigator;
  const screen = page.screen;
  const crypto = page.crypto;
  const PAGE_LOAD_TIME = Date.now();
  const COMMANDS = new Set(['identity.get', 'video.get', 'comments.list', 'comments.replies', 'comments.delete', 'images.begin', 'images.append', 'images.upload', 'images.reset', 'comments.publish']);
  const buffers = new Map();
  function getCookie(name) {
    const item = document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
    return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
  }
  function losslessJson(text) {
    // Quote integer tokens BEFORE JSON.parse; a reviver cannot recover rounded IDs.
    return JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (match, string, number) =>
      !string && /^-?\d+$/.test(number) && !Number.isSafeInteger(Number(number)) ? JSON.stringify(number) : match));
  }
  async function bridgeFetchJson(label, url, init = {}, readOnly = true) {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
        const text = await response.text();
        if (!text.trim() || /^\s*</.test(text)) throw new Error(`${label}: login check or non-JSON response`);
        return losslessJson(text);
      } catch (error) {
        if (!readOnly) error.outcomeUnknown = true;
        if (!readOnly || attempt >= 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      } finally { clearTimeout(timer); }
    }
  }
  const api = {
    _q() {
      const chromeVersion = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] || '';
      const mac = /Mac/.test(navigator.platform);
      return { device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', pc_client_type: '1',
        update_version_code: '170400', version_code: '170400', version_name: '17.4.0',
        cookie_enabled: 'true', browser_language: navigator.language || 'zh-CN',
        browser_platform: navigator.platform, browser_name: 'Chrome', browser_version: chromeVersion,
        browser_online: String(navigator.onLine), engine_name: 'Blink', engine_version: chromeVersion,
        os_name: mac ? 'Mac OS' : 'Windows', os_version: '', platform: 'PC',
        screen_width: String(screen.width), screen_height: String(screen.height) };
    },
  _imgx: (function(){
    var enc=new TextEncoder();
    function toHex(buf){var u=new Uint8Array(buf),s='';for(var i=0;i<u.length;i++)s+=(u[i]<16?'0':'')+u[i].toString(16);return s;}
    async function sha256Hex(data){
      var bytes=typeof data==='string'?enc.encode(data):data;
      return toHex(await crypto.subtle.digest('SHA-256',bytes));
    }
    async function hmacRaw(keyBytes,msg){
      var k=await crypto.subtle.importKey('raw',keyBytes,{name:'HMAC',hash:'SHA-256'},false,['sign']);
      return new Uint8Array(await crypto.subtle.sign('HMAC',k,typeof msg==='string'?enc.encode(msg):msg));
    }
    async function hmacHex(keyBytes,msg){return toHex(await hmacRaw(keyBytes,msg));}
    // AWS 规范 URI 编码（保留 A-Za-z0-9-_.~）
    function uriEncode(s){return encodeURIComponent(s).replace(/[!'()*]/g,function(c){return '%'+c.charCodeAt(0).toString(16).toUpperCase();});}
    function canonQuery(p){
      return Object.keys(p).sort().map(function(k){return uriEncode(k)+'='+uriEncode(p[k]);}).join('&');
    }
    function crc32(u8){
      var crc=0xFFFFFFFF,c,i,j;
      for(i=0;i<u8.length;i++){
        c=(crc^u8[i])&0xFF;
        for(j=0;j<8;j++)c=c&1?(c>>>1)^0xEDB88320:c>>>1;
        crc=(crc>>>8)^c;
      }
      return ((crc^0xFFFFFFFF)>>>0).toString(16).padStart(8,'0');
    }
    async function signingKey(secret,dateStamp){
      var k=await hmacRaw(enc.encode('AWS4'+secret),dateStamp);
      k=await hmacRaw(k,'cn-north-1');k=await hmacRaw(k,'imagex');
      return hmacRaw(k,'aws4_request');
    }
    // 签名并发送 ImageX 请求（region/service 固定 cn-north-1 / imagex）
    async function sign(method,host,pathname,creds,params,bodyObj){
      var amzDate=new Date().toISOString().replace(/\.\d{3}Z$/,'Z').replace(/[:\-]/g,'');
      var dateStamp=amzDate.slice(0,8);
      var cq=canonQuery(params||{});
      var hdrs={'x-amz-date':amzDate,'x-amz-security-token':creds.sessionToken};
      var body=null;
      if(bodyObj){body=JSON.stringify(bodyObj);hdrs['X-Amz-Content-Sha256']=await sha256Hex(body);}
      var bodyHash=hdrs['X-Amz-Content-Sha256']||(body?await sha256Hex(canonQuery(body)):await sha256Hex(''));
      var lower={};Object.keys(hdrs).forEach(function(h){lower[h.toLowerCase()]=hdrs[h];});
      var names=Object.keys(lower).sort();
      var canonHeaders=names.map(function(n){return n+':'+lower[n]+'\n';}).join('');
      var signedHeaders=names.join(';');
      var canonReq=[method,pathname,cq,canonHeaders,signedHeaders,bodyHash].join('\n');
      var scope=dateStamp+'/cn-north-1/imagex/aws4_request';
      var sts=['AWS4-HMAC-SHA256',amzDate,scope,await sha256Hex(canonReq)].join('\n');
      var sig=await hmacHex(await signingKey(creds.secretAccessKey,dateStamp),sts);
      var auth='AWS4-HMAC-SHA256 Credential='+creds.accessKeyId+'/'+scope+', SignedHeaders='+signedHeaders+', Signature='+sig;
      var url='https://'+host+pathname+(cq?'?'+cq:'');
      var init={method:method,headers:Object.assign({Authorization:auth},hdrs)};
      if(body){init.body=body;init.headers['Content-Type']='application/json';}
      var r=await fetch(url,init);
      var text=await r.text();
      var json;try{json=JSON.parse(text);}catch(e){json=text.slice(0,300);}
      return {http:r.status,body:json};
    }
    return {sha256Hex:sha256Hex,crc32:crc32,canonQuery:canonQuery,uriEncode:uriEncode,sign:sign};
  })(),
  // 分块传输缓冲：避免单条 eval 表达式塞进数 MB base64 拖垮 WebSocket
  _imgBuf: null,
  _getStorageUid: async function(){ return await strictUid(); },
  imageBegin: function(expectedLen){this._imgBuf={parts:[],len:0,expected:expectedLen||0};return true;},
  imageAppend: function(chunk){
    if(!this._imgBuf)throw new Error('imageBegin() 未调用');
    this._imgBuf.parts.push(chunk);this._imgBuf.len+=chunk.length;
    return this._imgBuf.len;
  },
  imageReset: function(){this._imgBuf=null;return true;},
  // 上传缓冲中的图片 → {uri,width,height,format,size}
  imageUpload: async function(){
    if(!this._imgBuf||!this._imgBuf.len)throw new Error('图片缓冲为空，请先 imageBegin/imageAppend');
    var b64=this._imgBuf.parts.join('');
    this._imgBuf=null;
    var bin=atob(b64),u8=new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);

    // 1) 取上传授权（同源，自动带 cookie）
    var q=Object.assign(this._q(),{content_type:'0'});
    var auth=await bridgeFetchJson('commentUploadAuth','/aweme/v1/web/comment/upload/auth/?'+new URLSearchParams(q),{credentials:'include'},true);
    if(auth.status_code!==0||!auth.access_key)throw new Error('取图片上传授权失败: '+(auth.status_msg||('status_code='+auth.status_code)));
    var creds={accessKeyId:auth.access_key,secretAccessKey:auth.secret_key,sessionToken:auth.session_token};

    // 2) ApplyImageUpload
    var apply=await this._imgx.sign('GET',auth.upload_domain,'/',creds,{
      Action:'ApplyImageUpload',Version:'2018-08-01',ServiceId:auth.service_id,
      s:Math.random().toString(36).slice(2)
    });
    var addr=apply.body&&apply.body.Result&&apply.body.Result.UploadAddress;
    if(!addr||!addr.StoreInfos||!addr.StoreInfos.length)throw new Error('申请上传地址失败: '+JSON.stringify(apply.body).slice(0,200));

    // 3) 上传字节到 TOS（无 /upload/v1 前缀，实测确认）
    var store=addr.StoreInfos[0];
    var uid=await this._getStorageUid();
    var upRes=await fetch('https://'+addr.UploadHosts[0]+'/'+store.StoreUri,{
      method:'PUT',
      headers:{Authorization:store.Auth,'Content-CRC32':this._imgx.crc32(u8),'X-Storage-U':uid},
      body:u8
    });
    var upText=await upRes.text();
    if(upRes.status!==200||/"success"\s*:\s*[1-9]/.test(upText)){
      throw new Error('图片上传失败 HTTP '+upRes.status+': '+upText.slice(0,200));
    }

    // 4) CommitImageUpload
    var commit=await this._imgx.sign('POST',auth.upload_domain,'/',creds,
      {Action:'CommitImageUpload',Version:'2018-08-01',ServiceId:auth.service_id},
      {SessionKey:addr.SessionKey});
    var pr=commit.body&&commit.body.Result&&commit.body.Result.PluginResult&&commit.body.Result.PluginResult[0];
    if(!pr)throw new Error('图片提交失败: '+JSON.stringify(commit.body).slice(0,200));
    return {uri:pr.ImageUri,width:pr.ImageWidth,height:pr.ImageHeight,format:pr.ImageFormat,size:pr.ImageSize};
  },
  };
  async function strictUid() {
    const data = await bridgeFetchJson('identity', '/aweme/v1/web/query/user/?' + new URLSearchParams(api._q()), { credentials: 'include' });
    if (data.status_code !== undefined && data.status_code !== 0) return '';
    const uid = String(data.user_uid || data.user?.uid || '');
    return /^\d{5,30}$/.test(uid) ? uid : '';
  }
  function decimal(value, label) { if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) throw new Error(`Invalid ${label}`); return value; }
  async function detail(videoId) {
    const data = await bridgeFetchJson('video.get', '/aweme/v1/web/aweme/detail/?' + new URLSearchParams({ ...api._q(), aweme_id: decimal(videoId, 'videoId') }), { credentials: 'include' });
    if (data.status_code !== undefined && data.status_code !== 0) throw new Error('Video detail rejected');
    return data;
  }
  async function ownVideo(videoId, uid) {
    const data = await detail(videoId);
    if (String(data.aweme_detail?.author?.uid || data.aweme_detail?.author?.uid_str || '') !== uid) throw new Error('Video ownership mismatch');
    return data;
  }
  function responseId(value) {
    if (typeof value === 'string' && /^\d{1,30}$/.test(value)) return value;
    if (Number.isSafeInteger(value) && value >= 0) return String(value);
    return '';
  }
  // Only delete a reply whose location and author are explicitly confirmed by
  // the platform. Agent provenance is independently checked by the caller.
  async function verifyOwnReply(videoId, rootCid, commentCid, uid) {
    let cursor = '0';
    const seen = new Set([cursor]);
    for (let page = 0; page < 50; page++) {
      const params = new URLSearchParams({ ...api._q(), item_id: videoId, comment_id: rootCid, cursor, count: '20', item_type: '0', pc_img_format: 'webp', cut_version: '1' });
      const data = await bridgeFetchJson('comments.replies', '/aweme/v1/web/comment/list/reply/?' + params, { credentials: 'include' });
      if (!data || (data.status_code !== undefined && data.status_code !== 0) || !Array.isArray(data.comments)) throw new Error('Reply lookup rejected or incomplete');
      const match = data.comments.find(comment => responseId(comment?.cid) === commentCid);
      if (match) {
        const author = match.user;
        const identities = author && typeof author === 'object' ? [author.uid, author.uid_str].filter(value => value !== undefined && value !== null) : [];
        if (responseId(match.aweme_id) !== videoId || responseId(match.reply_id) !== rootCid || !identities.length || identities.some(value => responseId(value) !== uid)) throw new Error('Reply identity or thread mismatch');
        return;
      }
      if (![true, false, 0, 1].includes(data.has_more)) throw new Error('Reply pagination is incomplete');
      if (!data.has_more) throw new Error('Reply not found');
      const next = responseId(data.cursor);
      if (!next || seen.has(next)) throw new Error('Reply pagination did not advance');
      seen.add(next); cursor = next;
    }
    throw new Error('Reply lookup exceeded page limit');
  }
  async function dispatch(command, args) {
    if (!COMMANDS.has(command)) throw new Error('Unsupported command');
    decimal(args?.accountUid, 'accountUid');
    const uid = await strictUid(); // Fresh, fail closed; no cookie/localStorage/cache fallback.
    if (command === 'identity.get') return { uid };
    if (!uid || uid !== args.accountUid) throw new Error('Current login identity mismatch');
    switch (command) {
      case 'video.get': return ownVideo(args.videoId, uid);
      case 'comments.list':
      case 'comments.replies': {
        decimal(args.videoId, 'videoId'); decimal(args.cursor || '0', 'cursor');
        if (command === 'comments.replies') decimal(args.rootCid, 'rootCid');
        const params = new URLSearchParams({ ...api._q(), cursor: args.cursor || '0', count: String(Math.min(20, args.count || 20)), item_type: '0', pc_img_format: 'webp', cut_version: '1' });
        if (command === 'comments.replies') { params.set('item_id', args.videoId); params.set('comment_id', args.rootCid); }
        else params.set('aweme_id', args.videoId);
        const response = await bridgeFetchJson(command, '/aweme/v1/web/comment/list/' + (command === 'comments.replies' ? 'reply/' : '') + '?' + params, { credentials: 'include' });
        // This local marker lets the bridge distinguish a corrected request
        // from an older installed script, which used the wrong video parameter.
        if (command === 'comments.replies' && response && typeof response === 'object' && !Array.isArray(response)) return { ...response, _bridge_reply_query: 'item_id-v1' };
        return response;
      }
      case 'comments.delete': {
        decimal(args.videoId, 'videoId'); decimal(args.rootCid, 'rootCid'); decimal(args.commentCid, 'commentCid');
        if (args.rootCid === args.commentCid || [args.videoId, args.rootCid, args.commentCid].some(value => /^0+$/.test(value))) throw new Error('Invalid reply delete target');
        const video = await ownVideo(args.videoId, uid);
        if (responseId(video.aweme_detail?.aweme_id) !== args.videoId) throw new Error('Video identity mismatch');
        await verifyOwnReply(args.videoId, args.rootCid, args.commentCid, uid);
        if (await strictUid() !== uid) throw new Error('Login changed before deleting');
        // Adapted from douyin-cli's deleteComment (MIT); writing is never retried.
        const params = new URLSearchParams({ ...api._q(), cid: args.commentCid, channel_id: '0', app_name: 'aweme' });
        return bridgeFetchJson('comments.delete', '/aweme/v1/web/comment/delete?' + params, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: '', credentials: 'include' }, false);
      }
      case 'images.begin': {
        if (!/^[a-zA-Z0-9-]{1,80}$/.test(args.uploadId) || !Number.isInteger(args.expectedLength) || args.expectedLength < 1 || args.expectedLength > 14 * 1024 * 1024) throw new Error('Invalid upload buffer');
        for (const [key, entry] of buffers) if (Date.now() - entry.createdAt > 120000) buffers.delete(key);
        if (buffers.size >= 3) throw new Error('Too many active image uploads');
        buffers.set(args.uploadId, { parts: [], len: 0, expected: args.expectedLength, createdAt: Date.now(), uid }); return true;
      }
      case 'images.append': {
        const buffer = buffers.get(args.uploadId);
        if (!buffer || buffer.uid !== uid || typeof args.chunk !== 'string' || args.chunk.length > 512 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(args.chunk)) throw new Error('Invalid upload chunk');
        if (buffer.len + args.chunk.length > buffer.expected) throw new Error('Upload exceeds expected length');
        buffer.parts.push(args.chunk); buffer.len += args.chunk.length; return buffer.len;
      }
      case 'images.reset': buffers.delete(args.uploadId); return true;
      case 'images.upload': {
        const buffer = buffers.get(args.uploadId); buffers.delete(args.uploadId);
        if (!buffer || buffer.uid !== uid || buffer.len !== buffer.expected) throw new Error('Image buffer is incomplete');
        api._imgBuf = buffer;
        return api.imageUpload();
      }
      case 'comments.publish': {
        decimal(args.videoId, 'videoId'); decimal(args.targetCid, 'targetCid'); if (args.rootCid) decimal(args.rootCid, 'rootCid');
        if (typeof args.text !== 'string' || args.text.length > 3000 || !Array.isArray(args.images) || args.images.length > 9 || (!args.text.trim() && !args.images.length)) throw new Error('Invalid reply payload');
        await ownVideo(args.videoId, uid);
        // A second fresh login read immediately precedes the only publishing call.
        if (await strictUid() !== uid) throw new Error('Login changed before publishing');
        const root = args.rootCid || args.targetCid;
        const rrid = args.rootCid && args.rootCid !== args.targetCid ? args.targetCid : null;
        const body = new URLSearchParams({ aweme_id: args.videoId, reply_id: root, text: args.text, text_extra: '[]', one_level_comment_rank: '1', paste_edit_method: 'non_paste',
          comment_send_celltime: String(Math.floor((Date.now() - PAGE_LOAD_TIME) / 1000) * 1000), comment_video_celltime: '0' });
        if (rrid) body.set('reply_to_reply_id', rrid);
        if (args.images.length) {
          for (const image of args.images) if (!image || typeof image.uri !== 'string' || !/^[A-Za-z0-9_./-]{1,1024}$/.test(image.uri) || !['gif', 'jpeg', 'png', 'webp', 'bmp', 'heic'].includes(image.format) || ![image.width, image.height].every(n => Number.isInteger(n) && n > 0 && n <= 50000)) throw new Error('Invalid uploaded image');
          body.set('image_uri_list', args.images.map(x => x.uri).join(',')); body.set('image_formats', args.images.map(x => x.format).join(','));
          body.set('image_widths', args.images.map(x => x.width).join(',')); body.set('image_heights', args.images.map(x => x.height).join(','));
        }
        const params = new URLSearchParams({ ...api._q(), app_name: 'aweme', enter_from: 'others_homepage', aweme_id: args.videoId, item_type: '0', webid: getCookie('s_v_web_id') || getCookie('webid'), uifid: getCookie('UIFID') });
        return bridgeFetchJson('comments.publish', '/aweme/v1/web/comment/publish/?' + params, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }, false);
      }
    }
  }
  function request(route, body) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({ method: 'POST', url: SERVER + route,
      timeout: 35000, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, data: JSON.stringify(body),
      onload(response) { try { const data = JSON.parse(response.responseText); if (response.status >= 400 || !data.ok) { const error = new Error(data.error || 'Bridge HTTP error'); error.code = data.code; throw error; } resolve(data); } catch (error) { reject(error); } },
      onerror: () => reject(new Error('Local bridge unavailable')), ontimeout: () => reject(new Error('Local bridge timeout')) }));
  }
  async function run() {
    let sessionId = null; let accountUid = null;
    for (;;) {
      try {
        if (!sessionId) {
          accountUid = await strictUid();
          if (!accountUid) throw new Error('Login identity unavailable; waiting');
          const connected = await request('/api/connect', { accountUid }); sessionId = connected.sessionId;
        }
        const message = await request('/api/poll', { sessionId });
        if (message.type !== 'command') continue;
        let value; let error; let outcomeUnknown = false;
        try { value = await dispatch(message.command, message.args); }
        catch (failure) { error = failure.message; outcomeUnknown = Boolean(failure.outcomeUnknown); }
        // Never rerun a command if this receipt fails: the platform may have accepted it.
        await request('/api/result', { sessionId, id: message.id, value, error, outcomeUnknown });
      } catch (error) {
        console.info('[大肥鱼] Bridge 暂停：' + error.message); sessionId = null; accountUid = null;
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }
  run();
})();
