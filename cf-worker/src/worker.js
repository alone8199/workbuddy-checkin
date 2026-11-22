// WorkBuddy 每日签到 - Cloudflare Worker 版
// 路由:
//   GET  /            面板（无 key 显示登录页）
//   GET  /api/status  状态 + 余额
//   POST /api/checkin 执行签到
//   GET  /api/logs    最近日志
// 鉴权: ?key= 或 header X-Key（与原面板一致）
import { runCheckin, fetchStatus, fetchBalance, tokenExp } from './checkin.js';

const LOG_KEY = 'checkin.log';
const MAX_LOG_LINES = 200;

function nowCN() {
  // 用北京时间的可读时间戳
  return new Date().toLocaleString('zh-CN', {
    hour12: false,
    timeZone: 'Asia/Shanghai',
  });
}

// ---------- 日志（KV 持久化，替代原 checkin.log） ----------
async function appendLog(env, msg) {
  const line = `[${nowCN()}] ${msg}`;
  console.log(line);
  const old = (await env.LOGS.get(LOG_KEY)) || '';
  const lines = (old ? old.split('\n') : []).concat(line);
  const trimmed = lines.slice(-MAX_LOG_LINES).join('\n');
  await env.LOGS.put(LOG_KEY, trimmed);
}

async function readLogs(env, tail = 50) {
  const all = (await env.LOGS.get(LOG_KEY)) || '';
  return all.trim().split('\n').filter(Boolean).slice(-tail).join('\n');
}

// 从日志解析结构化签到记录。日志行格式: [时间] KIND: message
function parseRecords(raw) {
  const lines = (raw || '').trim().split('\n').filter(Boolean);
  const records = [];
  for (const line of lines) {
    const m = line.match(/^\[([^\]]+)\]\s*(\w+)(?:\(([^)]*)\))?:\s*(.*)$/);
    if (!m) continue;
    const [, time, rawKind, , message] = m;
    let kind = rawKind.toLowerCase();
    if (kind === 'ok') kind = 'already';
    else if (kind === 'success') kind = 'success';
    else if (kind === 'auth') kind = 'auth';
    else if (kind === 'exit') kind = message.includes('过期') ? 'auth' : 'inactive';
    else if (kind === 'fail') kind = 'fail';
    else if (kind === 'error') kind = 'fail';
    records.push({ time, kind, message });
  }
  return records.reverse(); // 最新在前
}

function computeStats(records) {
  const total = records.length;
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const month = records.filter((r) => r.time.includes(monthPrefix)).length;
  const okCount = records.filter((r) => r.kind === 'success' || r.kind === 'already').length;
  const rate = total ? Math.round((okCount / total) * 100) : 0;
  return { total, month, rate };
}

// ---------- JSON 响应 ----------
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

