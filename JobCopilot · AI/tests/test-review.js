// ===== review 针对性测试：模板关键词/配额防误杀/慢渲染条件等待/慢导航/域名授权/网络报错 =====
'use strict';
const assert = require('assert');
const vm = require('vm');
const { define, makeChrome, loadSW, waitFor, readSrc, makeDom } = require('./helpers');

const MATCH_JSON = '{"match":true,"reason":"ok"}';
const GREETING = '您好，熟悉SQL，做过数据分析，期待沟通。';
const JOBS1 = [{ id: 'J1', name: '数据分析师', salary: '10-15K', company: '阿里科技有限公司', tags: ['SQL'], area: '北京·朝阳区', activeState: 'online', inviteCount: 10 }];

function baseCfg(extraFilter) {
  return {
    apiBaseUrl: 'https://api.test/v1/chat/completions', apiKey: 'sk-test', apiModel: 'test-model',
    resumeText: '熟练 SQL', keyword: '数据分析', city: '北京', count: '1',
    filterConfig: Object.assign({ listMode: 'off' }, extraFilter || {})
  };
}

// LLM 队列 fetch（高德不涉及）
function llmFetchQueue(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(init && init.body ? JSON.parse(init.body) : url);
    if (!responses.length) throw new Error('fetch queue empty');
    const n = responses.shift();
    if (typeof n === 'number') return { ok: false, status: n, text: async () => 'boom', json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: n } }] }) };
  };
  fn._calls = calls;
  return fn;
}

// 永远抛网络错误的 fetch（模拟未授权域名/断网）
function throwingFetch() {
  const fn = async () => { throw new TypeError('Failed to fetch'); };
  fn._calls = [];
  return fn;
}

function setup(opts) {
  opts = opts || {};
  const chrome = makeChrome({
    chatUrl: 'https://www.zhipin.com/web/geek/chat/1001',
    contentHandler: (tabId, msg) => {
      if (msg.type === 'PING') return { success: true, alive: true };
      if (msg.type === 'SCRAPE') return { success: true, jobs: opts.jobs || JOBS1 };
      if (msg.type === 'OPEN_JD') return { success: true, jd: 'JD', hrName: '王女士', addr: '北京市海淀区中关村', fundText: '' };
      if (msg.type === 'GO_CHAT') return opts.goChat || { success: true, navigated: true };
      if (msg.type === 'SEND_ACTIVE') return { success: true, imageOk: true };
      return { success: false, error: 'unexpected: ' + msg.type };
    }
  });
  const effCfg = opts.cfg || baseCfg({});
  for (const k of Object.keys(effCfg)) chrome._storageData.set(k, JSON.parse(JSON.stringify(effCfg[k])));
  if (opts.setupChrome) opts.setupChrome(chrome);
  const fetch_ = opts.fetch || llmFetchQueue(opts.llm || [MATCH_JSON, GREETING]);
  loadSW(chrome, fetch_);
  return { chrome, fetch: fetch_ };
}

async function collectToReview(chrome) {
  const resp = await chrome.panelSend({ type: 'START_COLLECT' });
  assert.ok(resp && resp.ok);
  await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'review'; }, 8000);
}
async function deliverToDone(chrome, timeout) {
  await chrome.panelSend({ type: 'START_DELIVER', jobIds: ['J1'] });
  await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, timeout || 10000);
}

// ── content-search mini-DOM 加载器（同 test-content-search 的模式，DOM 可延迟追加）──
function loadSearch(dom) {
  const listeners = [];
  const chromeStub = { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } } };
  const ctx = {
    console, chrome: chromeStub, document: dom.document, window: dom.window,
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readSrc('selectors.js'), ctx, { filename: 'selectors.js' });
  vm.runInContext(readSrc('content-search.js'), ctx, { filename: 'content-search.js' });
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

function buildListWithCards(dom, specs) {
  const list = dom.makeEl('div', 'job-list-box');
  dom.body.appendChild(list);
  specs.forEach(s => {
    const li = dom.makeEl('li', 'job-card-box');
    const a = dom.makeEl('a', '', '', { href: 'https://www.zhipin.com/job_detail/' + s.id + '.html?ka=1' });
    a.offsetParent = {};
    a.appendChild(dom.makeEl('span', 'job-name', s.name));
    a.appendChild(dom.makeEl('span', 'job-salary', s.salary));
    const areaWrap = dom.makeEl('span', 'job-area-wrapper');
    areaWrap.appendChild(dom.makeEl('span', 'job-area', s.area));
    a.appendChild(areaWrap);
    li.appendChild(a);
    const footer = dom.makeEl('div', 'job-card-footer');
    const cinfo = dom.makeEl('div', 'company-info');
    cinfo.appendChild(dom.makeEl('a', 'company-name', s.company));
    footer.appendChild(cinfo);
    li.appendChild(footer);
    li.offsetParent = {};
    list.appendChild(li);
  });
  return list;
}

