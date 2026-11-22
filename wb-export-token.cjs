// 从本机 WorkBuddy 客户端导出 accessToken → credentials.json
// 原理: --inspect 附着主进程, 直接调 ipcMain._invokeHandlers.get('wb:invoke')
//
// 用法:
//   node wb-export-token.cjs              自动定位 WorkBuddy, 关闭并以 --inspect 重启, 导出后保持运行
//   node wb-export-token.cjs --find       只打印定位到的安装路径, 不碰客户端
//   node wb-export-token.cjs --exe "D:\\WB\\WorkBuddy\\WorkBuddy.exe"   手动指定路径
//
// 定位顺序: --exe 参数 → 环境变量 WORKBUDDY_EXE → 上次成功的路径缓存 → 正在运行的进程
//          → 注册表卸载项 → 常见安装目录 → 磁盘浅层扫描(约 8 秒预算)
const { execSync, execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'credentials.json');
const CACHE = path.join(__dirname, '.cache', 'workbuddy-exe.txt');
const EXE_NAME = 'WorkBuddy.exe';
const PLATFORM_OK = process.platform === 'win32';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };

// ---------- 定位 ----------
function fromArgv() {
  const i = process.argv.indexOf('--exe');
  if (i < 0 || !process.argv[i + 1]) return null;
  const p = path.resolve(process.argv[i + 1]);
  if (exists(p)) return p;
  console.log(`--exe 指定的路径不存在: ${p}, 继续自动定位`);
  return null;
}
function fromEnv() {
  if (!process.env.WORKBUDDY_EXE) return null;
  const p = path.resolve(process.env.WORKBUDDY_EXE);
  if (exists(p)) return p;
  console.log(`环境变量 WORKBUDDY_EXE 指向的文件不存在: ${p}, 继续自动定位`);
  return null;
}
function fromCache() {
  try {
    const p = fs.readFileSync(CACHE, 'utf8').trim();
    return exists(p) ? p : null;
  } catch { return null; }
}
function saveCache(p) {
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, p);
  } catch {}
}

// 执行 PowerShell 片段, 失败一律返回空串(定位是尽力而为, 不该中断流程)
function ps(command) {
  if (!PLATFORM_OK) return '';
  try {
    return execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch { return ''; }
}

// 1) 正在运行的进程: 拿到的一定是真实路径(便携版也能命中)
function fromProcess() {
  if (!PLATFORM_OK) return null;
  const byProcess = ps(
    'Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path'
  );
  if (exists(byProcess)) return byProcess;
  const byWmi = ps(
    'Get-CimInstance Win32_Process -Filter "Name=\'WorkBuddy.exe\'" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty ExecutablePath'
  );
  return exists(byWmi) ? byWmi : null;
}

// 2) 注册表卸载项: InstallLocation / DisplayIcon 都可能带路径
function fromRegistry() {
  if (!PLATFORM_OK) return null;
  const out = ps(
    "$k=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'," +
    "'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); " +
    "Get-ItemProperty $k -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.DisplayName -like '*WorkBuddy*' } | " +
    "ForEach-Object { $_.InstallLocation; $_.DisplayIcon }"
  );
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim().replace(/^"(.*)"$/, '$1').replace(/,\d+$/, '');
    if (!line || line === 'X') continue;
    const cands = [line, path.join(line, EXE_NAME), path.join(path.dirname(line), EXE_NAME)];
    for (const c of cands) {
      if (exists(c) && path.basename(c).toLowerCase() === EXE_NAME.toLowerCase()) return c;
    }
  }
  return null;
}

// 3) 常见安装目录: 用户级、系统级、以及各盘的 WB/WorkBuddy 布局
function fromCommonDirs() {
  const dirs = [];
  const add = (d) => { if (d) dirs.push(d); };

  add(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'WorkBuddy'));
  add(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'WorkBuddy'));
  add(process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'WorkBuddy'));
  add(process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'WorkBuddy'));

  for (const letter of 'CDEFGH') {
    const root = letter + ':\\';
    try { if (!fs.existsSync(root)) continue; } catch { continue; }
    add(path.join(root, 'WB', 'WorkBuddy'));
    add(path.join(root, 'WorkBuddy'));
    add(path.join(root, 'Program Files', 'WorkBuddy'));
  }

  for (const d of dirs) {
    const cand = path.join(d, EXE_NAME);
    if (exists(cand)) return cand;
  }
  return null;
}