// ---------- 面板 HTML ----------
function panelHtml() {
  return `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>签到 · WorkBuddy</title><style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#f6f7f9;--card:#fff;--soft:#fcfcfd;
  --ink:#101828;--ink2:#344054;--dim:#667085;--faint:#98a2b3;
  --line:#eaecf0;--line2:#f2f4f7;
  --accent:#2563eb;--accent-d:#1d4fd8;--accent-s:#eff4ff;
  --gold:var(--accent);--green:#12b76a;--amber:#f79009;--red:#f04438;
  --radius:16px;
  --mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;
}
html{-webkit-text-size-adjust:100%}
body{
  background:var(--bg);color:var(--ink);min-height:100vh;font-size:14px;line-height:1.5;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  padding:0 clamp(14px,4vw,40px);
}
.shell{max-width:1080px;margin:0 auto;padding:clamp(16px,3vw,30px) 0 44px}

/* ---- masthead ---- */
.mast{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:clamp(16px,2.4vw,22px);flex-wrap:wrap}
.mid{display:flex;align-items:center;gap:11px;min-width:0}
.logo{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;flex:none;
  background:var(--accent);color:#fff;box-shadow:0 1px 2px rgba(37,99,235,.4)}
.word{font-size:15px;font-weight:650;letter-spacing:-.01em;line-height:1.25}
.sub{font-size:12px;color:var(--faint);line-height:1.25}
.meta{display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);
  border-radius:99px;padding:7px 13px;font-size:12px;color:var(--dim)}
.meta b{font-weight:500;color:var(--ink2);font-variant-numeric:tabular-nums}
.dot{width:6px;height:6px;border-radius:99px;background:var(--green);box-shadow:0 0 0 3px rgba(18,183,106,.15)}

/* ---- hero ---- */
.hero{display:grid;grid-template-columns:minmax(0,1fr) 262px;background:var(--card);
  border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;
  box-shadow:0 1px 2px rgba(16,24,40,.04)}
.hl{padding:clamp(20px,2.8vw,28px);min-width:0;display:flex;flex-direction:column;justify-content:center}
.kick{font-size:12px;color:var(--dim)}
.bal{display:flex;align-items:baseline;gap:8px;margin-top:4px}
.bal .n{font-size:clamp(42px,7vw,58px);font-weight:600;letter-spacing:-.035em;line-height:1.1;
  font-variant-numeric:tabular-nums;color:var(--ink)}
.bal .u{font-size:13px;color:var(--faint);font-weight:500}
.groups{display:flex;flex-wrap:wrap;gap:7px;margin-top:18px}
.groups span.g{display:inline-flex;align-items:center;gap:7px;background:var(--line2);
  border-radius:8px;padding:5px 10px;min-width:0}
.groups .gn{font-size:11.5px;color:var(--dim);white-space:nowrap}
.groups .gv{font-size:12px;font-weight:600;color:var(--ink2);font-variant-numeric:tabular-nums}

.hr{padding:clamp(20px,2.8vw,28px);border-left:1px solid var(--line2);background:var(--soft);
  display:flex;flex-direction:column;justify-content:space-between;gap:18px}
.st-label{font-size:11.5px;color:var(--faint)}
.st-word{font-size:19px;font-weight:600;letter-spacing:-.012em;margin-top:5px}
.st-word.ok{color:var(--green)}.st-word.warn{color:var(--amber)}.st-word.bad{color:var(--red)}
.st-note{font-size:12px;color:var(--dim);margin-top:5px;font-variant-numeric:tabular-nums}
.btn{width:100%;height:42px;border:0;border-radius:10px;background:var(--accent);color:#fff;
  font-size:13.5px;font-weight:600;letter-spacing:.01em;cursor:pointer;
  transition:background .15s,transform .12s,box-shadow .15s;box-shadow:0 1px 2px rgba(16,24,40,.08)}
.btn:hover:not(:disabled){background:var(--accent-d);transform:translateY(-1px);
  box-shadow:0 6px 16px -6px rgba(37,99,235,.65)}
.btn:active:not(:disabled){transform:none;box-shadow:0 1px 2px rgba(16,24,40,.08)}
.btn:focus-visible{outline:3px solid rgba(37,99,235,.28);outline-offset:2px}
.btn:disabled{background:var(--line2);color:var(--faint);cursor:default;box-shadow:none}
.hint{font-size:11px;color:var(--faint);text-align:center;margin-top:10px;letter-spacing:.02em}

/* ---- stat strip ---- */
.strip{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:12px}
.cell{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:15px 17px;
  box-shadow:0 1px 2px rgba(16,24,40,.03);min-width:0}
.cell .k{font-size:11.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cell .v{font-size:24px;font-weight:600;letter-spacing:-.025em;margin-top:7px;color:var(--ink);
  font-variant-numeric:tabular-nums;display:flex;align-items:baseline;gap:4px}
.cell .v em{font-style:normal;font-size:12px;color:var(--faint);font-weight:400;letter-spacing:0}
.track{height:4px;background:var(--line2);border-radius:99px;margin-top:12px;overflow:hidden}
.track i{display:block;height:100%;width:0;background:var(--accent);border-radius:99px;
  transition:width .8s cubic-bezier(.16,1,.3,1)}
.track.low i{background:var(--red)}

/* ---- calendar ---- */
.sect{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  margin-top:12px;padding:clamp(18px,2.6vw,24px);box-shadow:0 1px 2px rgba(16,24,40,.03)}
.sh{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:16px;flex-wrap:wrap}
.sh h2{font-size:15px;font-weight:600;letter-spacing:-.012em;line-height:1.3}
.sh .cap{font-size:11.5px;color:var(--dim);font-variant-numeric:tabular-nums;margin-top:4px}
.sh .cap b{color:var(--ink2);font-weight:600}
.calnav{display:flex;align-items:center;gap:2px;flex:none;background:var(--card);
  border:1px solid var(--line);border-radius:10px;padding:3px;
  box-shadow:0 1px 2px rgba(16,24,40,.04)}
.calnav button{width:26px;height:26px;border:0;border-radius:7px;background:none;color:var(--ink2);
  font-size:15px;line-height:1;cursor:pointer;display:grid;place-items:center;padding:0;
  transition:background .15s,color .15s,box-shadow .15s}
.calnav button:hover:not(:disabled){background:var(--line2);color:var(--ink)}
.calnav button:active:not(:disabled){background:#e9ecf1}
.calnav button:focus-visible{outline:2px solid rgba(37,99,235,.35);outline-offset:1px}
.calnav button:disabled{opacity:.34;cursor:default}
.calnav .ym{font-size:13px;font-weight:600;color:var(--ink);padding:0 8px;min-width:86px;text-align:center;
  font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.calarea{display:grid;grid-template-columns:minmax(0,500px) minmax(0,320px);
  gap:clamp(22px,3.4vw,44px);align-items:stretch}
.calbox{min-width:0}
.wdays{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-bottom:6px}
.wdays span{font-size:11px;color:var(--faint);text-align:center;padding-bottom:2px}
.cal{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
.day{aspect-ratio:1/.74;border:1px solid #eef0f4;border-radius:8px;background:#fafbfc;
  font-size:12px;font-weight:500;color:var(--faint);font-variant-numeric:tabular-nums;
  display:flex;align-items:center;justify-content:center;
  transition:background .15s,border-color .15s,transform .12s;animation:pop .28s cubic-bezier(.16,1,.3,1) both}
.day.pad{border:0;background:none;animation:none}
.day:hover:not(.pad){border-color:#d0d5dd;transform:translateY(-1px)}
.day.on{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;
  box-shadow:0 2px 6px -2px rgba(37,99,235,.5)}
.day.on:hover{background:var(--accent-d);border-color:var(--accent-d);box-shadow:0 4px 10px -3px rgba(37,99,235,.55)}
.day.fut{background:transparent;border-style:dashed;border-color:#dfe3ea;color:#cfd5df}
.day.tdy{box-shadow:0 0 0 2px rgba(37,99,235,.22)}
.day.tdy.on{box-shadow:0 0 0 2px rgba(37,99,235,.3),0 2px 6px -2px rgba(37,99,235,.5)}
.cside{border-left:1px solid var(--line2);padding-left:clamp(18px,2.8vw,32px);
  display:flex;flex-direction:column}
.cs{flex:1;display:flex;align-items:center;justify-content:space-between;gap:14px;
  border-bottom:1px solid var(--line2)}
.cs:last-child{border-bottom:0}
.cs .k{font-size:12px;color:var(--dim)}
.cs .v{font-size:21px;font-weight:600;letter-spacing:-.025em;color:var(--ink);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.cs .v em{font-style:normal;font-size:11.5px;color:var(--faint);margin-left:3px;font-weight:400}
.legend{display:flex;align-items:center;gap:16px;margin-top:14px;font-size:11.5px;color:var(--dim);flex-wrap:wrap}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:-1px}
@keyframes pop{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:none}}

/* ---- tabs ---- */
.tabsec{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
  margin-top:12px;overflow:hidden;box-shadow:0 1px 2px rgba(16,24,40,.03)}
.tabs{display:flex;gap:24px;padding:0 clamp(16px,2.4vw,22px);border-bottom:1px solid var(--line2)}
.tab{background:none;border:0;padding:15px 0 13px;cursor:pointer;position:relative;
  font-size:13px;font-weight:500;color:var(--dim);transition:color .15s}
.tab:hover{color:var(--ink2)}
.tab.on{color:var(--accent);font-weight:600}
.tab.on::after{content:'';position:absolute;left:0;right:0;bottom:-1px;height:2px;
  background:var(--accent);border-radius:2px 2px 0 0}
.tab:focus-visible{outline:2px solid rgba(37,99,235,.3);outline-offset:3px;border-radius:4px}
.pane{display:none;padding:4px clamp(16px,2.4vw,22px) 10px}
.pane.on{display:block;animation:fade .28s ease both}
@keyframes fade{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
#records{max-height:398px;overflow:auto}
.rec{display:grid;grid-template-columns:96px minmax(0,1fr) auto;gap:14px;align-items:center;
  padding:12px 0;border-bottom:1px solid var(--line2)}
.rec:last-child{border-bottom:0}
.rec .t{font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums}
.rec .m{font-size:13px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rec .b{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:500;
  padding:3px 9px;border-radius:99px;white-space:nowrap}
.rec .b i{width:5px;height:5px;border-radius:99px;background:currentColor;flex:none}
.rec .b.ok{color:#067647;background:#ecfdf3}
.rec .b.warn{color:#b54708;background:#fffaeb}
.rec .b.bad{color:#b42318;background:#fef3f2}
.empty{padding:38px 0;text-align:center;color:var(--faint);font-size:12.5px;line-height:1.9}
.tri{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:12px 0 14px}
.tri .x{padding:15px 16px;background:var(--soft);border:1px solid var(--line2);border-radius:12px}
.tri .n{font-size:27px;font-weight:600;letter-spacing:-.03em;color:var(--ink);font-variant-numeric:tabular-nums}
.tri .l{font-size:11.5px;color:var(--dim);margin-top:5px}
#logs{background:var(--soft);border:1px solid var(--line2);border-radius:12px;padding:13px 15px;margin:10px 0 14px;
  font-family:var(--mono);font-size:11.5px;line-height:1.7;color:var(--dim);max-height:340px;overflow:auto;
  white-space:pre-wrap;word-break:break-all}
#logs::-webkit-scrollbar,#records::-webkit-scrollbar{width:8px}
#logs::-webkit-scrollbar-thumb,#records::-webkit-scrollbar-thumb{background:#dfe3ea;border-radius:99px}
#logs::-webkit-scrollbar-track,#records::-webkit-scrollbar-track{background:transparent}

/* ---- foot ---- */
.foot{display:flex;justify-content:space-between;gap:12px;padding:22px 4px 0;
  font-size:11.5px;color:var(--faint);flex-wrap:wrap}
.foot .r{color:#c3c9d4}

/* ---- toast ---- */
#toast{position:fixed;left:50%;bottom:28px;transform:translate(-50%,12px);z-index:200;
  display:flex;align-items:center;gap:8px;padding:11px 16px;border-radius:10px;
  background:#101828;color:#fff;box-shadow:0 14px 34px -10px rgba(16,24,40,.45);
  font-size:12.5px;opacity:0;pointer-events:none;transition:opacity .22s,transform .22s;max-width:calc(100vw - 32px)}
#toast.show{opacity:1;transform:translate(-50%,0)}
#toast i{width:6px;height:6px;border-radius:99px;background:var(--accent);flex:none}

/* ---- responsive ---- */
@media(max-width:880px){
  .hero{grid-template-columns:1fr}
  .hr{border-left:0;border-top:1px solid var(--line2);flex-direction:column;gap:16px}
  .btn{width:100%}
}
@media(max-width:760px){
  .strip{grid-template-columns:1fr 1fr}
  .calarea{grid-template-columns:1fr;gap:22px}
  .cside{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-left:0;
    border-top:1px solid var(--line2);padding-left:0;padding-top:18px;gap:0}
  .cs{display:block;padding:0 12px;margin:0;border-bottom:0;border-left:1px solid var(--line2)}
  .cs:first-child{padding-left:0;border-left:0}
  .cs .v{font-size:18px;margin-top:6px}
  .tri{grid-template-columns:1fr 1fr}
  .tri .x:last-child{grid-column:1/3}
}
@media(max-width:560px){
  .mast{margin-bottom:14px}
  .meta{display:none}
  .hl{padding:18px}
  .hr{padding:18px}
  .cal{gap:5px}
  .wdays{gap:5px}
  .day{padding:5px 6px;font-size:10.5px;border-radius:7px;aspect-ratio:1/.9}
  .tabs{gap:18px}
  .rec{grid-template-columns:1fr auto;gap:3px 10px;padding:11px 0}
  .rec .t{grid-row:1;grid-column:1}
  .rec .m{grid-row:2;grid-column:1}
  .rec .b{grid-row:1/3;grid-column:2;align-self:center}
  .groups{gap:6px;margin-top:14px}
  .tri .n{font-size:22px}
}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style></head><body>
<div class="shell">

  <header class="mast">
    <div class="mid">
      <div class="logo">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l2.3 4.9 5.2.68-3.86 3.62 1.02 5.2L12 14.9l-4.66 2.5 1.02-5.2L4.5 8.58l5.2-.68L12 3z"/></svg>
      </div>
      <div>
        <div class="word">WorkBuddy</div>
        <div class="sub">每日签到</div>
      </div>
    </div>
    <div class="meta">
      <span class="dot"></span><b id="clock">--:--:--</b>
      <span style="color:#d0d5dd">·</span><span>自动值守</span>
    </div>
  </header>

  <section class="hero">
    <div class="hl">
      <div class="kick">积分余额</div>
      <div class="bal"><span class="n" id="bal">—</span><span class="u">分</span></div>
      <div class="groups" id="groups"></div>
    </div>
    <div class="hr">
      <div>
        <div class="st-label">今日状态</div>
        <div class="st-word warn" id="stWord">读取中</div>
        <div class="st-note" id="stNote">&nbsp;</div>
      </div>
      <div style="width:100%">
        <button class="btn" id="go" disabled>读取中</button>
        <div class="hint">上次 <span id="lastRun">—</span> · 下次 06:00</div>
      </div>
    </div>
  </section>

  <section class="strip">
    <div class="cell"><div class="k">连续签到</div><div class="v"><span id="streak">—</span><em>天</em></div></div>
    <div class="cell"><div class="k">活动累计</div><div class="v"><span id="actsum">—</span><em>分</em></div></div>
    <div class="cell"><div class="k">今日获得</div><div class="v"><span id="tcredit">—</span><em>分</em></div></div>
    <div class="cell"><div class="k">凭据剩余</div><div class="v"><span id="exp">—</span><em>天</em></div>
      <div class="track" id="expTrack"><i id="expBar"></i></div></div>
  </section>

  <section class="sect">
    <div class="sh">
      <div>
        <h2>签到日历</h2>
        <div class="cap">本月已签到 <b id="heatcap">—</b></div>
      </div>
      <div class="calnav">
        <button id="prevM" type="button" aria-label="上一月">‹</button>
        <span class="ym" id="calYm">—</span>
        <button id="nextM" type="button" aria-label="下一月">›</button>
      </div>
    </div>
    <div class="calarea">
      <div class="calbox">
        <div class="wdays"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>
        <div class="cal" id="cal"></div>
        <div class="legend">
          <span><i style="background:#2563eb"></i>已签到</span>
          <span><i style="background:#fafbfc;border:1px solid #eef0f4"></i>未签到</span>
          <span><i style="background:transparent;border:1px dashed #e4e7ec"></i>未到</span>
        </div>
      </div>
      <div class="cside">
        <div class="cs"><div class="k">本月签到</div><div class="v"><span id="hmMonth">—</span><em>天</em></div></div>
        <div class="cs"><div class="k">覆盖率</div><div class="v"><span id="hmRate">—</span><em>%</em></div></div>
        <div class="cs"><div class="k">最长连续</div><div class="v"><span id="hmMax">—</span><em>天</em></div></div>
      </div>
    </div>
  </section>

  <section class="tabsec">
    <div class="tabs">
      <button class="tab on" data-p="records">签到记录</button>
      <button class="tab" data-p="statspane">统计</button>
      <button class="tab" data-p="logspane">运行日志</button>
    </div>
    <div class="pane on" id="records"><div class="empty">读取中</div></div>
    <div class="pane" id="statspane">
      <div class="tri">
        <div class="x"><div class="n" id="st_total">—</div><div class="l">累计签到</div></div>
        <div class="x"><div class="n" id="st_month">—</div><div class="l">本月签到</div></div>
        <div class="x"><div class="n" id="st_rate">—</div><div class="l">成功率</div></div>
      </div>
    </div>
    <div class="pane" id="logspane"><pre id="logs">读取中</pre></div>
  </section>

  <footer class="foot"><span>WorkBuddy · 每日签到 · Cloudflare Worker</span><span class="r" id="refreshed">—</span></footer>
</div>
<div id="toast"><i></i><span id="toastText"></span></div>
<script>
var $ = function(id){ return document.getElementById(id); };
function api(p){
  return fetch(p, {method: p === '/api/checkin' ? 'POST' : 'GET'}).then(function(r){ return r.json(); });
}
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function fmt(n){ var v = Math.floor(Number(n) || 0); return v.toLocaleString('en-US'); }

function toast(msg, bad){
  var t = $('toast');
  $('toastText').textContent = msg;
  t.querySelector('i').style.background = bad ? 'var(--red)' : 'var(--accent)';
  t.classList.add('show');
  clearTimeout(toast._h);
  toast._h = setTimeout(function(){ t.classList.remove('show'); }, 3200);
}

function countUp(el, to){
  var start = performance.now(), dur = 780;
  function step(now){
    var k = Math.min(1, (now - start) / dur);
    var e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(to * e);
    if (k < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

document.querySelectorAll('.tab').forEach(function(tb){
  tb.onclick = function(){
    document.querySelectorAll('.tab').forEach(function(x){ x.classList.remove('on'); });
    document.querySelectorAll('.pane').forEach(function(x){ x.classList.remove('on'); });
    tb.classList.add('on');
    $(tb.dataset.p).classList.add('on');
  };
});

function recRow(r){
  var k = r.kind;
  var cls = (k === 'success' || k === 'already') ? 'ok' : (k === 'auth' || k === 'fail') ? 'bad' : 'warn';
  var label = k === 'success' ? '成功' : k === 'already' ? '已签' : k === 'auth' ? '已过期'
            : k === 'fail' ? '失败' : k === 'inactive' ? '未开启' : k === 'ended' ? '已结束' : '信息';
  var t = String(r.time || '');
  var short = t.length >= 16 ? t.slice(5, 16) : t;
  return '<div class="rec"><div class="t">' + esc(short) + '</div>'
       + '<div class="m">' + esc(r.message) + '</div>'
       + '<div class="b ' + cls + '"><i></i>' + label + '</div></div>';
}

function loadRecords(){
  return api('/api/records').then(function(d){
    var list = d.records || [];
    $('records').innerHTML = list.length
      ? list.map(recRow).join('')
      : '<div class="empty">暂无签到记录<br>等待首次自动签到</div>';
    var lr = $('lastRun');
    if (lr) lr.textContent = list.length && list[0].time ? String(list[0].time).slice(5, 16) : '—';
    if (d.stats) {
      $('st_total').textContent = d.stats.total;
      $('st_month').textContent = d.stats.month;
      $('st_rate').textContent = d.stats.rate + '%';
    }
  }).catch(function(){ $('records').innerHTML = '<div class="empty">记录读取失败</div>'; });
}
function loadLogs(){
  return api('/api/logs').then(function(l){ $('logs').textContent = l.logs || '(暂无日志)'; })
    .catch(function(){ $('logs').textContent = '(日志读取失败)'; });
}

// 月历热力图：7 列 = 周一~周日，行 = 周，每格带日期
var calOffset = 0, calStatus = null;
function renderHeat(s){
  if (s) calStatus = s; else s = calStatus || {};
  var set = {};
  (s.checkin_dates || []).forEach(function(d){ set[d] = 1; });
  function ymd(d){ return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }

  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var todayKey = ymd(today);

  // 当前查看的月份：offset=0 为本月，负数往前翻
  var view = new Date(today.getFullYear(), today.getMonth() + calOffset, 1);
  var y = view.getFullYear(), m = view.getMonth();
  var lead = (new Date(y, m, 1).getDay() + 6) % 7;        // 该月 1 号距周一几天
  var total = new Date(y, m + 1, 0).getDate();            // 该月天数，自动适配 28/29/30/31

  var cells = [], monthDays = 0, i;
  for (i = 0; i < lead; i++) cells.push('<div class="day pad"></div>');

  for (i = 1; i <= total; i++){
    var dt = new Date(y, m, i);
    var key = ymd(dt);
    var future = dt.getTime() > today.getTime();
    var on = !!set[key];
    if (on) monthDays++;
    var cls = 'day' + (on ? ' on' : '') + (future ? ' fut' : '') + (key === todayKey ? ' tdy' : '');
    cells.push('<div class="' + cls + '" style="animation-delay:' + (i * 7) + 'ms" title="'
      + key + (future ? ' · 未到' : (on ? ' · 已签到' : ' · 未签到')) + '"><span>' + i + '</span></div>');
  }
  $('cal').innerHTML = cells.join('');
  $('calYm').textContent = y + '年' + (m + 1) + '月';
  $('heatcap').textContent = monthDays + ' 天 / 共 ' + total + ' 天';
  $('prevM').disabled = calOffset <= -24;
  $('nextM').disabled = calOffset >= 0;

  // 历史最长连续
  var keys = [], kk;
  for (kk in set) if (set.hasOwnProperty(kk)) keys.push(kk);
  keys.sort();
  var best = 0, run = 0, prev = null;
  keys.forEach(function(k){
    var d = new Date(k + 'T00:00:00');
    run = (prev && (d - prev) === 864e5) ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  });

  $('hmMonth').textContent = monthDays;
  $('hmMax').textContent = best || 0;
  $('hmRate').textContent = total ? Math.round(monthDays / total * 100) : 0;
}

$('prevM').onclick = function(){
  if (calOffset <= -24) return;
  calOffset--; renderHeat(calStatus);
};
$('nextM').onclick = function(){
  if (calOffset >= 0) return;
  calOffset++; renderHeat(calStatus);
};

function load(){
  return api('/api/status').then(function(s){
    var bal = Number(s.balance) || 0;
    countUp($('bal'), bal);

    var g = (s.groups || []).filter(function(x){ return x && x.name; });
    $('groups').innerHTML = g.length
      ? g.map(function(x){
          return '<span class="g"><span class="gn">' + esc(x.name) + '</span>'
               + '<span class="gv">' + fmt(x.remain) + '</span></span>';
        }).join('')
      : '<span class="g"><span class="gn">暂无分组数据</span></span>';

    $('streak').textContent = s.streak_days != null ? s.streak_days : '—';
    $('actsum').textContent = s.total_credits != null ? fmt(s.total_credits) : '—';

    var word = $('stWord'), note = $('stNote'), go = $('go'), tc = $('tcredit');
    if (s.expired){
      word.className = 'st-word bad'; word.textContent = '凭据已过期';
      note.textContent = '需要重新导出 accessToken';
      go.disabled = true; go.textContent = '不可用';
      tc.textContent = '—';
    } else if (s.today_checked_in){
      word.className = 'st-word ok'; word.textContent = '今日已签到';
      note.textContent = '+' + (s.today_credit || 0) + ' 分已入账 · 连续 ' + (s.streak_days || 0) + ' 天';
      go.disabled = true; go.textContent = '已完成';
      tc.textContent = s.today_credit != null ? fmt(s.today_credit) : '—';
    } else if (!s.active){
      word.className = 'st-word warn'; word.textContent = '活动未开启';
      note.textContent = s.activity_name || '当前没有进行中的签到活动';
      go.disabled = true; go.textContent = '不可用';
      tc.textContent = '—';
    } else {
      word.className = 'st-word warn'; word.textContent = '今日待签到';
      note.textContent = '点击右侧按钮立即完成';
      go.disabled = false; go.textContent = '立即签到';
      tc.textContent = '—';
    }

    var exp = $('exp'), bar = $('expBar'), track = $('expTrack');
    if (s.expired){
      exp.textContent = '0'; bar.style.width = '100%'; track.className = 'track low';
    } else if (s.token_exp){
      var days = Math.floor((s.token_exp - Date.now()) / 864e5);
      if (days < 0) days = 0;
      exp.textContent = days;
      bar.style.width = Math.max(2, Math.min(100, days / 30 * 100)) + '%';
      track.className = 'track' + (days < 7 ? ' low' : '');
    } else {
      exp.textContent = '—'; bar.style.width = '0';
    }

    renderHeat(s);
    $('refreshed').textContent = '刷新 ' + new Date().toLocaleTimeString('zh-CN', {hour12: false});
    return Promise.all([loadRecords(), loadLogs()]);
  }).catch(function(e){
    $('stWord').className = 'st-word bad';
    $('stWord').textContent = '连接失败';
    $('stNote').textContent = '无法读取签到状态';
    $('go').disabled = true; $('go').textContent = '不可用';
  });
}

$('go').onclick = function(){
  var b = $('go');
  b.disabled = true; b.textContent = '签到中';
  api('/api/checkin').then(function(r){
    var ok = r && (r.kind === 'success' || r.kind === 'already');
    toast(r && r.message ? r.message : '已提交', !ok);
    if (ok){
      setTimeout(function(){ load(); }, 400);
    } else {
      b.disabled = false; b.textContent = '立即签到';
      loadRecords();
    }
  }).catch(function(){
    toast('签到请求失败', true);
    b.disabled = false; b.textContent = '立即签到';
  });
};

function tick(){ $('clock').textContent = new Date().toLocaleTimeString('zh-CN', {hour12: false}); }
tick(); setInterval(tick, 1000);
load(); setInterval(load, 60000);
</script></body></html>`;
}

