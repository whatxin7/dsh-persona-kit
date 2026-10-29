// 人格调试台（Persona Studio）—— 零依赖本地服务
// 作用：把桥接控制台里散落的「角色卡 / 人格提示词 / 备份回滚 / 当前生效预览」
// 收进一个专门窗口，并且不把控制台令牌暴露给浏览器（由本服务代注入）。
//
// 用法：D:\AI\python310 无关；用系统 node 即可
//   node studio/server.mjs            默认端口 3200（PERSONA_PORT 可改）
//   然后浏览器打开 http://127.0.0.1:3200
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = process.env.BRIDGE_API || 'http://127.0.0.1:3100';
const BRIDGE_ROOT = process.env.BRIDGE_ROOT || path.resolve('..');
const PORT = Number(process.env.PERSONA_PORT || 3200);

function consoleToken() {
  try {
    return fs.readFileSync(path.join(BRIDGE_ROOT, 'state/console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function bridgeFetch(pathname, init = {}) {
  const token = consoleToken();
  if (!token) throw new Error('读不到 state/console-token，桥接可能没跑过');
  const res = await fetch(BRIDGE + pathname, {
    ...init,
    headers: { 'x-console-token': token, 'content-type': 'application/json', ...(init.headers ?? {}) }
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { ok: false, error: text.slice(0, 400) }; }
  return { status: res.status, body };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 管理员自己的 QQ 号 + 该私聊会话的 agent token（reserved2 下发送必须带） */
function ownerContext() {
  let ownerQQ = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(BRIDGE_ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
    ownerQQ = cfg.ownerQQ ? String(cfg.ownerQQ) : null;
  } catch {}
  if (!ownerQQ) throw new Error('config.json 里没有 ownerQQ，无法确定试聊目标');
  let agentToken = '';
  try {
    const st = JSON.parse(fs.readFileSync(path.join(BRIDGE_ROOT, 'state/social-v2.json'), 'utf8'));
    agentToken = st?.conversations?.[`private:${ownerQQ}`]?.agentToken ?? '';
  } catch {}
  return { key: `private:${ownerQQ}`, ownerQQ, agentToken };
}

/** 试聊：按角色口吻往管理员自己的 QQ 私聊发一条（真实链路，不经模型，不烧 token） */
async function sendTrial({ text, voice }) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('没有内容');
  if (clean.length > 400) throw new Error('试聊内容太长（最多 400 字）');
  const { key, ownerQQ, agentToken } = ownerContext();
  const token = consoleToken();
  if (!token) throw new Error('读不到 state/console-token');
  if (!agentToken) throw new Error('这个私聊还没有 agent token（先在 QQ 里跟它说一句话，让桥接建会话）');
  const pathname = voice ? '/api/socialV2/speak' : '/api/send/private';
  const payload = voice ? { key, text: clean, token: agentToken } : { userId: ownerQQ, message: clean, token: agentToken };
  const res = await fetch(BRIDGE + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-console-token': token, 'x-agent-token': agentToken },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(voice ? 300000 : 60000)
  });
  const body = await res.text();
  let json = null;
  try { json = JSON.parse(body); } catch {}
  if (!res.ok || !json?.ok) throw new Error(json?.error ?? `桥接返回 ${res.status}: ${body.slice(0, 200)}`);
  return { key, messageId: json.messageId ?? null, detail: json.detail ?? null, verified: json.verified === true };
}

function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

/** 读桥接配置里的 TTS 段（在桥接侧统一维护，人格台只读不写） */
function ttsConfig() {
  try {
    const raw = fs.readFileSync(path.join(BRIDGE_ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw)?.socialV2?.tts ?? {};
  } catch {
    return {};
  }
}

/** 合成一段语音，直接把 wav 字节回给浏览器试听（不经过 QQ、不占语音配额） */
async function synthesizePreview(text) {
  const cfg = ttsConfig();
  if (!cfg.enabled) throw new Error('TTS 未启用：config.json 的 socialV2.tts.enabled 为 false');
  if (!cfg.refAudioPath) throw new Error('没有参考音频：config.json 的 socialV2.tts.refAudioPath 为空');
  const maxChars = Number(cfg.maxChars) || 200;
  if (text.length > maxChars) throw new Error(`文字太长（${text.length} > ${maxChars} 字），试听请用短句`);
  const res = await fetch(`${cfg.baseUrl || 'http://127.0.0.1:9880'}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      text_lang: cfg.textLang || 'zh',
      ref_audio_path: cfg.refAudioPath,
      prompt_text: cfg.promptText || '',
      prompt_lang: cfg.promptLang || 'zh',
      media_type: 'wav',
      streaming_mode: false,
      text_split_method: 'cut5',
      batch_size: 1
    }),
    signal: AbortSignal.timeout(Number(cfg.timeoutMs) || 180000)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`TTS 服务返回 ${res.status}：${detail.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error('TTS 返回的音频过小，合成可能失败');
  return buf;
}

function singConfig() {
  try {
    const raw = fs.readFileSync(path.join(BRIDGE_ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw)?.socialV2?.sing ?? {};
  } catch {
    return {};
  }
}

/** 试唱：文字 → 旋律 → RVC → wav 字节（只在浏览器播放，不发 QQ、不占语音配额） */
async function renderSongPreview({ text, melody }) {
  const cfg = singConfig();
  if (!cfg.enabled) throw new Error('唱歌未启用：config.json 的 socialV2.sing.enabled 为 false');
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new Error('没有歌词');
  const maxChars = Number(cfg.maxChars) || 120;
  if (clean.length > maxChars) throw new Error(`歌词太长（${clean.length} > ${maxChars} 字），试唱请用短句`);
  if (!cfg.pythonPath || !fs.existsSync(cfg.pythonPath)) throw new Error(`RVC 环境不存在：${cfg.pythonPath}`);
  if (!cfg.scriptPath || !fs.existsSync(cfg.scriptPath)) throw new Error(`渲染脚本不存在：${cfg.scriptPath}`);

  const out = path.join(os.tmpdir(), `studio-sing-${Date.now()}.wav`);
  const args = [cfg.scriptPath, '--out', out, '--text', clean, '--melody', String(melody || cfg.defaultMelody || 'twinkle')];
  await new Promise((resolve, reject) => {
    execFile(cfg.pythonPath, args, {
      timeout: Number(cfg.timeoutMs) || 600000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        // 不再写死某个人的工具目录：需要额外 PATH 时用 PY_EXTRA_PATH 指定
        PATH: [process.env.PY_EXTRA_PATH, process.env.PATH].filter(Boolean).join(path.delimiter)
      }
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message).split('\n').filter(Boolean).slice(-4).join(' | ');
        reject(new Error(`试唱渲染失败：${detail.slice(0, 400)}`));
        return;
      }
      resolve();
    });
  });
  if (!fs.existsSync(out)) throw new Error('试唱没有产出音频');
  const buf = fs.readFileSync(out);
  try { fs.unlinkSync(out); } catch {}
  if (buf.length < 1024) throw new Error('试唱产物过小，渲染可能失败');
  return buf;
}

/** 探活：桥接是否在线 + 当前管理员/白名单，供 UI 顶部显示 */async function studioInfo() {
  try {
    const { body } = await bridgeFetch('/api/whitelist');
    const status = await bridgeFetch('/api/status').catch(() => ({ body: {} }));
    return {
      ok: true,
      bridgeUp: true,
      mode: status.body?.mode ?? null,
      connected: status.body?.snowluma?.connected ?? null,
      ownerQQ: body?.ownerQQ ?? null,
      allow: body?.allow ?? null
    };
  } catch (error) {
    return { ok: false, bridgeUp: false, error: String(error?.message ?? error) };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(HERE, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (url.pathname === '/studio/info') {
      sendJson(res, 200, await studioInfo());
      return;
    }
    // 预览：AI 实际会看到的结构化信息（角色/工具/唤醒/记忆/黑话/表情）
    if (url.pathname === '/studio/preview') {
      const { body: wl } = await bridgeFetch('/api/whitelist');
      const key = url.searchParams.get('key') || `private:${wl?.ownerQQ ?? ''}`;
      const { status, body } = await bridgeFetch('/api/socialV2/prompt?key=' + encodeURIComponent(key));
      sendJson(res, status, body);
      return;
    }
    // 试听：文字 → GPT-SoVITS → wav（只在浏览器播放，不发 QQ）
    if (url.pathname === '/studio/tts' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = String(body.text ?? '').trim();
      if (!text) {
        sendJson(res, 400, { ok: false, error: '没有文字' });
        return;
      }
      try {
        const wav = await synthesizePreview(text);
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length, 'cache-control': 'no-store' });
        res.end(wav);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    // 试聊：按角色口吻往管理员自己的 QQ 发一条（文字或语音），真实链路
    if (url.pathname === '/studio/trial' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const out = await sendTrial({ text: body.text, voice: body.voice === true });
        sendJson(res, 200, { ok: true, ...out });
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    // 试唱：文字 → 旋律 → RVC → wav（只在浏览器播放，不发 QQ）
    if (url.pathname === '/studio/sing' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        const wav = await renderSongPreview({ text: body.text, melody: body.melody });
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length, 'cache-control': 'no-store' });
        res.end(wav);
      } catch (error) {
        sendJson(res, 502, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }
    // 试唱环境探活：RVC 环境 / 渲染脚本 / 已训好的权重在不在
    if (url.pathname === '/studio/sing/status') {
      const cfg = singConfig();
      let weight = null;
      const wdir = 'D:/AI/repos/Retrieval-based-Voice-Conversion-WebUI-main/assets/weights';
      try {
        const files = fs.readdirSync(wdir).filter((f) => f.endsWith('.pth'));
        files.sort((a, b) => fs.statSync(path.join(wdir, b)).mtimeMs - fs.statSync(path.join(wdir, a)).mtimeMs);
        weight = files[0] ?? null;
      } catch {}
      sendJson(res, 200, {
        ok: true,
        enabled: cfg.enabled === true,
        hasPython: Boolean(cfg.pythonPath && fs.existsSync(cfg.pythonPath)),
        hasScript: Boolean(cfg.scriptPath && fs.existsSync(cfg.scriptPath)),
        weight,
        defaultMelody: cfg.defaultMelody || 'twinkle',
        maxChars: Number(cfg.maxChars) || 120,
        melodies: ['twinkle', 'scale', 'octave', 'hum']
      });
      return;
    }
    // 试听环境探活：TTS 服务在不在
    if (url.pathname === '/studio/tts/status') {
      const cfg = ttsConfig();
      const base = cfg.baseUrl || 'http://127.0.0.1:9880';
      let up = false;
      try {
        const r = await fetch(`${base}/`, { signal: AbortSignal.timeout(2500) });
        up = r.ok || r.status === 404;
      } catch {
        up = false;
      }
      sendJson(res, 200, {
        ok: true,
        enabled: cfg.enabled !== false,
        up,
        baseUrl: base,
        hasRef: Boolean(cfg.refAudioPath),
        refAudioPath: cfg.refAudioPath || null,
        maxChars: Number(cfg.maxChars) || 200
      });
      return;
    }
    // 其余 /api/* 全部透传到桥接控制台
    if (url.pathname.startsWith('/api/')) {
      const init = { method: req.method };
      if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await readBody(req);
      const { status, body } = await bridgeFetch(url.pathname + url.search, init);
      sendJson(res, status, body);
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`人格调试台: http://127.0.0.1:${PORT}  (桥接 ${BRIDGE})`);
});
