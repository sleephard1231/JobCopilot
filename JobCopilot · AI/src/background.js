// ===== 小北智能招聘 Service Worker：编排 收集→筛选→审核→投递 + 自定义 LLM =====
importScripts('/src/selectors.js'); // 让 SW 也能用 CITY_MAP（否则城市永远是全国）
importScripts('/src/filters.js'); // 岗位过滤引擎（规则过滤前置，省 API）

const RESUME_TEXT = ''; // 不内置任何个人简历，由用户在设置页"简历文字"填写

let state = {
  phase: 'idle', paused: false, aborted: false,
  jobs: [], screened: [], greetings: {}, results: [], processed: {}
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); } catch (e) {}

// ── 小工具 ──
// MV3 SW 闲置 30 秒会被回收：长等待期间每 20 秒调用一次 API 保活
const sleep = (ms) => new Promise(r => {
  let done = false;
  const finish = () => { if (!done) { done = true; clearInterval(iv); r(); } };
  const iv = setInterval(() => { try { if (chrome.runtime.getPlatformInfo) chrome.runtime.getPlatformInfo(() => {}); } catch (e) {} }, 20000);
  setTimeout(finish, ms);
});
const rand = (a, b) => sleep(a + Math.random() * (b - a));
function log(text, level) { chrome.runtime.sendMessage({ type: 'LOG', text: text, level: level || 'info' }).catch(() => {}); }
function pushPhase(reason) { chrome.runtime.sendMessage(Object.assign({ type: 'PHASE', phase: state.phase }, reason ? { reason: reason } : {})).catch(() => {}); }
function progress(cur, total, label) { chrome.runtime.sendMessage({ type: 'PROGRESS', cur: cur, total: total, label: label || '' }).catch(() => {}); }
async function waitIfPaused() {
  let lastPing = 0;
  while (state.paused && !state.aborted) {
    if (Date.now() - lastPing > 15000) { lastPing = Date.now(); try { if (chrome.runtime.getPlatformInfo) chrome.runtime.getPlatformInfo(() => {}); } catch (e) {} }
    await sleep(400);
  }
}
function getCfg() { return chrome.storage.local.get(['apiBaseUrl', 'apiKey', 'apiModel', 'resumeText', 'resumeImage', 'city', 'keyword', 'count', 'filterConfig']); }
function filterCfg(cfg) { return BPFilters.normalize(cfg.filterConfig || BPFilters.DEFAULT_FILTER); }
function resumeFull(cfg) { return (cfg.resumeText || '').trim(); }
function jobInfo(j) { return '岗位：' + (j.name || '') + '\n技能标签：' + ((j.tags || []).join('、')) + '\n薪资：' + (j.salary || '') + '\n公司：' + (j.company || ''); }
function findJob(id) { for (var i = 0; i < state.jobs.length; i++) if (state.jobs[i].id === id) return state.jobs[i]; return null; }

// ── 投递节奏与统计（M2）──
const DEFAULT_PACE = { preSendDelay: [2, 4], postDeliverRest: [5, 8], skipRest: [2, 4], maxPerRun: 30, dailyGoal: 60, pauseOnGoal: true };
const DEFAULT_STAT_GOAL = { monthly: 300 };

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 串行写队列：投递/定时并发时读改写不互相覆盖
let statQueue = Promise.resolve();
function bumpStat(field) {
  statQueue = statQueue.then(async () => {
    const d = await chrome.storage.local.get('deliverStats');
    const stats = d.deliverStats || {};
    const k = todayKey();
    if (!stats[k]) stats[k] = { ok: 0, fail: 0, skip: 0 };
    stats[k][field] = (stats[k][field] || 0) + 1;
    await chrome.storage.local.set({ deliverStats: stats });
  }).catch(() => {});
  return statQueue;
}

