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