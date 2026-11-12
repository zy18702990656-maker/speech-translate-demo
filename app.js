/* =========================================================
 * 腾讯云语音识别 · 实时语音翻译（WebSocket）体验台
 * 接口文档 https://cloud.tencent.com/document/product/1093/127565
 * 纯前端实现：浏览器直连 wss，签名在本地用 Web Crypto 计算
 * ========================================================= */
'use strict';

const HOST = 'asr.cloud.tencent.com';
const PATH = '/asr/speech_translate/';
const FRAME_SAMPLES = 3200;          // 200ms @ 16k = 3200 samples = 6400 bytes
const TARGET_RATE = 16000;

const LANG_NAME = {
  zh: '中文', en: '英文', zh_en: '中英混合', ja: '日语',
  ko: '韩语', yue: '粤语', id: '印尼语', th: '泰语', ru: '俄语'
};
/* 官方 target 支持矩阵 */
const TARGET_MAP = {
  zh:    ['en', 'ja', 'ko', 'yue', 'id', 'th', 'zh'],
  en:    ['zh', 'ja', 'ko', 'yue', 'id', 'th', 'en'],
  zh_en: ['zh_en', 'zh', 'en', 'ja', 'ko', 'yue', 'id', 'th'],
  ja:    ['zh', 'en', 'ko', 'yue', 'ja'],
  ko:    ['zh', 'en', 'ja', 'yue', 'ko'],
  yue:   ['zh', 'en', 'ja', 'ko', 'yue'],
  id:    ['zh', 'en', 'id'],
  th:    ['zh', 'en', 'th'],
  ru:    ['zh', 'en', 'ru']
};
const TTS_OK_TARGET = ['zh', 'en', 'zh_en'];

const ERR_MSG = {
  6000: '音频发送过快（需 1:1 实时率）', 6001: '参数不合法', 6002: '鉴权失败（签名或账号配置异常）',
  6003: '账号未开通语音识别服务，请先在控制台开通', 6004: '资源包耗尽，请开通后付费或购买资源包',
  6005: '账户欠费已停止服务', 6006: '并发超限（默认 5 路）', 6007: '音频解码失败',
  6008: '客户端超过 15 秒未发送音频数据', 6009: '客户端连接断开', 6010: '上传了未知文本消息',
  6011: '分片音频数据过大', 6012: '后端负载/网络抖动，请重试', 6013: '后端负载/网络抖动，请重试',
  6014: '语音合成失败', 7000: '后端负载/网络抖动，请重试'
};

const $ = id => document.getElementById(id);
const el = {};
['authCard','hideAuth','credState',
 'appid','secretid','secretkey','toggleKey','remember','clearKey','source','target','transModel','langNote',
 'enableTts','ttsBody','voiceType','customVoiceWrap','customVoice','codec','speed','speedVal','volume','volumeVal',
 'advHead','advBody','advChev','hotword','vad','maxSpeak','filterDirty','filterModal','filterPunc','convertNum','noise','domain',
 'connPill','connText','mSentences','mDuration','mChars','langBadge','srcColTitle','tgtColTitle',
 'srcList','tgtList','copyBtn','clearBtn','micBtn','micLabel','fileBtn','fileInput','mockBtn',
 'meterFill','meterTxt','voiceIdTxt','statusLine','logHead','logBody','logChev','urlBox','logBox','logClear','toast']
 .forEach(k => el[k] = $(k));

/* ---------------- 运行时状态 ---------------- */
const S = {
  ws: null, running: false, mode: null,          // 'mic' | 'file' | 'mock'
  voiceId: '', startAt: 0, firstAt: 0,
  sentences: new Map(), order: [], chars: 0, finalSentences: 0,
  audioMs: 0,
  // 采集
  audioCtx: null, stream: null, node: null, srcNode: null, scriptNode: null,
  pcmTail: new Int16Array(0),
  // 文件推流
  pump: null, fileData: null, filePos: 0,
  // TTS 播放
  playCtx: null, playAt: 0, mp3Chunks: [], ttsRate: 16000,
  mockTimer: null
};