async function readPaceAndStats() {
  const d = await chrome.storage.local.get(['paceConfig', 'statGoal', 'deliverStats']);
  const pace = Object.assign({}, DEFAULT_PACE, d.paceConfig || {});
  pace.maxPerRun = parseInt(pace.maxPerRun, 10) || DEFAULT_PACE.maxPerRun;
  pace.dailyGoal = parseInt(pace.dailyGoal, 10) || DEFAULT_PACE.dailyGoal;
  pace.pauseOnGoal = pace.pauseOnGoal !== false;
  const clampRange = (v, fallback) => {
    if (!Array.isArray(v) || v.length !== 2 || !isFinite(v[0]) || !isFinite(v[1])) return fallback.slice();
    const lo = Math.max(1, Number(v[0]));
    return [lo, Math.max(lo, Number(v[1]))];
  };
  pace.preSendDelay = clampRange(pace.preSendDelay, DEFAULT_PACE.preSendDelay);
  pace.postDeliverRest = clampRange(pace.postDeliverRest, DEFAULT_PACE.postDeliverRest);
  pace.skipRest = clampRange(pace.skipRest, DEFAULT_PACE.skipRest);
  return {
    pace: pace,
    goal: Object.assign({}, DEFAULT_STAT_GOAL, d.statGoal || {}),
    stats: d.deliverStats || {}
  };
}
function todayOkOf(stats) { const s = stats ? stats[todayKey()] : null; return s ? (s.ok || 0) : 0; }

// ── 联系人级去重：精确双键（企业名 + HR 名同时完全一致才算重复）──
// 标准化：仅去首尾空白，不做任何模糊
function normStr(s) { return (s == null ? '' : String(s)).trim(); }
function contactKey(company, hrName) {
  // 用全角竖线作分隔符（业务名里几乎不会用到）
  return normStr(company) + '｜' + normStr(hrName);
}
async function loadContactHistory() {
  const d = await chrome.storage.local.get(['sentContacts']);
  return d.sentContacts || {};
}
async function isContactBlocked(company, hrName) {
  const sent = await loadContactHistory();
  if (!Object.keys(sent).length) return { blocked: false, matchedKey: '' };
  // 双键都得完全一致（trim 后）
  const k = contactKey(company, hrName);
  if (sent[k]) return { blocked: true, matchedKey: k };
  return { blocked: false, matchedKey: '' };
}
async function addContactToHistory(company, hrName) {
  const c = normStr(company);
  const h = normStr(hrName);
  if (!c) return; // 没企业名就跳过
  // HR 名为空也允许写入（部分 BOSS 岗位不显示 HR），但匹配时公司相同的视为同一条目
  const d = await chrome.storage.local.get(['sentContacts']);
  const sent = d.sentContacts || {};
  const key = contactKey(c, h);
  if (!sent[key]) sent[key] = { company: c, hrName: h, count: 0, firstSentAt: 0, lastSentAt: 0 };
  const meta = sent[key];
  meta.count = (meta.count || 0) + 1;
  const now = Date.now();
  if (!meta.firstSentAt) meta.firstSentAt = now;
  meta.lastSentAt = now;
  await chrome.storage.local.set({ sentContacts: sent });
}

// ── 自定义 LLM(OpenAI 兼容协议) ──
async function callLLM(messages, maxTokens, opts) {
  const cfg = await getCfg();
  const endpoint = (cfg.apiBaseUrl || '').trim();
  const apiKey = (cfg.apiKey || '').trim();
  const model = (cfg.apiModel || '').trim();
  if (!endpoint) throw new Error('请先在配置中填写 API 端点');
  if (!apiKey) throw new Error('请先在配置中填写 API Key');
  if (!model) throw new Error('请先在配置中填写模型名');
  const body = { model: model, messages: messages, max_tokens: maxTokens || 500, temperature: 0.5 };
  // 强制 JSON 输出：DeepSeek / GLM / OpenAI 及多数 OpenAI 兼容端点均支持
  if (opts && opts.json) body.response_format = { type: 'json_object' };
  // 思考型模型默认会先"思考"再答，reasoning 会吃掉 max_tokens 导致正文被截断 → 显式关闭
  if (opts && opts.noThink && /deepseek|glm/i.test(model)) body.thinking = { type: 'disabled' };
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'x-opencode-session': 'xiaobei-extension-v1' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) { const t = await resp.text().catch(() => ''); throw new Error('API ' + resp.status + ': ' + t.slice(0, 200)); }
  const data = await resp.json();
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  return msg ? (msg.content || '').trim() : '';
}