define('review 针对性测试', t => {

  t('模板 {{关键词}} 渲染为配置的关键词（修复回归）', async () => {
    const cfg = baseCfg({});
    cfg.greetingTemplate = '您好，我在找{{关键词}}方向的机会，看到{{岗位}}，期待沟通';
    const sent = [];
    const { chrome } = setup({
      cfg: cfg, llm: [MATCH_JSON, ''],
      setupChrome: (c) => {
        c.tabs._setContentHandler((tabId, msg) => {
          if (msg.type === 'SEND_ACTIVE') { sent.push(msg.greeting); return { success: true, imageOk: true }; }
          if (msg.type === 'SCRAPE') return { success: true, jobs: JOBS1 };
          if (msg.type === 'OPEN_JD') return { success: true, jd: '', hrName: '王女士', addr: '', fundText: '' };
          if (msg.type === 'GO_CHAT') return { success: true, navigated: true };
          return { success: false, error: 'unexpected' };
        });
      }
    });
    await collectToReview(chrome);
    await deliverToDone(chrome);
    assert.ok(sent.length >= 1, '应发送 1 条招呼语');
    const g = sent[0];
    assert.ok(g.indexOf('数据分析') >= 0, '关键词应渲染：' + g);
    assert.ok(g.indexOf('数据分析师') >= 0, '岗位应渲染');
    assert.ok(g.indexOf('{{') < 0, '不应残留占位符');
  });

  t('配额弹窗防误杀：促销弹窗（开通牛人会员，无沟通/名额字样）不算配额', async () => {
    const dom = makeDom();
    const list = buildList(dom, JOBS1.map(j => ({ id: j.id, name: j.name, company: j.company, area: j.area })));
    const btn = dom.makeEl('a', 'op-btn-chat', '立即沟通');
    btn.offsetParent = {};
    list.children[0].appendChild(btn);
    // 促销弹窗：可见、含 dialog 类名、含"开通牛人会员"，但无 沟通/名额/次数
    const promo = dom.makeEl('div', 'zhipin-dialog', '开通牛人会员，海量岗位任你挑');
    promo.offsetParent = {};
    dom.body.appendChild(promo);
    // 继续沟通按钮存在
    const go = dom.makeEl('span', 'dialog-btn', '继续沟通');
    go.offsetParent = {};
    dom.body.appendChild(go);
    const env = loadSearch(dom);
    const r = await env.send({ type: 'GO_CHAT', job: { id: 'J1', name: '数据分析师', company: '阿里科技有限公司' } });
    assert.ok(r && r.success && r.navigated === true, '促销弹窗不应触发配额收尾，应正常点继续沟通');
  });

  t('配额弹窗：真实配额文案（今日沟通名额已用完）→ 返回 quota', async () => {
    const dom = makeDom();
    const list = buildList(dom, [{ id: 'J1', name: '数据分析师', company: '阿里科技有限公司', area: '北京' }]);
    const btn = dom.makeEl('a', 'op-btn-chat', '立即沟通');
    btn.offsetParent = {};
    list.children[0].appendChild(btn);
    const dlg = dom.makeEl('div', 'dialog-wrap', '今日沟通名额已用完，可开通牛人会员继续畅聊');
    dlg.offsetParent = {};
    dom.body.appendChild(dlg);
    const env = loadSearch(dom);
    const r = await env.send({ type: 'GO_CHAT', job: { id: 'J1', name: '数据分析师', company: '阿里科技有限公司' } });
    assert.ok(r && r.success === false && r.quota === true, '真实配额弹窗应返回 quota');
    assert.ok(/名额已用完/.test(r.error));
  });

  t('配额弹窗：position:fixed 且 offsetParent=null（真实 Chrome 行为）仍能识别（回归）', async () => {
    const dom = makeDom();
    const list = buildList(dom, [{ id: 'J1', name: '数据分析师', company: '阿里科技有限公司', area: '北京' }]);
    const btn = dom.makeEl('a', 'op-btn-chat', '立即沟通');
    btn.offsetParent = {};
    list.children[0].appendChild(btn);
    const dlg = dom.makeEl('div', 'dialog-wrap', '今日沟通名额已用完，可开通牛人会员继续畅聊');
    // 关键：fixed 元素 offsetParent 为 null，仅靠 computed style 才能判定可见
    dom.window.getComputedStyle = () => ({ position: 'fixed', display: 'block', visibility: 'visible' });
    dom.body.appendChild(dlg);
    const env = loadSearch(dom);
    const r = await env.send({ type: 'GO_CHAT', job: { id: 'J1', name: '数据分析师', company: '阿里科技有限公司' } });
    assert.ok(r && r.success === false && r.quota === true, 'fixed 配额弹窗应被识别');
  });

  t('SCRAPE 慢渲染：卡片 800ms 后才出现，条件等待能等到（固定 sleep 会漏抓）', async () => {
    const dom = makeDom();
    const list = buildList(dom, []); // 初始为空
    dom.body.appendChild(list);
    setTimeout(() => {
      buildListAdd(dom, list, { id: 'J1', name: '数据分析师', company: '阿里科技有限公司', area: '北京' });
    }, 800);
    const env = loadSearch(dom);
    const r = await env.send({ type: 'SCRAPE', count: 5 });
    assert.ok(r && r.success && r.jobs.length === 1, '慢渲染岗位应被等到并抓到');
  });

  t('OPEN_JD 慢渲染：详情面板 700ms 后出现，JD 仍能抓到', async () => {
    const dom = makeDom();
    buildList(dom, [{ id: 'J1', name: '数据分析师', company: '阿里科技有限公司', area: '北京' }]);
    setTimeout(() => {
      const det = dom.makeEl('div', 'job-detail-box');
      det.offsetParent = {};
      det.appendChild(dom.makeEl('div', 'job-sec-text', '岗位职责：负责数据分析'));
      dom.body.appendChild(det);
    }, 700);
    const env = loadSearch(dom);
    const r = await env.send({ type: 'OPEN_JD', job: { id: 'J1', name: '数据分析师', company: '阿里科技有限公司' } });
    assert.ok(r && r.success, '应成功');
    assert.ok(r.jd.indexOf('岗位职责') >= 0, 'JD 应含岗位职责');
  });

  t('GO_CHAT：继续沟通按钮延迟出现仍能点到', async () => {
    const dom = makeDom();
    const list = buildList(dom, [{ id: 'J1', name: '数据分析师', company: '阿里科技有限公司', area: '北京' }]);
    const btn = dom.makeEl('a', 'op-btn-chat', '立即沟通');
    btn.offsetParent = {};
    list.children[0].appendChild(btn);
    setTimeout(() => {
      const go = dom.makeEl('span', 'dialog-btn', '继续沟通');
      go.offsetParent = {};
      dom.body.appendChild(go);
    }, 600);
    const env = loadSearch(dom);
    const r = await env.send({ type: 'GO_CHAT', job: { id: 'J1', name: '数据分析师', company: '阿里科技有限公司' } });
    assert.ok(r && r.success && r.navigated === true, '延迟出现的继续沟通应被点到');
  });

  t('条件等待导航：GO_CHAT 后 tab URL 延迟变成聊天页也能投出（慢导航回归）', async () => {
    let navigated = false;
    let tabsGetCalls = 0;
    const { chrome } = setup({
      llm: [MATCH_JSON, GREETING],
      goChat: { success: true, navigated: true },
      setupChrome: (c) => {
        const orig = c.tabs.get.bind(c.tabs);
        c.tabs.get = (id, cb) => {
          tabsGetCalls++;
          // GO_CHAT 后前 2 次查询仍返回搜索页 URL，之后才返回聊天页（模拟慢跳转）
          const url = navigated && tabsGetCalls > 2
            ? 'https://www.zhipin.com/web/geek/chat/1001'
            : 'https://www.zhipin.com/web/geek/jobs?query=x';
          setImmediate(() => cb({ id, status: 'complete', url }));
        };
      }
    });
    // 包装：OPEN_JD 后 navigated=true，模拟"点立即沟通后 tab 才慢慢跳到聊天页"
    await collectToReview(chrome);
    let openJdCalls = 0;
    chrome.tabs._setContentHandler((tabId, msg) => {
      if (msg.type === 'PING') return { success: true, alive: true };
      if (msg.type === 'SCRAPE') return { success: true, jobs: JOBS1 };
      if (msg.type === 'OPEN_JD') { openJdCalls++; navigated = true; tabsGetCalls = 0; return { success: true, jd: 'JD', hrName: '王女士', addr: '', fundText: '' }; }
      if (msg.type === 'GO_CHAT') return { success: true, navigated: true };
      if (msg.type === 'SEND_ACTIVE') return { success: true, imageOk: true };
      return { success: false, error: 'unexpected: ' + msg.type };
    });
    await deliverToDone(chrome);
    const sent = await chrome.storage.local.get('sentContacts');
    assert.strictEqual(Object.keys(sent.sentContacts || {}).length, 1, '慢导航下投递应成功');
  });

  t('PING：页面出现验证码组件时返回 verify:true（DOM 兜底检测）', async () => {
    const dom = makeDom();
    const cap = dom.makeEl('div', 'geetest_panel');
    cap.offsetParent = {};
    dom.body.appendChild(cap);
    const env = loadSearch(dom);
    const r = await env.send({ type: 'PING' });
    assert.ok(r && r.success && r.verify === true, '应返回 verify:true');
  });

  t('安全验证页：命中后自动暂停等人工，验证完成点继续后同一岗位重试投出（回归）', async () => {
    let verify = false;
    let openJdCount = 0;
    const { chrome } = setup({
      llm: [MATCH_JSON, GREETING],
      setupChrome: (c) => {
        c.tabs.get = (id, cb) => setImmediate(() => cb({
          id, status: 'complete',
          url: verify ? 'https://www.zhipin.com/web/common/security-check.html?seed=1' : 'https://www.zhipin.com/web/geek/chat/1001'
        }));
        c.tabs._setContentHandler((tabId, msg) => {
          if (msg.type === 'PING') return { success: true, alive: true };
          if (msg.type === 'SCRAPE') return { success: true, jobs: JOBS1 };
          if (msg.type === 'OPEN_JD') { openJdCount++; return { success: true, jd: 'JD', hrName: '王女士', addr: '', fundText: '' }; }
          if (msg.type === 'GO_CHAT') return { success: true, navigated: true };
          if (msg.type === 'SEND_ACTIVE') return { success: true, imageOk: true };
          return { success: false, error: 'unexpected: ' + msg.type };
        });
      }
    });
    await collectToReview(chrome);
    verify = true;
    await chrome.panelSend({ type: 'START_DELIVER', jobIds: ['J1'] });
    await waitFor(() => chrome.runtime._runtimeMessages.some(m => m.type === 'VERIFY_REQUIRED'), 5000);
    assert.ok(chrome.runtime._runtimeMessages.some(m => m.type === 'LOG' && /安全验证/.test(m.text)), '应有验证告警日志');
    await new Promise(r => setTimeout(r, 100));
    assert.strictEqual(openJdCount, 0, '暂停期间不应继续操作');
    let sent = await chrome.storage.local.get('sentContacts');
    assert.strictEqual(Object.keys(sent.sentContacts || {}).length, 0, '验证期间不应投出');
    verify = false;
    await chrome.panelSend({ type: 'RESUME' });
    await deliverToDone(chrome);
    sent = await chrome.storage.local.get('sentContacts');
    assert.strictEqual(Object.keys(sent.sentContacts || {}).length, 1, '验证完成继续后应投出');
  });

  t('连续失败熔断：达到阈值自动收尾，成功一次清零（回归）', async () => {
    const jobs = [];
    for (let i = 1; i <= 11; i++) jobs.push({ id: 'J' + i, name: '岗位' + i, salary: '10-15K', company: '公司' + i + '科技有限公司', tags: [], area: '北京·朝阳区', activeState: 'online', inviteCount: 1 });
    const llm = [];
    jobs.forEach(() => llm.push(MATCH_JSON));
    jobs.forEach(() => llm.push(GREETING));
    let sendCount = 0;
    const { chrome } = setup({
      jobs: jobs, llm: llm,
      setupChrome: (c) => {
        c.tabs._setContentHandler((tabId, msg) => {
          if (msg.type === 'PING') return { success: true, alive: true };
          if (msg.type === 'SCRAPE') return { success: true, jobs: jobs };
          if (msg.type === 'OPEN_JD') return { success: true, jd: 'JD', hrName: '王女士', addr: '', fundText: '' };
          if (msg.type === 'GO_CHAT') return { success: true, navigated: true };
          if (msg.type === 'SEND_ACTIVE') { sendCount++; return sendCount === 5 ? { success: true, imageOk: true } : { success: false, error: '发送失败' }; }
          return { success: false, error: 'unexpected: ' + msg.type };
        });
      }
    });
    await collectToReview(chrome);
    await chrome.panelSend({ type: 'START_DELIVER', jobIds: jobs.map(j => j.id) });
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, 15000);
    const g = await chrome.panelSend({ type: 'GET_STATS' });
    assert.strictEqual(g.today.ok, 1, '第 5 个成功');
    assert.strictEqual(g.today.fail, 9, '4 连败 → 成功清零 → 再 5 连败熔断，剩余不再投');
    const phases = chrome.runtime._runtimeMessages.filter(m => m.type === 'PHASE');
    assert.strictEqual(phases[phases.length - 1].reason, 'failstreak', '应以 failstreak 收尾');
    assert.ok(chrome.runtime._runtimeMessages.some(m => m.type === 'LOG' && /熔断/.test(m.text)), '应有熔断日志');
  });

  t('熔断阈值可配置：riskConfig.maxConsecFail=2 → 2 连败即熔断', async () => {
    const jobs = [];
    for (let i = 1; i <= 3; i++) jobs.push({ id: 'J' + i, name: '岗位' + i, salary: '10-15K', company: '公司' + i + '科技有限公司', tags: [], area: '北京·朝阳区', activeState: 'online', inviteCount: 1 });
    const llm = [MATCH_JSON, MATCH_JSON, MATCH_JSON, GREETING, GREETING];
    const { chrome } = setup({
      jobs: jobs, llm: llm,
      cfg: Object.assign(baseCfg({}), { riskConfig: { verifyDetect: true, maxConsecFail: 2 } }),
      setupChrome: (c) => {
        c.tabs._setContentHandler((tabId, msg) => {
          if (msg.type === 'PING') return { success: true, alive: true };
          if (msg.type === 'SCRAPE') return { success: true, jobs: jobs };
          if (msg.type === 'OPEN_JD') return { success: true, jd: 'JD', hrName: '王女士', addr: '', fundText: '' };
          if (msg.type === 'GO_CHAT') return { success: true, navigated: true };
          if (msg.type === 'SEND_ACTIVE') return { success: false, error: '发送失败' };
          return { success: false, error: 'unexpected: ' + msg.type };
        });
      }
    });
    await collectToReview(chrome);
    await chrome.panelSend({ type: 'START_DELIVER', jobIds: jobs.map(j => j.id) });
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, 15000);
    const g = await chrome.panelSend({ type: 'GET_STATS' });
    assert.strictEqual(g.today.fail, 2, '第 2 个失败后即收工，第 3 个不再投');
    const phases = chrome.runtime._runtimeMessages.filter(m => m.type === 'PHASE');
    assert.strictEqual(phases[phases.length - 1].reason, 'failstreak');
  });

  t('验证页检测关闭：verifyDetect=false 时不暂停、正常投出', async () => {
    let verify = true;
    const { chrome } = setup({
      llm: [MATCH_JSON, GREETING],
      cfg: Object.assign(baseCfg({}), { riskConfig: { verifyDetect: false, maxConsecFail: 5 } }),
      setupChrome: (c) => {
        c.tabs.get = (id, cb) => setImmediate(() => cb({
          id, status: 'complete',
          url: verify ? 'https://www.zhipin.com/web/common/security-check.html?seed=1' : 'https://www.zhipin.com/web/geek/chat/1001'
        }));
        c.tabs._setContentHandler((tabId, msg) => {
          if (msg.type === 'PING') return { success: true, alive: true };
          if (msg.type === 'SCRAPE') return { success: true, jobs: JOBS1 };
          if (msg.type === 'OPEN_JD') return { success: true, jd: 'JD', hrName: '王女士', addr: '', fundText: '' };
          if (msg.type === 'GO_CHAT') { verify = false; return { success: true, navigated: true }; }
          if (msg.type === 'SEND_ACTIVE') return { success: true, imageOk: true };
          return { success: false, error: 'unexpected: ' + msg.type };
        });
      }
    });
    await collectToReview(chrome);
    await deliverToDone(chrome);
    assert.ok(!chrome.runtime._runtimeMessages.some(m => m.type === 'VERIFY_REQUIRED'), '关闭检测后不应触发验证暂停');
    const sent = await chrome.storage.local.get('sentContacts');
    assert.strictEqual(Object.keys(sent.sentContacts || {}).length, 1, '应正常投出');
  });

  t('⑩ 域名授权：保存自定义端点时调用 permissions.request 请求该域名', async () => {
    const requested = [];
    const granted = {};
    const chrome = makeChrome();
    chrome.permissions = {
      contains: async (o) => !!granted[o.origins[0]],
      request: async (o) => { requested.push(o.origins); granted[o.origins[0]] = true; return true; }
    };
    const env = loadSidepanelLite(chrome);
    await waitFor(() => chrome._storageData.get('presetMigrated') === true || true);
    env.registry.apiBaseUrl.value = 'https://my-ai.example/v1/chat/completions';
    env.registry.apiModel.value = 'my-model';
    env.registry.apiKey.value = 'sk-x';
    env.registry.saveCfg.click();
    await waitFor(() => requested.length > 0, 3000);
    // vm 沙箱里的数组与外层 realm 原型不同，deepStrictEqual 会误判，用 JSON 比较
    assert.strictEqual(JSON.stringify(requested[0]), JSON.stringify(['https://my-ai.example/*']), '应请求自定义端点域名');
  });

  t('⑩ 开始收集：自定义端点先申请域名授权（回归）', async () => {
    const requested = [];
    const chrome = makeChrome();
    chrome.permissions = {
      contains: async () => false,
      request: async (o) => { requested.push(o.origins[0]); return true; }
    };
    const env = loadSidepanelLite(chrome);
    env.registry.apiBaseUrl.value = 'https://my-ai.example/v1/chat/completions';
    env.registry.apiModel.value = 'my-model';
    env.registry.apiKey.value = 'sk-x';
    env.registry.keyword.value = '数据分析';
    env.registry.btnCollect.click();
    await waitFor(() => requested.length > 0, 3000);
    assert.strictEqual(requested[0], 'https://my-ai.example/*', '开始收集前应申请端点域名');
  });

  t('⑩ 域名授权：已授权域名不再重复 request', async () => {
    let requestCalls = 0;
    const chrome = makeChrome();
    chrome.permissions = {
      contains: async () => true,
      request: async () => { requestCalls++; return true; }
    };
    const env = loadSidepanelLite(chrome);
    env.registry.saveCfg.click();
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(requestCalls, 0, '已授权不应重复请求');
  });

  t('网络异常报错：callLLM 抛 TypeError → 岗位标为不匹配且提示重新授权', async () => {
    const { chrome } = setup({ fetch: throwingFetch() });
    const resp = await chrome.panelSend({ type: 'START_COLLECT' });
    assert.ok(resp && resp.ok);
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'review'; }, 8000);
    const s = await chrome.panelSend({ type: 'GET_STATE' });
    assert.strictEqual(s.screened.length, 1);
    assert.strictEqual(s.screened[0].match, false);
    assert.ok(/无法连接接口/.test(s.screened[0].reason), '应含友好报错：' + s.screened[0].reason);
    assert.ok(/保存设置/.test(s.screened[0].reason), '应提示重新授权');
  });

  t('amap geocode：粗粒度 level（村庄/省/市/区县）视为解析失败 → 放行', async () => {
    const { makeChrome: mk, loadSW: lsw } = require('./helpers');
    const responses = [
      { status: '1', geocodes: [{ location: '108.9,26.5', level: '村庄' }] } // 模糊命中贵州某村庄
    ];
    const fetchMock = async () => ({ ok: true, status: 200, json: async () => responses.shift() || { status: '0' } });
    const chrome = mk({ contentHandler: () => ({ success: true }) });
    const ctx = lsw(chrome, fetchMock);
    const job = { name: 'x', addr: '火星乌托邦大道99号' };
    const r = await ctx.BPAmap.checkCommute(job, { key: 'k', origin: '北京市海淀区中关村', driveMaxKm: 1 });
    assert.strictEqual(r, '', '粗粒度匹配应放行');
    assert.ok(!job.commute, '不应挂 commute 数据');
  });

  t('amap geocode：精确 level（住宅区/兴趣点）正常计算', async () => {
    const { makeChrome: mk, loadSW: lsw } = require('./helpers');
    const calls = [];
    const fetchMock = async (url) => {
      calls.push(String(url));
      if (/geocode\/geo/.test(url)) return { ok: true, status: 200, json: async () => ({ status: '1', geocodes: [{ location: '116.32,39.98', level: '住宅区' }] }) };
      return { ok: true, status: 200, json: async () => ({ status: '1', results: [{ distance: '3000', duration: '600' }] }) };
    };
    const chrome = mk({ contentHandler: () => ({ success: true }) });
    const ctx = lsw(chrome, fetchMock);
    const job = { name: 'x', addr: '北京市朝阳区望京SOHO' };
    const r = await ctx.BPAmap.checkCommute(job, { key: 'k', origin: '北京市海淀区中关村', driveMaxKm: 1 });
    assert.ok(r && /驾车距离超/.test(r), '3km > 1km 应剔除');
    assert.ok(job.commute && job.commute.driveKm === 3, 'commute 应挂回');
    assert.strictEqual(calls.filter(u => /geocode\/geo/.test(u)).length, 2, '住址+公司各 geocode 一次');
    // 同地址第二次调用命中内存缓存，不再发请求
    const job2 = { name: 'x', addr: '北京市朝阳区望京SOHO' };
    await ctx.BPAmap.checkCommute(job2, { key: 'k', origin: '北京市海淀区中关村', driveMaxKm: 1 });
    assert.strictEqual(calls.filter(u => /geocode\/geo/.test(u)).length, 2, '缓存命中不再发请求');
  });

  t('amap distance：失败结果不缓存，同路线下次会重试（回归）', async () => {
    const { makeChrome: mk, loadSW: lsw } = require('./helpers');
    let distCalls = 0;
    const fetchMock = async (url) => {
      if (/geocode\/geo/.test(url)) return { ok: true, status: 200, json: async () => ({ status: '1', geocodes: [{ location: '116.32,39.98', level: '住宅区' }] }) };
      distCalls++;
      throw new Error('network down');
    };
    const chrome = mk({ contentHandler: () => ({ success: true }) });
    const ctx = lsw(chrome, fetchMock);
    const cfg = { key: 'k', origin: '北京市海淀区中关村', driveMaxKm: 1 };
    const r1 = await ctx.BPAmap.checkCommute({ addr: '北京市朝阳区望京SOHO' }, cfg);
    assert.strictEqual(r1, '', '距离取不到时放行不误伤');
    assert.strictEqual(distCalls, 2, '第一次应尝试驾车+步行');
    const r2 = await ctx.BPAmap.checkCommute({ addr: '北京市朝阳区望京SOHO' }, cfg);
    assert.strictEqual(r2, '');
    assert.strictEqual(distCalls, 4, '失败不缓存，第二次应重试驾车+步行');
  });

  t('工作时段：开启且当前不在时段 → 不投递并 reason=hours', async () => {
    const h = new Date().getHours();
    const cfg = Object.assign(baseCfg({}), { paceConfig: { workHours: { enabled: true, start: (h + 2) % 24, end: (h + 3) % 24 } } });
    const { chrome, fetch } = setup({ cfg });
    await collectToReview(chrome);
    const callsAfterCollect = fetch._calls.length;
    await chrome.panelSend({ type: 'START_DELIVER', jobIds: ['J1'] });
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, 8000);
    assert.strictEqual(fetch._calls.length, callsAfterCollect, '不在时段不应产生招呼语调用');
    const phases = chrome.runtime._runtimeMessages.filter(m => m.type === 'PHASE');
    assert.strictEqual(phases[phases.length - 1].reason, 'hours', '应以 hours 收尾');
    assert.ok(chrome.runtime._runtimeMessages.some(m => m.type === 'LOG' && /不在工作时段/.test(m.text)), '应有工作时段日志');
    const sent = await chrome.storage.local.get('sentContacts');
    assert.strictEqual(Object.keys(sent.sentContacts || {}).length, 0, '不在时段不应投出');
  });

  t('工作时段：开启且当前在时段 → 正常投出', async () => {
    const h = new Date().getHours();
    const cfg = Object.assign(baseCfg({}), { paceConfig: { workHours: { enabled: true, start: h, end: (h + 1) % 24 } } });
    const { chrome } = setup({ cfg });
    await collectToReview(chrome);
    await deliverToDone(chrome);
    const sent = await chrome.storage.local.get('sentContacts');
    assert.strictEqual(Object.keys(sent.sentContacts || {}).length, 1, '在时段内应正常投出');
  });

  t('标签页：新建专用页并复用，不劫持用户已有 BOSS 页（回归）', async () => {
    let createCount = 0, queryCount = 0;
    const { chrome } = setup({
      llm: [MATCH_JSON, GREETING],
      setupChrome: (c) => {
        const origCreate = c.tabs.create, origQuery = c.tabs.query;
        c.tabs.create = (t, cb) => { createCount++; return origCreate.call(c.tabs, t, cb); };
        c.tabs.query = (q, cb) => { queryCount++; return origQuery.call(c.tabs, q, cb); };
      }
    });
    await collectToReview(chrome);
    await deliverToDone(chrome);
    assert.strictEqual(queryCount, 0, '不应查询整站已有标签页');
    assert.strictEqual(createCount, 1, '整个流程应只新建一个专用标签页');
  });

  t('限流 429 自动重试：退避后成功，不误判为不匹配（回归）', async () => {
    const { chrome, fetch } = setup({ llm: [429, MATCH_JSON] });
    const resp = await chrome.panelSend({ type: 'START_COLLECT' });
    assert.ok(resp && resp.ok);
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'review'; }, 8000);
    const s = await chrome.panelSend({ type: 'GET_STATE' });
    assert.strictEqual(s.screened[0].match, true, '429 重试后应匹配');
    assert.strictEqual(fetch._calls.length, 2, '应重试一次');
  });

  t('amap 超时：请求挂起时失败放行，不卡死投递（回归）', async () => {
    const { makeChrome: mk, loadSW: lsw } = require('./helpers');
    const hang = (url, init) => new Promise((resolve, reject) => {
      const sig = init && init.signal;
      if (sig) sig.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const chrome = mk({ contentHandler: () => ({ success: true }) });
    const ctx = lsw(chrome, hang);
    const r = await ctx.BPAmap.checkCommute({ addr: '北京市朝阳区望京SOHO' }, { key: 'k', origin: '北京市海淀区中关村', driveMaxKm: 1 });
    assert.strictEqual(r, '', '取不到距离应放行');
  });

  t('manifest：关键域名已声明 host_permissions（回归）', () => {
    const fs = require('fs'), path = require('path');
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
    const hp = m.host_permissions || [];
    for (const o of ['*://*.zhipin.com/*', 'https://api.deepseek.com/*', 'https://opencode.ai/*', 'https://open.bigmodel.cn/*', 'https://restapi.amap.com/*']) {
      assert.ok(hp.indexOf(o) >= 0, '缺少 host_permission: ' + o);
    }
  });

  t('专用标签页：SW 重启后从 storage.session 复用，不重复新建（回归）', async () => {
    const { makeChrome: mk, loadSW: lsw, makeFetchQueue: mfq } = require('./helpers');
    let createCount = 0, queryCount = 0;
    const chrome = mk({ contentHandler: () => ({ success: true }) });
    const origCreate = chrome.tabs.create, origQuery = chrome.tabs.query;
    chrome.tabs.create = (t, cb) => { createCount++; return origCreate.call(chrome.tabs, t, cb); };
    chrome.tabs.query = (q, cb) => { queryCount++; return origQuery.call(chrome.tabs, q, cb); };
    const ctx1 = lsw(chrome, mfq([]));
    await ctx1.acquireTab('https://www.zhipin.com/web/geek/jobs?query=x');
    assert.strictEqual(createCount, 1, '首次应新建标签页');
    assert.strictEqual(chrome._sessionData.get('bossTabId'), 1, 'id 应写入 storage.session');
    // 模拟 SW 被回收后重启：全新实例，内存中的 bossTabId 为空
    const ctx2 = lsw(chrome, mfq([]));
    await ctx2.acquireTab('https://www.zhipin.com/web/geek/jobs?query=x');
    assert.strictEqual(createCount, 1, '重启后应复用 session 中的标签页');
    assert.strictEqual(queryCount, 0, '不应查询整站标签页');
  });

  t('接口超时：callLLM 卡死时按超时抛错，不永久挂起（回归）', async () => {
    // 永不 resolve 的 fetch，仅在 signal abort 时 reject
    const hang = (url, init) => new Promise((resolve, reject) => {
      const sig = init && init.signal;
      if (sig) sig.addEventListener('abort', () => reject(new Error('aborted')));
    });
    hang._calls = [];
    const { chrome } = setup({ fetch: hang });
    const resp = await chrome.panelSend({ type: 'START_COLLECT' });
    assert.ok(resp && resp.ok);
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'review'; }, 8000);
    const s = await chrome.panelSend({ type: 'GET_STATE' });
    assert.strictEqual(s.screened.length, 1);
    assert.ok(/接口超时/.test(s.screened[0].reason), '应报超时：' + s.screened[0].reason);
  });
});

