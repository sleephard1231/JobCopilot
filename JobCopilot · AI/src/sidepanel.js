// ===== 小北智能招聘 侧边栏(自定义 LLM + 科技风 UI) =====
const $ = (id) => document.getElementById(id);
const CFG_FIELDS = ['apiBaseUrl', 'apiModel', 'apiKey', 'resumeText', 'keyword', 'city', 'count'];
// 服务商预设：选一个自动填接口地址 + 模型（key 需用户自备，OpenCode 内置）
const PRESETS = {
  opencode: { label: 'OpenCode', url: 'https://opencode.ai/zen/go/v1/chat/completions', model: 'deepseek-v4-flash', builtinKey: true },
  'deepseek-flash': { label: 'DeepSeek · V4 Flash', url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-flash' },
  'deepseek-pro': { label: 'DeepSeek · V4 Pro', url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-v4-pro' },
  'glm-5.3': { label: '智谱 GLM-5.3', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-5.3' },
  'glm-4.7': { label: '智谱 GLM-4.7', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4.7' },
  'glm-4.7-flash': { label: '智谱 GLM-4.7-Flash', url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4.7-flash' }
};
const DEFAULT_PRESET_ID = 'opencode';
const PRESET = PRESETS[DEFAULT_PRESET_ID];

if (chrome.runtime.getManifest) $('appVersion').textContent = 'v' + chrome.runtime.getManifest().version;

// ===== 折叠 =====
document.querySelectorAll('.card-header[data-toggle]').forEach(h => {
  h.addEventListener('click', () => {
    const body = $(h.dataset.toggle);
    const isHidden = body.style.display === 'none';
    body.style.display = isHidden ? 'flex' : 'none';
    const icon = h.querySelector('.btn-icon svg');
    if (icon) icon.style.transform = isHidden ? 'rotate(0deg)' : 'rotate(-90deg)';
  });
});

// ===== 载入配置(兼容旧 dsKey) =====
chrome.storage.local.get(CFG_FIELDS.concat(['resumeImage', 'dsKey', 'presetMigrated']), (d) => {
  const apiKey = d.apiKey || d.dsKey || '';
  CFG_FIELDS.forEach(f => {
    const v = f === 'apiKey' ? apiKey : d[f];
    if (v !== undefined && $(f)) $(f).value = v;
  });
  // 旧版默认配置（deepseek.com + deepseek-chat）一次性迁移到内置预设。
  // 只迁移一次：避免用户后来主动选择 DeepSeek 预设时又被覆盖回 OpenCode。
  const legacyDeepSeek = d.apiBaseUrl === 'https://api.deepseek.com/v1/chat/completions' && (d.apiModel || 'deepseek-chat') === 'deepseek-chat';
  if (!d.presetMigrated && legacyDeepSeek) {
    applyPreset(true, '✓ 检测到旧版 DeepSeek 默认配置，已自动切换到内置预设（OpenCode · DeepSeek V4 Flash）');
  }
  if (!d.presetMigrated) chrome.storage.local.set({ presetMigrated: true });
  // 默认值,方便新用户上手
  if (!$('apiBaseUrl').value) $('apiBaseUrl').value = PRESET.url;
  if (!$('apiModel').value) $('apiModel').value = PRESET.model;
  if (!$('apiKey').value) $('apiKey').value = typeof __OPENCODE_API_KEY__ !== 'undefined' ? __OPENCODE_API_KEY__ : '';
  syncPresetSelect();
  if (d.resumeImage) showImg(d.resumeImage);
});

function syncPresetSelect() {
  const url = ($('apiBaseUrl').value || '').trim();
  const model = ($('apiModel').value || '').trim();
  let found = 'custom';
  for (const id of Object.keys(PRESETS)) {
    if (PRESETS[id].url === url && PRESETS[id].model === model) { found = id; break; }
  }
  $('presetSelect').value = found;
}

function applyPresetById(id, save, logText) {
  const p = PRESETS[id];
  if (!p) return;
  $('apiBaseUrl').value = p.url;
  $('apiModel').value = p.model;
  if (p.builtinKey) {
    if (typeof __OPENCODE_API_KEY__ !== 'undefined' && __OPENCODE_API_KEY__) $('apiKey').value = __OPENCODE_API_KEY__;
  } else if (typeof __OPENCODE_API_KEY__ !== 'undefined' && $('apiKey').value === __OPENCODE_API_KEY__) {
    $('apiKey').value = ''; // 换到别的服务商时清掉内置 key，避免误用
  }
  syncPresetSelect();
  if (!save) return;
  const obj = {};
  ['apiBaseUrl', 'apiModel', 'apiKey'].forEach(f => { obj[f] = $(f).value; });
  chrome.storage.local.set(obj, () => addLog(logText || ('✓ 已切换到预设：' + (p.label || id)), 'success'));
}

function applyPreset(save, logText) { return applyPresetById(DEFAULT_PRESET_ID, save, logText); }

$('btnRestorePreset').addEventListener('click', () => applyPreset(true));

$('presetSelect').addEventListener('change', () => {
  const id = $('presetSelect').value;
  if (id === 'custom') return;
  applyPresetById(id, true);
});

['apiBaseUrl', 'apiModel'].forEach(f => $(f).addEventListener('input', syncPresetSelect));

function showImg(dataUrl) {
  $('imgPrev').innerHTML = '<img src="' + dataUrl + '" alt="简历预览">';
}

$('resumeImg').addEventListener('change', (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    showImg(ev.target.result);
    chrome.storage.local.set({ resumeImage: ev.target.result });
  };
  reader.readAsDataURL(file);
});

$('saveCfg').addEventListener('click', () => {
  const obj = {};
  CFG_FIELDS.forEach(f => { obj[f] = $(f).value; });
  chrome.storage.local.set(obj, () => {
    const s = $('saved');
    s.classList.add('show');
    setTimeout(() => s.classList.remove('show'), 1500);
    addLog('✓ 配置已保存', 'success');
  });
});

function saveCfgSync() {
  return new Promise(res => {
    const obj = {};
    CFG_FIELDS.forEach(f => { obj[f] = $(f).value; });
    chrome.storage.local.set(obj, res);
  });
}

// ===== 岗位过滤（02 卡片）=====
function collectFilterCfg() {
  const lm = document.querySelector('input[name="listMode"]:checked');
  const jh = document.querySelector('input[name="jobHandle"]:checked');
  return {
    listMode: lm ? lm.value : 'off',
    blacklist: BPFilters.parseListText($('blackList').value),
    whitelist: BPFilters.parseListText($('whiteList').value),
    salary: { min: parseInt($('salMin').value, 10) || 0, max: parseInt($('salMax').value, 10) || 0 },
    cities: $('fCities').value,
    addrExclude: $('fAddrEx').value,
    active: { online: $('actOnline').checked, week: $('actWeek').checked, month: $('actMonth').checked },
    inviteMax: parseInt($('inviteMax').value, 10) || 0,
    kwMode: $('kwMode').value,
    keywords: $('fKeywords').value,
    skipUsdFund: $('skipUsdFund').checked,
    fundMin: parseInt($('fundMin').value, 10) || 0,
    jobHandle: jh ? jh.value : 'skip'
  };
}

function applyFilterCfgToUI(c) {
  c = c || {};
  const lm = c.listMode || 'off';
  document.querySelectorAll('input[name="listMode"]').forEach(r => { r.checked = r.value === lm; });
  const jh = c.jobHandle || 'skip';
  document.querySelectorAll('input[name="jobHandle"]').forEach(r => { r.checked = r.value === jh; });
  $('blackList').value = BPFilters.serializeListText(c.blacklist);
  $('whiteList').value = BPFilters.serializeListText(c.whitelist);
  const sal = c.salary || {};
  $('salMin').value = sal.min > 0 ? sal.min : '';
  $('salMax').value = sal.max > 0 ? sal.max : '';
  $('fCities').value = Array.isArray(c.cities) ? c.cities.join(', ') : (c.cities || '');
  $('fAddrEx').value = Array.isArray(c.addrExclude) ? c.addrExclude.join(', ') : (c.addrExclude || '');
  const act = c.active || {};
  $('actOnline').checked = !!act.online;
  $('actWeek').checked = !!act.week;
  $('actMonth').checked = !!act.month;
  $('inviteMax').value = c.inviteMax > 0 ? c.inviteMax : '';
  $('kwMode').value = c.kwMode || 'off';
  $('fKeywords').value = Array.isArray(c.keywords) ? c.keywords.join(', ') : (c.keywords || '');
  $('skipUsdFund').checked = !!c.skipUsdFund;
  $('fundMin').value = c.fundMin > 0 ? c.fundMin : '';
}

function saveFilterCfg(showToast) {
  return new Promise(res => {
    chrome.storage.local.set({ filterConfig: collectFilterCfg() }, () => {
      if (showToast) {
        const s = $('filterSaved');
        s.classList.add('show');
        setTimeout(() => s.classList.remove('show'), 1500);
      }
      res();
    });
  });
}

$('btnSaveFilter').addEventListener('click', () => saveFilterCfg(true));

$('btnDryRun').addEventListener('click', async () => {
  await saveFilterCfg(false);
  chrome.runtime.sendMessage({ type: 'RUN_FILTER_DRY' }, (resp) => {
    if (!resp || !resp.ok) return addLog('✗ 试算失败：' + ((resp && resp.error) || '无响应（需先完成一次收集+筛选）'), 'error');
    addLog('✓ 试算：保留 ' + resp.kept + '，规则再剔除 ' + resp.dropped, 'success');
  });
});

chrome.storage.local.get('filterConfig').then(d => applyFilterCfgToUI(d.filterConfig));

// ===== 运行控制 =====
let isPaused = false;
const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg><span>暂停</span>';
const RESUME_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>继续</span>';

$('btnCollect').addEventListener('click', async () => {
  if (!guardAlive()) return;
  const lb = document.getElementById('logBody');
  if (lb) lb.style.display = 'flex';
  await saveCfgSync();
  await saveFilterCfg(false);
  if (!$('apiBaseUrl').value.trim()) return addLog('✗ 请填写 API 端点', 'error');
  if (!$('apiModel').value.trim()) return addLog('✗ 请填写模型名', 'error');
  if (!$('apiKey').value.trim()) return addLog('✗ 请填写 API Key', 'error');
  if (!$('keyword').value.trim()) return addLog('✗ 请填写岗位关键词', 'error');
  $('reviewCard').style.display = 'none';
  setRunning(true);
  chrome.runtime.sendMessage({ type: 'START_COLLECT' }, (resp) => { if (resp && resp.ok === false) setRunning(false); });
});

$('btnDeliver').addEventListener('click', () => {
  if (!guardAlive()) return;
  const ids = Array.from(document.querySelectorAll('.job-item:not(.skip) input:checked')).map(c => c.dataset.id);
  if (!ids.length) return addLog('✗ 请至少勾选一个岗位', 'error');
  setRunning(true);
  addLog('▶ 开始投递 ' + ids.length + ' 个岗位', 'info');
  chrome.runtime.sendMessage({ type: 'START_DELIVER', jobIds: ids }, (resp) => { if (resp && resp.ok === false) setRunning(false); });
});

$('btnPause').addEventListener('click', () => {
  isPaused = !isPaused;
  $('btnPause').innerHTML = isPaused ? RESUME_ICON : PAUSE_ICON;
  chrome.runtime.sendMessage({ type: isPaused ? 'PAUSE' : 'RESUME' });
});

$('btnStop').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'STOP' });
  setRunning(false);
});

