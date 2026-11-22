// WB 签到核心逻辑（无 Node 依赖，可跑在 Cloudflare Workers）
// 从原 wb-checkin-server.cjs 移植：调状态接口 + 签到接口，返回结构化结果。

const DEFAULT_HOST = 'https://www.workbuddy.cn';

// 服务端会拒绝「空 User-Agent」的请求（返回 403 code=10085 请求不合法），
// 因此所有请求必须携带一个正常的浏览器 UA。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function baseHeaders(cred) {
  return {
    'Accept': 'application/json',
    'Authorization': 'Bearer ' + cred.accessToken,
    'Content-Type': 'application/json',
    'X-User-Id': cred.uid,
    'User-Agent': UA,
    'Referer': 'https://www.workbuddy.cn/',
    'Origin': 'https://www.workbuddy.cn',
  };
}

/**
 * 统一的签到接口调用
 * @param {object} cred {uid, accessToken, domain?}
 * @param {string} apiPath
 */
async function api(cred, apiPath) {
  const host = cred.domain ? `https://${cred.domain}` : DEFAULT_HOST;
  const r = await fetch(host + apiPath, {
    method: 'POST',
    headers: baseHeaders(cred),
    body: '{}',
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  if (r.status === 401) {
    const e = new Error('TOKEN_EXPIRED');
    e.code = 'AUTH';
    throw e;
  }
  return body;
}

/** 查询余额（get-user-resource-summary） */
export async function fetchBalance(cred) {
  const host = cred.domain ? `https://${cred.domain}` : DEFAULT_HOST;
  const r = await fetch(host + '/billing/meter/get-user-resource-summary', {
    method: 'POST',
    headers: baseHeaders(cred),
    body: '{}',
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) return { expired: true };
  const d = j.data || {};
  const groups = (d.CreditGroups || []).map((g) => ({
    name: g.Name,
    remain: +g.CycleRemainCapacity,
    total: +g.CycleTotalCapacity,
    used: +g.CycleUsedCapacity,
  }));
  return { expired: false, balance: +d.TotalCredits || 0, groups };
}

/** 查询签到活动状态 */
export async function fetchStatus(cred) {
  const j = await api(cred, '/v2/billing/meter/checkin-activity-status');
  if (j.code !== 0) return { expired: false, error: `code=${j.code} msg=${j.msg}` };
  return { expired: false, ...j.data };
}

/**
 * 执行签到主流程。
 * 返回 { kind, message }
 *   kind: 'already' | 'success' | 'inactive' | 'ended' | 'fail' | 'auth'
 */
export async function runCheckin(cred) {
  const st = await fetchStatus(cred);
  if (st.expired) return { kind: 'auth', message: 'accessToken 过期，需重新导出 credentials' };
  if (st.error) return { kind: 'fail', message: `状态查询失败 ${st.error}` };

  if (st.today_checked_in) {
    return {
      kind: 'already',
      message: `今日已签到 连续${st.streak_days}天 总积分${st.total_credits}`,
      data: st,
    };
  }
  if (!st.active) {
    return {
      kind: 'inactive',
      message: `签到活动未开启（${st.activity_name || ''} ${st.start_time}~${st.end_time}）`,
      data: st,
    };
  }

  const res = await api(cred, '/v2/billing/meter/daily-checkin');
  if (res.code === 0 && res.data && res.data.credit !== undefined) {
    return {
      kind: 'success',
      message: `签到成功 +${res.data.credit}积分 连续${res.data.streak_days ?? st.streak_days}天 总积分${res.data.total_credits ?? st.total_credits}`,
      data: res.data,
    };
  }
  if ([10001, 1001].includes(res.code)) {
    return { kind: 'already', message: '今日已签到（服务端去重）', data: st };
  }
  if ([1003].includes(res.code)) {
    return { kind: 'ended', message: '活动已结束', data: st };
  }
  return { kind: 'fail', message: `code=${res.code} msg=${res.msg}`, data: st };
}

/** 从 accessToken 解出 JWT 过期时间（毫秒），失败返回 0 */
export function tokenExp(accessToken) {
  try {
    const payload = JSON.parse(
      atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
    );
    return payload.exp * 1000;
  } catch {
    return 0;
  }
}
