// Inspector evaluate against main process: node wb-inspect.mjs "<expr>"
const PORT = 9229;
const expr = process.argv[2];
async function getWsUrl() {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(1500) });
      const list = await r.json();
      const t = list.find(x => x.webSocketDebuggerUrl && (x.type === 'node' || /node/i.test(x.title || ''))) || list[0];
      if (t) return t.webSocketDebuggerUrl;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('no inspector endpoint');
}
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try{ws.close()}catch{}; reject(new Error('timeout')); }, 30000);
    let id = 0;
    ws.onopen = () => { ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable', params: {} })); };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === 1) {
        ws.send(JSON.stringify({ id: ++id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: true } }));
      } else if (msg.id === 2) {
        clearTimeout(timer); ws.close();
        if (msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails, null, 1).slice(0, 2000)));
        else resolve(msg.result?.result?.value);
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
  });
}
(async () => {
  const url = await getWsUrl();
  console.log(JSON.stringify(await evaluate(url, expr), null, 1));
})().catch(e => { console.log('ERROR:', e.message); process.exit(1); });
