// WorkBuddy 每日签到（纯 HTTP 协议版，无客户端依赖）
// 依赖凭证文件 credentials.json: {uid, accessToken, domain}
// 用法: node wb-checkin-server.mjs [credentials路径]
// 退出码: 0=已签/成功  1=请求失败  2=token过期  3=活动结束
const fs = require('fs');
const path = require('path');

const CRED = process.argv[2] || process.env.WB_CREDENTIALS || path.join(__dirname, 'credentials.json');
const LOG = path.join(path.dirname(CRED), 'checkin.log');
const HOST = 'https://www.workbuddy.cn';

function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}

async function api(cred, apiPath) {
  const r = await fetch(HOST + apiPath, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Authorization': 'Bearer ' + cred.accessToken,
      'Content-Type': 'application/json',
      'X-User-Id': cred.uid,
    },
    body: '{}',
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`); }
  if (r.status === 401) throw Object.assign(new Error('TOKEN_EXPIRED'), { code: 'AUTH' });
  return body;
}

(async () => {
  const cred = JSON.parse(fs.readFileSync(CRED, 'utf8'));
  if (!cred.accessToken || !cred.uid) throw new Error('credentials.json 缺少 accessToken/uid');

  const st = await api(cred, '/v2/billing/meter/checkin-activity-status');
  if (st.code !== 0) throw new Error(`status code=${st.code} msg=${st.msg}`);
  const d = st.data || {};

  if (d.today_checked_in) {
    log(`OK: 今日已签到 连续${d.streak_days}天 总积分${d.total_credits}`);
    process.exit(0);
  }
  if (!d.active) {
    log(`EXIT: 签到活动未开启（${d.activity_name || ''} ${d.start_time}~${d.end_time}）`);
    process.exit(3);
  }

  const res = await api(cred, '/v2/billing/meter/daily-checkin');
  if (res.code === 0 && res.data && res.data.credit !== undefined) {
    log(`SUCCESS: 签到成功 +${res.data.credit}积分 连续${res.data.streak_days ?? d.streak_days}天 总积分${res.data.total_credits ?? d.total_credits}`);
  } else if ([10001, 1001].includes(res.code)) {
    log(`OK: 今日已签到（服务端去重）`);
  } else if ([1003].includes(res.code)) {
    log(`EXIT: 活动已结束`);
    process.exit(3);
  } else {
    log(`FAIL: code=${res.code} msg=${res.msg}`);
    process.exit(1);
  }
  process.exit(0);
})().catch(e => {
  if (e.code === 'AUTH') { log('EXIT: accessToken 过期，需重新导出 credentials.json'); process.exit(2); }
  log(`ERROR: ${e.message}`);
  process.exit(1);
});