$('btnReset').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RESET' });
  $('reviewCard').style.display = 'none';
  setRunning(false);
  $('progressBar').style.width = '0%';
  $('progText').textContent = '';
});

$('clearLog').addEventListener('click', () => { $('log').innerHTML = ''; });

$('selAll').addEventListener('change', (e) => {
  document.querySelectorAll('.job-item:not(.skip) input').forEach(c => c.checked = e.target.checked);
});

function setRunning(running) {
  $('btnCollect').disabled = running;
  $('btnPause').disabled = !running;
  $('btnStop').disabled = !running;
  $('statusDot').className = 'status-dot' + (running ? ' running' : '');
  $('headerStatus').textContent = running ? '运行中' : '就绪';
  if (!running) {
    isPaused = false;
    $('btnPause').innerHTML = PAUSE_ICON;
  }
}

// ===== 侧边栏存活守卫：扩展重载后旧面板会变成孤儿上下文，点击一律静默失败 =====
function swDead() {
  try {
    // 扩展重载后旧面板的 chrome.runtime.id 会被清空，这是可靠的同步失效信号
    if (!chrome.runtime.id) return true;
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, () => { if (chrome.runtime.lastError) {} });
    return false;
  } catch (e) { return true; }
}
function warnDead() {
  let b = document.getElementById('deadBanner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'deadBanner';
    b.className = 'dead-banner';
    b.textContent = '扩展已更新：点击这里刷新面板，否则所有按钮都会没反应';
    b.onclick = () => location.reload();
    document.body.insertBefore(b, document.body.firstChild);
  }
}
function guardAlive() {
  if (swDead()) {
    warnDead();
    addLog('✗ 扩展上下文已失效（面板是旧的），请点页面顶部的红色横幅刷新', 'error');
    return false;
  }
  return true;
}

