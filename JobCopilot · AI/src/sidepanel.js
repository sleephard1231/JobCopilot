// ===== JobCopilot · AI 侧边栏(自定义 LLM + 科技风 UI) =====
const $ = (id) => document.getElementById(id);
const CFG_FIELDS = ['apiBaseUrl', 'apiModel', 'apiKey', 'resumeText', 'keyword', 'city', 'count'];

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
chrome.storage.local.get(CFG_FIELDS.concat(['resumeImage', 'dsKey']), (d) => {
  const apiKey = d.apiKey || d.dsKey || '';
  CFG_FIELDS.forEach(f => {
    const v = f === 'apiKey' ? apiKey : d[f];
    if (v !== undefined && $(f)) $(f).value = v;
  });
  // 默认值,方便新用户上手
  if (!$('apiBaseUrl').value) $('apiBaseUrl').value = 'https://api.deepseek.com/v1/chat/completions';
  if (!$('apiModel').value) $('apiModel').value = 'deepseek-chat';
  if (d.resumeImage) showImg(d.resumeImage);
});

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

// ===== 运行控制 =====
let isPaused = false;
const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg><span>暂停</span>';
const RESUME_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>继续</span>';

$('btnCollect').addEventListener('click', async () => {
  await saveCfgSync();
  if (!$('apiBaseUrl').value.trim()) return addLog('✗ 请填写 API 端点', 'error');
  if (!$('apiModel').value.trim()) return addLog('✗ 请填写模型名', 'error');
  if (!$('apiKey').value.trim()) return addLog('✗ 请填写 API Key', 'error');
  if (!$('keyword').value.trim()) return addLog('✗ 请填写岗位关键词', 'error');
  $('reviewCard').style.display = 'none';
  setRunning(true);
  chrome.runtime.sendMessage({ type: 'START_COLLECT' });
});

$('btnDeliver').addEventListener('click', () => {
  const ids = Array.from(document.querySelectorAll('.job-item:not(.skip) input:checked')).map(c => c.dataset.id);
  if (!ids.length) return addLog('✗ 请至少勾选一个岗位', 'error');
  setRunning(true);
  addLog('▶ 开始投递 ' + ids.length + ' 个岗位', 'info');
  chrome.runtime.sendMessage({ type: 'START_DELIVER', jobIds: ids });
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
      _type: 'JobCopilot.Contacts',
      _version: 1,
      _exportedAt: new Date().toISOString(),
      sentContacts: d.sentContacts || {}
    };
    const name = 'jobcopilot-contacts-' + new Date().toISOString().slice(0, 10) + '.json';
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
    if (data._type && data._type !== 'JobCopilot.Contacts') {
      addLog('✗ 文件类型不匹配（期望 JobCopilot.Contacts）', 'error'); return;
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
    $('phaseText').textContent = map[msg.phase] || msg.phase;
    if (msg.phase === 'review' || msg.phase === 'done' || msg.phase === 'idle') {
      setRunning(false);
    }
    if (msg.phase === 'done') {
      $('statusDot').className = 'status-dot success';
      $('headerStatus').textContent = '已完成';
    }
  }
  if (msg.type === 'SCREENED') renderReview(msg.screened);
  if (msg.type === 'COMPANIES_UPDATED') refreshCompanies();
  if (msg.type === 'DONE') {
    setRunning(false);
    $('progText').textContent = '';
    $('progressBar').style.width = '100%';
    setTimeout(() => $('progressBar').style.width = '0%', 2500);
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
}