// buildList 的追加版本（供慢渲染测试用）
function buildListAdd(dom, spec) {
  const li = dom.makeEl('li', 'job-card-box');
  const a = dom.makeEl('a', '', '', { href: 'https://www.zhipin.com/job_detail/' + spec.id + '.html?ka=1' });
  a.offsetParent = {};
  a.appendChild(dom.makeEl('span', 'job-name', spec.name));
  const areaWrap = dom.makeEl('span', 'job-area-wrapper');
  areaWrap.appendChild(dom.makeEl('span', 'job-area', spec.area));
  a.appendChild(areaWrap);
  li.appendChild(a);
  const footer = dom.makeEl('div', 'job-card-footer');
  const cinfo = dom.makeEl('div', 'company-info');
  cinfo.appendChild(dom.makeEl('a', 'company-name', spec.company));
  footer.appendChild(cinfo);
  li.appendChild(footer);
  li.offsetParent = {};
  dom.body.querySelector('.job-list-box').appendChild(li);
  return li;
}

// buildList 内部追加（避免重复创建 list）
function buildList(dom, specs) {
  let list = dom.body.querySelector('.job-list-box');
  if (!list) list = buildListCreate(dom);
  specs.forEach(s => buildListAdd(dom, s));
  return list;
}
function buildListCreate(dom) {
  const list = dom.makeEl('div', 'job-list-box');
  dom.body.appendChild(list);
  return list;
}

