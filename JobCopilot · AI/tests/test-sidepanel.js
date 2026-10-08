// ===== sidepanel.js UI 逻辑测试（配置往返/保存/试算/审核渲染）=====
'use strict';
const assert = require('assert');
const vm = require('vm');
const { define, makeChrome, readSrc, waitFor } = require('./helpers');

function makeStubEl(extra) {
  const el = Object.assign({
    tagName: 'DIV', id: '', className: '', checked: false, disabled: false,
    innerHTML: '', textContent: '', style: {}, dataset: {}, scrollTop: 0, scrollHeight: 0,
    classList: { add() {}, remove() {}, contains: () => false },
    addEventListener(type, fn) { this._h = this._h || {}; (this._h[type] = this._h[type] || []).push(fn); },
    click() { (this._h && this._h.click || []).forEach(f => f()); },
    appendChild(c) { this._children = this._children || []; this._children.push(c); return c; },
    insertBefore(c) { this._inserted = this._inserted || []; this._inserted.push(c); return c; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    files: null
  }, {});
  let _value = '';
  Object.defineProperty(el, 'value', { get() { return _value; }, set(v) { _value = v == null ? '' : String(v); }, configurable: true });
  Object.assign(el, extra || {});
  return el;
}

function makePanelDoc(ids, selRegistry) {
  const registry = {};
  ids.forEach(id => { registry[id] = makeStubEl({ id }); });
  return {
    registry,
    getElementById: id => registry[id] || null,
    querySelector: sel => (selRegistry[sel] || [])[0] || null,
    querySelectorAll: sel => selRegistry[sel] || [],
    createElement: () => makeStubEl(),
    body: makeStubEl(),
    addEventListener() {}
  };
}

function loadSidepanel(chrome) {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidepanel.html'), 'utf8');
  const ids = [...new Set([...html.matchAll(/id="([\w-]+)"/g)].map(m => m[1]))];
  const selRegistry = {
    'input[name="listMode"]': [makeStubEl({ value: 'off' }), makeStubEl({ value: 'black' }), makeStubEl({ value: 'white' })],
    'input[name="listMode"]:checked': [],
    'input[name="jobHandle"]': [makeStubEl({ value: 'skip' }), makeStubEl({ value: 'collect' })],
    'input[name="jobHandle"]:checked': [],
    '.card-header[data-toggle]': [],
    '.job-item:not(.skip) input:checked': [],
    '.job-item:not(.skip) input': []
  };
  const doc = makePanelDoc(ids, selRegistry);
  const listeners = [];
  const panelMessages = [];
  chrome.runtime._setPanelListener(m => panelMessages.push(m));
  const ctx = {
    console, chrome, document: doc, BPFilters: undefined,
    setTimeout, clearTimeout, setInterval, clearInterval,
    confirm: () => true, alert: () => {}, FileReader: function () {}, Blob: function () {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }
  };
  ctx.self = ctx; ctx.globalThis = ctx; ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(readSrc('filters.js'), ctx, { filename: 'filters.js' });
  if (fs.existsSync(path.join(__dirname, '..', 'src', 'secrets.js'))) {
    vm.runInContext(readSrc('secrets.js'), ctx, { filename: 'secrets.js' });
  }
  vm.runInContext(readSrc('sidepanel.js'), ctx, { filename: 'sidepanel.js' });
  return { ctx, doc, selRegistry, panelMessages };
}

define('sidepanel.js 侧边栏逻辑', t => {

  t('加载：默认 API 端点/模型自动填充，空企业面板渲染', async () => {
    const chrome = makeChrome();
    const env = loadSidepanel(chrome);
    await waitFor(() => env.doc.registry.apiBaseUrl.value !== '');
    assert.strictEqual(env.doc.registry.apiBaseUrl.value, 'https://opencode.ai/zen/go/v1/chat/completions');
    assert.strictEqual(env.doc.registry.apiModel.value, 'deepseek-v4-flash');
    assert.strictEqual(env.doc.registry.appVersion.textContent, 'v9.9.9-test', '版本徽章应显示当前构建版本');
    assert.ok(env.doc.registry.companiesList.innerHTML.indexOf('暂无记录') >= 0);
    assert.strictEqual(env.doc.registry.companiesCount.textContent, '0');
  });

  t('collectFilterCfg：UI 值 → 结构化配置（@kw/数字/布尔）', async () => {
    const chrome = makeChrome();
    const env = loadSidepanel(chrome);
    await waitFor(() => env.doc.registry.apiBaseUrl.value !== '');
    const r = env.doc.registry;
    r.blackList.value = '某某科技\n字节跳动 @kw\n#注释行';
    r.whiteList.value = '目标公司 @kw';
    env.selRegistry['input[name="listMode"]:checked'] = [Object.assign(env.selRegistry['input[name="listMode"]'][1], { checked: true })];
    env.selRegistry['input[name="jobHandle"]:checked'] = [Object.assign(env.selRegistry['input[name="jobHandle"]'][1], { checked: true })];
    r.salMin.value = '8'; r.salMax.value = '30';
    r.fCities.value = '北京, 上海'; r.fAddrEx.value = '外派';
    r.actOnline.checked = true; r.actWeek.checked = false; r.actMonth.checked = false;
    r.inviteMax.value = '100';
    r.kwMode.value = 'exclude'; r.fKeywords.value = '销售, 前台';
    r.skipUsdFund.checked = true; r.fundMin.value = '50';
    const cfg = env.ctx.collectFilterCfg();
    assert.strictEqual(cfg.listMode, 'black');
    assert.strictEqual(JSON.stringify(cfg.blacklist), JSON.stringify([{ name: '某某科技', mode: 'exact' }, { name: '字节跳动', mode: 'keyword' }]));
    assert.strictEqual(JSON.stringify(cfg.whitelist), JSON.stringify([{ name: '目标公司', mode: 'keyword' }]));
    assert.strictEqual(JSON.stringify(cfg.salary), JSON.stringify({ min: 8, max: 30 }));
    assert.strictEqual(cfg.cities, '北京, 上海');
    assert.strictEqual(cfg.addrExclude, '外派');
    assert.strictEqual(JSON.stringify(cfg.active), JSON.stringify({ online: true, week: false, month: false }));
    assert.strictEqual(cfg.inviteMax, 100);
    assert.strictEqual(cfg.kwMode, 'exclude');
    assert.strictEqual(cfg.keywords, '销售, 前台');
    assert.strictEqual(cfg.skipUsdFund, true);
    assert.strictEqual(cfg.fundMin, 50);
    assert.strictEqual(cfg.jobHandle, 'collect');
  });

  t('applyFilterCfgToUI：结构化配置 → UI 回填（往返一致）', async () => {
    const chrome = makeChrome();
    const env = loadSidepanel(chrome);
    await waitFor(() => env.doc.registry.apiBaseUrl.value !== '');
    const cfg = {
      listMode: 'white', whitelist: [{ name: '目标公司', mode: 'keyword' }], blacklist: [],
      salary: { min: 10, max: 0 }, cities: '北京', addrExclude: '',
      active: { online: false, week: true, month: false },
      inviteMax: 0, kwMode: 'off', keywords: '', skipUsdFund: false, fundMin: 0, jobHandle: 'skip'
    };
    env.ctx.applyFilterCfgToUI(cfg);
    const r = env.doc.registry;
    const radios = env.selRegistry['input[name="listMode"]'];
    assert.ok(radios[2].checked && !radios[0].checked && !radios[1].checked, '白名单单选应点亮');
    assert.strictEqual(r.whiteList.value, '目标公司 @kw');
    assert.strictEqual(r.blackList.value, '');
    assert.strictEqual(r.salMin.value, '10');
    assert.strictEqual(r.salMax.value, '');
    assert.strictEqual(r.fCities.value, '北京');
    assert.strictEqual(r.actWeek.checked, true);
    assert.strictEqual(r.inviteMax.value, '');
    assert.strictEqual(env.selRegistry['input[name="jobHandle"]'][0].checked, true);
  });

  t('保存按钮：collectFilterCfg 持久化到 storage', async () => {
    const chrome = makeChrome();
    const env = loadSidepanel(chrome);
    await waitFor(() => env.doc.registry.apiBaseUrl.value !== '');
    env.doc.registry.blackList.value = '测试黑名单公司 @kw';
    env.selRegistry['input[name="listMode"]:checked'] = [Object.assign(env.selRegistry['input[name="listMode"]'][1], { checked: true })];
    env.doc.registry.btnSaveFilter.click();
    await waitFor(() => chrome._storageData.has('filterConfig'));
    const d = await chrome.storage.local.get('filterConfig');
    assert.strictEqual(d.filterConfig.listMode, 'black');
    assert.deepStrictEqual(d.filterConfig.blacklist, [{ name: '测试黑名单公司', mode: 'keyword' }]);
  });

  t('试算按钮：先存规则再发 RUN_FILTER_DRY', async () => {
    const chrome = makeChrome();
    const env = loadSidepanel(chrome);
    await waitFor(() => env.doc.registry.apiBaseUrl.value !== '');
    env.doc.registry.btnDryRun.click();
    await waitFor(() => chrome.runtime._runtimeMessages.some(m => m.type === 'RUN_FILTER_DRY'));
    const d = await chrome.storage.local.get('filterConfig');
    assert.ok(d.filterConfig, '试算前应先保存规则');
  });

  t('开始收集：先保存配置再发 START_COLLECT', async () => {
    const chrome = makeChrome();
    const env = loadSidepanel(chrome);
    await waitFor(() => env.doc.registry.apiBaseUrl.value !== '');
    const r = env.doc.registry;
    r.apiModel.value = 'deepseek-chat'; r.apiKey.value = 'sk-x'; r.keyword.value = '数据分析';
    r.btnCollect.click();
    await waitFor(() => chrome.runtime._runtimeMessages.some(m => m.type === 'START_COLLECT'));
    const d = await chrome.storage.local.get(['apiBaseUrl', 'apiKey', 'keyword']);
    assert.strictEqual(d.apiKey, 'sk-x');
    assert.strictEqual(d.keyword, '数据分析');
  });

  t('renderReview：匹配/规则剔除分区渲染', async () => {
    const chrome = makeChrome();
    const env = loadSidepanel(chrome);
    await waitFor(() => env.doc.registry.apiBaseUrl.value !== '');
    env.ctx.renderReview([
      { id: '1', name: '数据分析', company: 'A公司', salary: '10-15K', match: true, reason: '方向匹配' },
      { id: '2', name: '销售', company: '字节跳动', salary: '5-8K', match: false, reason: '规则：黑名单：字节跳动' }
    ]);
    const html = env.doc.registry.reviewList.innerHTML;
    assert.ok(html.indexOf('数据分析') >= 0);
    assert.ok(html.indexOf('规则：黑名单：字节跳动') >= 0);
    assert.ok(html.indexOf('job-item skip') >= 0, '剔除项应为 skip 样式');
    assert.strictEqual(env.doc.registry.reviewCount.textContent, '1 / 2');
    assert.strictEqual(env.doc.registry.reviewCard.style.display, 'block');
  });

  t('renderReview：AI 不匹配岗位可勾选，规则剔除仍禁用', async () => {
    const chrome = makeChrome();
    const env = loadSidepanel(chrome);
    await waitFor(() => env.doc.registry.apiBaseUrl.value !== '');
    env.ctx.renderReview([
      { id: '1', name: '匹配岗', company: 'A公司', salary: '10-15K', match: true, reason: '方向匹配' },
      { id: '2', name: 'AI不匹配岗', company: 'B公司', salary: '8-10K', match: false, reason: '方向明显不符' },
      { id: '3', name: '规则剔除岗', company: 'C公司', salary: '5-8K', match: false, reason: '规则：黑名单：C公司' }
    ]);
    const html = env.doc.registry.reviewList.innerHTML;
    assert.ok(html.indexOf('job-item nomatch') >= 0, 'AI 不匹配项应为 nomatch 样式');
    assert.ok(/<input type="checkbox" data-id="2">/.test(html), 'AI 不匹配项应可勾选（无 disabled）');
    assert.ok(/<input type="checkbox" disabled data-id="3">/.test(html), '规则剔除项应保持 disabled');
  });

  t('加载已有 filterConfig：UI 自动回填', async () => {
    const chrome = makeChrome();
    await chrome.storage.local.set({ filterConfig: { listMode: 'black', blacklist: [{ name: 'A公司', mode: 'exact' }], whitelist: [] } });
    const env = loadSidepanel(chrome);
    await waitFor(() => env.doc.registry.blackList.value !== '');
    assert.strictEqual(env.doc.registry.blackList.value, 'A公司');
  });

  t('旧版 DeepSeek 默认配置自动迁移到预设', async () => {
    const chrome = makeChrome();
    await chrome.storage.local.set({ apiBaseUrl: 'https://api.deepseek.com/v1/chat/completions', apiModel: 'deepseek-chat', apiKey: 'sk-old-invalid-key-8671' });
    const env = loadSidepanel(chrome);
    await waitFor(() => env.doc.registry.apiBaseUrl.value === 'https://opencode.ai/zen/go/v1/chat/completions');
    await waitFor(() => chrome._storageData.get('apiModel') === 'deepseek-v4-flash');
    const d = await chrome.storage.local.get(['apiBaseUrl', 'apiModel', 'apiKey']);
    assert.strictEqual(d.apiBaseUrl, 'https://opencode.ai/zen/go/v1/chat/completions');
    assert.strictEqual(d.apiModel, 'deepseek-v4-flash');
    assert.ok(d.apiKey !== 'sk-old-invalid-key-8671' && String(d.apiKey).length > 20, '失效密钥已替换为预设 key');
  });

  t('恢复预设按钮：覆盖当前配置并持久化', async () => {
    const chrome = makeChrome();
    const env = loadSidepanel(chrome);
    await waitFor(() => env.doc.registry.apiBaseUrl.value !== '');
    const r = env.doc.registry;
    r.apiBaseUrl.value = 'https://broken.example/v1';
    r.apiModel.value = 'wrong-model';
    r.apiKey.value = 'sk-wrong';
    r.btnRestorePreset.click();
    await waitFor(() => chrome._storageData.get('apiModel') === 'deepseek-v4-flash');
    const d = await chrome.storage.local.get(['apiBaseUrl', 'apiModel', 'apiKey']);
    assert.strictEqual(d.apiBaseUrl, 'https://opencode.ai/zen/go/v1/chat/completions');
    assert.strictEqual(d.apiModel, 'deepseek-v4-flash');
    assert.ok(String(d.apiKey).length > 20, 'key 已恢复');
    assert.strictEqual(String(r.apiKey.value).length > 20, true);
  });

  t('预设下拉：切换 DeepSeek/GLM 自动填充并持久化', async () => {
    const chrome = makeChrome();
    const env = loadSidepanel(chrome);
    await waitFor(() => env.doc.registry.apiBaseUrl.value !== '');
    const r = env.doc.registry;
    const fire = () => (r.presetSelect._h.change || []).forEach(f => f());

    r.presetSelect.value = 'glm-4.7'; fire();
    await waitFor(() => chrome._storageData.get('apiModel') === 'glm-4.7');
    assert.strictEqual(r.apiBaseUrl.value, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
    assert.strictEqual(r.apiModel.value, 'glm-4.7');
    assert.strictEqual(r.apiKey.value, '', '切到第三方服务商应清掉内置 key');

    r.presetSelect.value = 'deepseek-pro'; fire();
    await waitFor(() => chrome._storageData.get('apiModel') === 'deepseek-v4-pro');
    assert.strictEqual(r.apiBaseUrl.value, 'https://api.deepseek.com/chat/completions');

    // 已迁移过的用户二次加载，主动选的 DeepSeek 不应被旧版迁移覆盖
    await chrome.storage.local.set({ presetMigrated: true });
    const env2 = loadSidepanel(chrome);
    await waitFor(() => env2.doc.registry.apiBaseUrl.value !== '');
    assert.strictEqual(env2.doc.registry.apiModel.value, 'deepseek-v4-pro');
    assert.strictEqual(env2.doc.registry.presetSelect.value, 'deepseek-pro', '下拉应回填为 DeepSeek');
  });

  t('孤儿面板守卫：上下文失效时点击显示红色横幅', async () => {
    const chrome = makeChrome();
    const env = loadSidepanel(chrome);
    await waitFor(() => env.doc.registry.apiBaseUrl.value !== '');
    env.ctx.chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated'); };
    env.doc.registry.btnDeliver.click();
    const banner = (env.doc.body._inserted || []).find(b => b.id === 'deadBanner');
    assert.ok(banner, '应插入红色刷新横幅');
    assert.ok(banner.onclick, '横幅应可点击刷新');
  });

  t('投递统计：GET_STATS 渲染汇总/进度条/14天柱状图', async () => {
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      days.push({ date: k, ok: i === 13 ? 5 : (i % 3), fail: i === 13 ? 1 : 0, skip: 0 });
    }
    const chrome = makeChrome({
      messageResponses: {
        GET_STATS: {
          ok: true,
          today: { ok: 5, fail: 1, skip: 0 },
          week: { ok: 12, fail: 2, skip: 1 },
          month: { ok: 50, fail: 3, skip: 2 },
          goal: { monthly: 100 },
          todayOk: 5, dailyGoal: 60,
          days: days
        }
      }
    });
    const env = loadSidepanel(chrome);
    const r = env.doc.registry;
    await waitFor(() => r.statToday.textContent !== '' && r.statToday.textContent !== '0');
    assert.strictEqual(String(r.statToday.textContent), '5');
    assert.strictEqual(String(r.statWeek.textContent), '12');
    assert.strictEqual(String(r.statMonth.textContent), '50');
    assert.strictEqual(String(r.statTodayBadge.textContent), '5');
    assert.strictEqual(r.statGoalText.textContent, '50 / 100');
    assert.strictEqual(r.goalBar.style.width, '50%');
    assert.ok(r.statChart.innerHTML.indexOf('bar-col') >= 0, '柱状图已渲染');
    assert.strictEqual(r.statChart.innerHTML.split('bar-col').length - 1, 14, '14 根柱子');
    assert.ok(r.statChart.innerHTML.indexOf('title=') >= 0, '柱子带悬浮说明');
    assert.strictEqual(r.monthlyGoal.value, '100', '月目标输入框回填');
  });

  t('统计响应异常时静默不崩', async () => {
    const chrome = makeChrome();
    const env = loadSidepanel(chrome);
    await waitFor(() => env.doc.registry.apiBaseUrl.value !== '');
    assert.strictEqual(env.doc.registry.statToday.textContent, '', '异常响应被守卫拦截，不做渲染');
  });

  t('节奏设置：保存合并 paceConfig（默认区间保留）', async () => {
    const chrome = makeChrome();
    const env = loadSidepanel(chrome);
    await waitFor(() => env.doc.registry.apiBaseUrl.value !== '');
    const r = env.doc.registry;
    r.maxPerRun.value = '10';
    r.dailyGoal.value = '25';
    r.pauseOnGoal.checked = false;
    r.postRestText.value = '15-30';
    r.preSendText.value = '6-3';
    r.btnSavePace.click();
    await waitFor(() => chrome._storageData.has('paceConfig'));
    const d = await chrome.storage.local.get('paceConfig');
    const p = d.paceConfig;
    assert.strictEqual(p.maxPerRun, 10);
    assert.strictEqual(p.dailyGoal, 25);
    assert.strictEqual(p.pauseOnGoal, false);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p.postDeliverRest)), [15, 30], '休息区间生效');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p.preSendDelay)), [3, 6], '等待区间自动排序 min-max');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(p.skipRest)), [2, 4], '未填写的区间保留默认');
  });

  t('节奏 UI 回填：已保存配置显示区间', async () => {
    const chrome = makeChrome();
    await chrome.storage.local.set({ paceConfig: { maxPerRun: 5, dailyGoal: 20, pauseOnGoal: false, postDeliverRest: [12, 18], preSendDelay: [1, 2], skipRest: [3, 8] } });
    const env = loadSidepanel(chrome);
    const r = env.doc.registry;
    await waitFor(() => r.postRestText.value !== '');
    assert.strictEqual(r.maxPerRun.value, '5');
    assert.strictEqual(r.dailyGoal.value, '20');
    assert.strictEqual(r.postRestText.value, '12-18');
    assert.strictEqual(r.preSendText.value, '1-2');
    assert.strictEqual(r.pauseOnGoal.checked, false);
  });

  t('月目标：保存 statGoal 并刷新', async () => {
    const chrome = makeChrome({ messageResponses: { GET_STATS: { ok: true, today: { ok: 0, fail: 0, skip: 0 }, week: { ok: 0, fail: 0, skip: 0 }, month: { ok: 0, fail: 0, skip: 0 }, goal: { monthly: 300 }, days: [] } } });
    const env = loadSidepanel(chrome);
    await waitFor(() => env.doc.registry.apiBaseUrl.value !== '');
    env.doc.registry.monthlyGoal.value = '200';
    env.doc.registry.btnSaveGoal.click();
    await waitFor(() => chrome._storageData.has('statGoal'));
    const d = await chrome.storage.local.get('statGoal');
    assert.strictEqual(d.statGoal.monthly, 200);
  });

  t('风控设置：保存 riskConfig 并二次加载回填', async () => {
    const chrome = makeChrome();
    const env = loadSidepanel(chrome);
    await waitFor(() => env.doc.registry.apiBaseUrl.value !== '');
    const r = env.doc.registry;
    r.riskVerify.checked = false;
    r.riskMaxFail.value = '3';
    r.btnSavePace.click();
    await waitFor(() => chrome._storageData.has('riskConfig'));
    const d = await chrome.storage.local.get('riskConfig');
    assert.strictEqual(d.riskConfig.verifyDetect, false);
    assert.strictEqual(d.riskConfig.maxConsecFail, 3);
    const env2 = loadSidepanel(chrome);
    await waitFor(() => env2.doc.registry.riskMaxFail.value === '3');
    assert.strictEqual(env2.doc.registry.riskVerify.checked, false, '开关回填');
    assert.strictEqual(env2.doc.registry.riskMaxFail.value, '3', '阈值回填');
  });

  t('规则统计渲染：数字 count 不崩溃（esc 数字回归）', async () => {
    const chrome = makeChrome();
    const env = loadSidepanel(chrome);
    await waitFor(() => env.doc.registry.apiBaseUrl.value !== '');
    assert.strictEqual(env.ctx.esc(5), '5', 'esc 应能处理数字');
    assert.strictEqual(env.ctx.esc(0), '0');
    assert.strictEqual(env.ctx.esc(null), '', 'null/undefined 应为空串');
    assert.strictEqual(env.ctx.esc(undefined), '');
    env.ctx.renderRuleStats([{ rule: '黑名单', count: 3 }]);
    const html = env.doc.registry.ruleStats.innerHTML;
    assert.ok(html.indexOf('黑名单') >= 0 && html.indexOf('×3') >= 0, '应正常渲染规则与数量');
  });
});