// 从模型输出里尽量提取 {match,reason}：容忍 markdown 围栏、前后杂字、match 为字符串
function parseMatch(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/```(?:json|JSON)?/g, '').replace(/`/g, '').trim();
  let p = null;
  try { p = JSON.parse(s); } catch (e) {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { p = JSON.parse(m[0]); } catch (e2) {} }
  }
  return (p && typeof p === 'object' && 'match' in p) ? p : null;
}

// 筛选：只判断是否值得投（用岗位标签快速判断，不生成招呼语）
async function screenJob(cfg, job) {
  const sys = '你是资深求职助手。请完全依据下面提供的【求职者简历】，判断某个岗位是否值得该求职者投递。\n【判断标准·适中】保留(match=true)：岗位方向与求职者简历的专业/技能/经历相关，且求职者的经验年限、学历、级别够得着该岗位（不超纲）。剔除(match=false)：方向与简历明显无关；岗位要求的经验/学历/硬技能明显超出简历；岗位级别明显高于求职者当前水平。请依据简历本身判断，不要套用任何固定行业或级别。\n【输出】只输出一个JSON对象，不要markdown：{"match":true或false,"reason":"一句话理由"}';
  const user = '求职者简历：\n' + resumeFull(cfg) + '\n\n待判断岗位：\n' + jobInfo(job) + '\n\n严格输出JSON。';
  const raw = await callLLM([{ role: 'system', content: sys }, { role: 'user', content: user }], 4096, { json: true, noThink: true });
  const p = parseMatch(raw);
  if (!p) return { match: false, reason: 'AI解析失败' };
  return { match: p.match === true || p.match === 'true', reason: (p.reason || '').toString() };
}

// 投递时：结合该岗位的【完整JD】+ 简历，现场生成专属招呼语
async function genGreetingFromJD(cfg, job, jd) {
  const sys = '你是求职者本人，在BOSS直聘给HR发招呼语。回复会原样发给HR，严禁任何注释、说明、括号备注、字数统计或引导语。\n【格式】1.开头前15字必须是"熟悉XXX、XXX"(填该JD要求且你简历具备的核心技能1-2个)。2.紧接"做过XXX"说明简历里与该岗位相关的具体项目/经历。3.全文80-120字，真诚自然。';
  const jdText = (jd && jd.trim()) ? jd.trim() : ('技能标签：' + (job.tags || []).join('、'));
  const user = '我的简历：\n' + resumeFull(cfg) + '\n\n目标岗位：' + (job.name || '') + (job.company ? ('（' + job.company + '）') : '') + '\n该岗位JD：\n' + jdText + '\n\n请按格式生成一段招呼语，开头必须"熟悉…"，直接输出招呼语本身，不要任何多余内容。';
  const raw = await callLLM([{ role: 'system', content: sys }, { role: 'user', content: user }], 2048, { noThink: true });
  return (raw || '').trim();
}

