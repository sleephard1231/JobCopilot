// ===== 本轮升级新增能力测试：模板兜底/配额弹窗/高德通勤/规则统计/迁移链/filters 通勤规则 =====
'use strict';
const assert = require('assert');
const { define, makeChrome, loadSW, waitFor, readSrc } = require('./helpers');

const MATCH_JSON = '{"match":true,"reason":"方向匹配"}';
const GREETING = '您好，熟悉SQL，做过数据分析，期待沟通。';
const JOBS1 = [{ id: 'J1', name: '数据分析师', salary: '10-15K', company: '阿里科技有限公司', tags: ['SQL'], area: '北京·朝阳区', activeState: 'online', inviteCount: 10 }];

function baseCfg(extraFilter) {
  return {
    apiBaseUrl: 'https://api.test/v1/chat/completions', apiKey: 'sk-test', apiModel: 'test-model',
    resumeText: '熟练 SQL，3 年数据分析经验', keyword: '数据分析', city: '北京', count: '1',
    filterConfig: Object.assign({ listMode: 'off', blacklist: [], whitelist: [] }, extraFilter || {})
  };
}

// 万能 fetch mock：LLM 请求返回 scripted LLM 响应队列；高德请求走 amapQueue
function makeMockFetch(opts) {
  opts = opts || {};
  const llmQueue = (opts.llm || []).slice();
  const amapQueue = (opts.amap || []).slice();
  const calls = [];
  const fn = async (url, init) => {
    calls.push(init && init.body ? JSON.parse(init.body) : String(url));
    if (/restapi\.amap\.com/.test(String(url))) {
      if (!amapQueue.length) throw new Error('amap queue empty');
      return { ok: true, status: 200, json: async () => amapQueue.shift() };
    }
    if (!llmQueue.length) throw new Error('fetch queue empty（调用次数超出脚本预期）');
    const body = llmQueue.shift();
    if (typeof body === 'number') return { ok: false, status: body, text: async () => 'boom', json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: body } }] }) };
  };
  fn._calls = calls;
  return fn;
}

function setup(opts) {
  opts = opts || {};
  const chrome = makeChrome({
    chatUrl: 'https://www.zhipin.com/web/geek/chat/1001',
    contentHandler: (tabId, msg) => {
      if (msg.type === 'PING') return { success: true, alive: true };
      if (msg.type === 'SCRAPE') return { success: true, jobs: JSON.parse(JSON.stringify(opts.jobs || JOBS1)) };
      if (msg.type === 'OPEN_JD') return Object.assign({ success: true, jd: 'JD', hrName: '王女士', addr: '北京市海淀区中关村', fundText: '' }, opts.openJd || {});
      if (msg.type === 'GO_CHAT') return opts.goChat || { success: true, navigated: true };
      if (msg.type === 'SEND_ACTIVE') { opts.sent = opts.sent || []; opts.sent.push(msg.greeting); return { success: true, imageOk: true }; }
      return { success: false, error: 'unexpected: ' + msg.type };
    }
  });
  // 未显式给 cfg 时播种默认配置（收集前置校验需要端点/关键词/简历）
  const effCfg = opts.cfg || baseCfg({});
  for (const k of Object.keys(effCfg)) chrome._storageData.set(k, JSON.parse(JSON.stringify(effCfg[k])));
  const fetch_ = opts.fetch || makeMockFetch(opts);
  loadSW(chrome, fetch_);
  return { chrome, fetch: fetch_ };
}

async function collectToReview(chrome) {
  const resp = await chrome.panelSend({ type: 'START_COLLECT' });
  assert.ok(resp && resp.ok);
  await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'review'; }, 8000);
}

async function deliverToDone(chrome, jobIds) {
  await chrome.panelSend({ type: 'START_DELIVER', jobIds: jobIds || ['J1'] });
  await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, 10000);
}

