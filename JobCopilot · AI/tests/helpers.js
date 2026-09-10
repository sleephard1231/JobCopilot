// ===== 测试公共设施：chrome.* mock、SW 加载器、迷你 DOM、套件注册 =====
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function readSrc(f) { return fs.readFileSync(path.join(SRC, f), 'utf8'); }

// ── 套件注册与运行 ──
const suites = [];
function define(name, fn) { suites.push({ name, fn }); }
async function runAll(onlyName) {
  let tp = 0, tf = 0; const failed = [];
  for (const s of suites) {
    if (onlyName && s.name.indexOf(onlyName) < 0) continue;
    console.log('\n=== ' + s.name + ' ===');
    const tests = [];
    await s.fn((tn, tfn) => tests.push([tn, tfn]));
    for (const [tn, tfn] of tests) {
      try {
        const r = tfn();
        if (r && typeof r.then === 'function') await r;
        console.log('  PASS ' + tn); tp++;
      } catch (e) {
        console.log('  FAIL ' + tn + ' :: ' + (e && e.message)); tf++;
        failed.push(s.name + ' / ' + tn + ' :: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
      }
    }
  }
  console.log('\n==== TOTAL: ' + tp + ' passed, ' + tf + ' failed ====');
  if (failed.length) { console.log('\nFailures:'); failed.forEach(x => console.log('  - ' + x)); }
  process.exitCode = tf ? 1 : 0;
}

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

// ── chrome.* mock ──
function makeChrome(opts) {
  opts = opts || {};
  const data = new Map();
  const storage = {
    local: {
      get(keys, cb) {
        // 惰性求值：微任务执行时才读取最新数据（与真实 chrome.storage 时序一致）
        const buildOut = () => {
          const list = keys == null ? [...data.keys()]
            : Array.isArray(keys) ? keys
            : typeof keys === 'string' ? [keys]
            : Object.keys(keys);
          const out = {};
          for (const k of list) if (data.has(k)) out[k] = clone(data.get(k));
          return out;
        };
        if (cb) { setImmediate(() => cb(buildOut())); return; }
        return Promise.resolve().then(buildOut);
      },
      set(obj, cb) {
        for (const k of Object.keys(obj)) data.set(k, clone(obj[k]));
        if (cb) { setImmediate(() => cb()); return; }
        return Promise.resolve();
      },
      _data: data
    }
  };

  const runtimeMessages = [];
  let panelListener = null;
  const messageListeners = [];
  const runtime = {
    id: 'test-ext-id',
    lastError: undefined,
    getManifest: () => ({ version: '9.9.9-test' }),
    getPlatformInfo: (cb) => { if (cb) setImmediate(() => cb({ os: 'win' })); },
    onInstalled: { addListener() {} },
    onMessage: { addListener(fn) { messageListeners.push(fn); } },
    sendMessage(msg, cb) {
      runtimeMessages.push(clone(msg));
      if (panelListener) setImmediate(() => { try { panelListener(clone(msg)); } catch (e) {} });
      if (cb) {
        const preset = opts.messageResponses && opts.messageResponses[msg.type];
        setImmediate(() => cb(preset ? clone(preset) : { ok: true, count: 0, list: [] }));
        return;
      }
      return Promise.resolve({});
    },
    _runtimeMessages: runtimeMessages,
    _setPanelListener(fn) { panelListener = fn; }
  };

  let contentHandler = opts.contentHandler || (() => ({ success: false, error: 'no handler' }));
  const tabs = {
    query(q, cb) { const r = [{ id: 1, url: opts.tabUrl || 'https://www.zhipin.com/web/geek/jobs?query=x', status: 'complete' }]; if (cb) { setImmediate(() => cb(r)); return; } return Promise.resolve(r); },
    create(t, cb) { const r = Object.assign({ id: 1, status: 'complete', url: (t && t.url) || '' }, {}); if (cb) { setImmediate(() => cb(r)); return; } return Promise.resolve(r); },
    update(id, props, cb) { const r = { id, status: 'complete', url: (props && props.url) || '' }; if (cb) { setImmediate(() => cb(r)); return; } return Promise.resolve(r); },
    get(id, cb) { setImmediate(() => cb({ id, status: 'complete', url: opts.chatUrl || 'https://www.zhipin.com/web/geek/chat/1001' })); },
    sendMessage(tabId, msg, cb) { setImmediate(() => cb(contentHandler(tabId, msg))); },
    onUpdated: { addListener() {}, removeListener() {} },
    _setContentHandler(fn) { contentHandler = fn; }
  };

  const injected = [];
  const scripting = {
    executeScript(args) { injected.push((args.files || []).join(',')); return Promise.resolve(); },
    _injected: injected
  };

  const alarms = { create() {}, onAlarm: { addListener() {} } };
  const sidePanel = { setPanelBehavior: () => Promise.resolve() };

  // 侧边栏 → SW：调用 SW 注册的 onMessage 监听器并等待 sendResponse
  function panelSend(msg) {
    return new Promise(resolve => {
      let responded = false;
      const sendResponse = r => { if (!responded) { responded = true; resolve(r); } };
      if (!messageListeners.length) return resolve(undefined);
      let keepOpen = false;
      for (const fn of messageListeners) {
        const k = fn(clone(msg), {}, sendResponse);
        if (k === true) keepOpen = true;
      }
      if (!keepOpen && !responded) resolve(undefined);
      setTimeout(() => { if (!responded) resolve(undefined); }, 3000);
    });
  }

  return { storage, runtime, tabs, scripting, alarms, sidePanel, panelSend, _storageData: data };
}

// ── SW 加载器：vm 沙箱 + 快速定时器 ──
function loadSW(chrome, fetchMock, extraFiles) {
  // 与真实运行一致：只加载 background.js，由其 importScripts 链式加载其余模块
  const files = extraFiles || ['/src/background.js'];
  const ctx = {
    console, chrome, fetch: fetchMock,
    URL, URLSearchParams, TextEncoder, TextDecoder,
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 1)),
    clearTimeout, clearInterval,
    setInterval: (fn, ms) => setInterval(fn, Math.min(ms || 10, 10)),
    importScripts: (...paths) => { for (const p of paths) vm.runInContext(fs.readFileSync(path.join(ROOT, p), 'utf8'), ctx, { filename: p }); }
  };
  ctx.self = ctx; ctx.globalThis = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  ctx.importScripts(...files);
  return ctx;
}

