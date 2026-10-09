// ===== 岗位过滤引擎：纯函数、无 DOM/Storage 依赖（可单测） =====
(function (root) {
  'use strict';

  const DEFAULT_FILTER = {
    listMode: 'off',
    blacklist: [],
    whitelist: [],
    salary: { min: 0, max: 0 },
    cities: [],
    addrExclude: [],
    active: { online: false, week: false, month: false },
    inviteMax: 0,
    kwMode: 'off',
    keywords: [],
    hardExclude: [],
    screenLevel: 'balanced',
    skipUsdFund: false,
    fundMin: 0,
    commute: { enabled: false, key: '', origin: '', driveMaxKm: 0, driveMaxMin: 0, walkMaxKm: 0, walkMaxMin: 0 },
    jobHandle: 'skip'
  };

  function toList(v) {
    if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
    if (typeof v === 'string') return v.split(/[,，;；\s]+/).map(s => s.trim()).filter(Boolean);
    return [];
  }

  function normalize(cfg) {
    const c = Object.assign({}, DEFAULT_FILTER, cfg || {});
    const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    c.salary = Object.assign({}, DEFAULT_FILTER.salary, isObj(cfg && cfg.salary) ? cfg.salary : {});
    c.active = Object.assign({}, DEFAULT_FILTER.active, isObj(cfg && cfg.active) ? cfg.active : {});
    c.commute = Object.assign({}, DEFAULT_FILTER.commute, isObj(cfg && cfg.commute) ? cfg.commute : {});
    c.blacklist = Array.isArray(c.blacklist) ? c.blacklist : [];
    c.whitelist = Array.isArray(c.whitelist) ? c.whitelist : [];
    c.cities = toList(c.cities);
    c.addrExclude = toList(c.addrExclude);
    c.keywords = toList(c.keywords);
    c.hardExclude = toList(c.hardExclude);
    c.screenLevel = ['loose', 'balanced', 'strict'].indexOf(c.screenLevel) >= 0 ? c.screenLevel : 'balanced';
    c.inviteMax = Number(c.inviteMax) || 0;
    c.fundMin = Number(c.fundMin) || 0;
    c.skipUsdFund = !!c.skipUsdFund;
    c.listMode = ['black', 'white'].indexOf(c.listMode) >= 0 ? c.listMode : 'off';
    c.kwMode = ['include', 'exclude'].indexOf(c.kwMode) >= 0 ? c.kwMode : 'off';
    c.jobHandle = c.jobHandle === 'collect' ? 'collect' : 'skip';
    return c;
  }

  // '10-15K·13薪' / '1.5-2.5万' / '8千-1.2万' / '200-400元/天' / '面议' → {min,max}（单位 K/月），无法解析返回 null
  function unitFactor(u, s) {
    if (u) { if (/万/.test(u)) return 10; if (/[Kk千]/.test(u)) return 1; }
    if (/万/.test(s)) return 10;
    if (/[Kk千]/.test(s)) return 1;
    if (/元\/(天|日)/.test(s)) return 22 / 1000;
    if (/元/.test(s)) return 1 / 1000;
    return null;
  }

  function parseSalary(text) {
    const s = String(text || '').replace(/\s+/g, '');
    if (!s || /面议|商议|私聊/.test(s)) return null;
    let lo, hi, u1 = '', u2 = '';
    let m = s.match(/^(\d+(?:\.\d+)?)(万|K|k|千)?$/);
    if (m) { lo = parseFloat(m[1]); hi = lo; u1 = u2 = m[2] || ''; }
    else {
      m = s.match(/(\d+(?:\.\d+)?)(万|K|k|千)?[-–~](\d+(?:\.\d+)?)(万|K|k|千)?/);
      if (!m) return null;
      lo = parseFloat(m[1]); hi = parseFloat(m[3]);
      u1 = m[2] || ''; u2 = m[4] || '';
    }
    const f1 = unitFactor(u1, s), f2 = unitFactor(u2, s);
    if (f1 == null || f2 == null) return null;
    lo *= f1; hi *= f2;
    if (!isFinite(lo) || !isFinite(hi)) return null;
    if (hi < lo) { const t = lo; lo = hi; hi = t; }
    return { min: Math.round(lo * 10) / 10, max: Math.round(hi * 10) / 10 };
  }

  // '注册资本 1000万人民币' → { fund: 1000(万), currency: 'cny' | 'usd' }
  function parseFund(text) {
    const t = String(text || '');
    const m = t.match(/注册资本[^0-9]{0,10}([\d,.]+)\s*(亿|万)?/);
    if (!m) return null;
    const num = parseFloat(String(m[1]).replace(/,/g, ''));
    if (!isFinite(num) || num <= 0) return null;
    const fund = m[2] === '亿' ? num * 10000 : num;
    return { fund: Math.round(fund * 10) / 10, currency: /美元|美圆|USD/i.test(t) ? 'usd' : 'cny' };
  }

  // 文本框 → 名单结构：每行一条，行尾 '@kw' 表示关键词匹配，'#' 开头为注释行
  function parseListText(text) {
    const out = [];
    String(text || '').split(/\r?\n/).forEach(raw => {
      const line = raw.trim();
      if (!line || line.charAt(0) === '#') return;
      const m = line.match(/^(.+?)\s*@kw$/i);
      if (m) { const name = m[1].trim(); if (name) out.push({ name: name, mode: 'keyword' }); }
      else out.push({ name: line, mode: 'exact' });
    });
    return out;
  }

  function serializeListText(list) {
    return (list || []).map(e => e && e.name ? (e.mode === 'keyword' ? e.name + ' @kw' : e.name) : '').filter(Boolean).join('\n');
  }

  function matchList(company, list) {
    const c = String(company || '').trim().toLowerCase();
    if (!c) return null;
    for (const e of (list || [])) {
      const n = String(e && e.name || '').trim().toLowerCase();
      if (!n) continue;
      if (e.mode === 'keyword' ? c.indexOf(n) >= 0 : c === n) return e;
    }
    return null;
  }

  // 单岗位规则检查：返回剔除理由（空串=通过）。顺序即短路顺序。
  function checkJob(j, cfgRaw) {
    const c = normalize(cfgRaw);
    const comp = j.company || '';

    if (c.listMode === 'black') {
      const hit = matchList(comp, c.blacklist);
      if (hit) return '黑名单：' + hit.name;
    }
    if (c.listMode === 'white') {
      const hit = matchList(comp, c.whitelist);
      if (!hit) return '白名单外';
    }

    const sal = parseSalary(j.salary);
    if (sal) {
      if (c.salary.min > 0 && sal.max < c.salary.min) return '薪资低于下限（' + (j.salary || '') + '）';
      if (c.salary.max > 0 && sal.min > c.salary.max) return '薪资高于上限（' + (j.salary || '') + '）';
    }

    const area = String(j.area || j.addr || '').trim();
    if (area) {
      if (c.cities.length && !c.cities.some(k => area.indexOf(k) >= 0)) return '城市不符（' + area + '）';
      if (c.addrExclude.length && c.addrExclude.some(k => area.indexOf(k) >= 0)) return '地址排除（' + area + '）';
    }

    const want = [];
    if (c.active.online) want.push('online');
    if (c.active.week) want.push('week');
    if (c.active.month) want.push('month');
    if (want.length && j.activeState && j.activeState !== 'unknown' && want.indexOf(j.activeState) < 0) {
      return '活跃度不符（' + j.activeState + '）';
    }

    if (c.inviteMax > 0 && typeof j.inviteCount === 'number' && j.inviteCount >= 0 && j.inviteCount > c.inviteMax) {
      return '邀请量过高（' + j.inviteCount + '）';
    }
    const hay = (String(j.name || '') + ' ' + (j.tags || []).join(' ')).toLowerCase();
    // 硬排除：命中即剔除，不进入 AI 筛选（省一次调用、也更果断）
    if (c.hardExclude.length) {
      const hit = c.hardExclude.find(k => hay.indexOf(String(k).toLowerCase()) >= 0);
      if (hit) return '硬排除命中（' + hit + '）';
    }
    if (c.keywords.length) {
      if (c.kwMode === 'include' && !c.keywords.some(k => hay.indexOf(k.toLowerCase()) >= 0)) return '关键词不含';
      if (c.kwMode === 'exclude' && c.keywords.some(k => hay.indexOf(k.toLowerCase()) >= 0)) return '关键词排除';
    }

    const fundReason = checkFund(j, c);
    if (fundReason) return fundReason;
    return checkCommuteNorm(j, c);
  }

  // 通勤判定的归一化版本：checkJob 传入的已是归一化配置，避免重复 normalize
  function checkCommuteNorm(j, c) {
    if (!j || !c.commute || !c.commute.enabled) return '';
    const m = j.commute;
    if (!m || typeof m !== 'object') return ''; // 未预计算（功能关闭/接口失败）→ 放行
    const reasons = [];
    if (c.commute.driveMaxKm > 0 && m.driveKm != null && m.driveKm > c.commute.driveMaxKm) reasons.push('驾车距离超 ' + c.commute.driveMaxKm + 'km');
    if (c.commute.driveMaxMin > 0 && m.driveMin != null && m.driveMin > c.commute.driveMaxMin) reasons.push('驾车时间超 ' + c.commute.driveMaxMin + ' 分钟');
    if (c.commute.walkMaxKm > 0 && m.walkKm != null && m.walkKm > c.commute.walkMaxKm) reasons.push('步行距离超 ' + c.commute.walkMaxKm + 'km');
    if (c.commute.walkMaxMin > 0 && m.walkMin != null && m.walkMin > c.commute.walkMaxMin) reasons.push('步行时间超 ' + c.commute.walkMaxMin + ' 分钟');
    return reasons.join('；');
  }

  // 通勤规则单独暴露：投递期由 amap.js 预计算好 job.commute 后可二次校验（本函数保持纯同步）
  function checkCommute(j, cfgRaw) {
    return checkCommuteNorm(j, normalize(cfgRaw));
  }

  // 注册资金规则单独暴露：投递期拿到 JD 后可二次校验
  function checkFund(j, cfgRaw) {
    const c = normalize(cfgRaw);
    if (!j || j.fund == null) return '';
    if (c.skipUsdFund && j.fundCurrency === 'usd') return '美元注册资金';
    if (c.fundMin > 0 && j.fund < c.fundMin) return '注册资金低于下限（' + j.fund + '万）';
    return '';
  }

  // 主入口：{kept, dropped}，dropped 项带 _dropReason
  function applyFilters(jobs, cfgRaw) {
    const c = normalize(cfgRaw);
    const kept = [];
    const dropped = [];
    for (const job of (jobs || [])) {
      const reason = checkJob(job, c);
      if (reason) dropped.push(Object.assign({}, job, { _dropReason: reason }));
      else kept.push(job);
    }
    return { kept: kept, dropped: dropped };
  }

  const BPFilters = {
    DEFAULT_FILTER: DEFAULT_FILTER,
    normalize: normalize,
    parseSalary: parseSalary,
    parseFund: parseFund,
    parseListText: parseListText,
    serializeListText: serializeListText,
    matchList: matchList,
    checkJob: checkJob,
    checkFund: checkFund,
    checkCommute: checkCommute,
    applyFilters: applyFilters
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BPFilters;
  root.BPFilters = BPFilters;
})(typeof self !== 'undefined' ? self : this);