define('升级新能力', t => {

  t('⑨ 配额弹窗：GO_CHAT 返回 quota → 不建联不发送，按"平台额度"收尾', async () => {
    const { chrome, fetch } = setup({ llm: [MATCH_JSON, GREETING], goChat: { success: false, quota: true, error: '平台提示：今日沟通名额已用完' } });
    await collectToReview(chrome);
    const callsAfterCollect = fetch._calls.length;
    await deliverToDone(chrome);
    assert.strictEqual(fetch._calls.length, callsAfterCollect + 1, '招呼语在建联前生成（1 次），配额中断后不再有其他调用');
    const phases = chrome.runtime._runtimeMessages.filter(m => m.type === 'PHASE');
    assert.strictEqual(phases[phases.length - 1].reason, 'limit', '收尾 reason=limit');
    assert.ok(chrome.runtime._runtimeMessages.some(m => m.type === 'LOG' && /名额已用完/.test(m.text)), '应有额度日志');
    const sent = await chrome.storage.local.get('sentContacts');
    assert.strictEqual(Object.keys(sent.sentContacts || {}).length, 0, '不记录联系人');
    const g = await chrome.panelSend({ type: 'GET_STATS' });
    assert.strictEqual(g.today.skip, 1, '计为 skip');
  });

  t('⑥ 模板兜底：AI 返回空时按模板渲染并成功投递', async () => {
    const cfg = baseCfg({});
    cfg.greetingTemplate = '您好，看到贵司{{岗位}}（{{薪资}}），我有{{技能}}相关经验，期待沟通！';
    const { chrome, fetch } = setup({ cfg: cfg, llm: [MATCH_JSON, ''] });
    await collectToReview(chrome);
    await deliverToDone(chrome);
    const sent = await chrome.storage.local.get('sentContacts');
    assert.strictEqual(Object.keys(sent.sentContacts || {}).length, 1, '模板兜底后投递成功');
    assert.ok(chrome.runtime._runtimeMessages.some(m => m.type === 'LOG' && /模板/.test(m.text)), '应有模板兜底日志');
    assert.strictEqual(fetch._calls.length, 2, '筛选 1 次 + 招呼语 1 次（AI 空响应）');
  });

  t('⑥ 无模板且 AI 失败 → 投递失败（保持原行为）', async () => {
    const { chrome } = setup({ llm: [MATCH_JSON, ''] });
    await collectToReview(chrome);
    await deliverToDone(chrome);
    const sent = await chrome.storage.local.get('sentContacts');
    assert.strictEqual(Object.keys(sent.sentContacts || {}).length, 0, '无兜底时失败');
    const g = await chrome.panelSend({ type: 'GET_STATS' });
    assert.strictEqual(g.today.fail, 1);
  });

  t('⑥ 模板变量渲染：岗位/公司/薪资/技能/HR 替换、未识别变量清除', async () => {
    const cfg = baseCfg({});
    cfg.greetingTemplate = '{{岗位}}@{{公司}} {{薪资}} {{技能}} {{不存在}} {{HR}}';
    const opts = { cfg: cfg, llm: [MATCH_JSON, ''] }; // 招呼语走模板，AI 返回空
    const { chrome } = setup(opts);
    await collectToReview(chrome);
    await deliverToDone(chrome);
    assert.ok(opts.sent && opts.sent.length === 1, '应发送 1 条招呼语');
    const g = opts.sent[0];
    assert.ok(/数据分析师@阿里科技有限公司/.test(g), '岗位@公司 已替换：' + g);
    assert.ok(g.indexOf('10-15K') >= 0, '薪资已替换');
    assert.ok(g.indexOf('SQL') >= 0, '技能已替换');
    assert.ok(g.indexOf('王') >= 0, 'HR 已替换');
    assert.ok(g.indexOf('{{') < 0, '未识别变量被清除');
  });

  t('④ 高德通勤：驾车超限岗位投递期被拦截并计入规则统计', async () => {
    const cfg = baseCfg({
      commute: { enabled: true, key: 'amap-key', origin: '北京市海淀区西二旗', driveMaxKm: 5, driveMaxMin: 0, walkMaxKm: 0, walkMaxMin: 0 }
    });
    const amap = [
      { status: '1', geocodes: [{ location: '116.30,39.90' }] },  // 住址 geocode
      { status: '1', geocodes: [{ location: '116.50,40.10' }] },  // 公司 geocode
      { status: '1', results: [{ distance: '30000', duration: '3600' }] }, // 驾车 30km/60min
      { status: '1', results: [{ distance: '30000', duration: '21600' }] }  // 步行 30km/360min
    ];
    const { chrome, fetch } = setup({ cfg: cfg, fetch: makeMockFetch({ amap: amap, llm: [MATCH_JSON, GREETING] }) });
    await collectToReview(chrome);
    await deliverToDone(chrome);
    assert.ok(chrome.runtime._runtimeMessages.some(m => m.type === 'LOG' && /驾车距离超/.test(m.text)), '应有通勤拦截日志');
    const g = await chrome.panelSend({ type: 'GET_STATS' });
    assert.strictEqual(g.today.skip, 1);
    const rs = await chrome.storage.local.get('ruleStats');
    assert.ok(rs.ruleStats['通勤距离'] >= 1, '规则统计应含 通勤距离');
    const sent = await chrome.storage.local.get('sentContacts');
    assert.strictEqual(Object.keys(sent.sentContacts || {}).length, 0, '拦截不记录联系人');
  });

  t('⑪ 通勤使用详情页工作地址 job.addr，而非卡片区域（回归）', async () => {
    const cfg = baseCfg({
      commute: { enabled: true, key: 'amap-key', origin: '北京市海淀区中关村', driveMaxKm: 5, driveMaxMin: 0, walkMaxKm: 0, walkMaxMin: 0 }
    });
    const amap = [
      { status: '1', geocodes: [{ location: '116.30,39.90' }] },
      { status: '1', geocodes: [{ location: '116.50,40.10' }] },
      { status: '1', results: [{ distance: '30000', duration: '3600' }] },
      { status: '1', results: [{ distance: '30000', duration: '21600' }] }
    ];
    const { chrome, fetch } = setup({
      cfg: cfg,
      fetch: makeMockFetch({ amap: amap, llm: [MATCH_JSON, GREETING] }),
      openJd: { addr: '工作地址：北京市大兴区亦庄经济开发区' }
    });
    await collectToReview(chrome);
    await deliverToDone(chrome);
    const urls = fetch._calls.filter(c => typeof c === 'string').map(decodeURIComponent);
    assert.ok(urls.some(u => u.indexOf('大兴区亦庄') >= 0), '公司 geocode 应使用详情页工作地址');
    assert.ok(!urls.some(u => u.indexOf('朝阳区') >= 0), '不应再用卡片上的粗略区域');
  });

  t('④ 高德通勤：未启用时不发任何高德请求、岗位正常投出', async () => {
    const { chrome, fetch } = setup({ llm: [MATCH_JSON, GREETING] });
    await collectToReview(chrome);
    await deliverToDone(chrome);
    const sent = await chrome.storage.local.get('sentContacts');
    assert.strictEqual(Object.keys(sent.sentContacts || {}).length, 1, '正常投出');
    assert.strictEqual(fetch._calls.length, 2, '仅筛选+招呼语，无高德请求');
  });

  t('⑦ 规则统计：黑名单剔除计入 ruleStats 且 GET_STATS 返回 TOP 列表', async () => {
    const jobs = [
      JOBS1[0],
      { id: 'J2', name: '销售', salary: '5-8K', company: '字节跳动网络科技', tags: [], area: '北京', activeState: 'week', inviteCount: 20 }
    ];
    const cfg = baseCfg({ listMode: 'black', blacklist: [{ name: '字节跳动', mode: 'keyword' }] });
    const { chrome, fetch } = setup({ jobs: jobs, cfg: cfg, llm: [MATCH_JSON] });
    await collectToReview(chrome);
    await waitFor(() => chrome._storageData.has('ruleStats'));
    const g = await chrome.panelSend({ type: 'GET_STATS' });
    assert.ok(g.ok && Array.isArray(g.rules), 'GET_STATS 应返回 rules 数组');
    const blk = g.rules.find(r => /黑名单/.test(r.rule));
    assert.ok(blk && blk.count >= 1, '黑名单计数 ≥ 1');
    assert.strictEqual(fetch._calls.length, 1, '黑名单岗位不进 AI，仅 J1 一次筛选');
  });

  t('⑦ CLEAR_STATS 同时清空规则统计', async () => {
    const cfg = baseCfg({ listMode: 'black', blacklist: [{ name: '字节跳动', mode: 'keyword' }] });
    const jobs = [JOBS1[0], { id: 'J2', name: '销售', salary: '5-8K', company: '字节跳动网络科技', tags: [], area: '北京', activeState: 'week', inviteCount: 20 }];
    const { chrome } = setup({ jobs: jobs, cfg: cfg, llm: [MATCH_JSON] });
    await collectToReview(chrome);
    await waitFor(() => chrome._storageData.has('ruleStats'));
    await chrome.panelSend({ type: 'CLEAR_STATS' });
    const d = await chrome.storage.local.get('ruleStats');
    assert.deepStrictEqual(d.ruleStats, {}, '规则统计已清空');
  });

  t('filters.checkCommute：纯同步判定（预计算数据超限/放行/未启用）', () => {
    const module_ = { exports: {} };
    const fn = new Function('module', 'exports', 'self', 'window', readSrc('filters.js'));
    fn(module_, module_.exports, globalThis, globalThis);
    const F = module_.exports;
    const cfg = { commute: { enabled: true, driveMaxKm: 10, driveMaxMin: 45 } };
    assert.ok(F.checkCommute({ commute: { driveKm: 12, driveMin: 40 } }, cfg).indexOf('驾车距离超') === 0, '超距离剔除');
    assert.strictEqual(F.checkCommute({ commute: { driveKm: 8, driveMin: 50 } }, cfg).indexOf('驾车时间超') === 0, true, '超时间剔除');
    assert.strictEqual(F.checkCommute({ commute: { driveKm: 8, driveMin: 40 } }, cfg), '', '范围内放行');
    assert.strictEqual(F.checkCommute({}, cfg), '', '无预计算数据放行');
    assert.strictEqual(F.checkCommute({ commute: { driveKm: 99 } }, { commute: { enabled: false, driveMaxKm: 1 } }), '', '未启用放行');
  });

  t('⑧ 迁移链：旧 DeepSeek 配置升级 + migrations 标记 + 二次加载不重复执行', async () => {
    const chrome = makeChrome();
    chrome._storageData.set('apiBaseUrl', 'https://api.deepseek.com/v1/chat/completions');
    chrome._storageData.set('apiModel', 'deepseek-chat');
    chrome._storageData.set('apiKey', 'sk-old-invalid-key-8671-8671');
    loadSidepanelLite(chrome);
    await waitFor(() => chrome._storageData.get('presetMigrated') === true, 5000);
    let d = await chrome.storage.local.get(['apiBaseUrl', 'migrations']);
    assert.strictEqual(d.apiBaseUrl, 'https://opencode.ai/zen/go/v1/chat/completions');
    assert.ok(d.migrations && d.migrations['legacy-dskey-to-preset'], '迁移标记已写入');
    // 二次加载：gate（presetMigrated=true）拦截，用户配置不被覆盖
    loadSidepanelLite(chrome);
    await new Promise(r => setTimeout(r, 50));
    d = await chrome.storage.local.get('apiModel');
    assert.strictEqual(d.apiModel, 'deepseek-v4-flash');
  });
});

