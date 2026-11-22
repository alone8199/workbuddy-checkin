// 本地预览生成器：抽取 panelHtml 的模板，注入模拟数据，输出 preview.html
const fs = require('fs');
const src = fs.readFileSync('src/worker.js', 'utf8');

const a = src.indexOf('function panelHtml() {');
const b = src.indexOf('// ---------- Worker 入口 ----------');
const seg = src.slice(a, b);
const r = seg.indexOf('return `');
const s1 = seg.indexOf('`', r);
const s2 = seg.lastIndexOf('`;');
let html = seg.slice(s1 + 1, s2);

function ymd(d) {
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}
const today = new Date();
today.setHours(0, 0, 0, 0);
const dates = [];
for (let i = 0; i < 35; i++) {
  if ((i * 13) % 10 < 7) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    dates.push(ymd(d));
  }
}

const mockBody = `
var NOW = Date.now();
var DATES = ${JSON.stringify(dates)};
window.fetch = function (u) {
  var body;
  if (u.indexOf('/api/status') === 0) {
    body = {
      balance: 1284.6,
      groups: [
        { name: '平台奖励积分', remain: 405 },
        { name: '套餐基础积分', remain: 0 },
        { name: '套餐赠送积分', remain: 120 },
        { name: '购买积分', remain: 759 }
      ],
      total_credits: 1846, streak_days: 18,
      today_checked_in: true, today_credit: 100,
      active: true, token_exp: NOW + 19 * 864e5,
      checkin_dates: DATES
    };
  } else if (u.indexOf('/api/records') === 0) {
    body = {
      records: [
        { time: '2026-11-22 06:12:03', kind: 'success', message: '签到成功 +100积分 连续18天 总积分1846' },
        { time: '2026-11-21 06:31:44', kind: 'already', message: '今日已签到 连续17天 总积分1746' },
        { time: '2026-11-20 06:05:12', kind: 'success', message: '签到成功 +100积分 连续16天 总积分1646' },
        { time: '2026-11-19 06:22:51', kind: 'success', message: '签到成功 +100积分 连续15天 总积分1546' }
      ],
      stats: { total: 18, month: 12, rate: 100 }
    };
  } else if (u.indexOf('/api/logs') === 0) {
    body = { logs: '[2026-11-22 06:12:03] SUCCESS: 签到成功 +100积分 连续18天 总积分1846\\n[2026-11-21 06:31:44] ALREADY: 今日已签到 连续17天' };
  } else {
    body = {};
  }
  return Promise.resolve({
    json: function () { return Promise.resolve(body); },
    text: function () { return Promise.resolve(''); }
  });
};
`;

const mock = '<script>' + mockBody + '</' + 'script>';
const idx = html.lastIndexOf('<script>');
html = html.slice(0, idx) + mock + html.slice(idx);

fs.writeFileSync('preview.html', html);
console.log('preview.html 生成，大小', html.length, '| 签到日数', dates.length);