// 简化 sidepanel 载入（同 test-upgrade 的 lite 版，另带 registry 导出）
function loadSidepanelLite(chrome) {
  const stub = () => ({ style: {}, classList: { add() {}, remove() {} }, addEventListener(type, fn) { this._h = this._h || {}; (this._h[type] = this._h[type] || []).push(fn); }, click() { (this._h && this._h.click || []).forEach(f => f()); }, value: '', textContent: '', innerHTML: '', checked: false, dataset: {}, appendChild() {}, scrollTop: 0, scrollHeight: 0 });
  const ids = ['presetSelect', 'apiBaseUrl', 'apiModel', 'apiKey', 'resumeImg', 'resumeText', 'greetingTemplate', 'keyword', 'city', 'count', 'appVersion', 'imgPrev', 'saved', 'btnRestorePreset', 'saveCfg', 'blackList', 'whiteList', 'salMin', 'salMax', 'fCities', 'fAddrEx', 'actOnline', 'actWeek', 'actMonth', 'inviteMax', 'kwMode', 'fKeywords', 'skipUsdFund', 'fundMin', 'commuteOn', 'commuteKey', 'commuteOrigin', 'driveMaxKm', 'driveMaxMin', 'walkMaxKm', 'walkMaxMin', 'btnSaveFilter', 'filterSaved', 'btnDryRun', 'btnCollect', 'btnDeliver', 'btnPause', 'btnStop', 'btnReset', 'clearLog', 'selAll', 'log', 'reviewCard', 'reviewCount', 'reviewList', 'companiesCount', 'companiesList', 'btnClearCompanies', 'btnExportCompanies', 'btnImportCompanies', 'importFileInput', 'btnSelfCheck', 'statToday', 'statWeek', 'statMonth', 'statTodayBadge', 'statGoalText', 'goalBar', 'statChart', 'ruleStats', 'monthlyGoal', 'btnSaveGoal', 'btnClearStats', 'maxPerRun', 'dailyGoal', 'pauseOnGoal', 'postRestText', 'preSendText', 'btnSavePace', 'paceSaved', 'phaseText', 'progText', 'progressBar', 'statusDot', 'headerStatus', 'logBody', 'riskVerify', 'riskMaxFail', 'cfgSub', 'filterSub', 'runSteps'];
  const registry = {};
  ids.forEach(id => registry[id] = stub());
  const doc = {
    registry,
    getElementById: id => registry[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {}, value: '' }),
    body: { insertBefore() {}, appendChild() {} },
    addEventListener() {}
  };
  chrome.runtime._setPanelListener(() => {});
  // 用真实 URL 构造器（endpointOrigin 依赖 new URL()），并补 createObjectURL 供导出用
  const URLShim = URL;
  URLShim.createObjectURL = () => 'blob:x';
  URLShim.revokeObjectURL = () => {};
  const ctx = {
    console, chrome, document: doc,
    setTimeout, clearTimeout, setInterval, clearInterval,
    confirm: () => true, FileReader: function () { this.readAsDataURL = () => {}; }, Blob: function () {}, URL: URLShim,
    __OPENCODE_API_KEY__: undefined
  };
  ctx.self = ctx; ctx.globalThis = ctx; ctx.window = ctx;
  const fs = require('fs');
  const path = require('path');
  vm.createContext(ctx);
  vm.runInContext(readSrc('filters.js'), ctx, { filename: 'filters.js' });
  const secretsPath = path.join(__dirname, '..', 'src', 'secrets.js');
  if (fs.existsSync(secretsPath)) vm.runInContext(fs.readFileSync(secretsPath, 'utf8'), ctx, { filename: 'secrets.js' });
  vm.runInContext(readSrc('sidepanel.js'), ctx, { filename: 'sidepanel.js' });
  return { ctx, registry, doc };
}
