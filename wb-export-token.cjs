// 从本机 WorkBuddy 客户端导出 accessToken → credentials.json
// 原理: --inspect 附着主进程, 直接调 ipcMain._invokeHandlers.get('wb:invoke')
// 用法: 先关闭 WorkBuddy, 再运行 node wb-export-token.cjs
//       (脚本会自动以 --inspect 启动 WorkBuddy, 结束后 WorkBuddy 保持运行)
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const WB_EXE = 'D:\\WB\\WorkBuddy\\WorkBuddy.exe';
const OUT = __dirname + '/credentials.json';

function isRunning() {
  try { return execSync('tasklist /FI "IMAGENAME eq WorkBuddy.exe" /NH', { encoding: 'utf8' }).includes('WorkBuddy.exe'); } catch { return false; }
}
function kill() { try { execSync('taskkill /IM WorkBuddy.exe /F', { stdio: 'ignore' }); } catch {} }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function evalInMain(expr) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9229/json', { signal: AbortSignal.timeout(1500) });
      const t = (await r.json()).find(x => x.webSocketDebuggerUrl);
      if (t) return await new Promise((resolve, reject) => {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        const timer = setTimeout(() => { try{ws.close()}catch{}; reject(new Error('eval timeout')); }, 30000);
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.id === 1) ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
          else if (m.id === 2) { clearTimeout(timer); ws.close(); m.result?.exceptionDetails ? reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 500))) : resolve(m.result?.result?.value); }
        };
        ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
      });
    } catch {}
    await sleep(1000);
  }
  throw new Error('inspector 未就绪');
}

(async () => {
  if (isRunning()) { console.log('关闭 WorkBuddy...'); kill(); await sleep(3000); }
  console.log('启动 WorkBuddy (--inspect)...');
  spawn(WB_EXE, ['--inspect=9229'], { detached: true, stdio: 'ignore' }).unref();

  const payload = await evalInMain(`(async()=>{const e=process.mainModule.require('electron');const wc=e.webContents.getAllWebContents().find(w=>!w.isDestroyed()&&w.getURL().includes('renderer/index.html'))||e.webContents.getAllWebContents()[0];if(!wc)throw new Error('renderer 未就绪');const h=e.ipcMain._invokeHandlers.get('wb:invoke');const ev={sender:wc,senderFrame:wc.mainFrame,processId:wc.getProcessId(),frameId:wc.mainFrame.frameId};const token=await h(ev,'auth:getToken');const acc=await h(ev,'auth:getAccount');return JSON.stringify({token,acc})})()`);

  const { token, acc } = JSON.parse(payload);
  fs.writeFileSync(OUT, JSON.stringify({
    uid: acc.uid, uin: acc.uin, domain: acc.domain, accessToken: token,
    exportedAt: new Date().toISOString(),
  }, null, 2));
  // JWT exp
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    console.log('token 过期时间:', new Date(p.exp * 1000).toLocaleString('zh-CN', { hour12: false }));
  } catch {}
  console.log('已导出:', OUT);
})().catch(e => { console.log('ERROR:', e.message); process.exit(1); });