/* ================= 工具 ================= */
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove('show'), 2600);
}
function status(msg, type) {
  el.statusLine.textContent = msg;
  el.statusLine.className = 'console-status' + (type ? ' ' + type : '');
}
function setConn(state, text) {
  el.connPill.className = 'conn-pill' + (state ? ' ' + state : '');
  el.connText.textContent = text;
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
function log(tag, msg) {
  const empty = el.logBox.querySelector('.log-empty');
  if (empty) empty.remove();
  const d = new Date();
  const t = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `<span class="log-t">${t}</span><span class="log-tag ${tag.cls}">${tag.txt}</span><span class="log-msg"></span>`;
  line.querySelector('.log-msg').textContent = msg;
  el.logBox.appendChild(line);
  if (el.logBox.childElementCount > 400) el.logBox.firstElementChild.remove();
  el.logBox.scrollTop = el.logBox.scrollHeight;
}
const T = {
  up:   { cls: 'up',   txt: '发送' },
  down: { cls: 'down', txt: '接收' },
  bin:  { cls: 'bin',  txt: '音频' },
  err:  { cls: 'err',  txt: '错误' }
};

/* ================= 密钥存取 ================= */
const LS = 'tc_spt_demo_cred';
function loadCred() {
  try {
    const v = JSON.parse(localStorage.getItem(LS) || '{}');
    if (v.appid) el.appid.value = v.appid;
    if (v.secretid) el.secretid.value = v.secretid;
    if (v.secretkey) el.secretkey.value = v.secretkey;
  } catch (e) {}
}
function hasCred() {
  return !!(el.appid.value.trim() && el.secretid.value.trim() && el.secretkey.value.trim());
}
/* localStorage 按 origin 隔离：本地调试地址与线上地址需各填一次，这里显式提示 */
function refreshCredState() {
  const og = location.origin;
  if (hasCred()) {
    el.credState.className = 'alert alert-origin ok';
    el.credState.innerHTML = `<b>当前站点已保存配置 ✓</b> 实时链路可用。<span class="og">${escapeHtml(og)}</span>`;
  } else {
    el.credState.className = 'alert alert-origin no';
    el.credState.innerHTML = `<b>当前站点尚未保存配置</b>　localStorage 按站点隔离，本地调试地址与线上地址需各填一次。<span class="og">${escapeHtml(og)}</span>`;
  }
}
function saveCred() {
  if (!el.remember.checked) { refreshCredState(); return; }
  localStorage.setItem(LS, JSON.stringify({
    appid: el.appid.value.trim(), secretid: el.secretid.value.trim(), secretkey: el.secretkey.value.trim()
  }));
  refreshCredState();
}

/* ================= 语言下拉 ================= */
function initLang() {
  Object.keys(TARGET_MAP).forEach(k => {
    const o = document.createElement('option');
    o.value = k; o.textContent = `${k} · ${LANG_NAME[k]}`;
    el.source.appendChild(o);
  });
  el.source.value = 'zh';
  syncTarget('en');
}
function syncTarget(prefer) {
  const src = el.source.value;
  const list = TARGET_MAP[src] || ['en'];
  const keep = prefer || el.target.value;
  el.target.innerHTML = '';
  list.forEach(k => {
    const o = document.createElement('option');
    o.value = k; o.textContent = `${k} · ${LANG_NAME[k]}`;
    el.target.appendChild(o);
  });
  el.target.value = list.includes(keep) ? keep : list[0];
  refreshLangUI();
}
function refreshLangUI() {
  const s = el.source.value, t = el.target.value;
  el.langBadge.textContent = `${LANG_NAME[s]} → ${LANG_NAME[t]}`;
  el.srcColTitle.textContent = `识别原文 · ${LANG_NAME[s]}`;
  el.tgtColTitle.textContent = `翻译译文 · ${LANG_NAME[t]}`;
  if (s === 'zh_en' && t === 'zh_en') {
    el.langNote.innerHTML = 'source 与 target 同为 <code>zh_en</code>：中文自动译英文、英文自动译中文，适合中英混说场景。';
  } else {
    el.langNote.innerHTML = `当前链路 <code>${s}</code> → <code>${t}</code>。切换源语言后目标语言会按官方支持矩阵自动收敛。`;
  }
  if (el.enableTts.checked && !TTS_OK_TARGET.includes(t)) {
    status(`目标语言 ${LANG_NAME[t]} 不支持译文语音合成（仅 zh / en / zh_en），该参数将被忽略。`, 'err');
  }
}

/* ================= 签名 ================= */
async function hmacSha1B64(key, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  let s = '';
  new Uint8Array(sig).forEach(b => s += String.fromCharCode(b));
  return btoa(s);
}
function collectParams() {
  const now = Math.floor(Date.now() / 1000);
  const p = {
    secretid: el.secretid.value.trim(),
    timestamp: now,
    expired: now + 24 * 3600,
    nonce: Math.floor(Math.random() * 1e9) + 1,
    voice_id: S.voiceId,
    voice_format: 1,
    source: el.source.value,
    target: el.target.value,
    trans_model: el.transModel.value
  };
  if (el.enableTts.checked && TTS_OK_TARGET.includes(el.target.value)) {
    p.enable_tts = 1;
    const vt = el.voiceType.value === '__custom' ? el.customVoice.value.trim() : el.voiceType.value;
    if (vt) {
      if (/^\d+$/.test(vt)) {
        p.voice_type = vt;
      } else {                       // 非纯数字视为一句话声音复刻音色
        p.voice_type = 200000000;
        p.fast_voice_type = vt;
      }
    }
    p.codec = el.codec.value;
    p.sample_rate = 16000;
    if (parseFloat(el.speed.value) !== 0) p.speed = parseFloat(el.speed.value);
    if (parseFloat(el.volume.value) !== 0) p.volume = parseFloat(el.volume.value);
  }
  const hw = el.hotword.value.trim();
  if (hw) p.hotword_list = hw;
  if (el.filterDirty.value !== '0') p.filter_dirty = el.filterDirty.value;
  if (el.filterModal.value !== '0') p.filter_modal = el.filterModal.value;
  if (el.filterPunc.value !== '0') p.filter_punc = el.filterPunc.value;
  if (el.convertNum.value !== '1') p.convert_num_mode = el.convertNum.value;
  if (parseFloat(el.noise.value) !== 0) p.noise_threshold = parseFloat(el.noise.value);
  if (el.domain.value) p.domain = el.domain.value;
  if (el.vad.value && el.vad.value !== '1000') p.vad_silence_time = el.vad.value;
  if (el.maxSpeak.value && el.maxSpeak.value !== '10000') p.max_speak_time = el.maxSpeak.value;
  return p;
}
async function buildUrl() {
  const appid = el.appid.value.trim();
  const sk = el.secretkey.value.trim();
  const p = collectParams();
  const qs = Object.keys(p).sort()
    .map(k => `${k}=${encodeURIComponent(p[k])}`).join('&');
  const origin = `${HOST}${PATH}${appid}?${qs}`;
  const sig = await hmacSha1B64(sk, origin);
  const url = `wss://${origin}&signature=${encodeURIComponent(sig)}`;
  const masked = url
    .replace(`${PATH}${appid}?`, `${PATH}${appid.slice(0, 4)}******?`)
    .replace(/secretid=[^&]+/, 'secretid=AKID****************')
    .replace(/signature=[^&]+/, 'signature=****************');
  el.urlBox.textContent = masked;
  return url;
}

/* ================= 字幕渲染 ================= */
function clearSubs() {
  S.sentences.clear(); S.order = []; S.chars = 0; S.finalSentences = 0;
  el.srcList.innerHTML = ''; el.tgtList.innerHTML = '';
  el.mSentences.innerHTML = '0<i>句</i>';
  el.mChars.innerHTML = '0<i>字</i>';
  el.mDuration.innerHTML = '0.0<i>s</i>';
}
function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}.${String(Math.floor(ms % 1000 / 100))}`;
}
function renderSentence(sid, r) {
  let rec = S.sentences.get(sid);
  if (!rec) {
    const mk = cls => {
      const d = document.createElement('div');
      d.className = 'sub-item live';
      d.innerHTML = `<span class="ts"></span><span class="tx"></span>`;
      return d;
    };
    rec = { s: mk(), t: mk() };
    el.srcList.appendChild(rec.s);
    el.tgtList.appendChild(rec.t);
    S.sentences.set(sid, rec);
    S.order.push(sid);
  }
  const tag = `${fmtTime(r.start_time || 0)} → ${fmtTime(r.end_time || 0)}`;
  const done = !!r.sentence_end;
  const put = (node, text) => {
    node.className = 'sub-item ' + (done ? 'done' : 'live');
    node.querySelector('.ts').textContent = tag;
    node.querySelector('.tx').innerHTML = escapeHtml(text || '') + (done ? '' : '<span class="caret"></span>');
  };
  put(rec.s, r.source_text);
  put(rec.t, r.target_text);
  if (done && !rec.counted) {
    rec.counted = true;
    S.finalSentences++;
    S.chars += (r.target_text || '').length;
    el.mSentences.innerHTML = `${S.finalSentences}<i>句</i>`;
    el.mChars.innerHTML = `${S.chars}<i>字</i>`;
  }
  el.srcList.scrollTop = el.srcList.scrollHeight;
  el.tgtList.scrollTop = el.tgtList.scrollHeight;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* ================= TTS 播放 ================= */
function playPcm(ab) {
  if (!S.playCtx) { S.playCtx = new (window.AudioContext || window.webkitAudioContext)(); S.playAt = S.playCtx.currentTime + 0.2; }
  const i16 = new Int16Array(ab);
  if (!i16.length) return;
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
  const buf = S.playCtx.createBuffer(1, f32.length, S.ttsRate);
  buf.copyToChannel ? buf.copyToChannel(f32, 0) : buf.getChannelData(0).set(f32);
  const src = S.playCtx.createBufferSource();
  src.buffer = buf; src.connect(S.playCtx.destination);
  const now = S.playCtx.currentTime;
  if (S.playAt < now) S.playAt = now + 0.05;
  src.start(S.playAt);
  S.playAt += buf.duration;
}
function playMp3() {
  if (!S.mp3Chunks.length) return;
  const blob = new Blob(S.mp3Chunks, { type: 'audio/mpeg' });
  S.mp3Chunks = [];
  const a = new Audio(URL.createObjectURL(blob));
  a.play().catch(() => {});
}

/* ================= WebSocket ================= */
async function openWs() {
  let url;
  try { url = await buildUrl(); }
  catch (e) { status('签名计算失败：' + e.message + '（crypto.subtle 需 HTTPS 或 localhost 环境）', 'err'); return null; }

  setConn('wait', '握手中');
  status('正在建立 WebSocket 连接…');
  log(T.up, `CONNECT wss://${HOST}${PATH}${el.appid.value.trim().slice(0, 4)}****** …`);

  return new Promise(resolve => {
    let ws;
    try { ws = new WebSocket(url); } catch (e) { status('连接创建失败：' + e.message, 'err'); return resolve(null); }
    ws.binaryType = 'arraybuffer';
    let settled = false;

    ws.onopen = () => log(T.down, 'WebSocket opened，等待握手确认');

    ws.onmessage = ev => {
      if (typeof ev.data !== 'string') {
        log(T.bin, `binary ${ev.data.byteLength} bytes（合成音频分片）`);
        if (el.codec.value === 'mp3') S.mp3Chunks.push(ev.data); else playPcm(ev.data);
        return;
      }
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { log(T.err, 'JSON 解析失败：' + ev.data); return; }
      log(T.down, ev.data.length > 400 ? ev.data.slice(0, 400) + '…' : ev.data);

      if (m.code !== 0) {
        const tip = ERR_MSG[m.code] || m.message || '未知错误';
        status(`接口返回错误 code=${m.code}：${tip}`, 'err');
        setConn('err', `错误 ${m.code}`);
        log(T.err, `code=${m.code} ${m.message || ''}`);
        stopAll(true);
        if (!settled) { settled = true; resolve(null); }
        return;
      }
      if (!settled) {
        settled = true;
        setConn('on', '已连接');
        status('握手成功，开始推送音频流…', 'ok');
        resolve(ws);
        return;
      }
      if (m.result) {
        if (!S.firstAt) S.firstAt = performance.now();
        renderSentence(m.sentence_id || 'single', m.result);
      }
      if (m.final === 1) {
        log(T.down, 'final=1 音频流翻译结束');
        if (!(el.enableTts.checked && TTS_OK_TARGET.includes(el.target.value))) {
          status(`翻译完成：共 ${S.finalSentences} 句 / ${S.chars} 字译文。`, 'ok');
          closeWs();
        } else {
          status('识别翻译已完成，等待译文语音合成结束…');
        }
      }
      if (m.final === 2) {
        log(T.down, 'final=2 译文合成结束');
        if (el.codec.value === 'mp3') playMp3();
        status(`全部完成：${S.finalSentences} 句译文，语音播报已就绪。`, 'ok');
        closeWs();
      }
    };

    ws.onerror = () => {
      log(T.err, 'WebSocket error');
      if (!settled) { settled = true; status('连接失败：请检查网络连通性与账号服务开通状态，稍后重试。', 'err'); setConn('err', '连接失败'); resolve(null); }
    };
    ws.onclose = e => {
      log(T.down, `closed code=${e.code}`);
      setConn('', '未连接');
      if (!settled) { settled = true; resolve(null); }
      finishUI();
    };
  });
}
function closeWs() {
  if (S.ws && S.ws.readyState <= 1) { try { S.ws.close(); } catch (e) {} }
  S.ws = null;
  stopCapture();
  finishUI();
}
function sendEnd() {
  if (S.ws && S.ws.readyState === 1) {
    S.ws.send(JSON.stringify({ type: 'end' }));
    log(T.up, '{"type":"end"}');
  }
}

