// ===== content-chat.js DOM 逻辑测试（输入框/会话列表/发送验证）=====
'use strict';
const assert = require('assert');
const vm = require('vm');
const { define, readSrc, makeDom } = require('./helpers');

function loadChat(buildDom, opts) {
  opts = opts || {};
  const dom = makeDom();
  if (buildDom) buildDom(dom);
  const listeners = [];
  const chromeStub = { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } } };
  // 加速时钟：每次 Date.now() 推进 250ms，让 waitVisible 超时瞬间到达
  let clock = 0;
  const FakeDate = { now: () => (clock += 250) };
  function FakeEvent(type, init) { this.type = type; Object.assign(this, init || {}); }
  const ctx = {
    console, chrome: chromeStub, document: dom.document, window: dom.window,
    Date: FakeDate, Event: FakeEvent, InputEvent: FakeEvent, KeyboardEvent: FakeEvent,
    setTimeout: (fn, ms) => setTimeout(fn, 1),
    clearTimeout, setInterval: (fn, ms) => setInterval(fn, 1), clearInterval
  };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readSrc('selectors.js'), ctx, { filename: 'selectors.js' });
  vm.runInContext(readSrc('content-chat.js'), ctx, { filename: 'content-chat.js' });
  return {
    dom,
    send(msg) {
      return new Promise(resolve => {
        let done = false;
        for (const fn of listeners) {
          const keep = fn(msg, {}, r => { if (!done) { done = true; resolve(r); } });
          if (keep !== true && !done) resolve(undefined);
        }
      });
    }
  };
}

function buildChatInput(dom) {
  const input = dom.makeEl('div', 'chat-input', '', { id: 'chat-input' });
  input.isContentEditable = true;
  input.setAttribute('contenteditable', 'true');
  input.offsetParent = {};
  input.onEvent = ev => { if (ev.type === 'keydown') input.textContent = ''; };
  dom.body.appendChild(input);
  return input;
}

function buildUserList(dom) {
  const ul = dom.makeEl('ul', 'user-list-content');
  const li1 = dom.makeEl('li', '', '阿里科技有限公司 王女士 数据分析师');
  const li2 = dom.makeEl('li', '', '字节跳动网络科技 李先生 销售专员');
  li1.offsetParent = {}; li2.offsetParent = {};
  ul.appendChild(li1); ul.appendChild(li2);
  dom.body.appendChild(ul);
  return ul;
}

define('content-chat.js 发送逻辑', t => {

  t('SEND_ACTIVE：contenteditable 输入 + 回车发送成功', async () => {
    const input = { ref: null };
    const env = loadChat(dom => {
      input.ref = buildChatInput(dom);
      const sent1 = dom.makeEl('div', 'item-myself', '旧消息1');
      const sent2 = dom.makeEl('div', 'item-myself', '旧消息2');
      dom.body.appendChild(sent1); dom.body.appendChild(sent2);
    });
    const r = await env.send({ type: 'SEND_ACTIVE', image: '', greeting: '您好，熟悉SQL、Python' });
    assert.ok(r && r.success, '发送应成功');
    assert.ok(r.imageOk === true, '无图片视为成功');
    assert.strictEqual(input.ref.textContent, '', '发送后输入框应被清空');
    const events = input.ref._events || [];
    assert.ok(events.some(e => e.type === 'input'), '应派发 input 事件');
    assert.ok(events.some(e => e.type === 'keydown'), '应派发回车 keydown');
  });

  t('SEND_ACTIVE：找不到输入框时返回诊断信息', async () => {
    const env = loadChat(() => {});
    const r = await env.send({ type: 'SEND_ACTIVE', image: '', greeting: 'x' });
    assert.ok(r && r.success === false);
    assert.ok(r.error.indexOf('未找到输入框') >= 0);
    assert.ok(r.error.indexOf('dumpInputs') < 0 && r.error.length > 10, '应附带候选元素诊断');
  });

  t('SEND：按公司名匹配会话后发送', async () => {
    const input = { ref: null };
    const env = loadChat(dom => {
      input.ref = buildChatInput(dom);
      buildUserList(dom);
      dom.body.appendChild(dom.makeEl('div', 'item-myself', '旧'));
    });
    const r = await env.send({ type: 'SEND', company: '阿里科技有限公司', hrName: '王女士', position: '数据分析师', image: '', greeting: '您好' });
    assert.ok(r && r.success);
  });

  t('SEND：无匹配会话时兜底选第一条', async () => {
    const env = loadChat(dom => {
      buildChatInput(dom);
      buildUserList(dom);
      dom.body.appendChild(dom.makeEl('div', 'item-myself', '旧'));
    });
    const r = await env.send({ type: 'SEND', company: '完全不存在公司', hrName: '', position: '', image: '', greeting: '您好' });
    assert.ok(r && r.success, '兜底第一条会话应成功');
  });

  t('SEND_ACTIVE：回车无效但点击发送按钮也可发送', async () => {
    const env = loadChat(dom => {
      const input = dom.makeEl('div', 'chat-input', '', { id: 'chat-input' });
      input.isContentEditable = true;
      input.setAttribute('contenteditable', 'true');
      input.offsetParent = {};
      dom.body.appendChild(input);
      const btn = dom.makeEl('button', 'btn-send', '发送');
      btn.offsetParent = {};
      dom.body.appendChild(btn);
      dom.body.appendChild(dom.makeEl('div', 'item-myself', '旧'));
      btn.onclick = () => { input.textContent = ''; };
    });
    const r = await env.send({ type: 'SEND_ACTIVE', image: '', greeting: '您好' });
    assert.ok(r && r.success, '发送按钮兜底应成功');
  });

  t('SEND_ACTIVE：输入框存在但文字未清空且无新气泡 → 报发送未确认', async () => {
    const env = loadChat(dom => {
      const input = buildChatInput(dom);
      input.onEvent = null; // 回车不清空
      dom.body.appendChild(dom.makeEl('div', 'item-myself', '旧'));
    });
    const r = await env.send({ type: 'SEND_ACTIVE', image: '', greeting: '您好' });
    assert.ok(r && r.success === false);
    assert.ok(r.error.indexOf('发送未确认') >= 0);
  });

  t('SEND_ACTIVE：配置了简历图片但无上传入口 → 判失败不误报成功（回归）', async () => {
    const env = loadChat(dom => {
      buildChatInput(dom);
      dom.body.appendChild(dom.makeEl('div', 'item-myself', '旧'));
    });
    const r = await env.send({ type: 'SEND_ACTIVE', image: 'data:image/png;base64,AAAA', greeting: '您好' });
    assert.ok(r && r.success === false, '图片传不上去不应报成功');
    assert.ok(/简历图片/.test(r.error || ''), '应提示图片问题：' + r.error);
  });
});
