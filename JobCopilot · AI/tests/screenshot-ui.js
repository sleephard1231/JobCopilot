// 截图新 UI：node tests/screenshot-ui.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const PORT = 9235;
const ROOT = path.resolve(__dirname, '..');

async function getJson(p) { const r = await fetch('http://127.0.0.1:' + PORT + p); return r.json(); }

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = () => reject(new Error('ws error'));
      this.ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id); this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
        }
      };
    });
  }
  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 10000);
    });
  }
  async evalExpr(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.result.value; }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-shot-'));
  let edge = null;
  try {
    edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
      '--headless', '--disable-gpu', '--no-first-run', '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + tmp, '--enable-unsafe-extension-debugging', '--load-extension=' + ROOT, 'about:blank'
    ], { stdio: 'ignore' });
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) { try { await getJson('/json/version'); ready = true; } catch (e) { await new Promise(r => setTimeout(r, 300)); } }
    if (!ready) throw new Error('CDP 未就绪');
    let sw = null;
    for (let i = 0; i < 40 && !sw; i++) {
      const list = await getJson('/json/list');
      sw = list.find(t => t.type === 'service_worker' && /background\.js/.test(t.url)) || null;
      if (!sw) await new Promise(r => setTimeout(r, 250));
    }
    if (!sw) throw new Error('未发现扩展');
    const extId = sw.url.match(/chrome-extension:\/\/([^/]+)\//)[1];
    await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent('chrome-extension://' + extId + '/src/sidepanel.html'), { method: 'PUT' });
    await new Promise(r => setTimeout(r, 1200));
    const list2 = await getJson('/json/list');
    const page = list2.find(t => t.type === 'page' && /sidepanel\.html/.test(t.url));
    const cdp = await new Cdp(page.webSocketDebuggerUrl).connect();
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 400, height: 1400, deviceScaleFactor: 2, mobile: false });
    // 展开所有折叠卡片再截图
    await cdp.evalExpr(
      'document.querySelectorAll(".card-header[data-toggle]").forEach(h => { const b = document.getElementById(h.dataset.toggle); if (b && b.style.display === "none") h.click(); }); true'
    );
    await new Promise(r => setTimeout(r, 500));
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(ROOT, 'docs', 'ui-preview.png');
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('截图已保存: ' + out);
    cdp.ws.close();
  } finally {
    try { if (edge) execSync('taskkill /pid ' + edge.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
})().catch(e => { console.error('ERR: ' + e.message); process.exit(1); });