/* ================= 音频采集：麦克风 ================= */
const WORKLET_SRC = `
class Tap extends AudioWorkletProcessor{
  process(inputs){
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(new Float32Array(ch));
    return true;
  }
}
registerProcessor('pcm-tap', Tap);
`;

function f32ToI16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}
function resample(f32, from, to) {
  if (from === to) return f32;
  const ratio = from / to;
  const len = Math.round(f32.length / ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const p = i * ratio, i0 = Math.floor(p), i1 = Math.min(i0 + 1, f32.length - 1);
    out[i] = f32[i0] + (f32[i1] - f32[i0]) * (p - i0);
  }
  return out;
}
function feed(i16) {
  const merged = new Int16Array(S.pcmTail.length + i16.length);
  merged.set(S.pcmTail, 0); merged.set(i16, S.pcmTail.length);
  let off = 0;
  while (merged.length - off >= FRAME_SAMPLES) {
    const frame = merged.subarray(off, off + FRAME_SAMPLES);
    if (S.ws && S.ws.readyState === 1) {
      S.ws.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
      S.audioMs += 200;
      el.mDuration.innerHTML = `${(S.audioMs / 1000).toFixed(1)}<i>s</i>`;
    }
    off += FRAME_SAMPLES;
  }
  S.pcmTail = merged.slice(off);
}
function meter(f32) {
  let sum = 0;
  for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
  const rms = Math.sqrt(sum / f32.length);
  const pct = Math.min(100, Math.round(rms * 320));
  el.meterFill.style.width = pct + '%';
  el.meterTxt.textContent = pct + '%';
}

