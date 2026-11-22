// WorkBuddy 签到 Web 面板（纯 Node，无依赖）
// 用法: WB_PANEL_PORT=7777 node wb-panel.cjs
// 接口: /api/status /api/checkin /api/logs  鉴权: ?key= 或 header X-Key
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DIR = __dirname;
const CRED = path.join(DIR, 'credentials.json');
const CHECKIN = path.join(DIR, 'wb-checkin-server.cjs');
const LOG = path.join(DIR, 'checkin.log');
const PORT = +(process.env.WB_PANEL_PORT || 7777);
const cred = JSON.parse(fs.readFileSync(CRED, 'utf8'));
const KEY = process.env.WB_PANEL_KEY || crypto.createHash('sha256').update(cred.uid + cred.accessToken.slice(0, 32)).digest('hex').slice(0, 10);

function tokenExp() {
  try {
    const p = JSON.parse(Buffer.from(cred.accessToken.split('.')[1], 'base64').toString('utf8'));
    return p.exp * 1000;
  } catch { return 0; }
}

function readCred() { try { return JSON.parse(fs.readFileSync(CRED, 'utf8')); } catch { return cred; } }

function runCheckin() {
  return new Promise(resolve => {
    execFile('node', [CHECKIN, CRED], { cwd: DIR, timeout: 60000 }, (err, stdout, stderr) => {
      resolve((stdout || '') + (stderr || '') || (err ? err.message : 'done'));
    });
  });
}

async function apiBalance() {
  const c = readCred();
  const r = await fetch('https://www.workbuddy.cn/billing/meter/get-user-resource-summary', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + c.accessToken, 'Content-Type': 'application/json', 'X-User-Id': c.uid },
    body: '{}', signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) return { expired: true };
  const d = j.data || {};
  const groups = (d.CreditGroups || []).map(g => ({ name: g.Name, remain: +g.CycleRemainCapacity, total: +g.CycleTotalCapacity, used: +g.CycleUsedCapacity }));
  return { expired: false, balance: +d.TotalCredits || 0, groups };
}

async function apiStatus() {
  const c = readCred();
  const r = await fetch('https://www.workbuddy.cn/v2/billing/meter/checkin-activity-status', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Authorization': 'Bearer ' + c.accessToken, 'Content-Type': 'application/json', 'X-User-Id': c.uid },
    body: '{}', signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) return { expired: true };
  return j.data ? { expired: false, ...j.data } : { expired: false, error: j.msg || r.status };
}