// ===== 审核列表 =====
function renderReview(screened) {
  const matched = screened.filter(j => j.match);
  const skipped = screened.filter(j => !j.match);
  $('reviewCount').textContent = matched.length + ' / ' + screened.length;
  let html = '';
  matched.forEach(j => {
    html += '<div class="job-item">'
      + '<input type="checkbox" checked data-id="' + esc(j.id) + '">'
      + '<div class="job-main">'
      + '<div class="job-title">' + esc(j.name) + '</div>'
      + '<div class="job-sub">' + esc(j.company) + ' · ' + esc(j.salary) + '</div>'
      + '<span class="job-reason m">✓ ' + esc(j.reason) + '</span>'
      + '</div></div>';
  });
  skipped.forEach(j => {
    html += '<div class="job-item skip">'
      + '<input type="checkbox" disabled data-id="' + esc(j.id) + '">'
      + '<div class="job-main">'
      + '<div class="job-title">' + esc(j.name) + '</div>'
      + '<div class="job-sub">' + esc(j.company) + ' · ' + esc(j.salary) + '</div>'
      + '<span class="job-reason s">✗ ' + esc(j.reason) + '</span>'
      + '</div></div>';
  });
  $('reviewList').innerHTML = html || '<div class="job-sub" style="text-align:center;padding:20px">暂无岗位数据</div>';
  $('reviewCard').style.display = 'block';
}