async function startMic() {
  S.stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
  const AC = window.AudioContext || window.webkitAudioContext;
  try { S.audioCtx = new AC({ sampleRate: TARGET_RATE }); } catch (e) { S.audioCtx = new AC(); }
  await S.audioCtx.resume();
  const rate = S.audioCtx.sampleRate;
  S.srcNode = S.audioCtx.createMediaStreamSource(S.stream);

  const onChunk = f32 => {
    meter(f32);
    feed(f32ToI16(resample(f32, rate, TARGET_RATE)));
  };

  let ok = false;
  if (S.audioCtx.audioWorklet) {
    try {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      await S.audioCtx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      S.node = new AudioWorkletNode(S.audioCtx, 'pcm-tap');
      S.node.port.onmessage = e => onChunk(e.data);
      S.srcNode.connect(S.node);
      const sink = S.audioCtx.createGain(); sink.gain.value = 0;
      S.node.connect(sink); sink.connect(S.audioCtx.destination);
      ok = true;
    } catch (e) { ok = false; }
  }
  if (!ok) {
    S.scriptNode = S.audioCtx.createScriptProcessor(4096, 1, 1);
    S.scriptNode.onaudioprocess = e => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
    S.srcNode.connect(S.scriptNode);
    S.scriptNode.connect(S.audioCtx.destination);
  }
  log(T.up, `麦克风已开启：采集 ${rate}Hz → 转码 16000Hz/16bit/mono，每 200ms 发 6400 字节`);
}
function stopCapture() {
  try { if (S.node) { S.node.port.onmessage = null; S.node.disconnect(); } } catch (e) {}
  try { if (S.scriptNode) { S.scriptNode.onaudioprocess = null; S.scriptNode.disconnect(); } } catch (e) {}
  try { if (S.srcNode) S.srcNode.disconnect(); } catch (e) {}
  try { if (S.stream) S.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { if (S.audioCtx) S.audioCtx.close(); } catch (e) {}
  S.node = S.scriptNode = S.srcNode = S.stream = S.audioCtx = null;
  if (S.pump) { clearInterval(S.pump); S.pump = null; }
  el.meterFill.style.width = '0%'; el.meterTxt.textContent = '0%';
}

/* ================= 文件推流 ================= */
async function decodeFile(file) {
  const ab = await file.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const tmp = new AC();
  let buf = null;
  try { buf = await tmp.decodeAudioData(ab.slice(0)); } catch (e) { buf = null; }
  tmp.close();
  if (!buf) {   // 裸 pcm 兜底：按 16k/16bit/mono 解释
    const i16 = new Int16Array(ab);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    return f32;
  }
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const len = Math.max(1, Math.ceil(buf.duration * TARGET_RATE));
  const off = new OAC(1, len, TARGET_RATE);
  const s = off.createBufferSource(); s.buffer = buf; s.connect(off.destination); s.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}
function startFilePump(f32) {
  const i16 = f32ToI16(f32);
  S.fileData = i16; S.filePos = 0;
  const total = (i16.length / TARGET_RATE).toFixed(1);
  status(`音频已转码：16k/16bit/mono，时长 ${total}s，按 1:1 实时率推流中…`);
  S.pump = setInterval(() => {
    if (!S.ws || S.ws.readyState !== 1) return;
    if (S.filePos >= S.fileData.length) {
      clearInterval(S.pump); S.pump = null;
      sendEnd();
      status('音频推流完成，等待后端返回最终结果…');
      return;
    }
    const end = Math.min(S.filePos + FRAME_SAMPLES, S.fileData.length);
    const frame = S.fileData.subarray(S.filePos, end);
    S.ws.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
    S.filePos = end;
    S.audioMs = S.filePos / TARGET_RATE * 1000;
    el.mDuration.innerHTML = `${(S.filePos / TARGET_RATE).toFixed(1)}<i>s</i>`;
    const pct = Math.round(S.filePos / S.fileData.length * 100);
    el.meterFill.style.width = pct + '%'; el.meterTxt.textContent = pct + '%';
  }, 200);
}

/* ================= 流程控制 ================= */
function validate() {
  const miss = [];
  if (!el.appid.value.trim()) miss.push('AppID');
  if (!el.secretid.value.trim()) miss.push('SecretID');
  if (!el.secretkey.value.trim()) miss.push('SecretKey');
  if (miss.length) {
    if (!authVisible()) {
      // 访客侧：不暴露"缺少密钥"这类配置细节，直接平滑切到演示模式
      status('本设备未配置实时链路，已为你切换到演示模式回放。现场实时体验请联系腾讯云同学开启。');
      toast('本站点未保存配置 → 已切演示模式（配置按站点隔离）');
      setTimeout(() => { if (!S.running) el.mockBtn.click(); }, 260);
      return false;
    }
    status(`请先填写 ${miss.join(' / ')}。没有密钥可以点右侧「演示模式」查看交互效果。`, 'err');
    toast('缺少 ' + miss.join(' / '));
    return false;
  }
  if (!window.crypto || !crypto.subtle) {
    status('当前环境不支持 crypto.subtle，请通过 HTTPS 或 localhost 打开本页。', 'err');
    return false;
  }
  return true;
}
function prepare(mode) {
  S.mode = mode; S.running = true;
  S.voiceId = uuid(); S.firstAt = 0; S.audioMs = 0; S.pcmTail = new Int16Array(0);
  S.mp3Chunks = []; S.playCtx = null; S.playAt = 0;
  el.voiceIdTxt.textContent = S.voiceId;
  clearSubs();
  S.startAt = performance.now();
  el.micBtn.classList.add('rec');
  el.micLabel.textContent = mode === 'mic' ? '结束说话' : '停止';
  el.fileBtn.disabled = mode !== 'file';
  el.mockBtn.disabled = mode !== 'mock';
}
function finishUI() {
  S.running = false;
  el.micBtn.classList.remove('rec');
  el.micLabel.textContent = '开始说话';
  el.fileBtn.disabled = false;
  el.mockBtn.disabled = false;
  el.mockBtn.classList.remove('on');
}
function stopAll(silent) {
  if (S.mockTimer) { clearInterval(S.mockTimer); S.mockTimer = null; }
  stopCapture();
  if (S.ws && S.ws.readyState === 1 && !silent) sendEnd();
  finishUI();
}

el.micBtn.onclick = async () => {
  if (S.running) {
    if (S.mode === 'mic') {
      stopCapture(); sendEnd();
      status('已停止录音，等待后端返回最终结果…');
      el.micLabel.textContent = '开始说话';
      el.micBtn.classList.remove('rec');
    } else { stopAll(); closeWs(); status('已手动停止。'); }
    return;
  }
  if (!validate()) return;
  saveCred();
  prepare('mic');
  const ws = await openWs();
  if (!ws) { finishUI(); return; }
  S.ws = ws;
  try { await startMic(); status('正在聆听，请开始说话 —— 结果会边说边出。', 'ok'); }
  catch (e) {
    status('麦克风获取失败：' + (e && e.message ? e.message : e) + '（需 HTTPS 并允许麦克风权限）', 'err');
    closeWs();
  }
};

el.fileBtn.onclick = () => { if (!S.running) el.fileInput.click(); };
el.fileInput.onchange = async e => {
  const file = e.target.files && e.target.files[0];
  el.fileInput.value = '';
  if (!file) return;
  if (!validate()) return;
  saveCred();
  status(`正在解码并重采样 ${file.name} …`);
  let f32;
  try { f32 = await decodeFile(file); }
  catch (err) { status('音频解码失败：' + err.message, 'err'); return; }
  prepare('file');
  const ws = await openWs();
  if (!ws) { finishUI(); return; }
  S.ws = ws;
  startFilePump(f32);
};

el.clearBtn.onclick = () => { clearSubs(); status('字幕已清空。'); };
el.copyBtn.onclick = () => {
  const rows = S.order.map(sid => {
    const r = S.sentences.get(sid);
    return `${r.s.querySelector('.tx').textContent}\n${r.t.querySelector('.tx').textContent}`;
  });
  if (!rows.length) { toast('暂无内容'); return; }
  navigator.clipboard.writeText(rows.join('\n\n')).then(() => toast('双语全文已复制'), () => toast('复制失败'));
};
el.logClear.onclick = () => { el.logBox.innerHTML = '<div class="log-empty">暂无报文</div>'; };

/* ================= 演示模式（无需密钥） ================= */
const MOCK = {
  zh_en: [
    { s: '各位领导好，今天由我来介绍腾讯云实时语音翻译的能力。', t: 'Hello everyone, today I will introduce the real-time speech translation capability of Tencent Cloud.' },
    { s: '这个接口走 WebSocket 协议，一边说一边出识别和翻译结果。', t: 'This API works over WebSocket and returns recognition and translation results while you are still speaking.' },
    { s: '目前支持中文、英文、日语、韩语、粤语、印尼语、泰语和俄语的互译。', t: 'It currently supports mutual translation among Chinese, English, Japanese, Korean, Cantonese, Indonesian, Thai and Russian.' },
    { s: '翻译模型可以在轻量版和标准版之间切换，分别对应低延迟和高质量。', t: 'The translation model can switch between the lite and standard versions, for lower latency or higher quality.' },
    { s: '如果打开语音合成，译文还可以直接播报出来，做到真正的同声传译。', t: 'With speech synthesis enabled, the translation can be read aloud directly, achieving true simultaneous interpretation.' }
  ]
};
function mockRun() {
  const list = MOCK.zh_en;
  let idx = 0, step = 0, sid = uuid(), t0 = 0;
  S.startAt = performance.now();
  const tick = () => {
    if (idx >= list.length) {
      clearInterval(S.mockTimer); S.mockTimer = null;
      status(`演示模式播放完毕：${S.finalSentences} 句双语字幕。实际链路为 WebSocket 直连，可现场实时体验。`, 'ok');
      setConn('', '未连接');
      finishUI();
      return;
    }
    const item = list[idx];
    const sTotal = item.s.length, tTotal = item.t.length;
    step++;
    const prog = Math.min(1, step / 11);
    const sCut = Math.ceil(sTotal * prog);
    const tCut = Math.ceil(tTotal * Math.max(0, prog - 0.18) / 0.82);
    const end = prog >= 1;
    if (!S.firstAt) S.firstAt = performance.now();
    renderSentence(sid, {
      source: 'zh', target: 'en',
      source_text: item.s.slice(0, sCut),
      target_text: item.t.slice(0, Math.min(tTotal, tCut)),
      start_time: t0, end_time: t0 + step * 260,
      sentence_end: end
    });
    S.audioMs = t0 + step * 260;
    el.mDuration.innerHTML = `${(S.audioMs / 1000).toFixed(1)}<i>s</i>`;
    const pct = 30 + Math.round(Math.random() * 55);
    el.meterFill.style.width = pct + '%'; el.meterTxt.textContent = pct + '%';
    if (end) { t0 = t0 + step * 260 + 320; idx++; step = 0; sid = uuid(); }
  };
  S.mockTimer = setInterval(tick, 230);
}
el.mockBtn.onclick = () => {
  if (S.running) { stopAll(); status('演示已停止。'); return; }
  prepare('mock');
  el.mockBtn.classList.add('on');
  el.voiceIdTxt.textContent = uuid();
  setConn('on', '演示模式');
  el.urlBox.textContent = `wss://${HOST}${PATH}<AppID>?expired=…&nonce=…&secretid=AKID******&source=zh&target=en&timestamp=…&trans_model=hunyuan-translation-lite&voice_format=1&voice_id=…&signature=******\n\n（演示模式为本地脚本回放，不产生真实请求与计费）`;
  log(T.down, '演示模式启动：本地脚本回放，不发起真实请求');
  status('演示模式：正在回放一段「中 → 英」边说边译效果。点「开始说话」可接入真实链路现场实时体验。');
  mockRun();
};

/* ================= 预设 ================= */
const PRESETS = {
  meeting: { source: 'zh', target: 'en', model: 'hunyuan-translation', tts: false, vad: 1000 },
  service: { source: 'zh_en', target: 'zh_en', model: 'hunyuan-translation-lite', tts: false, vad: 800 },
  live:    { source: 'zh', target: 'ja', model: 'hunyuan-translation-lite', tts: false, vad: 700 },
  tts:     { source: 'zh', target: 'en', model: 'hunyuan-translation', tts: true, voice: '101051', vad: 1000 }
};
document.querySelectorAll('.preset').forEach(btn => {
  btn.onclick = () => {
    const p = PRESETS[btn.dataset.preset];
    if (!p) return;
    document.querySelectorAll('.preset').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    el.source.value = p.source;
    syncTarget(p.target);
    el.transModel.value = p.model;
    el.enableTts.checked = p.tts;
    el.ttsBody.classList.toggle('collapsed', !p.tts);
    if (p.voice) el.voiceType.value = p.voice;
    el.vad.value = p.vad;
    refreshLangUI();
    toast('已套用预设：' + btn.querySelector('.preset-name').textContent);
  };
});

/* ================= 其它交互 ================= */
el.source.onchange = () => syncTarget();
el.target.onchange = refreshLangUI;
el.toggleKey.onclick = () => {
  const show = el.secretkey.type === 'password';
  el.secretkey.type = show ? 'text' : 'password';
  el.toggleKey.textContent = show ? '隐藏' : '显示';
};
el.clearKey.onclick = () => {
  localStorage.removeItem(LS);
  el.appid.value = el.secretid.value = el.secretkey.value = '';
  refreshCredState();
  toast('本站点已保存的配置已清除');
};
el.enableTts.onchange = () => {
  el.ttsBody.classList.toggle('collapsed', !el.enableTts.checked);
  refreshLangUI();
};
el.voiceType.onchange = () => el.customVoiceWrap.classList.toggle('hidden', el.voiceType.value !== '__custom');
el.speed.oninput = () => el.speedVal.textContent = el.speed.value;
el.volume.oninput = () => el.volumeVal.textContent = el.volume.value;
const toggle = (head, body, chev) => head.onclick = () => {
  const open = body.classList.toggle('collapsed');
  head.classList.toggle('open', !open);
  chev.textContent = open ? '展开' : '收起';
};
toggle(el.advHead, el.advBody, el.advChev);
toggle(el.logHead, el.logBody, el.logChev);

['appid', 'secretid', 'secretkey'].forEach(k => {
  el[k].onchange = saveCred;
  el[k].oninput = refreshCredState;
});

/* ========= 鉴权面板的显示控制（默认对客户隐藏） ========= */
function authVisible() { return el.authCard.classList.contains('show'); }
function setAuth(show) {
  el.authCard.classList.toggle('show', show);
  if (show) {
    refreshCredState();
    el.authCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast('配置面板已解锁 —— 演示前记得点「隐藏」');
  } else {
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    toast('配置面板已隐藏');
  }
}
el.hideAuth.onclick = () => setAuth(false);
// 暗门 1：地址栏 #config / #admin
function checkHash() {
  if (/^#(config|admin|setup)$/i.test(location.hash)) setAuth(true);
}
window.addEventListener('hashchange', checkHash);
// 暗门 2：连点左上角图标 5 次
let tapCount = 0, tapTimer = null;
document.querySelector('.brand-mark').addEventListener('click', () => {
  tapCount++;
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => tapCount = 0, 1200);
  if (tapCount >= 5) { tapCount = 0; setAuth(true); }
});
// Esc 快速收起
document.addEventListener('keydown', e => { if (e.key === 'Escape' && authVisible()) setAuth(false); });

/* ================= 启动 ================= */
initLang();
loadCred();
refreshCredState();
checkHash();
if (hasCred()) {
  status('实时链路已就绪，点「开始说话」即可现场体验；也可先点「演示模式」看效果回放。', 'ok');
} else {
  status('点「演示模式」可直接查看「边说边译」效果回放，无需任何配置。');
}
document.querySelector('.preset[data-preset="meeting"]').classList.add('active');
if (location.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  status('当前为非安全上下文，麦克风与签名计算不可用，请用 HTTPS 访问。可先体验「演示模式」。', 'err');
}
window.addEventListener('beforeunload', () => { try { stopAll(true); } catch (e) {} });
