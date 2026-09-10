// ===== 真实 Edge 冒烟测试：headless 加载扩展 → 验证 SW 与侧边栏 =====
// 用法：node tests/smoke-edge.js
// 原理：Edge headless=new + 独立临时 user-data-dir + --load-extension，
//       通过 CDP (remote-debugging-port) 驱动，不触碰用户真实浏览器配置。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT);
const PORT = 9231;

function findEdge() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
  ].filter(Boolean);
  for (const p of candidates) { try { fs.accessSync(p); return p; } catch (e) {} }
  return null;
}

async function httpGetJson(port, p) {
  const r = await fetch('http://127.0.0.1:' + port + p);
  return r.json();
}

async function httpPutJson(port, p) {
  const r = await fetch('http://127.0.0.1:' + port + p, { method: 'PUT' });
  if (!r.ok) throw new Error('PUT ' + p + ' -> ' + r.status);
  return r.json();
}

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); this.handlers = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = e => reject(new Error('WebSocket error'));
      this.ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        } else if (msg.method) {
          this.handlers.forEach(h => h(msg.method, msg.params));
        }
      };
    });
  }
  send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 10000);
    });
  }
  evalExpr(expression) {
    return this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      .then(r => r.result.value);
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail && !ok ? ' :: ' + detail : ''));
}