function esc(s) {
  return (s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ===== 已投递企业面板 =====
function refreshCompanies() {
  chrome.runtime.sendMessage({ type: 'GET_COMPANIES' }, (resp) => {
    if (!resp || !resp.ok) return;
    $('companiesCount').textContent = String(resp.count || 0);
    const list = resp.list || [];
    if (!list.length) {
      $('companiesList').innerHTML = '<div class="companies-empty">暂无记录。投递成功后会自动累积在此。</div>';
      return;
    }
    let html = '<div class="companies-summary">共 ' + list.length + ' 位已投递联系人</div>';
    html += '<div class="companies-scroll">';
    for (const c of list.slice(0, 200)) {
      const last = c.lastSentAt ? new Date(c.lastSentAt).toLocaleDateString() : '';
      const hrTxt = c.hrName ? '<span class="co-hr">' + esc(c.hrName) + '</span>' : '<span class="co-hr empty">未识别 HR</span>';
      html += '<div class="co-row">'
        + '<span class="co-name">' + esc(c.company) + '</span>'
        + hrTxt
        + '<span class="co-meta">×' + (c.count || 1) + (last ? ' · ' + last : '') + '</span>'
        + '</div>';
    }
    if (list.length > 200) html += '<div class="companies-empty">仅显示前 200 条</div>';
    html += '</div>';
    $('companiesList').innerHTML = html;
  });
}

$('btnClearCompanies').addEventListener('click', () => {
  const total = ($('companiesCount').textContent || '0');
  if (!parseInt(total)) { addLog('当前无企业记录', 'warn'); return; }
  if (!confirm('确认清空已投递企业记录？清空后下次收集就不会再过滤这些企业。')) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_COMPANIES' }, (resp) => {
    if (resp && resp.ok) { addLog('✓ 已清空企业记录', 'warn'); refreshCompanies(); }
  });
});

// 初次载入列表
refreshCompanies();