async function waitFor(condFn, timeout, step) {
  timeout = timeout || 5000; step = step || 10;
  const t0 = Date.now();
  for (;;) {
    const v = await condFn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('waitFor timeout');
    await new Promise(r => setTimeout(r, step));
  }
}

// ── LLM fetch mock：按队列返回脚本化响应，空了就抛错（保证调用次数可断言）──
function makeFetchQueue(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(JSON.parse(init.body));
    if (!responses.length) throw new Error('fetch queue empty（调用次数超出脚本预期）');
    const next = responses.shift();
    if (typeof next === 'number') return { ok: false, status: next, text: async () => 'boom', json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: next } }] }) };
  };
  fn._calls = calls;
  return fn;
}

// ── 迷你 DOM：仅支持本项目选择器用到的形态 ──
// 支持: tag / .class / tag.class / [attr] / [attr*="val"] / A B(后代) / 逗号多选
function makeDom() {
  const roots = [];

  function makeEl(tag, cls, text, attrs) {
    const node = {
      tagName: String(tag || 'div').toUpperCase(),
      className: cls || '',
      id: (attrs && attrs.id) || '',
      attrs: Object.assign({}, attrs || {}),
      children: [], parent: null,
      _text: text || '',
      style: {}, offsetParent: null, disabled: false,
      get classList() { const c = String(this.className || '').split(/\s+/).filter(Boolean); return { contains: s => c.indexOf(s) >= 0 }; },
      get textContent() { return this._text + this.children.map(c => c.textContent).join(''); },
      set textContent(v) { this._text = String(v); this.children.length = 0; },
      get innerText() {
        if (!this.children.length) return this._text;
        const parts = this._text ? [this._text] : [];
        return parts.concat(this.children.map(c => c.innerText)).join('\n');
      },
      set innerText(v) { this.textContent = v; },
      get href() { return this.attrs.href != null ? this.attrs.href : ''; },
      appendChild(c) { c.parent = this; this.children.push(c); return c; },
      click() { this._clicked = (this._clicked || 0) + 1; if (this.onclick) this.onclick(); },
      scrollIntoView() {}, focus() {}, blur() {}, select() {},
      getAttribute(n) { if (n === 'class') return this.className; if (n === 'id') return this.id; return this.attrs[n] !== undefined ? this.attrs[n] : null; },
      setAttribute(n, v) { this.attrs[n] = String(v); },
      dispatchEvent(ev) { this._events = this._events || []; this._events.push(ev); if (this.onEvent) this.onEvent(ev); return true; },
      addEventListener() {},
      querySelector(sel) { const r = this.querySelectorAll(sel); return r.length ? r[0] : null; },
      querySelectorAll(sel) { const out = []; walk(this, out); out.shift(); return out.filter(n => matchNode(n, sel)); },
      attachShadow() { return makeEl('shadow-root'); }
    };
    return node;
  }

  function matchSimple(node, sel) {
    let rest = sel;
    const idm = rest.match(/#([\w-]+)/);
    const idSel = idm ? idm[1] : null;
    if (idm) rest = rest.replace(/#[\w-]+/g, '');
    const tm = rest.match(/^[a-zA-Z][\w-]*/);
    const tag = tm ? tm[0].toUpperCase() : null;
    if (tag) rest = rest.slice(tm[0].length);
    const classes = []; const attrConds = [];
    const re = /\.([\w-]+)|\[([^\]]+)\]/g;
    let mm;
    while ((mm = re.exec(rest))) {
      if (mm[1]) classes.push(mm[1]);
      else {
        const am = mm[2].match(/^([\w-]+)(?:\*?=(.*))?$/);
        if (!am) continue;
        let val = am[2] != null ? am[2].replace(/^["']|["']$/g, '') : null;
        attrConds.push({ name: am[1], val });
      }
    }
    if (tag && node.tagName !== tag) return false;
    if (idSel && String(node.id || '') !== idSel) return false;
    const cls = String(node.className || '').split(/\s+/).filter(Boolean);
    for (const c of classes) if (cls.indexOf(c) < 0) return false;
    for (const cond of attrConds) {
      let v;
      if (cond.name === 'class') v = node.className;
      else if (node.attrs[cond.name] !== undefined) v = node.attrs[cond.name];
      else if (cond.name === 'href') v = node.href;
      if (cond.val == null) { if (v === undefined || v === null) return false; }
      else { if (v === undefined || v === null || String(v).indexOf(cond.val) < 0) return false; }
    }
    return true;
  }

  function matchTail(node, parts, i) {
    if (!matchSimple(node, parts[i])) return false;
    if (i === 0) return true;
    let p = node.parent;
    while (p) { if (matchTail(p, parts, i - 1)) return true; p = p.parent; }
    return false;
  }

  function matchNode(node, sel) {
    return sel.split(',').map(s => s.trim()).some(s => s && matchTail(node, s.split(/\s+/), s.split(/\s+/).length - 1));
  }

  function walk(node, out) {
    out.push(node);
    for (const c of node.children) walk(c, out);
  }

  function queryAll(sel) {
    const out = [];
    for (const r of roots) { const all = []; walk(r, all); all.shift(); for (const n of all) if (matchNode(n, sel)) out.push(n); }
    return out;
  }

  const body = makeEl('body');
  const docEl = makeEl('html');
  docEl.appendChild(body);
  roots.push(docEl);

  const documentStub = {
    body, documentElement: docEl, head: makeEl('head'),
    querySelector: sel => queryAll(sel)[0] || null,
    querySelectorAll: sel => queryAll(sel),
    createElement: tag => makeEl(tag),
    createTextNode: t => ({ _text: String(t), get textContent() { return this._text; } }),
    addEventListener() {}
  };

  const windowStub = {
    scrollTo() {}, location: { href: 'https://www.zhipin.com/web/geek/jobs?query=test' },
    HTMLInputElement: function HTMLInputElement() {},
    HTMLTextAreaElement: function HTMLTextAreaElement() {},
    DataTransfer: function DataTransfer() { this.items = { add() {} }; this.files = []; },
    getComputedStyle: () => ({ position: 'static' })
  };
  Object.defineProperty(windowStub.HTMLInputElement.prototype, 'files', { set(v) { this._files = v; }, get() { return this._files || []; } });
  Object.defineProperty(windowStub.HTMLTextAreaElement.prototype, 'value', { set(v) { this._value = v; }, get() { return this._value || ''; } });

  return { makeEl, document: documentStub, window: windowStub, queryAll, body };
}

module.exports = { ROOT, SRC, readSrc, define, runAll, makeChrome, loadSW, waitFor, makeFetchQueue, makeDom };
