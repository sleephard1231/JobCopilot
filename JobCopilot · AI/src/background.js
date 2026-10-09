// ===== 小北智能招聘 Service Worker：编排 收集→筛选→审核→投递 + 自定义 LLM =====
importScripts('/src/selectors.js'); // 让 SW 也能用 CITY_MAP（否则城市永远是全国）
importScripts('/src/filters.js'); // 岗位过滤引擎（规则过滤前置，省 API）
importScripts('/src/amap.js'); // 高德通勤计算（投递期预计算 job.commute）

const RESUME_TEXT = ''; // 不内置任何个人简历，由用户在设置页"简历文字"填写

let state = {
  phase: 'idle', paused: false, aborted: false,
  verifyPending: false, consecFail: 0,
  jobs: [], screened: [], greetings: {}, results: [], processed: {},
  runActive: false, runJobIds: []
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

// ── 分段等待 / 心跳 / 看门狗：防止 MV3 SW 在长休中被回收后"静默停摆" ──
const WAIT_CHUNK_MS = 30000;          // 单段等待上限 30 秒，远低于 SW "单活动 5 分钟"回收线
const RUN_STALE_MS = 90000;           // 心跳超 90 秒未更新即视为中断
const RUN_MAX_AGE_MS = 15 * 60 * 1000; // 超过 15 分钟的陈旧任务不再自动续投（如隔天启动）
function randMs(range) { const a = range[0] * 1000, b = range[1] * 1000; return a + Math.random() * (b - a); }
// 分段等待：按请求时长递减（不依赖 Date.now，测试沙箱钳制定时器时也能瞬间跑完）；
// 每段刷新心跳并打印倒计时，暂停/停止即时响应
async function pacedWait(ms, label) {
  let remain = Math.max(0, Math.round(ms || 0));
  if (remain <= 0) return;
  if (label) log('⏳ ' + label + '（约 ' + Math.round(remain / 1000) + ' 秒）', 'info');
  while (remain > 0 && !state.aborted) {
    if (state.paused) { await waitIfPaused(); if (state.aborted) return; }
    const step = Math.min(remain, WAIT_CHUNK_MS);
    await sleep(step);
    remain -= step;
    if (state.aborted) return;
    beatHeartbeat();
    if (remain > 0) log('   ⏳ 剩余约 ' + Math.ceil(remain / 1000) + ' 秒…', 'info');
  }
}
// 投递心跳：写入 storage，供侧边栏看门狗与 alarms 自动续投判断"是否还活着"
function beatHeartbeat() {
  if (!state.runActive) return;
  try { chrome.storage.local.set({ deliverRun: { jobIds: state.runJobIds || [], active: true, at: Date.now() } }); } catch (e) {}
}
function markRunStart(jobIds) {
  state.runActive = true; state.runJobIds = (jobIds || []).slice();
  beatHeartbeat();
  try { if (chrome.alarms) chrome.alarms.create('deliverWatchdog', { periodInMinutes: 1 }); } catch (e) {}
}
function markRunEnd() {
  state.runActive = false; state.runJobIds = [];
  try { chrome.storage.local.set({ deliverRun: { jobIds: [], active: false, at: Date.now() } }); } catch (e) {}
  try { if (chrome.alarms) chrome.alarms.clear('deliverWatchdog'); } catch (e) {}
}
// SW 曾因长等待被回收：alarm 唤醒后自动续投剩余岗位（心跳陈旧 + 本进程空闲才触发，避免重复投）
let watchdogBusy = false;
async function deliverWatchdogTick() {
  if (watchdogBusy) return;
  watchdogBusy = true;
  try {
    const d = await chrome.storage.local.get('deliverRun');
    const run = d && d.deliverRun;
    if (!run || !run.active) { try { if (chrome.alarms) chrome.alarms.clear('deliverWatchdog'); } catch (e) {} return; }
    const age = Date.now() - (run.at || 0);
    if (age > RUN_MAX_AGE_MS) { log('上次投递任务已过期（' + Math.round(age / 60000) + ' 分钟无心跳），不再自动续投', 'warn'); markRunEnd(); return; }
    if (age < RUN_STALE_MS) return;      // 心跳新鲜，仍在正常等待
    if (BUSY_PHASES[state.phase]) return; // 本进程还在投递
    if (state.paused) return;             // 用户主动暂停
    log('⚠ 检测到上一轮投递中断（' + Math.round(age / 1000) + ' 秒无心跳），自动继续剩余 ' + ((run.jobIds || []).length) + ' 个岗位', 'warn');
    runDeliver(run.jobIds || []).catch(e => { log('✗ 自动续投异常：' + ((e && e.message) || e), 'error'); state.phase = 'idle'; pushPhase(); });
  } catch (e) {} finally { watchdogBusy = false; }
}
function getCfg() { return chrome.storage.local.get(['apiBaseUrl', 'apiKey', 'apiModel', 'resumeText', 'resumeImage', 'city', 'keyword', 'count', 'filterConfig', 'greetingTemplate', 'riskConfig']); }
function riskOf(cfg) {
  const r = (cfg && cfg.riskConfig) || {};
  const n = parseInt(r.maxConsecFail, 10);
  return { verifyDetect: r.verifyDetect !== false, maxConsecFail: n > 0 ? n : MAX_CONSEC_FAIL };
}
function filterCfg(cfg) { return BPFilters.normalize(cfg.filterConfig || BPFilters.DEFAULT_FILTER); }
function resumeFull(cfg) { return (cfg.resumeText || '').trim(); }
// 从卡片技能标签里分离出"经验要求""学历要求"，喂给 AI 时单列，判断更准
const EXP_PAT = /应届|经验不限|无经验|不限经验|\d+\s*年(?:以内|以下|以上|经验)?|\d+\s*[-–~]\s*\d+\s*年/;
const EDU_PAT = /学历不限|初中|中专|中技|高中|大专|本科|硕士|研究生|博士|MBA/;
function parseExpEdu(tags) {
  const list = (tags || []).map(t => String(t || '').trim()).filter(Boolean);
  return {
    exp: list.find(t => EXP_PAT.test(t)) || '',
    edu: list.find(t => EDU_PAT.test(t)) || ''
  };
}
// 喂给 AI 的岗位画像：尽量把卡片能拿到的信息都给全（多几十 token，换来判断更准）
function jobInfo(j) {
  const ee = parseExpEdu(j.tags);
  return [
    '岗位：' + (j.name || ''),
    '公司：' + (j.company || ''),
    '地区：' + (j.area || '未知'),
    '薪资：' + (j.salary || '未标注'),
    '经验要求：' + (ee.exp || '未标注'),
    '学历要求：' + (ee.edu || '未标注'),
    '技能标签：' + ((j.tags || []).join('、') || '无')
  ].join('\n');
}
function findJob(id) { for (var i = 0; i < state.jobs.length; i++) if (state.jobs[i].id === id) return state.jobs[i]; return null; }

// ── 投递节奏与统计（M2）──
// 默认取"稳健提速"节奏：投递后 20-40 秒、发送前 3-6 秒、单次上限 41、每日 60；
// 另含工作时段限制、每 N 个长休息、验证通过后冷却，均可在侧边栏"运行策略"调整。
const DEFAULT_PACE = {
  preSendDelay: [3, 6], postDeliverRest: [20, 40], skipRest: [1, 3],
  maxPerRun: 41, dailyGoal: 60, pauseOnGoal: true,
  workHours: { enabled: false, start: 9, end: 21 },
  longBreakEvery: 10, longBreakRest: [60, 150], verifyCooldownMin: 5
};
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
  // 工作时段 / 长休息 / 验证冷却：缺失或非法一律回退到默认值
  const whRaw = (pace.workHours && typeof pace.workHours === 'object') ? pace.workHours : {};
  const clampHour = (v, fb) => { const n = parseInt(v, 10); return isFinite(n) && n >= 0 && n <= 23 ? n : fb; };
  pace.workHours = {
    enabled: whRaw.enabled === true,
    start: clampHour(whRaw.start, DEFAULT_PACE.workHours.start),
    end: clampHour(whRaw.end, DEFAULT_PACE.workHours.end)
  };
  pace.longBreakEvery = parseInt(pace.longBreakEvery, 10);
  if (!isFinite(pace.longBreakEvery) || pace.longBreakEvery < 0) pace.longBreakEvery = DEFAULT_PACE.longBreakEvery;
  pace.longBreakRest = clampRange(pace.longBreakRest, DEFAULT_PACE.longBreakRest);
  pace.verifyCooldownMin = parseInt(pace.verifyCooldownMin, 10);
  if (!isFinite(pace.verifyCooldownMin) || pace.verifyCooldownMin < 0) pace.verifyCooldownMin = DEFAULT_PACE.verifyCooldownMin;
  return {
    pace: pace,
    goal: Object.assign({}, DEFAULT_STAT_GOAL, d.statGoal || {}),
    stats: d.deliverStats || {}
  };
}
function todayOkOf(stats) { const s = stats ? stats[todayKey()] : null; return s ? (s.ok || 0) : 0; }