function html(key) {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WB 签到面板</title><style>
:root{color-scheme:dark}
body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;display:flex;justify-content:center}
.wrap{max-width:520px;width:100%;padding:24px}
h1{font-size:20px;display:flex;align-items:center;gap:8px}.card{background:#181b22;border:1px solid #262b36;border-radius:12px;padding:16px;margin:12px 0}
.row{display:flex;justify-content:space-between;margin:6px 0;align-items:center}.muted{color:#8a90a0}
.big{font-size:34px;font-weight:700}.btn{width:100%;padding:12px;border:0;border-radius:10px;background:#3b82f6;color:#fff;font-size:15px;cursor:pointer}
.btn:disabled{opacity:.5}.ok{color:#4ade80}.warn{color:#fbbf24}.bad{color:#f87171}
a.link{color:#60a5fa;text-decoration:none;border-bottom:1px dotted #60a5fa}
a.link:hover{color:#93c5fd}
svg.ic{width:16px;height:16px;vertical-align:-3px}
pre{background:#12151b;border-radius:8px;padding:10px;font-size:12px;max-height:220px;overflow:auto;white-space:pre-wrap}
.dots{display:flex;gap:4px;align-items:center;justify-content:flex-end}
.dots span{display:inline-flex;width:26px;height:26px;align-items:center;justify-content:center;border-radius:6px;background:#262b36}
.dots .on{background:#22c55e;color:#052e16}
</style></head><body><div class="wrap">
<h1><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:22px;height:22px"><path d="M12 2l2.4 5.3 5.6.6-4.2 3.9 1.2 5.6L12 14.5 6.9 17.4l1.2-5.6L3.9 7.9l5.7-.6L12 2z"/></svg>WB 每日签到</h1>
<div class="card"><div class="row"><span>总余额</span><span style="text-align:right"><span class="big" id="total">-</span><div id="groups" class="muted" style="font-size:11px;margin-top:2px"></div></span></div>
<div class="row"><span>签到累计</span><span id="checkin_total" class="muted">-</span></div>
<div class="row"><span>连续签到</span><span id="streak">-</span></div>
<div class="row"><span>今日状态</span><span id="today">-</span></div>
<div class="row"><span>活动</span><span id="act" class="muted">-</span></div>
<div class="row"><span>本周</span><span class="dots" id="week"></span></div>
<div class="row"><span>凭据到期</span><span id="exp">-</span></div></div>
<button class="btn" id="go">立即签到</button>
<div class="card"><div class="row"><span>最近日志</span><span class="muted" id="refreshed"></span></div><pre id="logs"></pre></div>
<script>
const KEY = "${key}";
const ICO_OK = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" fill="rgba(74,222,128,.12)"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>';
const ICO_NO = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="9" fill="rgba(251,191,36,.12)"/><path d="M12 7.5v5"/><circle cx="12" cy="16" r=".5" fill="#fbbf24"/></svg>';
const ICO_CHK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="#052e16" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';
async function api(p){ const r = await fetch(p + '?key=' + KEY, {method: p === '/api/checkin' ? 'POST' : 'GET'}); return r.json(); }
async function load(){
  const s = await api('/api/status');
  document.getElementById('total').textContent = s.balance != null ? Math.floor(s.balance) : '-';
  document.getElementById('groups').textContent = (s.groups || []).map(g => g.name + ' ' + Math.floor(g.remain)).join(' / ');
  document.getElementById('checkin_total').textContent = s.total_credits != null ? s.total_credits + ' 分（活动累计）' : '-';
  document.getElementById('streak').textContent = s.streak_days != null ? s.streak_days + ' 天' : '-';
  const t = document.getElementById('today');
  if (s.expired) { t.innerHTML = '凭据已过期'; t.className = 'bad'; }
  else if (s.today_checked_in) { t.innerHTML = ICO_OK + ' 已签到 (+' + (s.today_credit||0) + ')'; t.className = 'ok'; }
  else { t.innerHTML = ICO_NO + ' 未签到'; t.className = 'warn'; }
  const act = document.getElementById('act');
  const name = (s.activity_name||'') + ' ' + (s.start_time||'').slice(0,10) + '~' + (s.end_time||'').slice(0,10);
  const url = s.action_button && s.action_button.action || '';
  const href = /^https?:\\/\\/|^workbuddy:\\/\\//.test(url) ? url : '';
  if (href) { act.innerHTML = '<a class="link" href="' + href + '" target="_blank" rel="noopener">' + name + ' ↗</a>'; }
  else { act.textContent = name; }
  document.getElementById('week').innerHTML = (s.week_progress||[]).map(v => '<span class="' + (v?'on':'') + '">' + (v?ICO_CHK:'') + '</span>').join('');
  const e = document.getElementById('exp');
  if (s.expired) { e.textContent = '已过期，需重新导出凭据'; e.className = 'bad'; }
  else if (s.token_exp) { const days = Math.floor((s.token_exp - Date.now())/864e5); e.textContent = days + ' 天后'; e.className = days < 7 ? 'warn' : 'muted'; }
  const l = await api('/api/logs');
  document.getElementById('logs').textContent = l.logs || '(空)';
  document.getElementById('refreshed').textContent = '刷新于 ' + new Date().toLocaleTimeString('zh-CN',{hour12:false});
  const go = document.getElementById('go');
  if (s.expired || s.today_checked_in || !s.active) { go.disabled = true; if (s.expired) go.textContent = '凭据已过期'; else if (!s.active) go.textContent = '活动未开启'; else if (go.textContent !== '完成') go.textContent = '今日已签到'; }
}
document.getElementById('go').onclick = async (ev) => {
  ev.target.disabled = true; ev.target.textContent = '签到中...';
  const r = await api('/api/checkin');
  ev.target.textContent = '完成'; load();
};
load(); setInterval(load, 60000);
</script></div></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = url.searchParams.get('key') || req.headers['x-key'] || '';
  const publicPage = url.pathname === '/' && !key;
  if (!publicPage && key !== KEY) { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('unauthorized'); }
  if (url.pathname === '/api/status') {
    const s = await apiStatus();
    s.token_exp = tokenExp();
    if (!s.expired) { const b = await apiBalance(); s.balance = b.balance; s.groups = b.groups; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(s));
  }
  if (url.pathname === '/api/checkin') {
    const output = await runCheckin();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ output: output.trim().slice(-300) }));
  }
  if (url.pathname === '/api/logs') {
    let logs = '';
    try { logs = fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-50).join('\n'); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ logs }));
  }
  if (url.pathname === '/') {
    if (!key) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>WB 签到面板</title>
<style>body{font-family:system-ui;background:#0f1115;color:#e6e6e6;display:flex;justify-content:center;padding-top:18vh;margin:0}
.c{background:#181b22;border:1px solid #262b36;border-radius:12px;padding:24px;width:300px;text-align:center}
input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #262b36;background:#12151b;color:#e6e6e6;font-size:14px;margin:12px 0}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#3b82f6;color:#fff;font-size:14px;cursor:pointer}</style></head>
<body><div class="c"><h3><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg> WB 签到面板</h3><input id="k" placeholder="访问密钥" autofocus><button onclick="go()">进入</button>
<script>const go=()=>{const k=document.getElementById('k').value.trim();if(k)location.href='/?key='+encodeURIComponent(k)};
document.getElementById('k').addEventListener('keydown',e=>{if(e.key==='Enter')go()});</script></div></body></html>`);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html(key));
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`panel http://127.0.0.1:${PORT}  key=${KEY}`);
});
