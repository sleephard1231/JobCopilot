// ===== 聊天页 content script：打开会话 + 先发图片 + 再发招呼语 =====
(function () {
  if (window.__bossToudiChat) return;
  window.__bossToudiChat = true;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // 多选择器找第一个可见元素
  function findVisible(selList) {
    for (const sel of selList) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (el && (el.offsetParent !== null || getComputedStyle(el).position === 'fixed')) return el;
      }
    }
    return null;
  }
  async function waitVisible(selList, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const el = findVisible(selList);
      if (el) return el;
      await sleep(250);
    }
    return null;
  }

  const INPUT_SELS = ['div#chat-input', '#chat-input', 'div.chat-input', '.chat-input[contenteditable]', '[contenteditable="true"]', 'textarea.input-area', '.chat-editor textarea', 'textarea[placeholder]', 'textarea'];
  const SEND_SELS = ['button.btn-send', '.btn-send', 'button[class*="send"]', '[class*="send-btn"]'];
  const IMG_SELS = ['.btn-sendimg input[type=file]', '.toolbar input[type=file]', 'input[type=file]'];

  // 诊断：把页面里可编辑元素结构dump成字符串（找不到输入框时回传，便于定位）
  function dumpInputs() {
    const out = [];
    document.querySelectorAll('[contenteditable="true"], textarea, div[id*="input"], div[class*="input"]').forEach((el, i) => {
      if (i < 8) out.push(el.tagName + '#' + (el.id || '') + '.' + (typeof el.className === 'string' ? el.className.slice(0, 40) : ''));
    });
    return out.join(' | ') || '无可编辑元素';
  }

  function dataURLtoFile(dataUrl, name) {
    const parts = dataUrl.split(',');
    const mime = parts[0].match(/:(.*?);/)[1];
    const bin = atob(parts[1]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name || 'resume.png', { type: mime });
  }

  async function openConversation(company, hrName, position) {
    await waitVisible([SELECTORS.chat.userList], 8000);
    const items = Array.from(document.querySelectorAll(SELECTORS.chat.userList));
    if (!items.length) return { ok: false, err: '会话列表为空' };
    let target = null;
    const ck = (company || '').replace(/\s/g, '');
    const hk = (hrName || '').replace(/\s/g, '');
    const pk = (position || '').replace(/\s/g, '');
    for (const li of items) {
      const tx = (li.textContent || '').replace(/\s/g, '');
      if (ck && tx.indexOf(ck) >= 0) { target = li; break; }
      if (pk && tx.indexOf(pk) >= 0) { target = li; break; }
      if (hk && tx.indexOf(hk) >= 0) { target = li; break; }
    }
    if (!target) target = items[0]; // 兜底：最新一条（刚建联的通常在顶部）
    target.click();
    await sleep(1600);
    return { ok: true };
  }

  // 发送简历图片：返回 {ok, confirmed}
  //   ok=false      → 图片根本没上传（未配置可发送，或找不到入口/数据损坏），调用方应判失败
  //   confirmed=false → change 事件已派发但页面上未观察到新图片，可能上传未完成，仅告警
  async function sendImage(image) {
    if (!image) return { ok: true, confirmed: true };
    const input = findVisible(IMG_SELS) || document.querySelector('input[type=file]');
    if (!input) return { ok: false, confirmed: false, err: '未找到图片上传入口' };
    let file;
    try { file = dataURLtoFile(image, 'resume.png'); }
    catch (e) { return { ok: false, confirmed: false, err: '图片数据无效：' + (e.message || e) }; }
    const beforeImgs = document.querySelectorAll('.item-myself img, img[src^="blob:"]').length;
    const dt = new DataTransfer();
    dt.items.add(file);
    try {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files').set;
      setter.call(input, dt.files);
    } catch (e) { return { ok: false, confirmed: false, err: '图片写入失败：' + (e.message || e) }; }
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // 轮询确认：出现新的「自己发出」的图片才算送达（最长约 8 秒）
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      if (document.querySelectorAll('.item-myself img, img[src^="blob:"]').length > beforeImgs) {
        return { ok: true, confirmed: true };
      }
    }
    return { ok: true, confirmed: false, err: '未能确认图片已发送' };
  }

  function inputText(el) { return (el.isContentEditable || el.getAttribute('contenteditable') === 'true') ? (el.textContent || '') : (el.value || ''); }

  function pressEnter(el) {
    const opt = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opt));
    el.dispatchEvent(new KeyboardEvent('keypress', opt));
    el.dispatchEvent(new KeyboardEvent('keyup', opt));
  }

  async function sendText(greeting) {
    const input = await waitVisible(INPUT_SELS, 8000);
    if (!input) return { ok: false, err: '未找到输入框｜页面候选：' + dumpInputs() };
    input.focus();
    await sleep(300);
    const editable = input.isContentEditable || input.getAttribute('contenteditable') === 'true';
    if (editable) {
      input.textContent = greeting;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: greeting }));
    } else {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(input, greeting);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await sleep(700);
    if (!inputText(input).trim()) return { ok: false, err: '文字未填入输入框' };

    const before = document.querySelectorAll(SELECTORS.chat.messageSent).length;
    // 以回车为主发送
    pressEnter(input);
    await sleep(400);
    // 回车已生效（输入框清空或新增气泡）就不要再点按钮，避免重复/空消息
    const sentByEnter = !inputText(input).trim() || document.querySelectorAll(SELECTORS.chat.messageSent).length > before;
    if (!sentByEnter) {
      const btn = findVisible(SEND_SELS);
      if (btn && !btn.classList.contains('disabled') && !btn.disabled) btn.click();
    }

    // 验证：输入框被清空 或 新增自己消息气泡 => 成功
    for (let i = 0; i < 12; i++) {
      await sleep(300);
      const cleared = !inputText(input).trim();
      const after = document.querySelectorAll(SELECTORS.chat.messageSent).length;
      if (cleared || after > before) return { ok: true };
    }
    return { ok: false, err: '发送未确认（输入框未清空、未见新气泡）' };
  }

  async function doSend(msg) {
    const oc = await openConversation(msg.company, msg.hrName, msg.position);
    if (!oc.ok) return { success: false, error: oc.err };
    const img = await sendImage(msg.image);
    if (!img.ok) return { success: false, error: '简历图片：' + (img.err || '上传失败') };
    await sleep(800);
    const tr = await sendText(msg.greeting);
    if (!tr.ok) return { success: false, error: tr.err };
    return { success: true, imageOk: img.ok, imageConfirmed: img.confirmed };
  }

  // 发给当前已打开的会话（点继续沟通后跳进来的就是目标岗位，无需匹配）
  async function sendActive(image, greeting) {
    let input = await waitVisible(INPUT_SELS, 6000);
    if (!input) {
      const items = document.querySelectorAll(SELECTORS.chat.userList);
      if (items[0]) { items[0].click(); await sleep(1500); }
      input = await waitVisible(INPUT_SELS, 6000);
    }
    if (!input) return { success: false, error: '未找到输入框｜' + dumpInputs() };
    const img = await sendImage(image);
    // 配置了简历图却传不上去：直接判失败，避免"没发简历却显示投递成功"
    if (!img.ok) return { success: false, error: '简历图片：' + (img.err || '上传失败') };
    await sleep(800);
    const tr = await sendText(greeting);
    if (!tr.ok) return { success: false, error: tr.err };
    return { success: true, imageOk: img.ok, imageConfirmed: img.confirmed };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') { sendResponse({ success: true, alive: true }); return; }
    if (msg.type === 'SEND') {
      doSend(msg).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'SEND_ACTIVE') {
      sendActive(msg.image, msg.greeting).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
  });
})();