// ===== 导出 / 导入 JSON =====
function downloadJSON(obj, filename) {
  const text = JSON.stringify(obj, null, 2);
  // 加 BOM 让 Windows 记事本也能正确显示中文
  const blob = new Blob(['﻿' + text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}

$('btnExportCompanies').addEventListener('click', () => {
  const total = parseInt($('companiesCount').textContent || '0');
  if (!total) { addLog('当前无联系人记录可导出', 'warn'); return; }
  chrome.storage.local.get(['sentContacts'], (d) => {
    const payload = {
      _type: 'Xiaobei.Contacts',
      _version: 1,
      _exportedAt: new Date().toISOString(),
      sentContacts: d.sentContacts || {}
    };
    const name = 'xiaobei-contacts-' + new Date().toISOString().slice(0, 10) + '.json';
    downloadJSON(payload, name);
    addLog('✓ 已导出 ' + Object.keys(payload.sentContacts).length + ' 位联系人 → ' + name, 'success');
  });
});

$('btnImportCompanies').addEventListener('click', () => { $('importFileInput').click(); });

$('importFileInput').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = ''; // 清空以允许重复选择同名文件
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { addLog('✗ 文件过大（>5MB），已拒绝', 'error'); return; }
  const reader = new FileReader();
  reader.onload = (ev) => {
    let data;
    try { data = JSON.parse(ev.target.result); }
    catch (err) { addLog('✗ JSON 解析失败：' + err.message, 'error'); return; }
    if (!data || typeof data !== 'object') { addLog('✗ 文件内容不是 JSON 对象', 'error'); return; }
    if (data._type && data._type !== 'Xiaobei.Contacts' && data._type !== 'JobCopilot.Contacts') {
      addLog('✗ 文件类型不匹配（期望 Xiaobei.Contacts）', 'error'); return;
    }
    const incoming = data.sentContacts;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      addLog('✗ sentContacts 字段缺失或格式错误', 'error'); return;
    }
    // 校验每个条目结构
    for (const k of Object.keys(incoming)) {
      const v = incoming[k];
      if (!v || typeof v !== 'object' || typeof v.count !== 'number') {
        addLog('✗ 条目 "' + k + '" 格式错误，已中止', 'error'); return;
      }
    }
    // 合并策略：提示用户
    const current = parseInt($('companiesCount').textContent || '0');
    const incomingCount = Object.keys(incoming).length;
    let action;
    if (current === 0) action = '直接导入';
    else action = '合并（保留现有 + 添加新条目，已存在的 count 取较大值）';
    if (!confirm('检测到 ' + incomingCount + ' 位联系人。\n当前已有 ' + current + ' 位。\n\n点击"确定"将' + action + '。\n点击"取消"放弃。')) return;

    chrome.storage.local.get(['sentContacts'], (cur) => {
      const merged = cur.sentContacts || {};
      let addedNew = 0, updated = 0, kept = 0;
      const now = Date.now();
      for (const k of Object.keys(incoming)) {
        const inc = incoming[k];
        if (!merged[k]) {
          merged[k] = {
            company: inc.company || k,
            hrName: inc.hrName || '',
            count: inc.count || 1,
            firstSentAt: inc.firstSentAt || now,
            lastSentAt: inc.lastSentAt || now
          };
          addedNew++;
        } else {
          const cur2 = merged[k];
          if ((inc.count || 0) > (cur2.count || 0)) { cur2.count = inc.count; updated++; }
          if ((inc.lastSentAt || 0) > (cur2.lastSentAt || 0)) cur2.lastSentAt = inc.lastSentAt;
          if (!cur2.firstSentAt || (inc.firstSentAt && inc.firstSentAt < cur2.firstSentAt)) cur2.firstSentAt = inc.firstSentAt;
          kept++;
        }
      }
      chrome.storage.local.set({ sentContacts: merged }, () => {
        addLog('✓ 导入完成：新增 ' + addedNew + ' | 更新 ' + updated + ' | 已有 ' + kept + ' | 合计 ' + Object.keys(merged).length, 'success');
        refreshCompanies();
      });
    });
  };
  reader.onerror = () => addLog('✗ 文件读取失败', 'error');
  reader.readAsText(file, 'utf-8');
});