// ── tab 注入 + 发消息 ──
async function ensureInjected(tabId, file) {
  try { await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['src/selectors.js', file] }); } catch (e) {}
}
function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { success: false, error: 'no response' });
    });
  });
}
function waitTabComplete(tabId) {
  return new Promise((resolve) => {
    function lis(id, info) { if (id === tabId && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(lis); setTimeout(resolve, 1200); } }
    chrome.tabs.onUpdated.addListener(lis);
    chrome.tabs.get(tabId, (t) => { if (t && t.status === 'complete') { chrome.tabs.onUpdated.removeListener(lis); setTimeout(resolve, 1200); } });
  });
}
function resolveCity(cfg) {
  const firstCity = (cfg.city || '').split(/[\/、,，\s]+/)[0].replace(/[市省]$/, '') || '';
  const code = (typeof CITY_MAP !== 'undefined' && CITY_MAP[firstCity]) || '100010000';
  return { name: firstCity, code: code, found: code !== '100010000' || firstCity === '全国' };
}
function buildSearchUrl(cfg) {
  const c = resolveCity(cfg);
  const params = new URLSearchParams({ query: cfg.keyword || '', city: c.code });
  // 行业/规模：BOSS 代码不确定，暂不加入（错误代码会导致搜不到任何岗位）
  return 'https://www.zhipin.com/web/geek/jobs?' + params.toString();
}
async function ensureTab(url) {
  let tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/*' });
  let tab = tabs[0];
  if (!tab) tab = await chrome.tabs.create({ url: url });
  else await chrome.tabs.update(tab.id, { url: url });
  await waitTabComplete(tab.id);
  await sleep(2000);
  return tab;
}
async function getSearchTab(cfg) { return ensureTab(buildSearchUrl(cfg)); }
function curUrl(tabId) { return new Promise(res => chrome.tabs.get(tabId, t => res((t && t.url) || ''))); }

// ── 流程：收集 + 筛选 ──
async function runCollect() {
  state.aborted = false; state.paused = false;
  state.jobs = []; state.screened = []; state.greetings = {}; state.results = [];
  state.phase = 'collecting'; pushPhase();
  const cfg = await getCfg();
  if (!cfg.apiBaseUrl || !cfg.apiKey || !cfg.apiModel) { log('请先填写 API 端点 / 模型 / Key', 'error'); state.phase = 'idle'; pushPhase(); return; }
  if (!cfg.keyword) { log('请先填写岗位关键词', 'error'); state.phase = 'idle'; pushPhase(); return; }
  if (!(cfg.resumeText || '').trim()) { log('请先在设置里填写"简历文字"（AI筛选和招呼语都需要它）', 'error'); state.phase = 'idle'; pushPhase(); return; }

  const _c = resolveCity(cfg);
  log('打开搜索页：' + cfg.keyword + ' | 城市：' + (_c.found ? _c.name : '全国'));
  if (cfg.city && !_c.found) log('城市"' + cfg.city + '"未识别，已按全国搜索', 'warn');
  const tab = await getSearchTab(cfg);
  const count = parseInt(cfg.count) || 20;

  log('收集岗位中（目标 ' + count + ' 个）...');
  await ensureInjected(tab.id, 'src/content-search.js');
  let r = await sendToTab(tab.id, { type: 'SCRAPE', count: count });
  // 页面刚导航完成/可能仍在 bfcache 或 content script 未就绪：失败则重试几次再放弃
  for (let i = 0; i < 3 && (!r || !r.success); i++) {
    await sleep(1500);
    await ensureInjected(tab.id, 'src/content-search.js');
    r = await sendToTab(tab.id, { type: 'SCRAPE', count: count });
  }
  if (!r || !r.success) { log('收集失败：' + (r && r.error), 'error'); state.phase = 'idle'; pushPhase(); return; }
  state.jobs = r.jobs || [];
  // 规则过滤前置：黑/白名单 + 硬性规则，零 API 成本
  const fc = filterCfg(cfg);
  const fr = BPFilters.applyFilters(state.jobs, fc);
  const ruleDropped = fc.jobHandle === 'collect' ? fr.dropped : [];
  if (fr.dropped.length) {
    const byReason = {};
    fr.dropped.forEach(j => { const k = String(j._dropReason).split('（')[0]; byReason[k] = (byReason[k] || 0) + 1; });
    const brief = Object.keys(byReason).map(k => k + '×' + byReason[k]).join(' · ');
    log('规则过滤：剔除 ' + fr.dropped.length + ' 个（' + brief + '）', 'warn');
    if (ruleDropped.length) log('  其中 ' + ruleDropped.length + ' 个按"保留展示"进审核列表（不筛不投）', 'info');
  }
  state.jobs = fr.kept;
  log('收集到 ' + state.jobs.length + ' 个岗位（规则过滤后）', 'success');
  if (!state.jobs.length && !ruleDropped.length) { state.phase = 'idle'; pushPhase(); return; }

  // 筛选（并发3）
  state.phase = 'screening'; pushPhase();
  log('AI 筛选中...');
  let done = 0; const total = state.jobs.length;
  progress(0, total, '筛选');
  let authFail = 0;
  const CONC = 3;
  for (let i = 0; i < state.jobs.length; i += CONC) {
    if (state.aborted) break; await waitIfPaused();
    const batch = state.jobs.slice(i, i + CONC);
    await Promise.all(batch.map(async (job) => {
      let res;
      try { res = await screenJob(cfg, job); }
      catch (e) {
        if (/API 40[13]|api key/i.test(String(e.message))) {
          res = { match: false, reason: 'API 鉴权失败' };
          authFail++;
          if (authFail === 1) log('✗ API 鉴权失败（401/403）：接口地址或密钥不对（或订阅额度已用完），请检查第 1 步配置，可点「恢复预设」', 'error');
          if (authFail >= 2) state.aborted = true;
        } else { res = { match: false, reason: '筛选异常:' + e.message }; }
      }
      state.screened.push(Object.assign({}, job, { match: res.match, reason: res.reason }));
      done++; progress(done, total, '筛选');
    }));
  }
  if (state.aborted) {
    log('筛选已中止，本轮结果未保存。修复配置后重新开始', 'warn');
    state.phase = 'idle'; pushPhase();
    return;
  }
  // 联系人级去重需要 HR 名，HR 名要等点开卡片才拿得到，所以审核阶段无法预判
  // 投递环节会按 (公司, HR) 实时判断
  const matched = state.screened.filter(j => j.match).length;
  log('筛选完成：匹配 ' + matched + ' / ' + total, 'success');
  // "保留展示"的规则剔除岗位：进审核列表置灰，默认不勾选
  ruleDropped.forEach(j => state.screened.push(Object.assign({}, j, { match: false, reason: '规则：' + (j._dropReason || '') })));
  // 存盘：SW 可能在审核期间被浏览器回收，投递时需从存储读回
  await chrome.storage.local.set({ sw_jobs: state.jobs, sw_greetings: state.greetings, sw_screened: state.screened });
  state.phase = 'review'; pushPhase();
  chrome.runtime.sendMessage({ type: 'SCREENED', screened: state.screened }).catch(() => {});
}

// ── 流程：投递（单个闭环：建联→进聊天页→发图片+招呼语→回搜索页→下一个）──
async function runDeliver(jobIds) {
  state.aborted = false; state.paused = false; state.results = [];
  state.phase = 'delivering'; pushPhase();
  // SW 可能在审核期间被回收，内存丢了就从存储读回
  if (!state.jobs.length) { const d = await chrome.storage.local.get(['sw_jobs', 'sw_greetings']); state.jobs = d.sw_jobs || []; state.greetings = d.sw_greetings || {}; }
  const cfg = await getCfg();
  if (!cfg.resumeImage) log('未上传简历图片，将只发招呼语', 'warn');

  const ps = await readPaceAndStats();
  const pace = ps.pace;
  const todayOk0 = todayOkOf(ps.stats);
  const quota = Math.min(pace.maxPerRun, Math.max(0, pace.dailyGoal - todayOk0));

  const ids = (jobIds || []).filter(id => !state.processed[id]);
  if (!ids.length) { log('没有可投递的岗位（可能已投过，可点重置）', 'warn'); finishDeliver(); return; }
  if (quota <= 0) {
    log('今日已投 ' + todayOk0 + ' / 目标 ' + pace.dailyGoal + '，本次不投递。可在"节奏设置"里调整单次上限或每日目标后继续', 'warn');
    finishDeliver('goal');
    return;
  }
  log('本轮配额：' + quota + ' 个（单次上限 ' + pace.maxPerRun + ' · 今日 ' + todayOk0 + '/' + pace.dailyGoal + '）');
  if (pace.postDeliverRest[0] < 5) log('⚠ 投递间隔低于 5 秒，账号风控风险较高，建议至少 5-8 秒', 'warn');
  const searchUrl = buildSearchUrl(cfg);

  let deliveredThisRun = 0;
  for (let k = 0; k < ids.length; k++) {
    if (state.aborted) break; await waitIfPaused();
    if (deliveredThisRun >= quota) {
      log('  ⏸ 已达单次投递上限（' + pace.maxPerRun + '），剩余 ' + (ids.length - k) + ' 个岗位未投。点"投递选中"可继续下一轮', 'warn');
      finishDeliver('quota');
      return;
    }
    if (pace.pauseOnGoal) {
      const okNow = todayOkOf((await readPaceAndStats()).stats);
      if (okNow >= pace.dailyGoal) {
        log('  ⏸ 已达今日目标（' + okNow + '/' + pace.dailyGoal + '），自动暂停。提高"每日目标"后可继续', 'warn');
        finishDeliver('goal');
        return;
      }
    }
    const job = findJob(ids[k]);
    if (!job) { log('[' + (k + 1) + '/' + ids.length + '] 找不到岗位数据，跳过', 'warn'); continue; }
    log('[' + (k + 1) + '/' + ids.length + '] ' + job.name + ' - ' + (job.company || ''));

    // 1. 回搜索页，点开卡片读取该岗位完整JD + HR 名
    const tab = await ensureTab(searchUrl);
    await ensureInjected(tab.id, 'src/content-search.js');
    log('  读取岗位JD + HR...');
    const jdr = await sendToTab(tab.id, { type: 'OPEN_JD', job: job });
    const jd = (jdr && jdr.jd) || '';
    const hrName = (jdr && jdr.hrName) || '';
    job.hrName = hrName;

    // 投递期二次校验：注册资金/地址规则（收集期卡片上没有这些数据）
    if (jdr && (jdr.fundText || jdr.addr)) {
      if (jdr.addr && !job.area) job.area = jdr.addr;
      const fi = BPFilters.parseFund(jdr.fundText || '');
      if (fi) { job.fund = fi.fund; job.fundCurrency = fi.currency; }
      const fundReason = BPFilters.checkFund(job, cfg.filterConfig);
      if (fundReason) {
        log('  ↳ 跳过（' + fundReason + '）', 'warn');
        state.results.push({ id: job.id, name: job.name, ok: false, msg: fundReason });
        bumpStat('skip');
        progress(k + 1, ids.length, '投递');
        await rand(pace.skipRest[0] * 1000, pace.skipRest[1] * 1000);
        continue;
      }
    }

    // 联系人级去重：HR 名拿不到时降级到只按企业名精确比较
    const cb = await isContactBlocked(job.company, hrName);
    if (cb.blocked) {
      log('  ↳ 跳过（已投过同企业 HR：' + (job.company || '') + (hrName ? ' · ' + hrName : '') + '）', 'warn');
      state.results.push({ id: job.id, name: job.name, ok: false, msg: '已投递过同联系人' });
      bumpStat('skip');
      progress(k + 1, ids.length, '投递');
      await rand(pace.skipRest[0] * 1000, pace.skipRest[1] * 1000);
      continue;
    }

    // 2. 用【完整JD + 简历】现场生成这个岗位专属的招呼语
    log('  AI生成专属招呼语...');
    let greeting = '';
    try { greeting = await genGreetingFromJD(cfg, job, jd); } catch (e) { log('  生成失败：' + e.message, 'error'); }
    if (!greeting) { recordFail(job, '招呼语生成失败'); log('  招呼语为空，跳过', 'warn'); progress(k + 1, ids.length, '投递'); continue; }

    // 3. 点立即沟通 → 继续沟通（跳聊天页），发送前按节奏随机等待
    log('  建立联系（立即沟通 → 继续沟通）...');
    await rand(pace.preSendDelay[0] * 1000, pace.preSendDelay[1] * 1000);
    await sendToTab(tab.id, { type: 'GO_CHAT', job: job });
    await waitTabComplete(tab.id); await sleep(2500);

    // 4. 聊天页当前打开的即该岗位会话，先发图片再发招呼语（无需匹配）
    const u = await curUrl(tab.id);
    if (u.indexOf('/web/geek/chat') < 0) { recordFail(job, '未跳转聊天页'); log('  未进入聊天页，跳过', 'error'); progress(k + 1, ids.length, '投递'); continue; }
    await ensureInjected(tab.id, 'src/content-chat.js');
    log('  发简历图片 + 招呼语...');
    const r = await sendToTab(tab.id, { type: 'SEND_ACTIVE', image: cfg.resumeImage || '', greeting: greeting });
    if (r && r.success) { recordOk(job); state.processed[job.id] = 1; deliveredThisRun++; await chrome.storage.local.set({ processed: state.processed }); log('  ✓ 投递成功' + (job.hrName ? '（HR: ' + job.hrName + '）' : ''), 'success'); }
    else { recordFail(job, (r && r.error) || '发送失败'); log('  失败：' + (r && r.error), 'error'); }
    progress(k + 1, ids.length, '投递');
    await rand(pace.postDeliverRest[0] * 1000, pace.postDeliverRest[1] * 1000);
  }
  finishDeliver();
}
function recordOk(job) {
  state.results.push({ id: job.id, name: job.name, ok: true });
  if (job && job.company) addContactToHistory(job.company, job.hrName || '').catch(() => {});
  bumpStat('ok');
}
function recordFail(job, msg) { state.results.push({ id: job.id, name: job.name, ok: false, msg: msg }); bumpStat('fail'); }
function finishDeliver(reason) {
  statQueue.then(() => {
    const ok = state.results.filter(r => r.ok).length;
    const fail = state.results.length - ok;
    state.phase = 'done'; pushPhase(reason);
    log('投递完成：成功 ' + ok + ' | 失败 ' + fail, 'success');
    chrome.runtime.sendMessage({ type: 'DONE', ok: ok, fail: fail }).catch(() => {});
  }).catch(() => {});
}

// ── 消息入口 ──
if (self.addEventListener) {
  self.addEventListener('unhandledrejection', (ev) => {
    try { log('✗ 后台异常：' + ((ev.reason && ev.reason.message) || String(ev.reason)), 'error'); } catch (e) {}
  });
  self.addEventListener('error', (ev) => {
    try { log('✗ 后台错误：' + (ev.message || 'unknown'), 'error'); } catch (e) {}
  });
}

const BUSY_PHASES = { collecting: 1, screening: 1, delivering: 1 };
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_COLLECT') {
    if (BUSY_PHASES[state.phase]) { log('当前正在 ' + state.phase + '，请先点「停止」', 'warn'); sendResponse({ ok: false, error: 'busy' }); return; }
    runCollect().catch(e => { log('✗ 收集异常：' + ((e && e.message) || e), 'error'); state.phase = 'idle'; pushPhase(); });
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'START_DELIVER') {
    if (BUSY_PHASES[state.phase]) { log('当前正在 ' + state.phase + '，请先点「停止」', 'warn'); sendResponse({ ok: false, error: 'busy' }); return; }
    runDeliver(msg.jobIds).catch(e => { log('✗ 投递异常：' + ((e && e.message) || e), 'error'); state.phase = 'idle'; pushPhase(); });
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'PAUSE') { state.paused = true; log('已暂停', 'warn'); sendResponse({ ok: true }); return; }
  if (msg.type === 'RESUME') { state.paused = false; log('继续', 'info'); sendResponse({ ok: true }); return; }
  if (msg.type === 'STOP') { state.aborted = true; state.paused = false; log('已停止', 'warn'); state.phase = 'idle'; pushPhase(); sendResponse({ ok: true }); return; }
  if (msg.type === 'RESET') { state.processed = {}; chrome.storage.local.set({ processed: {} }); state.jobs = []; state.screened = []; state.greetings = {}; state.results = []; state.phase = 'idle'; pushPhase(); log('已重置（清空本轮已投记录；企业去重记录保留）', 'warn'); sendResponse({ ok: true }); return; }
  if (msg.type === 'GET_STATE') { sendResponse({ phase: state.phase, screened: state.screened }); return; }
  if (msg.type === 'RUN_FILTER_DRY') {
    (async () => {
      try {
        const cfg = await getCfg();
        const d = await chrome.storage.local.get('sw_screened');
        const screened = d.sw_screened || [];
        const live = screened.filter(j => j.match);
        const fr = BPFilters.applyFilters(live, cfg.filterConfig);
        const demoted = fr.dropped.map(j => Object.assign({}, j, { match: false, reason: '规则：' + (j._dropReason || '') + '（原AI：' + (j.reason || '') + '）' }));
        const merged = fr.kept.concat(demoted);
        state.screened = merged;
        await chrome.storage.local.set({ sw_screened: merged });
        log('试算完成：规则再剔除 ' + demoted.length + ' / ' + live.length + '，保留 ' + fr.kept.length, 'success');
        chrome.runtime.sendMessage({ type: 'SCREENED', screened: merged }).catch(() => {});
        sendResponse({ ok: true, kept: fr.kept.length, dropped: demoted.length });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  // ── 联系人去重消息 ──
  if (msg.type === 'CLEAR_COMPANIES') {
    chrome.storage.local.set({ sentContacts: {} }, () => {
      log('已清空联系人去重记录', 'warn');
      chrome.runtime.sendMessage({ type: 'COMPANIES_UPDATED' }).catch(() => {});
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'GET_COMPANIES') {
    chrome.storage.local.get(['sentContacts']).then(d => {
      const sent = d.sentContacts || {};
      const list = Object.keys(sent).map(k => {
        const v = sent[k];
        return { key: k, company: v.company || k, hrName: v.hrName || '', count: v.count || 0, lastSentAt: v.lastSentAt || 0 };
      });
      list.sort((a, b) => (b.lastSentAt || 0) - (a.lastSentAt || 0));
      sendResponse({ ok: true, count: list.length, list: list });
    });
    return true;
  }
  // ── 投递统计 ──
  if (msg.type === 'GET_STATS') {
    (async () => {
      try {
        const ps = await readPaceAndStats();
        const stats = ps.stats;
        const now = new Date();
        const keyOf = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const tk = keyOf(now);
        const weekFrom = new Date(now); weekFrom.setDate(weekFrom.getDate() - 6);
        const wk = keyOf(weekFrom);
        const monthPrefix = tk.slice(0, 7);
        const sumKeys = filter => {
          const acc = { ok: 0, fail: 0, skip: 0 };
          for (const k of Object.keys(stats)) {
            if (!filter(k)) continue;
            acc.ok += stats[k].ok || 0; acc.fail += stats[k].fail || 0; acc.skip += stats[k].skip || 0;
          }
          return acc;
        };
        const days = [];
        for (let i = 13; i >= 0; i--) {
          const d2 = new Date(now); d2.setDate(d2.getDate() - i);
          const k = keyOf(d2); const s = stats[k] || {};
          days.push({ date: k, ok: s.ok || 0, fail: s.fail || 0, skip: s.skip || 0 });
        }
        sendResponse({
          ok: true,
          today: stats[tk] || { ok: 0, fail: 0, skip: 0 },
          week: sumKeys(k => k >= wk && k <= tk),
          month: sumKeys(k => k.slice(0, 7) === monthPrefix),
          goal: ps.goal,
          todayOk: todayOkOf(stats),
          dailyGoal: ps.pace.dailyGoal,
          days: days
        });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (msg.type === 'CLEAR_STATS') {
    chrome.storage.local.set({ deliverStats: {} }, () => {
      log('已清空投递统计', 'warn');
      sendResponse({ ok: true });
    });
    return true;
  }
});

chrome.storage.local.get(['processed', 'filterConfig']).then(r => {
  if (r.processed) state.processed = r.processed;
  if (!r.filterConfig) chrome.storage.local.set({ filterConfig: BPFilters.DEFAULT_FILTER });
});