async function main() {
  const edgePath = findEdge();
  if (!edgePath) { console.log('SKIP 未找到 msedge.exe（可设 EDGE_PATH 环境变量）'); process.exit(0); return; }
  console.log('Edge: ' + edgePath);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-smoke-'));
  let edge = null;
  try {
    edge = spawn(edgePath, [
      '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-features=Translate',
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + tmpDir,
      '--load-extension=' + EXT_DIR,
      '--enable-unsafe-extension-debugging',
      'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    edge.on('error', e => console.log('SPAWN ERROR: ' + e.message));
    edge.on('exit', (code, sig) => console.log('EDGE EXITED code=' + code + ' sig=' + sig));
    edge.stderr.on('data', d => { const s = String(d).trim(); if (s) console.log('[edge-stderr] ' + s.split('\n')[0].slice(0, 200)); });

    // 等调试端口就绪
    let ready = false;
    for (let i = 0; i < 50 && !ready; i++) {
      try { await httpGetJson(PORT, '/json/version'); ready = true; } catch (e) { await new Promise(r => setTimeout(r, 300)); }
    }
    if (!ready) throw new Error('CDP 端口未就绪');

    // 找扩展 SW target
    let swTarget = null;
    for (let i = 0; i < 40 && !swTarget; i++) {
      const list = await httpGetJson(PORT, '/json/list');
      swTarget = list.find(t => t.type === 'service_worker' && /chrome-extension:\/\/.+\/src\/background\.js/.test(t.url)) || null;
      if (!swTarget) await new Promise(r => setTimeout(r, 250));
    }
    if (!swTarget) {
      const list = await httpGetJson(PORT, '/json/list');
      console.log('调试目标列表：'); list.forEach(t => console.log('  - ' + t.type + ' ' + t.url));
      throw new Error('未发现扩展 Service Worker（headless 可能不支持扩展，或加载失败）');
    }
    const extId = (swTarget.url.match(/chrome-extension:\/\/([^/]+)\//) || [])[1];
    check('扩展已加载且 SW 已启动', !!extId, 'extId=' + extId);

    // ── SW 检查 ──
    const sw = await new Cdp(swTarget.webSocketDebuggerUrl).connect();
    const manifestLocal = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const version = await sw.evalExpr('chrome.runtime.getManifest().version');
    check('SW: manifest 版本 ' + manifestLocal.version, version === manifestLocal.version, String(version));

    const hasFilters = await sw.evalExpr('typeof BPFilters === "object" && typeof BPFilters.applyFilters === "function"');
    check('SW: BPFilters 过滤引擎已加载', hasFilters === true);

    const sal = await sw.evalExpr('JSON.stringify(BPFilters.parseSalary("8千-1.2万"))');
    check('SW: parseSalary 混合单位', sal === '{"min":8,"max":12}', sal);

    const filtered = await sw.evalExpr(
      'JSON.stringify(BPFilters.applyFilters([{id:1,company:"字节跳动网络科技"},{id:2,company:"好的公司"}], {listMode:"black",blacklist:[{name:"字节跳动",mode:"keyword"}]}).kept.map(j=>j.id))'
    );
    check('SW: 黑名单过滤端到端', filtered === '[2]', filtered);

    const cfgDefault = await sw.evalExpr(
      'new Promise(res => chrome.storage.local.get("filterConfig", d => res(!!d.filterConfig)))'
    );
    check('SW: filterConfig 默认值已写入', cfgDefault === true);

    // ── 侧边栏页面检查 ──
    const newTarget = await httpPutJson(PORT, '/json/new?' + encodeURIComponent('chrome-extension://' + extId + '/src/sidepanel.html'));
    await new Promise(r => setTimeout(r, 800));
    const list2 = await httpGetJson(PORT, '/json/list');
    const pageTarget = list2.find(t => t.type === 'page' && t.url.indexOf('sidepanel.html') >= 0);
    if (!pageTarget) throw new Error('侧边栏页面未打开');
    const page = await new Cdp(pageTarget.webSocketDebuggerUrl).connect();

    const uiOk = await page.evalExpr(
      'JSON.stringify({cards: document.querySelectorAll(".card").length, dryRun: !!document.getElementById("btnDryRun"), blackList: !!document.getElementById("blackList"), saveFilter: !!document.getElementById("btnSaveFilter"), statToday: !!document.getElementById("statToday"), statChart: !!document.getElementById("statChart"), maxPerRun: !!document.getElementById("maxPerRun"), dailyGoal: !!document.getElementById("dailyGoal")})'
    );
    const ui = JSON.parse(uiOk);
    check('UI: 卡片数量 7（含岗位过滤+投递统计）', ui.cards === 7, uiOk);
    check('UI: 岗位过滤控件齐全', ui.dryRun && ui.blackList && ui.saveFilter, uiOk);
    check('UI: 统计与节奏控件齐全', ui.statToday && ui.statChart && ui.maxPerRun && ui.dailyGoal, uiOk);

    const filled = await page.evalExpr('document.getElementById("apiBaseUrl").value');
    check('UI: 默认 API 端点已填充', filled === 'https://opencode.ai/zen/go/v1/chat/completions', String(filled));

    const keyLen = await page.evalExpr('document.getElementById("apiKey").value.length');
    check('UI: API Key 已预设', keyLen > 20, 'keyLen=' + keyLen);

    // UI 操作 → 保存黑名单 → SW 侧读 storage 验证全链路
    await page.evalExpr(
      '(function(){document.getElementById("blackList").value="冒烟测试公司 @kw";' +
      'document.querySelector(\'input[name="listMode"][value="black"]\').checked=true;' +
      'document.getElementById("btnSaveFilter").click();return true;})()'
    );
    await new Promise(r => setTimeout(r, 500));
    const saved = await sw.evalExpr(
      'new Promise(res => chrome.storage.local.get("filterConfig", d => res(JSON.stringify(d.filterConfig && d.filterConfig.blacklist || []))))'
    );
    check('全链路: UI 保存黑名单 → storage 结构化', saved.indexOf('冒烟测试公司') >= 0 && saved.indexOf('keyword') >= 0, saved);

    sw.close(); page.close();
    const failed = results.filter(r => !r.ok).length;
    console.log('\n==== Edge 冒烟测试: ' + (results.length - failed) + ' passed, ' + failed + ' failed ====');
    process.exitCode = failed ? 1 : 0;
  } catch (e) {
    console.error('SMOKE ERROR: ' + e.message);
    process.exitCode = 1;
  } finally {
    try { if (edge) execSync('taskkill /pid ' + edge.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

main();