// 4) 兜底: 各盘浅层扫描(深度 ≤ 3, 跳过系统/缓存目录, 有总时间预算)
function fromDriveScan(budgetMs = 8000) {
  const deadline = Date.now() + budgetMs;
  const skip = new Set([
    'windows', '$recycle.bin', 'system volume information', 'node_modules',
    '.git', 'temp', 'tmp', 'cache', 'appdata', 'windows.old', 'recovery',
  ]);

  for (const letter of 'CDEFGH') {
    const root = letter + ':\\';
    try { if (!fs.existsSync(root)) continue; } catch { continue; }

    const queue = [{ dir: root, depth: 0 }];
    while (queue.length) {
      if (Date.now() > deadline) return null;
      const { dir, depth } = queue.shift();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isFile() && e.name.toLowerCase() === EXE_NAME.toLowerCase()) return path.join(dir, e.name);
        if (e.isDirectory() && depth < 3 && !skip.has(e.name.toLowerCase())) {
          queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
        }
      }
    }
  }
  return null;
}

function locate() {
  const steps = [
    ['--exe 参数', fromArgv],
    ['环境变量 WORKBUDDY_EXE', fromEnv],
    ['历史缓存', fromCache],
    ['运行中的进程', fromProcess],
    ['注册表', fromRegistry],
    ['常见安装目录', fromCommonDirs],
    ['磁盘扫描', () => fromDriveScan()],
  ];
  // 调试用: WB_LOCATE_SKIP="注册表,磁盘扫描" 可跳过指定来源
  const skip = (process.env.WB_LOCATE_SKIP || '').split(',').map((s) => s.trim()).filter(Boolean);

  for (const [label, fn] of steps) {
    if (skip.includes(label)) continue;
    let hit = null;
    try { hit = fn(); } catch {}
    if (hit) {
      console.log(`定位到 WorkBuddy: ${hit}  (来源: ${label})`);
      saveCache(hit);
      return hit;
    }
  }
  return null;
}

function die(msg) {
  console.log('ERROR: ' + msg);
  process.exit(1);
}

// ---------- 进程控制 ----------
function isRunning() {
  try {
    return execSync('tasklist /FI "IMAGENAME eq WorkBuddy.exe" /NH', { encoding: 'utf8' }).includes('WorkBuddy.exe');
  } catch { return false; }
}
function kill() {
  try { execSync('taskkill /IM WorkBuddy.exe /F', { stdio: 'ignore' }); } catch {}
}

// ---------- 调试协议 ----------
async function evalInMain(expr) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9229/json', { signal: AbortSignal.timeout(1500) });
      const t = (await r.json()).find((x) => x.webSocketDebuggerUrl);
      if (t) {
        return await new Promise((resolve, reject) => {
          const ws = new WebSocket(t.webSocketDebuggerUrl);
          const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('eval timeout')); }, 30000);
          ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
          ws.onmessage = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id === 1) {
              ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
            } else if (m.id === 2) {
              clearTimeout(timer);
              ws.close();
              m.result?.exceptionDetails
                ? reject(new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 500)))
                : resolve(m.result?.result?.value);
            }
          };
          ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
        });
      }
    } catch {}
    await sleep(1000);
  }
  throw new Error('inspector 未就绪');
}

// ---------- 主流程 ----------
(async () => {
  if (!PLATFORM_OK) die('该脚本目前只支持 Windows(依赖 tasklist/taskkill 与注册表)');

  const exe = locate();
  if (!exe) {
    die('没找到 WorkBuddy.exe。请用 --exe 指定路径, 或设置环境变量 WORKBUDDY_EXE, 例如:\n' +
        '  node wb-export-token.cjs --exe "D:\\WB\\WorkBuddy\\WorkBuddy.exe"');
  }

  if (process.argv.includes('--find')) {
    console.log('仅定位模式, 未启动客户端。');
    return;
  }

  if (isRunning()) {
    console.log('关闭 WorkBuddy...');
    kill();
    await sleep(3000);
  }

  console.log('启动 WorkBuddy (--inspect)...');
  spawn(exe, ['--inspect=9229'], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) }).unref();

  const payload = await evalInMain(
    `(async()=>{const e=process.mainModule.require('electron');` +
    `const wc=e.webContents.getAllWebContents().find(w=>!w.isDestroyed()&&w.getURL().includes('renderer/index.html'))||e.webContents.getAllWebContents()[0];` +
    `if(!wc)throw new Error('renderer 未就绪');` +
    `const h=e.ipcMain._invokeHandlers.get('wb:invoke');` +
    `const ev={sender:wc,senderFrame:wc.mainFrame,processId:wc.getProcessId(),frameId:wc.mainFrame.frameId};` +
    `const token=await h(ev,'auth:getToken');const acc=await h(ev,'auth:getAccount');` +
    `return JSON.stringify({token,acc})})()`
  );

  const { token, acc } = JSON.parse(payload);
  fs.writeFileSync(OUT, JSON.stringify({
    uid: acc.uid, uin: acc.uin, domain: acc.domain, accessToken: token,
    exportedAt: new Date().toISOString(),
  }, null, 2));

  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    console.log('token 过期时间:', new Date(p.exp * 1000).toLocaleString('zh-CN', { hour12: false }));
  } catch {}

  console.log('已导出:', OUT);
})().catch((e) => die(e.message));
