// ===== background.js 集成测试：收集→规则过滤→AI筛选→审核→试算→投递→去重→资金拦截→控制消息 =====
'use strict';
const assert = require('assert');
const { define, makeChrome, loadSW, waitFor, makeFetchQueue } = require('./helpers');

const JOBS5 = [
  { id: 'J1', name: '数据分析师', salary: '10-15K', company: '阿里科技有限公司', tags: ['SQL', 'Python'], area: '北京·朝阳区', activeState: 'online', inviteCount: 10, link: 'https://www.zhipin.com/job_detail/J1.html?ka=1' },
  { id: 'J2', name: '销售专员', salary: '5-8K', company: '字节跳动网络科技', tags: [], area: '北京', activeState: 'week', inviteCount: 20, link: 'https://www.zhipin.com/job_detail/J2.html?ka=2' },
  { id: 'J3', name: '数据分析实习生', salary: '150-200元/天', company: '字节跳动旗下的某公司', tags: [], area: '北京·海淀区', activeState: 'online', inviteCount: 3, link: 'https://www.zhipin.com/job_detail/J3.html?ka=3' },
  { id: 'J4', name: '算法工程师', salary: '25-40K', company: '正常科技', tags: ['Python'], area: '上海·浦东', activeState: 'month', inviteCount: 100, link: 'https://www.zhipin.com/job_detail/J4.html?ka=4' },
  { id: 'J5', name: '前台接待', salary: '面议', company: '饭店集团', tags: [], area: '广州', activeState: 'unknown', inviteCount: -1, link: 'https://www.zhipin.com/job_detail/J5.html?ka=5' }
];

const MATCH_JSON = '{"match":true,"reason":"方向匹配"}';

function baseCfg(extraFilter) {
  return {
    apiBaseUrl: 'https://api.test/v1/chat/completions', apiKey: 'sk-test', apiModel: 'test-model',
    resumeText: '熟练 SQL、Python，3 年数据分析经验', keyword: '数据分析', city: '北京', count: '5',
    filterConfig: Object.assign({ listMode: 'off', blacklist: [], whitelist: [] }, extraFilter || {})
  };
}

function setup(opts) {
  opts = opts || {};
  const chrome = makeChrome({
    chatUrl: 'https://www.zhipin.com/web/geek/chat/1001',
    contentHandler: (tabId, msg) => {
      if (msg.type === 'SCRAPE') return { success: true, jobs: opts.jobs || JOBS5 };
      if (msg.type === 'OPEN_JD') {
        const custom = (opts.openJdByJob || {})[msg.job.id] || {};
        return Object.assign({ success: true, jd: '岗位JD：负责数据分析', hrName: '王女士', addr: '', fundText: '' }, custom);
      }
      if (msg.type === 'GO_CHAT') return { success: true, navigated: true };
      if (msg.type === 'SEND_ACTIVE') return opts.chatFail ? { success: false, error: opts.chatFail } : { success: true, imageOk: true };
      return { success: false, error: 'unexpected: ' + msg.type };
    }
  });
  // 在 SW 加载前同步预置 storage，避免 ensureDefaults 竞态覆盖
  if (opts.cfg) {
    for (const k of Object.keys(opts.cfg)) chrome._storageData.set(k, JSON.parse(JSON.stringify(opts.cfg[k])));
  }
  const fetch_ = makeFetchQueue(opts.responses || []);
  loadSW(chrome, fetch_);
  return { chrome, fetch: fetch_ };
}

// 直接同步写入 storage 底层数据（在微任务 ensureDefaults 读取之前完成）
function seedStorage(chrome, cfg) {
  for (const k of Object.keys(cfg)) chrome._storageData.set(k, JSON.parse(JSON.stringify(cfg[k])));
  return Promise.resolve();
}

async function runCollectAndWait(chrome, phase) {
  const resp = await chrome.panelSend({ type: 'START_COLLECT' });
  assert.strictEqual(resp && resp.ok, true, 'START_COLLECT 应返回 ok');
  await waitFor(async () => {
    const s = await chrome.panelSend({ type: 'GET_STATE' });
    return s && s.phase === (phase || 'review');
  }, 8000);
  return chrome.panelSend({ type: 'GET_STATE' });
}