// ---------- Worker 入口 ----------
export default {
  // 定时触发（Cron Triggers）
  async scheduled(event, env, ctx) {
    const cred = JSON.parse(env.CREDENTIALS);
    // 短随机延迟，模拟原 random.sh 的分散效果（Workers 里不宜长 sleep）
    const delay = Math.floor(Math.random() * 5000);
    await new Promise((r) => setTimeout(r, delay));

    try {
      const res = await runCheckin(cred);
      await appendLog(env, `${res.kind.toUpperCase()}: ${res.message}`);
    } catch (e) {
      const kind = e.code === 'AUTH' ? 'AUTH(过期)' : 'ERROR';
      await appendLog(env, `${kind}: ${e.message}`);
    }
  },

  // HTTP 面板
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let cred;
    try {
      cred = JSON.parse(env.CREDENTIALS);
    } catch {
      return json({ error: '未配置 CREDENTIALS secret' }, 500);
    }

    // 已移除鉴权：直接访问即可（如需保护请改用 Cloudflare Access）

    if (url.pathname === '/api/status') {
      const [st, bal] = await Promise.all([
        fetchStatus(cred).catch((e) =>
          e.code === 'AUTH' ? { expired: true } : { expired: false, error: e.message }
        ),
        fetchBalance(cred).catch((e) =>
          e.code === 'AUTH' ? { expired: true } : { expired: false }
        ),
      ]);
      const s = { ...st, balance: bal.balance, groups: bal.groups, token_exp: tokenExp(cred.accessToken) };
      return json(s);
    }

    if (url.pathname === '/api/checkin') {
      let result;
      try {
        result = await runCheckin(cred);
        await appendLog(env, `${result.kind.toUpperCase()}: ${result.message}`);
      } catch (e) {
        const kind = e.code === 'AUTH' ? 'AUTH(过期)' : 'ERROR';
        await appendLog(env, `${kind}: ${e.message}`);
        result = { kind: 'error', message: e.message };
      }
      return json(result);
    }

    if (url.pathname === '/api/logs') {
      return json({ logs: await readLogs(env) });
    }

    if (url.pathname === '/api/records') {
      const all = (await env.LOGS.get(LOG_KEY)) || '';
      const records = parseRecords(all).slice(0, 30);
      return json({ records, stats: computeStats(parseRecords(all)) });
    }

    if (url.pathname === '/') {
      return new Response(panelHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    return new Response('not found', { status: 404 });
  },
};