// ===== 投递统计 + 节奏设置 =====
function refreshStats() {
  chrome.runtime.sendMessage({ type: 'GET_STATS' }, (resp) => {
    if (!resp || !resp.ok || !resp.today) return;
    $('statToday').textContent = resp.today.ok || 0;
    $('statWeek').textContent = resp.week.ok || 0;
    $('statMonth').textContent = resp.month.ok || 0;
    $('statTodayBadge').textContent = resp.today.ok || 0;
    const monthly = resp.goal.monthly || 0;
    $('statGoalText').textContent = (resp.month.ok || 0) + ' / ' + monthly;
    $('goalBar').style.width = (monthly ? Math.min(100, resp.month.ok / monthly * 100) : 0) + '%';
    const max = Math.max.apply(null, [1].concat(resp.days.map(d => d.ok + d.fail)));
    $('statChart').innerHTML = resp.days.map(d => {
      const total = d.ok + d.fail;
      const h = total > 0 ? Math.max(6, total / max * 100) : 2;
      return '<div class="bar-col" title="' + esc(d.date) + ' 成功' + d.ok + ' 失败' + d.fail + ' 跳过' + d.skip + '">'
        + '<div class="bar' + (total ? '' : ' empty') + '" style="height:' + h + '%"></div>'
        + '<span class="bar-date">' + esc(d.date.slice(8)) + '</span></div>';
    }).join('');
    if (!$('monthlyGoal').value) $('monthlyGoal').value = monthly > 0 ? monthly : '';
  });
}

$('btnSaveGoal').addEventListener('click', () => {
  const monthly = parseInt($('monthlyGoal').value, 10) || 0;
  if (monthly <= 0) return addLog('请填写有效的本月目标数', 'warn');
  chrome.storage.local.get('statGoal', d => {
    chrome.storage.local.set({ statGoal: Object.assign({ monthly: 300 }, d.statGoal || {}, { monthly: monthly }) }, () => {
      addLog('✓ 已保存本月目标：' + monthly, 'success');
      refreshStats();
    });
  });
});

$('btnClearStats').addEventListener('click', () => {
  if (!confirm('确认清空全部投递统计？此操作不可恢复。')) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_STATS' }, (resp) => {
    if (resp && resp.ok) { addLog('已清空投递统计', 'warn'); refreshStats(); }
  });
});

function loadPaceUI() {
  chrome.storage.local.get('paceConfig', (d) => {
    const p = d.paceConfig || {};
    $('maxPerRun').value = p.maxPerRun > 0 ? p.maxPerRun : '';
    $('dailyGoal').value = p.dailyGoal > 0 ? p.dailyGoal : '';
    $('pauseOnGoal').checked = p.pauseOnGoal !== false;
    $('postRestText').value = Array.isArray(p.postDeliverRest) ? p.postDeliverRest[0] + '-' + p.postDeliverRest[1] : '';
    $('preSendText').value = Array.isArray(p.preSendDelay) ? p.preSendDelay[0] + '-' + p.preSendDelay[1] : '';
  });
}

$('btnSavePace').addEventListener('click', () => {
  chrome.storage.local.get('paceConfig', (d) => {
    const p = Object.assign({ preSendDelay: [2, 4], postDeliverRest: [5, 8], skipRest: [2, 4], maxPerRun: 30, dailyGoal: 60, pauseOnGoal: true }, d.paceConfig || {});
    p.maxPerRun = parseInt($('maxPerRun').value, 10) || p.maxPerRun;
    p.dailyGoal = parseInt($('dailyGoal').value, 10) || p.dailyGoal;
    p.pauseOnGoal = $('pauseOnGoal').checked;
    const parseRange = (raw, fallback) => {
      const m = String(raw || '').trim().match(/^(\d+)\s*-\s*(\d+)$/);
      if (!m) return fallback;
      const lo = parseInt(m[1], 10); const hi = parseInt(m[2], 10);
      return [Math.min(lo, hi), Math.max(lo, hi)];
    };
    p.postDeliverRest = parseRange($('postRestText').value, p.postDeliverRest);
    p.preSendDelay = parseRange($('preSendText').value, p.preSendDelay);
    chrome.storage.local.set({ paceConfig: p }, () => {
      const s = $('paceSaved');
      s.classList.add('show');
      setTimeout(() => s.classList.remove('show'), 1500);
      addLog('✓ 节奏已保存：单次上限 ' + p.maxPerRun + ' · 每日目标 ' + p.dailyGoal + ' · 投递后休息 ' + p.postDeliverRest[0] + '-' + p.postDeliverRest[1] + 's', 'success');
    });
  });
});