define('background.js 集成流程', t => {

  t('初始化：写入 filterConfig 默认值', async () => {
    const { chrome } = setup();
    await waitFor(() => chrome._storageData.has('filterConfig'));
    const d = await chrome.storage.local.get('filterConfig');
    assert.strictEqual(d.filterConfig.listMode, 'off');
  });

  t('完整收集：黑名单过滤 2 个 → AI 筛 3 个 → 审核列表 3 条全 match', async () => {
    const { chrome, fetch } = setup({ responses: [MATCH_JSON, MATCH_JSON, MATCH_JSON] });
    await seedStorage(chrome, baseCfg({ listMode: 'black', blacklist: [{ name: '字节跳动', mode: 'keyword' }] }));
    const s = await runCollectAndWait(chrome);
    assert.strictEqual(fetch._calls.length, 3, 'AI 只应被调用 3 次（黑名单不进 AI）');
    assert.strictEqual(s.screened.length, 3);
    assert.ok(s.screened.every(j => j.match === true), '全部 match');
    const d = await chrome.storage.local.get('sw_screened');
    assert.strictEqual(d.sw_screened.length, 3);
    const filterLogs = chrome.runtime._runtimeMessages.filter(m => m.type === 'LOG' && /规则过滤：剔除 2/.test(m.text));
    assert.ok(filterLogs.length > 0, '应有「规则过滤：剔除 2」日志');
  });

  t('jobHandle=collect：规则剔除岗位以灰色保留进审核列表且不进 AI', async () => {
    const { chrome, fetch } = setup({ responses: [MATCH_JSON, MATCH_JSON, MATCH_JSON] });
    await seedStorage(chrome, baseCfg({ listMode: 'black', blacklist: [{ name: '字节跳动', mode: 'keyword' }], jobHandle: 'collect' }));
    const s = await runCollectAndWait(chrome);
    assert.strictEqual(fetch._calls.length, 3, '被规则剔除的岗位不进 AI');
    assert.strictEqual(s.screened.length, 5, '审核列表应为 3 match + 2 规则剔除');
    const ruleDropped = s.screened.filter(j => j.match === false);
    assert.strictEqual(ruleDropped.length, 2);
    assert.ok(ruleDropped.every(j => String(j.reason).indexOf('规则：黑名单') === 0));
  });

  t('RUN_FILTER_DRY：按最新规则对已筛结果再过滤并持久化', async () => {
    const { chrome, fetch } = setup({ responses: [MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON] });
    await seedStorage(chrome, baseCfg({}));
    await runCollectAndWait(chrome);
    await chrome.storage.local.set({ filterConfig: { kwMode: 'include', keywords: ['分析'] } });
    const resp = await chrome.panelSend({ type: 'RUN_FILTER_DRY' });
    assert.ok(resp && resp.ok, '试算应成功');
    assert.strictEqual(resp.kept, 2, 'J1 数据分析师 + J3 数据分析实习生 保留');
    assert.strictEqual(resp.dropped, 3);
    const d = await chrome.storage.local.get('sw_screened');
    assert.strictEqual(d.sw_screened.filter(j => j.match).length, 2);
    assert.ok(d.sw_screened.some(j => String(j.reason).indexOf('规则：关键词不含') === 0));
    assert.ok(chrome.runtime._runtimeMessages.some(m => m.type === 'SCREENED'), '应推送 SCREENED 刷新审核列表');
    assert.strictEqual(fetch._calls.length, 5, '试算不产生 AI 调用');
  });

  t('投递闭环：读JD→生成招呼语→建联→发送成功→记录联系人', async () => {
    const { chrome, fetch } = setup({
      responses: [MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON,
        '您好，熟悉SQL、Python，做过数据分析项目，期待沟通。', '您好，熟悉Python、算法，做过推荐系统，期待沟通。']
    });
    await seedStorage(chrome, baseCfg({}));
    await runCollectAndWait(chrome);
    const resp = await chrome.panelSend({ type: 'START_DELIVER', jobIds: ['J1', 'J4'] });
    assert.ok(resp && resp.ok);
    await waitFor(async () => {
      const s = await chrome.panelSend({ type: 'GET_STATE' });
      return s && s.phase === 'done';
    }, 8000);
    assert.strictEqual(fetch._calls.length, 7, '5 次筛选 + 2 次招呼语');
    const sent = await chrome.storage.local.get('sentContacts');
    assert.strictEqual(Object.keys(sent.sentContacts || {}).length, 2, '成功后应记录 2 位联系人');
    const doneLogs = chrome.runtime._runtimeMessages.filter(m => m.type === 'LOG' && /投递完成：成功 2 \| 失败 0/.test(m.text));
    assert.ok(doneLogs.length > 0, '应有「成功 2 | 失败 0」日志');
    const processed = await chrome.storage.local.get('processed');
    assert.ok(processed.processed.J1 && processed.processed.J4);
  });

  t('联系人级去重：RESET 后重投同公司同 HR 被拦截', async () => {
    const { chrome, fetch } = setup({ responses: [MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, '招呼语A'] });
    await seedStorage(chrome, baseCfg({}));
    await runCollectAndWait(chrome);
    await chrome.panelSend({ type: 'START_DELIVER', jobIds: ['J1'] });
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, 8000);
    assert.strictEqual(fetch._calls.length, 6, '5 次筛选 + 1 次招呼语');
    // J1(阿里科技有限公司/王女士) 已记录；把 J4 的公司改成同一家模拟"同公司同HR"
    const jobs = await chrome.storage.local.get('sw_jobs');
    const j4 = jobs.sw_jobs.find(j => j.id === 'J4');
    assert.ok(j4);
    j4.company = '阿里科技有限公司';
    j4.hrName = '王女士';
    await chrome.storage.local.set({ sw_jobs: jobs.sw_jobs });
    await chrome.panelSend({ type: 'RESET' });
    const callsBefore = fetch._calls.length;
    const resp2 = await chrome.panelSend({ type: 'START_DELIVER', jobIds: ['J1'] });
    assert.ok(resp2 && resp2.ok);
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, 8000);
    assert.strictEqual(fetch._calls.length, callsBefore, '被去重拦截不应产生新招呼语调用');
    const doneLogs = chrome.runtime._runtimeMessages.filter(m => m.type === 'LOG' && /已投过同企业 HR/.test(m.text));
    assert.ok(doneLogs.length > 0, '应出现「已投过同企业 HR」跳过日志');
  });

  t('投递期注册资金规则：美元注册资金岗位被拦截', async () => {
    const { chrome, fetch } = setup({
      openJdByJob: { J1: { fundText: '注册资本 50万美元', addr: '北京市海淀区' } },
      responses: [MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON]
    });
    await seedStorage(chrome, baseCfg({ skipUsdFund: true }));
    await runCollectAndWait(chrome);
    const callsAfterCollect = fetch._calls.length;
    await chrome.panelSend({ type: 'START_DELIVER', jobIds: ['J1'] });
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, 8000);
    assert.strictEqual(fetch._calls.length, callsAfterCollect, '拦截发生在生成招呼语之前，无新增调用');
    const sent = await chrome.storage.local.get('sentContacts');
    assert.strictEqual(Object.keys(sent.sentContacts || {}).length, 0, '被拦截不应记录联系人');
    const failLogs = chrome.runtime._runtimeMessages.filter(m => m.type === 'LOG' && /美元注册资金/.test(m.text));
    assert.ok(failLogs.length > 0, '应有资金拦截日志');
  });

  t('AI 筛选异常容错：接口 500 时岗位标为不匹配而非崩溃', async () => {
    const { chrome } = setup({ jobs: [JOBS5[0]], responses: [500] });
    await seedStorage(chrome, baseCfg({}));
    const s = await runCollectAndWait(chrome);
    assert.strictEqual(s.screened.length, 1);
    assert.strictEqual(s.screened[0].match, false);
    assert.ok(/筛选异常|API/.test(s.screened[0].reason));
  });

  t('AI 返回 markdown 围栏/杂字也能解析 JSON', async () => {
    const { chrome } = setup({ jobs: [JOBS5[0]], responses: ['```json\n{"match":false,"reason":"方向不符"}\n```'] });
    await seedStorage(chrome, baseCfg({}));
    const s = await runCollectAndWait(chrome);
    assert.strictEqual(s.screened.length, 1);
    assert.strictEqual(s.screened[0].match, false);
    assert.strictEqual(s.screened[0].reason, '方向不符');
  });

  t('AI 返回 match 为字符串 "true" 也能识别', async () => {
    const { chrome } = setup({ jobs: [JOBS5[0]], responses: ['{"match":"true","reason":"匹配"}'] });
    await seedStorage(chrome, baseCfg({}));
    const s = await runCollectAndWait(chrome);
    assert.strictEqual(s.screened[0].match, true);
  });

  t('API 鉴权失败（401）自动熔断：不再烧完所有岗位', async () => {
    const { chrome, fetch } = setup({ responses: [401, 401, 401, 401, 401] });
    await seedStorage(chrome, baseCfg({}));
    const resp = await chrome.panelSend({ type: 'START_COLLECT' });
    assert.ok(resp && resp.ok);
    await waitFor(async () => chrome.runtime._runtimeMessages.some(m => m.type === 'LOG' && /鉴权失败/.test(m.text)), 8000);
    await waitFor(async () => {
      const s = await chrome.panelSend({ type: 'GET_STATE' });
      return s && s.phase === 'idle';
    }, 8000);
    assert.strictEqual(fetch._calls.length, 3, '第一批 3 个失败后立即中止，不再调用后 2 个');
    const s = await chrome.panelSend({ type: 'GET_STATE' });
    assert.strictEqual(s.phase, 'idle', '鉴权失败不进入审核');
    const stored = await chrome.storage.local.get('sw_screened');
    assert.ok(!stored.sw_screened, '中止后不落盘筛选结果');
  });

  t('发送失败路径：SEND_ACTIVE 失败时不记录联系人', async () => {
    const { chrome, fetch } = setup({
      responses: [MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, '招呼语X'],
      chatFail: '模拟发送失败'
    });
    await seedStorage(chrome, baseCfg({}));
    await runCollectAndWait(chrome);
    await chrome.panelSend({ type: 'START_DELIVER', jobIds: ['J1'] });
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, 8000);
    assert.strictEqual(fetch._calls.length, 6, '5 次筛选 + 1 次招呼语');
    const sent = await chrome.storage.local.get('sentContacts');
    assert.strictEqual(Object.keys(sent.sentContacts || {}).length, 0, '失败不应记录联系人');
    const doneLogs = chrome.runtime._runtimeMessages.filter(m => m.type === 'LOG' && /投递完成：成功 0 \| 失败 1/.test(m.text));
    assert.ok(doneLogs.length > 0);
  });

  t('运行控制：PAUSE/RESUME/STOP/RESET', async () => {
    const { chrome } = setup();
    await seedStorage(chrome, baseCfg({}));
    await chrome.panelSend({ type: 'PAUSE' });
    await chrome.panelSend({ type: 'RESUME' });
    await chrome.panelSend({ type: 'STOP' });
    const s = await chrome.panelSend({ type: 'GET_STATE' });
    assert.strictEqual(s.phase, 'idle');
    await chrome.panelSend({ type: 'RESET' });
    const processed = await chrome.storage.local.get('processed');
    assert.deepStrictEqual(processed.processed, {});
  });

  t('GET_COMPANIES / CLEAR_COMPANIES', async () => {
    const { chrome, fetch } = setup({
      responses: [MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, '招呼语A', '招呼语B']
    });
    await seedStorage(chrome, baseCfg({}));
    await runCollectAndWait(chrome);
    await chrome.panelSend({ type: 'START_DELIVER', jobIds: ['J1', 'J4'] });
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, 8000);
    const g = await chrome.panelSend({ type: 'GET_COMPANIES' });
    assert.ok(g && g.ok && g.count === 2, '应查到 2 位联系人');
    assert.ok(g.list[0].lastSentAt >= g.list[1].lastSentAt, '按最近投递时间倒序');
    await chrome.panelSend({ type: 'CLEAR_COMPANIES' });
    const g2 = await chrome.panelSend({ type: 'GET_COMPANIES' });
    assert.strictEqual(g2.count, 0, '清空后为 0');
    assert.ok(chrome.runtime._runtimeMessages.some(m => m.type === 'COMPANIES_UPDATED'));
  });

  t('投递空列表与重复投递防护', async () => {
    const { chrome, fetch } = setup({
      responses: [MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, '招呼语A']
    });
    await seedStorage(chrome, baseCfg({}));
    await runCollectAndWait(chrome);
    await chrome.panelSend({ type: 'START_DELIVER', jobIds: ['J1'] });
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, 8000);
    const callsAfterFirst = fetch._calls.length;
    await chrome.panelSend({ type: 'START_DELIVER', jobIds: ['J1'] });
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, 8000);
    assert.strictEqual(fetch._calls.length, callsAfterFirst, '已投岗位不应再次投递');
    const warnLogs = chrome.runtime._runtimeMessages.filter(m => m.type === 'LOG' && /没有可投递的岗位/.test(m.text));
    assert.ok(warnLogs.length > 0);
  });

  t('投递统计：ok/fail/skip 计数、GET_STATS 与 CLEAR_STATS', async () => {
    const { chrome } = setup({ responses: [MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, '招呼语A'] });
    await seedStorage(chrome, baseCfg({}));
    await runCollectAndWait(chrome);
    await chrome.panelSend({ type: 'START_DELIVER', jobIds: ['J1'] });
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, 8000);
    let g = await waitFor(async () => {
      const r = await chrome.panelSend({ type: 'GET_STATS' });
      return r && r.ok && r.today && r.today.ok === 1 ? r : null;
    }, 5000);
    assert.strictEqual(g.today.fail, 0);
    assert.strictEqual(g.days.length, 14, '返回近 14 天');
    assert.strictEqual(g.days[13].ok, 1, '最后一天是今天');
    assert.ok(g.goal.monthly >= 1 && g.dailyGoal >= 1, '应返回目标配置');
    // 重置后重投同一 HR → skip 计数
    await chrome.panelSend({ type: 'RESET' });
    await chrome.panelSend({ type: 'START_DELIVER', jobIds: ['J1'] });
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, 8000);
    g = await waitFor(async () => {
      const r = await chrome.panelSend({ type: 'GET_STATS' });
      return r && r.today && r.today.skip === 1 ? r : null;
    }, 5000);
    assert.strictEqual(g.today.ok, 1, 'skip 不计入成功');
    // 失败路径计入 fail
    const { chrome: c2 } = setup({
      responses: [MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, '招呼语X'],
      chatFail: '模拟发送失败'
    });
    await seedStorage(c2, baseCfg({}));
    await runCollectAndWait(c2);
    await c2.panelSend({ type: 'START_DELIVER', jobIds: ['J1'] });
    await waitFor(async () => { const s = await c2.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, 8000);
    const g2 = await waitFor(async () => {
      const r = await c2.panelSend({ type: 'GET_STATS' });
      return r && r.today && r.today.fail === 1 ? r : null;
    }, 5000);
    assert.strictEqual(g2.today.ok, 0);
    // 清空
    await c2.panelSend({ type: 'CLEAR_STATS' });
    const g3 = await c2.panelSend({ type: 'GET_STATS' });
    assert.strictEqual(g3.today.ok, 0);
    assert.strictEqual(g3.month.ok, 0);
    assert.strictEqual(g3.days.length, 14);
  });

  t('单次投递上限：maxPerRun=1 时第二个岗位自动暂停（reason=quota）', async () => {
    const { chrome, fetch } = setup({
      responses: [MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, '招呼语A', '招呼语B']
    });
    await seedStorage(chrome, baseCfg({}));
    await chrome.storage.local.set({ paceConfig: { maxPerRun: 1, dailyGoal: 60, pauseOnGoal: true } });
    await runCollectAndWait(chrome);
    await chrome.panelSend({ type: 'START_DELIVER', jobIds: ['J1', 'J4'] });
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, 8000);
    const phases = chrome.runtime._runtimeMessages.filter(m => m.type === 'PHASE');
    const lastPhase = phases[phases.length - 1];
    assert.strictEqual(lastPhase.reason, 'quota', '最后一个 PHASE 应带 reason=quota');
    assert.ok(chrome.runtime._runtimeMessages.some(m => m.type === 'LOG' && /单次投递上限/.test(m.text)), '应有限额日志');
    const g = await chrome.panelSend({ type: 'GET_STATS' });
    assert.strictEqual(g.today.ok, 1, '只投出 1 个');
    const processed = await chrome.storage.local.get('processed');
    assert.ok(processed.processed.J1 && !processed.processed.J4, 'J4 未投出可下轮继续');
  });

  t('每日目标：已达 dailyGoal 时不再投递（reason=goal）', async () => {
    const { chrome, fetch } = setup({ responses: [MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON] });
    const cfg = baseCfg({});
    const tk = new Date();
    const tkStr = tk.getFullYear() + '-' + String(tk.getMonth() + 1).padStart(2, '0') + '-' + String(tk.getDate()).padStart(2, '0');
    cfg.deliverStats = {};
    cfg.deliverStats[tkStr] = { ok: 60, fail: 0, skip: 0 };
    cfg.paceConfig = { maxPerRun: 30, dailyGoal: 60, pauseOnGoal: true };
    await seedStorage(chrome, cfg);
    await runCollectAndWait(chrome);
    const callsAfterCollect = fetch._calls.length;
    await chrome.panelSend({ type: 'START_DELIVER', jobIds: ['J1'] });
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, 8000);
    assert.strictEqual(fetch._calls.length, callsAfterCollect, '达标后不产生招呼语调用');
    const phases = chrome.runtime._runtimeMessages.filter(m => m.type === 'PHASE');
    const lastPhase = phases[phases.length - 1];
    assert.strictEqual(lastPhase.reason, 'goal', '应带 reason=goal');
    assert.ok(chrome.runtime._runtimeMessages.some(m => m.type === 'LOG' && /达到?今日目标|今日已投/.test(m.text)), '应有达标日志');
    const sent = await chrome.storage.local.get('sentContacts');
    assert.strictEqual(Object.keys(sent.sentContacts || {}).length, 0, '不记录联系人');
  });

  t('连续投递多个岗位：默认节奏长休眠下循环不中断', async () => {
    const { chrome, fetch } = setup({
      responses: [MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, MATCH_JSON, '招呼语A', '招呼语B', '招呼语C']
    });
    await seedStorage(chrome, baseCfg({}));
    await runCollectAndWait(chrome);
    await chrome.panelSend({ type: 'START_DELIVER', jobIds: ['J1', 'J4', 'J5'] });
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, 15000);
    assert.strictEqual(fetch._calls.length, 8, '5 次筛选 + 3 次招呼语');
    const doneLogs = chrome.runtime._runtimeMessages.filter(m => m.type === 'LOG' && /投递完成：成功 3 \| 失败 0/.test(m.text));
    assert.ok(doneLogs.length > 0, '3 个岗位应全部投出');
    const g = await chrome.panelSend({ type: 'GET_STATS' });
    assert.ok(g.today.ok >= 3, '统计应累计 3 次成功');
  });

  t('SW 消息全链路：LOG/PROGRESS/PHASE/SCREENED/DONE 均有回传', async () => {
    const { chrome, fetch } = setup({ responses: [MATCH_JSON, '招呼语A'] });
    await seedStorage(chrome, baseCfg({}));
    await runCollectAndWait(chrome);
    await chrome.panelSend({ type: 'START_DELIVER', jobIds: ['J1'] });
    await waitFor(async () => { const s = await chrome.panelSend({ type: 'GET_STATE' }); return s && s.phase === 'done'; }, 8000);
    const types = new Set(chrome.runtime._runtimeMessages.map(m => m.type));
    for (const tt of ['LOG', 'PROGRESS', 'PHASE', 'SCREENED', 'DONE']) assert.ok(types.has(tt), '缺少消息类型 ' + tt);
  });
});