// ── 按筛选规则分别计数：{"黑名单": n, "薪资低于下限": n, ...}，用于调规则时有数据依据 ──
let ruleStatQueue = Promise.resolve();
function bumpRuleStat(name) {
  const n = String(name || '').trim();
  if (!n) return;
  ruleStatQueue = ruleStatQueue.then(async () => {
    const d = await chrome.storage.local.get('ruleStats');
    const rs = d.ruleStats || {};
    rs[n] = (rs[n] || 0) + 1;
    await chrome.storage.local.set({ ruleStats: rs });
  }).catch(() => {});
  return ruleStatQueue;
}
async function readRuleStats() {
  const d = await chrome.storage.local.get('ruleStats');
  return d.ruleStats || {};
}

// 投递期通勤校验：高德预计算 job.commute（异步源不进 filters），异常时放行不阻塞投递
async function checkCommuteAtDeliver(cfg, job) {
  const fc = filterCfg(cfg);
  if (!fc.commute || !fc.commute.enabled || !(fc.commute.key || '').trim() || !(fc.commute.origin || '').trim()) return '';
  try { return await BPAmap.checkCommute(job, fc.commute); }
  catch (e) { log('  通勤计算失败（已放行）：' + (e.message || e), 'warn'); return ''; }
}

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
  const c = normStr(company);
  if (!c) return { blocked: false, matchedKey: '' };
  const sent = await loadContactHistory();
  if (!Object.keys(sent).length) return { blocked: false, matchedKey: '' };
  const h = normStr(hrName);
  // 1) 精确双键完全一致
  const exact = contactKey(c, h);
  if (sent[exact]) return { blocked: true, matchedKey: exact };
  // 2) 降级：同公司，且本次 HR 或历史条目 HR 有一方为空 → 视为同一联系人（HR 名常抓不到，避免重复打扰）
  const prefix = c + '｜';
  for (const k of Object.keys(sent)) {
    if (k.indexOf(prefix) !== 0) continue;
    if (!h || !normStr(sent[k] && sent[k].hrName)) return { blocked: true, matchedKey: k };
  }
  return { blocked: false, matchedKey: '' };
}
async function addContactToHistory(company, hrName) {
  const c = normStr(company);
  const h = normStr(hrName);
  if (!c) return; // 没企业名就跳过
  // HR 名为空也允许写入（部分 BOSS 岗位不显示 HR）；匹配时同公司且任一方 HR 为空视为同一条目
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

// OpenCode Go/Zen 网关要求携带稳定的 x-opencode-session 才能路由：缺失会返回 400 MissingSessionID
// 值是任意 opaque 字符串，这里生成一次并持久化，保证同一浏览器会话稳定
let _ocSessionId = null;
async function opencodeSessionId() {
  if (_ocSessionId) return _ocSessionId;
  try { const s = await chrome.storage.local.get('ocSessionId'); if (s && s.ocSessionId) { _ocSessionId = s.ocSessionId; return _ocSessionId; } } catch (e) {}
  _ocSessionId = 'jobcopilot-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  try { await chrome.storage.local.set({ ocSessionId: _ocSessionId }); } catch (e) {}
  return _ocSessionId;
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
  // 超时保护：端点无响应时不能让整轮收集/投递永久挂起（STOP 也无法取消在途 fetch）
  const timeoutMs = (opts && opts.timeoutMs) || 90000;
  const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timer = controller ? setTimeout(() => { try { controller.abort(); } catch (e) {} }, timeoutMs) : null;
  let resp;
  try {
    // 限流/暂时不可用：最多重试 2 次（退避 1s、2s），其余状态码只试一次
    for (let attempt = 0; ; attempt++) {
      try {
        const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey };
        if (/opencode\.ai/i.test(endpoint)) headers['x-opencode-session'] = await opencodeSessionId();
        resp = await fetch(endpoint, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body),
          signal: controller ? controller.signal : undefined
        });
      } catch (e) {
        if (controller && controller.signal.aborted) {
          throw new Error('接口超时（' + Math.round(timeoutMs / 1000) + ' 秒无响应）：请检查网络或接口地址后重试');
        }
        // fetch 直接抛 TypeError 多为：无网络 / 该域名未授权（host_permissions 收紧后自定义端点需在面板授权）
        throw new Error('无法连接接口（' + (e.message || '网络错误') + '）：请检查网络，或回到面板点「保存设置」重新授权自定义接口域名');
      }
      if ((resp.status === 429 || resp.status === 503) && attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      break;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
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
// 严格度可在侧边栏"过滤规则 → AI 筛选严格度"切换；宁缺毋滥/宁多勿漏由用户定
const SCREEN_SYS = {
  loose: '你是资深求职助手。请完全依据下面提供的【求职者简历】，判断某个岗位是否值得该求职者投递。\n【判断标准·宽松】只要岗位方向与简历的专业/技能/经历大体相关就保留(match=true)；只有明显无关（如简历是技术岗、岗位却是纯销售/体力/完全跨行）才剔除(match=false)。宁可多留，别漏掉机会。请依据简历本身判断，不要套用任何固定行业或级别。\n【输出】只输出一个JSON对象，不要markdown：{"match":true或false,"score":0到100的契合度,"reason":"一句话理由","flags":["关键不符点，最多3条，无则空数组"]}',
  balanced: '你是资深求职助手。请完全依据下面提供的【求职者简历】，判断某个岗位是否值得该求职者投递。\n【判断标准·适中】保留(match=true)：岗位方向与求职者简历的专业/技能/经历相关，且求职者的经验年限、学历、级别够得着该岗位（不超纲）。剔除(match=false)：方向与简历明显无关；岗位要求的经验/学历/硬技能明显超出简历；岗位级别明显高于求职者当前水平。请依据简历本身判断，不要套用任何固定行业或级别。\n【输出】只输出一个JSON对象，不要markdown：{"match":true或false,"score":0到100的契合度,"reason":"一句话理由","flags":["关键不符点，最多3条，无则空数组"]}',
  strict: '你是资深求职助手。请完全依据下面提供的【求职者简历】，判断某个岗位是否值得该求职者投递。\n【判断标准·严格】只有岗位方向、核心技能、经验年限、学历要求都与简历明显匹配时才保留(match=true)。出现以下任一情况即剔除(match=false)：方向偏离；岗位要求的硬技能简历里没有；经验年限或学历够不着/明显超纲；岗位级别高于当前水平；职责偏销售/外包/驻场等与简历不符。宁缺毋滥。请依据简历本身判断，不要套用任何固定行业或级别。\n【输出】只输出一个JSON对象，不要markdown：{"match":true或false,"score":0到100的契合度,"reason":"一句话理由","flags":["关键不符点，最多3条，无则空数组"]}'
};
// 契合度 score：0=完全不符，100=高度匹配。模型没给/非法时按 match 兜底一个合理分，保证排序可用
function normalizeScore(v, match) {
  let n = parseInt(v, 10);
  if (!isFinite(n)) n = match ? 70 : 20;
  return Math.max(0, Math.min(100, n));
}
async function screenJob(cfg, job) {
  const lvl = filterCfg(cfg).screenLevel || 'balanced';
  const sys = SCREEN_SYS[lvl] || SCREEN_SYS.balanced;
  const user = '求职者简历：\n' + resumeFull(cfg) + '\n\n待判断岗位：\n' + jobInfo(job) + '\n\n严格输出JSON。';
  const raw = await callLLM([{ role: 'system', content: sys }, { role: 'user', content: user }], 4096, { json: true, noThink: true });
  const p = parseMatch(raw);
  if (!p) return { match: false, reason: 'AI解析失败', score: 0, flags: [] };
  const match = p.match === true || p.match === 'true';
  const flags = Array.isArray(p.flags) ? p.flags.map(x => String(x).trim()).filter(Boolean).slice(0, 3) : [];
  return { match: match, reason: (p.reason || '').toString(), score: normalizeScore(p.score, match), flags: flags };
}

// ── 招呼语模板：变量 {{岗位}} {{公司}} {{薪资}} {{地区}} {{HR}} {{技能}} {{关键词}} ──
// AI 优先，模板兜底：AI 挂了照样能发（不再让整轮投递中断在招呼语上）
const TPL_VARS = [
  { k: ['岗位', 'job'], v: j => j.name || '' },
  { k: ['公司', 'company'], v: j => j.company || '' },
  { k: ['薪资', 'salary'], v: j => j.salary || '' },
  { k: ['地区', 'area'], v: j => j.area || '' },
  { k: ['HR', 'hr'], v: j => j.hrName || '' },
  { k: ['技能', 'tags'], v: j => (j.tags || []).slice(0, 3).join('、') },
  { k: ['关键词', 'keyword'], v: j => j.keyword || '' }
];
function renderTemplate(tpl, job, cfg) {
  let out = String(tpl || '');
  const jobVars = Object.assign({}, job, { keyword: (cfg && cfg.keyword) || '' });
  for (const t of TPL_VARS) {
    for (const name of t.k) {
      out = out.replace(new RegExp('\\{\\{\\s*' + name + '\\s*\\}\\}', 'gi'), () => t.v(jobVars));
    }
  }
  return out.replace(/\{\{[^}]*\}\}/g, '').replace(/[ \t]+/g, ' ').trim(); // 清掉未识别的变量占位
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
function sendToTab(tabId, msg, timeoutMs) {
  const ms = timeoutMs || 15000;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => finish({ success: false, error: '页面响应超时（' + Math.round(ms / 1000) + ' 秒无响应）' }), ms);
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) finish({ success: false, error: chrome.runtime.lastError.message });
        else finish(resp || { success: false, error: 'no response' });
      });
    } catch (e) { finish({ success: false, error: (e && e.message) || String(e) }); }
  });
}
function waitTabComplete(tabId, timeoutMs) {
  const ms = timeoutMs || 30000;
  return new Promise((resolve) => {
    let done = false, settle = null;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); if (settle) clearTimeout(settle); chrome.tabs.onUpdated.removeListener(lis); resolve(); };
    const timer = setTimeout(finish, ms);
    // 页面 complete 后再给 1.2 秒让渲染稳定；超时则直接放行，避免永久挂起
    const onComplete = () => { chrome.tabs.onUpdated.removeListener(lis); if (!settle) settle = setTimeout(finish, 1200); };
    function lis(id, info) { if (id === tabId && info.status === 'complete') onComplete(); }
    chrome.tabs.onUpdated.addListener(lis);
    chrome.tabs.get(tabId, (t) => { if (t && t.status === 'complete') onComplete(); });
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
// 轮询等待条件满足（替代盲等固定 sleep）：condFn 返回真值即停，超时返回 null
async function waitForCond(condFn, timeout, stepMs) {
  const t0 = Date.now();
  for (;;) {
    const v = await condFn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > (timeout || 5000)) return null;
    await sleep(stepMs || 400);
  }
}
// 等待 tab URL 包含指定片段（GO_CHAT 跳转聊天页后用，替代固定 sleep 2500）
// 中途撞上安全验证页时提前返回，由调用方识别并暂停
function waitUrlContains(tabId, substr, timeout) {
  return waitForCond(async () => {
    const u = await curUrl(tabId);
    if (verifyGuardOn() && isVerifyUrl(u)) return u;
    return u.indexOf(substr) >= 0 ? u : null;
  }, timeout || 6000, 400);
}
// ── 安全验证页检测：BOSS 风控会跳到 security-check/验证码页，继续跑只会整轮失败并加重风控 ──
const MAX_CONSEC_FAIL = 5; // 连续失败熔断默认阈值（可在侧边栏"运行策略"调整，成功一次即清零）
function verifyGuardOn() { return !state.risk || state.risk.verifyDetect !== false; }
function isVerifyUrl(u) {
  try {
    const p = new URL(String(u || '')).pathname; // 只看路径，避免关键词里带 verify 误判
    return /security-check|captcha|verify|geetest|yidun/i.test(p) || /\/safe(\/|$)/i.test(p);
  } catch (e) { return false; }
}
function pauseForVerify(url) {
  if (!verifyGuardOn()) return; // 用户在"运行策略"里关掉了验证页检测
  if (state.verifyPending) return;
  state.verifyPending = true;
  state.paused = true;
  log('🔒 检测到安全验证：' + (url || ''), 'error');
  log('   请在浏览器标签页手动完成滑块/验证，完成后回到面板点「继续」', 'warn');
  chrome.runtime.sendMessage({ type: 'VERIFY_REQUIRED' }).catch(() => {});
}
// 验证通过后的强制冷却：刚过验证就立刻高频操作极易二次触发风控
async function cooldownAfterVerify() {
  let mins = 0;
  try { const ps = await readPaceAndStats(); mins = ps.pace.verifyCooldownMin || 0; } catch (e) {}
  if (!(mins > 0)) return;
  await pacedWait(mins * 60 * 1000, '🧊 安全验证已通过，冷却后自动继续（可点「停止」取消）');
}
// 验证页等待：返回 true=用户点了停止；false=验证已恢复（或用户关闭了检测）
async function waitOutVerify(tabId) {
  if (!verifyGuardOn()) return false;
  let recovered = false; // 本次调用确实观察到过验证页，恢复后才执行冷却
  for (;;) {
    const u = await curUrl(tabId);
    if (!isVerifyUrl(u)) { if (recovered) await cooldownAfterVerify(); return false; }
    recovered = true;
    pauseForVerify(u);
    await waitIfPaused();
    if (state.aborted) return true;
  }
}
// 当前 tab 若是验证页则等待人工处理；返回 true=验证曾出现且已恢复（调用方可重试当前动作）
async function checkVerifyTab(tabId) {
  if (!verifyGuardOn()) return false;
  const u = await curUrl(tabId);
  if (!isVerifyUrl(u)) return false;
  return !(await waitOutVerify(tabId));
}
// 探测 content script 是否已注入并可响应（页面刚加载完成后的就绪判断）
async function contentReady(tabId, file, timeout) {
  const t0 = Date.now();
  let verifySeen = false; // DOM 检测到过验证组件，恢复后同样要冷却
  for (;;) {
    const r = await sendToTab(tabId, { type: 'PING' }, 4000);
    if (r && r.success) {
      // 页面内出现验证码组件（URL 可能没变）：同样暂停等人工处理
      if (r.verify && verifyGuardOn()) { verifySeen = true; pauseForVerify('页面出现验证码组件'); await waitIfPaused(); if (state.aborted) return false; continue; }
      if (verifySeen) await cooldownAfterVerify();
      return true;
    }
    await ensureInjected(tabId, file);
    if (Date.now() - t0 > (timeout || 2500)) return false;
    await sleep(300);
  }
}
// 复用本插件自己创建/接管的标签页，绝不劫持用户正在浏览的 BOSS 页面
// tabId 存 storage.session：MV3 SW 会被回收，内存丢失后仍能找回上次那个页，避免每次运行都新开 tab
let bossTabId = null;
async function loadTabId() {
  if (bossTabId != null) return bossTabId;
  try {
    if (chrome.storage && chrome.storage.session) {
      const d = await chrome.storage.session.get('bossTabId');
      if (d && d.bossTabId != null) bossTabId = d.bossTabId;
    }
  } catch (e) {}
  return bossTabId;
}
async function saveTabId(id) {
  bossTabId = id;
  try { if (chrome.storage && chrome.storage.session) await chrome.storage.session.set({ bossTabId: id }); } catch (e) {}
}
function getTabById(id) {
  return new Promise(res => chrome.tabs.get(id, t => res(chrome.runtime.lastError ? null : (t || null))));
}
function isZhipinUrl(u) { return /^https?:\/\/([^/]*\.)?zhipin\.com\//i.test(String(u || '')); }
async function acquireTab(url) {
  let tab = null;
  const id = await loadTabId();
  if (id != null) {
    tab = await getTabById(id);
    if (!tab || !isZhipinUrl(tab.url)) tab = null; // 自己那个页被关了/被导航走了 → 新建
  }
  if (!tab) { tab = await chrome.tabs.create({ url: url }); await saveTabId(tab.id); }
  else await chrome.tabs.update(tab.id, { url: url });
  return tab;
}
async function ensureTab(url) {
  const tab = await acquireTab(url);
  await waitTabComplete(tab.id);
  if (await waitOutVerify(tab.id)) return tab; // 命中安全验证页：暂停等人工处理
  const ready = await contentReady(tab.id, 'src/content-search.js', 2500);
  if (!ready) await sleep(500); // 探测失败兜底：等一拍再让上层重试逻辑接管
  return tab;
}
async function getSearchTab(cfg) { return ensureTab(buildSearchUrl(cfg)); }
function curUrl(tabId) { return new Promise(res => chrome.tabs.get(tabId, t => res((t && t.url) || ''))); }

// ── 流程：收集 + 筛选 ──
async function runCollect() {
  state.aborted = false; state.paused = false; state.verifyPending = false;
  state.jobs = []; state.screened = []; state.greetings = {}; state.results = [];
  markRunEnd(); // 新一轮收集作废上一轮未完成的投递任务，避免看门狗误续投
  state.phase = 'collecting'; pushPhase();
  const cfg = await getCfg();
  state.risk = riskOf(cfg);
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
    if (await checkVerifyTab(tab.id)) { i = -1; continue; } // 安全验证等待不计入重试次数，完成后重试
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
    fr.dropped.forEach(j => {
      const k = String(j._dropReason).split('（')[0];
      byReason[k] = (byReason[k] || 0) + 1;
      bumpRuleStat(k);
    });
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
          res = { match: false, reason: 'API 鉴权失败', score: 0, flags: [] };
          authFail++;
          if (authFail === 1) log('✗ API 鉴权失败（401/403）：接口地址或密钥不对（或订阅额度已用完），请检查第 1 步配置，可点「恢复预设」', 'error');
          if (authFail >= 2) state.aborted = true;
        } else { res = { match: false, reason: '筛选异常:' + e.message, score: 0, flags: [] }; }
      }
      state.screened.push(Object.assign({}, job, { match: res.match, reason: res.reason, score: res.score, flags: res.flags || [] }));
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
  state.verifyPending = false; state.consecFail = 0;
  state.phase = 'delivering'; pushPhase();
  markRunStart(jobIds);
  // SW 可能在审核期间被回收，内存丢了就从存储读回
  if (!state.jobs.length) { const d = await chrome.storage.local.get(['sw_jobs', 'sw_greetings']); state.jobs = d.sw_jobs || []; state.greetings = d.sw_greetings || {}; }
  const cfg = await getCfg();
  state.risk = riskOf(cfg);
  if (!cfg.resumeImage) log('未上传简历图片，将只发招呼语', 'warn');

  const ps = await readPaceAndStats();
  const pace = ps.pace;
  const todayOk0 = todayOkOf(ps.stats);
  const quota = Math.min(pace.maxPerRun, Math.max(0, pace.dailyGoal - todayOk0));

  // 工作时段限制：避免凌晨/非工作时段批量操作这种极不自然的账号行为
  if (pace.workHours && pace.workHours.enabled) {
    const h = new Date().getHours();
    const ws = pace.workHours.start, we = pace.workHours.end;
    const inHours = ws <= we ? (h >= ws && h < we) : (h >= ws || h < we);
    if (!inHours) {
      log('当前 ' + h + ' 点不在工作时段（' + ws + ':00-' + we + ':00），已停止本轮投递。可在"运行策略"调整或关闭限制', 'warn');
      finishDeliver('hours');
      return;
    }
  }

  const ids = (jobIds || []).filter(id => !state.processed[id]);
  if (!ids.length) { log('没有可投递的岗位（可能已投过，可点重置）', 'warn'); finishDeliver(); return; }
  if (quota <= 0) {
    log('今日已投 ' + todayOk0 + ' / 目标 ' + pace.dailyGoal + '，本次不投递。可在"节奏设置"里调整单次上限或每日目标后继续', 'warn');
    finishDeliver('goal');
    return;
  }
  log('本轮配额：' + quota + ' 个（单次上限 ' + pace.maxPerRun + ' · 今日 ' + todayOk0 + '/' + pace.dailyGoal + '）');
  if (pace.postDeliverRest[0] < 15) log('⚠ 投递间隔低于 15 秒，账号风控风险较高，建议至少 20-40 秒', 'warn');
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
      // job.addr 是详情页精确工作地址（通勤计算用），area 不够精确会解析失败被放行
      if (jdr.addr) { job.addr = jdr.addr; if (!job.area) job.area = jdr.addr; }
      const fi = BPFilters.parseFund(jdr.fundText || '');
      if (fi) { job.fund = fi.fund; job.fundCurrency = fi.currency; }
      const fundReason = BPFilters.checkFund(job, cfg.filterConfig);
      if (fundReason) {
        log('  ↳ 跳过（' + fundReason + '）', 'warn');
        bumpRuleStat(String(fundReason).split('（')[0]);
        state.results.push({ id: job.id, name: job.name, ok: false, msg: fundReason });
        bumpStat('skip');
        progress(k + 1, ids.length, '投递');
        await pacedWait(randMs(pace.skipRest), '');
        continue;
      }
    }

    // 投递期通勤校验：高德算距离/时间（数据在 filters 判定前由 BPAmap 预计算，filters 保持纯同步）
    const commuteReason = await checkCommuteAtDeliver(cfg, job);
    if (commuteReason) {
      log('  ↳ 跳过（' + commuteReason + '）', 'warn');
      bumpRuleStat('通勤距离');
      state.results.push({ id: job.id, name: job.name, ok: false, msg: commuteReason });
      bumpStat('skip');
      progress(k + 1, ids.length, '投递');
      await pacedWait(randMs(pace.skipRest), '');
      continue;
    }

    // 联系人级去重：HR 名拿不到时降级到只按企业名精确比较
    const cb = await isContactBlocked(job.company, hrName);
    if (cb.blocked) {
      log('  ↳ 跳过（已投过同企业 HR：' + (job.company || '') + (hrName ? ' · ' + hrName : '') + '）', 'warn');
      state.results.push({ id: job.id, name: job.name, ok: false, msg: '已投递过同联系人' });
      bumpStat('skip');
      progress(k + 1, ids.length, '投递');
      await pacedWait(randMs(pace.skipRest), '');
      continue;
    }

    // 2. 用【完整JD + 简历】现场生成这个岗位专属的招呼语；配了模板时 AI 失败自动兜底
    log('  AI生成专属招呼语...');
    const tpl = (cfg.greetingTemplate || '').trim();
    let greeting = '';
    let via = 'AI';
    try { greeting = await genGreetingFromJD(cfg, job, jd); } catch (e) { log('  生成失败：' + e.message, 'error'); }
    if (!greeting && tpl) {
      greeting = renderTemplate(tpl, job, cfg);
      if (greeting) { via = '模板'; log('  AI 不可用，已按自定义模板生成兜底招呼语', 'warn'); }
    }
    if (!greeting) {
      const tripped = recordFail(job, '招呼语生成失败');
      log('  招呼语为空，跳过（可在设置里配"招呼语模板"作为兜底）', 'warn'); progress(k + 1, ids.length, '投递');
      if (tripped) { finishDeliver('failstreak'); return; }
      continue;
    }
    job.greetingVia = via;

    // 3. 点立即沟通 → 继续沟通（跳聊天页），发送前按节奏随机等待
    log('  建立联系（立即沟通 → 继续沟通）...');
    await pacedWait(randMs(pace.preSendDelay), '');
    const gc = await sendToTab(tab.id, { type: 'GO_CHAT', job: job });
    // 平台配额弹窗：当日名额用完，本轮到此为止（继续点只会反复弹窗，且有风控风险）
    if (gc && gc.quota) {
      state.results.push({ id: job.id, name: job.name, ok: false, msg: '平台额度用完' });
      bumpStat('skip');
      log('  ⏸ 平台提示今日沟通名额已用完，自动收工。明日再试或开通对应服务后继续', 'warn');
      finishDeliver('limit');
      return;
    }
    if (gc && !gc.success) {
      if (await checkVerifyTab(tab.id)) { k--; continue; } // 安全验证完成后重试当前岗位
      const tripped = recordFail(job, gc.error || '建联失败');
      log('  失败：' + (gc.error || '建联失败'), 'error'); progress(k + 1, ids.length, '投递');
      if (tripped) { finishDeliver('failstreak'); return; }
      continue;
    }
    await waitTabComplete(tab.id);
    // 条件等待跳转聊天页（替代固定 sleep 2500）：最多 6 秒，兜底再等 800ms
    const inChat = await waitUrlContains(tab.id, '/web/geek/chat', 6000);
    if (!inChat) await sleep(800);

    // 4. 聊天页当前打开的即该岗位会话，先发图片再发招呼语（无需匹配）
    const u = await curUrl(tab.id);
    if (verifyGuardOn() && isVerifyUrl(u)) { // 点立即沟通触发安全验证：等人工处理后重试当前岗位
      if (await waitOutVerify(tab.id)) break;
      k--; continue;
    }
    if (u.indexOf('/web/geek/chat') < 0) {
      const tripped = recordFail(job, '未跳转聊天页');
      log('  未进入聊天页，跳过', 'error'); progress(k + 1, ids.length, '投递');
      if (tripped) { finishDeliver('failstreak'); return; }
      continue;
    }
    await ensureInjected(tab.id, 'src/content-chat.js');
    log('  发简历图片 + 招呼语...');
    const r = await sendToTab(tab.id, { type: 'SEND_ACTIVE', image: cfg.resumeImage || '', greeting: greeting });
    let failedTrip = false;
    if (r && r.success) {
      await recordOk(job); // 等待联系人落盘，避免紧接着的下一轮去重读到旧数据
      state.processed[job.id] = 1; deliveredThisRun++;
      await chrome.storage.local.set({ processed: state.processed });
      log('  ✓ 投递成功' + (job.hrName ? '（HR: ' + job.hrName + '）' : ''), 'success');
      if (r.imageConfirmed === false) log('  ⚠ 简历图片未能确认送达，建议抽查该会话', 'warn');
    } else { failedTrip = recordFail(job, (r && r.error) || '发送失败'); log('  失败：' + (r && r.error), 'error'); }
    progress(k + 1, ids.length, '投递');
    if (failedTrip) { finishDeliver('failstreak'); return; }
    await pacedWait(randMs(pace.postDeliverRest), '投递后休息');
    // 长休息：每投 N 个停一段较长时间，避免连续高频批量建联
    if (pace.longBreakEvery > 0 && deliveredThisRun > 0 && deliveredThisRun % pace.longBreakEvery === 0) {
      log('  ☕ 已连续投 ' + deliveredThisRun + ' 个，长休息 ' + pace.longBreakRest[0] + '-' + pace.longBreakRest[1] + ' 秒后再继续', 'info');
      await pacedWait(randMs(pace.longBreakRest), '长休息');
    }
  }
  finishDeliver();
}
async function recordOk(job) {
  state.results.push({ id: job.id, name: job.name, ok: true });
  state.consecFail = 0; // 成功一次即清零熔断计数
  // 关键：等联系人写入完成再继续，否则用户快速再投时去重会漏判导致重复发送
  try { if (job && job.company) await addContactToHistory(job.company, job.hrName || ''); } catch (e) {}
  bumpStat('ok');
}
// 记录失败并累计连续失败；达到阈值返回 true，调用方据此熔断收尾
function recordFail(job, msg) {
  state.results.push({ id: job.id, name: job.name, ok: false, msg: msg });
  state.consecFail = (state.consecFail || 0) + 1;
  bumpStat('fail');
  const maxFail = (state.risk && state.risk.maxConsecFail) || MAX_CONSEC_FAIL;
  if (state.consecFail >= maxFail) {
    log('⛔ 连续 ' + state.consecFail + ' 次投递失败，已自动熔断，避免继续无效操作触发风控', 'error');
    log('   请检查网络/接口/页面状态，处理后重新点「投递选中」继续未投岗位', 'warn');
    return true;
  }
  return false;
}
function finishDeliver(reason) {
  markRunEnd();
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
// alarms 看门狗：SW 被回收后仍能按周期唤醒，自动续投中断的投递
if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((a) => { if (a && a.name === 'deliverWatchdog') deliverWatchdogTick(); });
}
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
  if (msg.type === 'RESUME') {
    state.paused = false;
    const wasVerify = state.verifyPending;
    state.verifyPending = false;
    if (wasVerify) log('继续（已确认完成安全验证）', 'info'); else log('继续', 'info');
    chrome.runtime.sendMessage({ type: 'VERIFY_CLEARED' }).catch(() => {});
    sendResponse({ ok: true }); return;
  }
  if (msg.type === 'STOP') { state.aborted = true; state.paused = false; markRunEnd(); log('已停止', 'warn'); state.phase = 'idle'; pushPhase(); sendResponse({ ok: true }); return; }
  if (msg.type === 'RESET') { state.processed = {}; chrome.storage.local.set({ processed: {} }); state.jobs = []; state.screened = []; state.greetings = {}; state.results = []; markRunEnd(); state.phase = 'idle'; pushPhase(); log('已重置（清空本轮已投记录；企业去重记录保留）', 'warn'); sendResponse({ ok: true }); return; }
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
        const ruleStats = await readRuleStats();
        const rules = Object.keys(ruleStats).map(k => ({ rule: k, count: ruleStats[k] })).sort((a, b) => b.count - a.count).slice(0, 8);
        sendResponse({
          ok: true,
          today: stats[tk] || { ok: 0, fail: 0, skip: 0 },
          week: sumKeys(k => k >= wk && k <= tk),
          month: sumKeys(k => k.slice(0, 7) === monthPrefix),
          goal: ps.goal,
          todayOk: todayOkOf(stats),
          dailyGoal: ps.pace.dailyGoal,
          days: days,
          rules: rules
        });
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }
  if (msg.type === 'CLEAR_STATS') {
    chrome.storage.local.set({ deliverStats: {}, ruleStats: {} }, () => {
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

// SW 启动（含被回收后重启）时：若上一轮投递任务仍在存盘中，补挂看门狗并尝试续投
chrome.storage.local.get('deliverRun').then(r => {
  const run = r && r.deliverRun;
  if (!run || !run.active) return;
  if (Date.now() - (run.at || 0) > RUN_MAX_AGE_MS) {
    chrome.storage.local.set({ deliverRun: { jobIds: [], active: false, at: Date.now() } });
    return;
  }
  try { if (chrome.alarms) chrome.alarms.create('deliverWatchdog', { periodInMinutes: 1 }); } catch (e) {}
  deliverWatchdogTick();
}).catch(() => {});