loadPaceUI();
refreshStats();

// ===== 消息接收 =====
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'LOG') addLog(msg.text, msg.level);
  if (msg.type === 'PROGRESS') {
    $('progText').textContent = (msg.label ? msg.label + ' · ' : '') + msg.cur + ' / ' + msg.total;
    const pct = msg.total ? (msg.cur / msg.total * 100) : 0;
    $('progressBar').style.width = pct + '%';
  }
  if (msg.type === 'PHASE') {
    const map = {
      idle: '待开始',
      collecting: '收集中',
      screening: 'AI 筛选中',
      review: '待审核',
      delivering: '投递中',
      done: '已完成'
    };
    let label = map[msg.phase] || msg.phase;
    if (msg.reason === 'goal') label = '达标暂停';
    if (msg.reason === 'quota') label = '单次上限暂停';
    $('phaseText').textContent = label;
    if (msg.reason) addLog('⏸ ' + label + '（投递记录与统计已更新）', 'warn');
    if (msg.phase === 'review' || msg.phase === 'done' || msg.phase === 'idle') {
      setRunning(false);
    }
    if (msg.phase === 'done') {
      $('statusDot').className = 'status-dot success';
      $('headerStatus').textContent = msg.reason ? label : '已完成';
      refreshStats();
    }
  }
  if (msg.type === 'SCREENED') renderReview(msg.screened);
  if (msg.type === 'COMPANIES_UPDATED') refreshCompanies();
  if (msg.type === 'DONE') {
    setRunning(false);
    $('progText').textContent = '';
    $('progressBar').style.width = '100%';
    setTimeout(() => $('progressBar').style.width = '0%', 2500);
    refreshStats();
  }
});

function addLog(text, level) {
  level = level || 'info';
  const now = new Date();
  const t = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  const el = document.createElement('div');
  el.className = 'log-item ' + level;
  el.innerHTML = '<span class="log-time">' + t + '</span><span>' + esc(text) + '</span>';
  $('log').appendChild(el);
  $('log').scrollTop = $('log').scrollHeight;
  const logBody = document.getElementById('logBody');
  if (logBody && logBody.style.display === 'none' && (level === 'error' || level === 'warn')) {
    logBody.style.display = 'flex';
  }
}

// ===== 一键自检：定位"点了没反应"类问题 =====
function runSelfCheck() {
  addLog('—— 自检开始 ——', 'info');
  const mv = chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '?';
  addLog('面板构建：v' + mv, 'info');
  if (swDead()) {
    addLog('✗ 扩展上下文已失效：这是"点了没反应"的最常见原因。点页面顶部红色横幅刷新面板即可修复', 'error');
    warnDead();
    return;
  }
  addLog('✓ 面板 ↔ 扩展 上下文连接正常', 'success');
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (resp) => {
    if (chrome.runtime.lastError) { addLog('✗ 后台无响应：' + chrome.runtime.lastError.message, 'error'); return; }
    addLog('✓ 后台已响应，当前状态：' + ((resp && resp.phase) || 'unknown'), 'success');
    chrome.storage.local.get(['apiBaseUrl', 'apiModel', 'apiKey', 'keyword', 'city', 'count', 'resumeText'], (d) => {
      addLog('端点：' + (d.apiBaseUrl || '(空)'), 'info');
      addLog('模型：' + (d.apiModel || '(空)') + ' · 密钥：' + (d.apiKey ? '已填' : '(空!)'), d.apiKey ? 'info' : 'warn');
      addLog('关键词：' + (d.keyword || '(空)') + ' · 城市：' + (d.city || '(空)') + ' · 数量：' + (d.count || '(空)'), 'info');
      addLog('简历文字：' + ((d.resumeText || '').length) + ' 字（AI 筛选必需）', 'info');
      addLog('—— 自检完成，以上信息可截图反馈 ——', 'info');
    });
  });
}

$('btnSelfCheck').addEventListener('click', runSelfCheck);