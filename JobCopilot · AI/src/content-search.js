// ===== 搜索页 content script：收集岗位 + 建立联系（立即沟通→继续沟通跳聊天页）=====
(function () {
  if (window.__bossToudiSearch) return;
  window.__bossToudiSearch = true;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ── 文本清洗：BOSS 大量用图标字体，textContent 会夹带私用区(PUA)/零宽/控制字符，显示成乱码 ──
  // 统一剔除这些字符并规整空白，避免污染审核列表和 AI 提示词。
  const GARBAGE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\uFFFD]/g;
  const ICON_GLYPHS = /[\u{E000}-\u{F8FF}\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;
  function stripGarbage(s) {
    return String(s == null ? '' : s).replace(GARBAGE, '').replace(ICON_GLYPHS, '');
  }
  function cleanText(s) {
    return stripGarbage(s).replace(/[\u00A0\u3000]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function cleanMultiline(s) {
    return stripGarbage(s).replace(/[\u00A0\u3000]/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }
  // 按选择器优先级取第一个非空文本（避免 querySelector 的树序把外层包裹元素选中）
  function firstText(root, sels) {
    for (const sel of sels) {
      const el = root.querySelector(sel);
      if (!el) continue;
      const t = cleanText(el.textContent);
      if (t) return t;
    }
    return '';
  }

  function getCards() { return Array.from(document.querySelectorAll(SELECTORS.jobs.jobCard)); }

  function parseCard(card) {
    const nameEl = card.querySelector(SELECTORS.jobs.jobName);
    const salEl = card.querySelector(SELECTORS.jobs.jobSalary);
    const linkEl = card.querySelector('a[href*="/job_detail/"]') || card.querySelector('a[ka][href]') || card.querySelector('a');
    const link = linkEl ? linkEl.href : '';
    const m = link.match(/job_detail\/([^.?]+)\.html/);
    const name = cleanText(nameEl && nameEl.textContent) || '未知岗位';
    const salary = cleanText(salEl && salEl.textContent);
    const id = (m && m[1]) || (name + '|' + salary);
    const tags = Array.from(card.querySelectorAll(SELECTORS.jobs.tagList))
      .map(t => cleanText(t.textContent)).filter(Boolean);
    const company = firstText(card, [
      '.company-name', '.company-info .company-name', '.company-info a',
      '.boss-info .company-name', '[class*="company-name"]', '[class*="company"] a'
    ]);
    const areaEl = card.querySelector('.job-area') || card.querySelector(SELECTORS.jobs.area);
    const area = cleanText(areaEl && areaEl.textContent);
    let activeState = 'unknown';
    const actEls = card.querySelectorAll(SELECTORS.jobs.activeTag);
    for (const el of actEls) {
      const t = cleanText(el.textContent);
      if (!t) continue;
      if (/本月|本月活跃/.test(t)) { activeState = 'month'; break; }
      if (/本周|周内/.test(t)) { activeState = 'week'; break; }
      if (/在线|刚刚活跃|今日活跃/.test(t)) { activeState = 'online'; break; }
    }
    let inviteCount = -1;
    const iv = cleanText(card.textContent).match(/(\d+)\s*人\s*(投递|沟通|邀请)/);
    if (iv) inviteCount = parseInt(iv[1], 10);
    return {
      id: id,
      name: name,
      salary: salary,
      tags: tags,
      company: company,
      link: link,
      area: area,
      activeState: activeState,
      inviteCount: inviteCount
    };
  }

  async function scrape(count) {
    const seen = {};
    const jobs = [];
    let stall = 0;
    for (let loop = 0; loop < 40 && jobs.length < count && stall < 4; loop++) {
      const cards = getCards();
      let added = 0;
      for (const c of cards) {
        const j = parseCard(c);
        if (j.id && !seen[j.id]) { seen[j.id] = 1; jobs.push(j); added++; if (jobs.length >= count) break; }
      }
      if (added === 0) stall++; else stall = 0;
      if (jobs.length >= count) break;
      window.scrollTo(0, document.body.scrollHeight);
      const container = document.querySelector('.job-list-container, .job-list-box, [class*="job-list"]');
      if (container) container.scrollTop = container.scrollHeight;
      await sleep(1200);
    }
    return jobs.slice(0, count);
  }

  function findCardByJob(job) {
    const cards = getCards();
    for (const c of cards) { const j = parseCard(c); if (job.id && j.id === job.id) return c; }
    for (const c of cards) { const j = parseCard(c); if (j.name === job.name && (!job.company || j.company === job.company)) return c; }
    return null;
  }

  // 目标岗位可能排在列表后面还没被渲染：滚动列表直到找到卡片（带上限，避免死循环）
  async function findCardByJobScroll(job) {
    for (let i = 0; i < 15; i++) {
      const c = findCardByJob(job);
      if (c) return c;
      window.scrollTo(0, document.body.scrollHeight);
      const container = document.querySelector('.job-list-container, .job-list-box, [class*="job-list"]');
      if (container) container.scrollTop = container.scrollHeight;
      await sleep(900);
    }
    return null;
  }

  function waitFor(sel, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) { clearInterval(iv); resolve(el); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(null); }
      }, 200);
    });
  }

  // 等待出现文字完全匹配的可见元素（用于弹窗"继续沟通"按钮）
  function waitForText(texts, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const els = document.querySelectorAll('a, button, span, div');
        for (const el of els) {
          const tx = (el.textContent || '').trim();
          if (texts.indexOf(tx) >= 0 && el.offsetParent !== null) { clearInterval(iv); resolve(el); return; }
        }
        if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(null); }
      }, 200);
    });
  }

  // 点开卡片 → 抓取右侧详情面板的完整JD + HR名
  async function openJD(job) {
    const card = await findCardByJobScroll(job);
    if (!card) return { success: false, error: '未找到岗位卡片' };
    card.scrollIntoView({ block: 'center' });
    await sleep(400);
    card.click();
    await sleep(1600);
    let jd = '';
    const det = document.querySelector('.job-detail-box, [class*="job-detail"], .detail-content, .job-detail');
    if (det) jd = cleanMultiline(det.innerText);
    if (!jd) {
      const secs = document.querySelectorAll('.job-sec-text, [class*="job-sec"], [class*="job-desc"]');
      jd = Array.from(secs).map(s => cleanMultiline(s.innerText)).filter(Boolean).join('\n');
    }
    // 抓取 HR 名（精确去重需要）
    let hrName = '';
    const hrCandidates = document.querySelectorAll(
      '.job-detail-box [class*="hr-name"], .job-detail-box [class*="boss-name"], ' +
      '.job-detail [class*="hr-name"], [class*="job-banner"] [class*="name"], ' +
      '.boss-info .name, [class*="hr-info"] [class*="name"], ' +
      '.job-detail-box .name, .job-detail .name'
    );
    for (const el of hrCandidates) {
      const t = cleanText(el.textContent);
      if (t && t.length <= 20) { hrName = t; break; }
    }
    // 兜底：详情面板前 3 行文本里挑短的那行作为 HR
    if (!hrName && det) {
      const lines = cleanMultiline(det.innerText).split('\n').map(s => s.trim()).filter(Boolean);
      for (const ln of lines) {
        if (ln.length >= 2 && ln.length <= 8 && !/公司|有限|股份|集团|科技|网络|经验|学历|薪资|岗位/.test(ln)) { hrName = ln; break; }
      }
    }
    // 去掉"先生/女士"等称谓，保证匹配键一致
    hrName = cleanText(hrName).replace(/\s*(先生|女士|老师|sir|mr|ms)\s*$/i, '').trim();
    let addr = '';
    let fundText = '';
    const infoText = det ? cleanMultiline(det.innerText) : '';
    if (infoText) {
      const lines = infoText.split('\n').map(s => s.trim()).filter(Boolean);
      for (const ln of lines) {
        if (!addr && /工作(地址|地点)|附近/.test(ln) && ln.length <= 40) addr = ln;
        if (!fundText && /注册资本/.test(ln)) fundText = ln;
      }
    }
    return { success: true, jd: jd.slice(0, 1800), hrName: hrName, addr: addr, fundText: fundText };
  }

  // 卡片已打开 → 点立即沟通 → 弹窗点"继续沟通"（跳转聊天页）
  async function goChat(job) {
    let btn = await waitFor(SELECTORS.jobs.immediateChatBtn, 5000);
    if (!btn) {
      const all = document.querySelectorAll('a, button, span');
      for (const el of all) { const tx = (el.textContent || '').trim(); if (tx === '立即沟通' || tx === '继续沟通') { btn = el; break; } }
    }
    if (!btn) { // 面板可能关了，重新点卡片
      const card = findCardByJob(job);
      if (card) { card.click(); await sleep(1200); btn = await waitFor(SELECTORS.jobs.immediateChatBtn, 4000); }
    }
    if (!btn) return { success: false, error: '未找到立即沟通按钮' };
    btn.click();
    await sleep(1500);
    const go = await waitForText(['继续沟通'], 4000);
    if (go) { go.click(); return { success: true, navigated: true }; }
    return { success: true, navigated: false };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SCRAPE') {
      scrape(msg.count || 20).then(jobs => sendResponse({ success: true, jobs: jobs })).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'OPEN_JD') {
      openJD(msg.job).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'GO_CHAT' || msg.type === 'INITIATE' || msg.type === 'CREATE_CONV') {
      goChat(msg.job).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
  });
})();