// 简化版 sidepanel 上下文（只跑迁移逻辑，不需要完整 UI）
function loadSidepanelLite(chrome) {
  const stub = () => ({ style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, value: '', textContent: '', innerHTML: '', checked: false, dataset: {}, appendChild() {}, scrollTop: 0, scrollHeight: 0 });
  const ids = ['presetSelect', 'apiBaseUrl', 'apiModel', 'apiKey', 'resumeImg', 'resumeText', 'greetingTemplate', 'keyword', 'city', 'count', 'appVersion', 'imgPrev', 'saved', 'btnRestorePreset', 'saveCfg', 'btnSelfCheck', 'blackList', 'whiteList', 'salMin', 'salMax', 'fCities', 'fAddrEx', 'actOnline', 'actWeek', 'actMonth', 'inviteMax', 'kwMode', 'fKeywords', 'skipUsdFund', 'fundMin', 'commuteOn', 'commuteKey', 'commuteOrigin', 'driveMaxKm', 'driveMaxMin', 'walkMaxKm', 'walkMaxMin', 'btnSaveFilter', 'filterSaved', 'btnDryRun', 'btnCollect', 'btnDeliver', 'btnPause', 'btnStop', 'btnReset', 'clearLog', 'selAll', 'log', 'reviewCard', 'reviewCount', 'reviewList', 'companiesCount', 'companiesList', 'btnClearCompanies', 'btnExportCompanies', 'btnImportCompanies', 'importFileInput', 'statToday', 'statWeek', 'statMonth', 'statTodayBadge', 'statGoalText', 'goalBar', 'statChart', 'ruleStats', 'monthlyGoal', 'btnSaveGoal', 'btnClearStats', 'maxPerRun', 'dailyGoal', 'pauseOnGoal', 'postRestText', 'preSendText', 'btnSavePace', 'paceSaved', 'phaseText', 'progText', 'progressBar', 'statusDot', 'headerStatus', 'logBody', 'deadBanner', 'riskVerify', 'riskMaxFail', 'cfgSub', 'filterSub', 'runSteps'];
  const registry = {};
  ids.forEach(id => registry[id] = stub());
  const doc = {
    registry,
    getElementById: id => registry[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => stub(),
    body: Object.assign(stub(), { insertBefore() {} }),
    addEventListener() {}
  };
  const listeners = [];
  chrome.runtime._setPanelListener(m => listeners.push(m));
  const ctx = {
    console, chrome, document: doc,
    setTimeout, clearTimeout, setInterval, clearInterval,
    confirm: () => true, FileReader: function () {}, Blob: function () {}, URL: { createObjectURL: () => 'b', revokeObjectURL() {} },
    __OPENCODE_API_KEY__: undefined
  };
  ctx.self = ctx; ctx.globalThis = ctx; ctx.window = ctx;
  const vm = require('vm');
  const fs = require('fs');
  const path = require('path');
  vm.createContext(ctx);
  vm.runInContext(readSrc('filters.js'), ctx, { filename: 'filters.js' });
  const secretsPath = path.join(__dirname, '..', 'src', 'secrets.js');
  if (fs.existsSync(secretsPath)) vm.runInContext(fs.readFileSync(secretsPath, 'utf8'), ctx, { filename: 'secrets.js' });
  vm.runInContext(readSrc('sidepanel.js'), ctx, { filename: 'sidepanel.js' });
  return ctx;
}
