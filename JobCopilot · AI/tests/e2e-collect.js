// ===== 真实 Edge 端到端：点击「开始收集并筛选」验证全链路 =====
// 用法：node tests/e2e-collect.js
// 验证：面板点击 → SW 响应 → 创建 zhipin 标签页 → content script 注入 → 消息 → 日志回传 → 状态机
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const PORT = 9241;
const ROOT = path.resolve(__dirname, '..');

async function getJson(p) { const r = await fetch('http://127.0.0.1:' + PORT + p); return r.json(); }

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.consoleErrors = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = () => reject(new Error('ws error'));
      this.ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id); this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(JSON.stringify(msg.error).slice(0, 300))) : p.resolve(msg.result);
        } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
          this.consoleErrors.push(msg.params.args.map(a => a.value || a.description || '').join(' ').slice(0, 300));
        } else if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params.exceptionDetails;
          this.consoleErrors.push('EXC: ' + ((d.exception && d.exception.description) || d.text).slice(0, 300));
        }
      };
    });
  }
  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 15000);
    });
  }
  async evalExpr(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r.result.value;
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : ' :: ' + detail));
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-e2e-'));
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
    if (!sw) throw new Error('未发现扩展 SW');
    const extId = sw.url.match(/chrome-extension:\/\/([^/]+)\//)[1];
    check('1. SW 已启动', true);

    const swCdp = await new Cdp(sw.webSocketDebuggerUrl).connect();
    await swCdp.send('Runtime.enable');

    // 打开侧边栏
    await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent('chrome-extension://' + extId + '/src/sidepanel.html'), { method: 'PUT' });
    await new Promise(r => setTimeout(r, 1200));
    const list2 = await getJson('/json/list');
    const page = list2.find(t => t.type === 'page' && /sidepanel\.html/.test(t.url));
    const pageCdp = await new Cdp(page.webSocketDebuggerUrl).connect();
    await pageCdp.send('Runtime.enable');
    check('2. 侧边栏页面已打开', true);

    const ver = await pageCdp.evalExpr('document.getElementById("appVersion").textContent');
    check('3. 版本徽章 = ' + ver, /^v\d/.test(ver), ver);

    // 填配置并保存
    await pageCdp.evalExpr(`
      document.getElementById("apiBaseUrl").value = "https://opencode.ai/zen/go/v1/chat/completions";
      document.getElementById("apiModel").value = "deepseek-v4-flash";
      document.getElementById("apiKey").value = "sk-e2e-test-key";
      document.getElementById("resumeText").value = "测试简历内容";
      document.getElementById("keyword").value = "数据分析";
      document.getElementById("city").value = "北京";
      document.getElementById("count").value = "3";
      document.getElementById("saveCfg").click();
      true
    `);
    await new Promise(r => setTimeout(r, 500));

    // 展开 5 运行日志卡片让日志可见
    await pageCdp.evalExpr('const b = document.getElementById("logBody"); if (b.style.display === "none") document.querySelector(\'[data-toggle="logBody"]\').click(); true');

    // 真实点击「开始收集并筛选」
    await pageCdp.evalExpr('document.getElementById("btnCollect").click(); true');
    check('4. 已点击「开始收集并筛选」', true);

    // 轮询状态与日志（最长 40s：headless 下 zhipin 页无岗位，SCRAPE 空转会跑几秒）
    let phase = '', panelLog = '';
    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      phase = (await swCdp.evalExpr('state.phase').catch(() => 'sw-dead')) || '';
      panelLog = await pageCdp.evalExpr('document.getElementById("log").innerText');
      if (/收集到|筛选|收集失败|异常/.test(panelLog) && phase !== 'collecting') break;
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log('--- SW phase: ' + phase);
    console.log('--- 面板日志 ---\n' + panelLog.split('\n').slice(-12).join('\n'));

    check('5. SW 状态机运转过（非 idle 卡死）', /collecting|screening|review|idle|done/.test(phase) && phase === 'idle', phase);
    check('6. 面板收到 SW 日志回传', panelLog.length > 50, panelLog.slice(0, 80));
    check('7. 无后台异常', swCdp.consoleErrors.length === 0, swCdp.consoleErrors.join(' | ').slice(0, 300));
    check('8. 无面板异常', pageCdp.consoleErrors.length === 0, pageCdp.consoleErrors.join(' | ').slice(0, 300));

    const failed = results.filter(r => !r.ok).length;
    console.log('\n==== E2E: ' + (results.length - failed) + ' passed, ' + failed + ' failed ====');
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error('E2E ERROR: ' + e.message);
    process.exitCode = 1;
  } finally {
    try { if (edge) execSync('taskkill /pid ' + edge.pid + ' /T /F', { stdio: 'ignore' }); } catch (e2) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) {}
  }
})();
