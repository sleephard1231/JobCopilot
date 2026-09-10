// ===== content-search.js DOM 逻辑测试（迷你 DOM + 真实选择器）=====
'use strict';
const assert = require('assert');
const vm = require('vm');
const { define, readSrc, makeDom } = require('./helpers');

const CARD_SPECS = [
  { id: 'J1', name: '数据分析师', salary: '10-15K', tags: ['SQL', 'Python'], company: '阿里科技有限公司', area: '北京·朝阳区', hr: '张女士', active: '在线', inviteText: '32人沟通' },
  { id: 'J2', name: '销售专员', salary: '5-8K', tags: [], company: '字节跳动网络科技', area: '北京', hr: '李先生', active: '本周活跃', inviteText: '' },
  { id: 'J3', name: '数据分析实习生', salary: '150-200元/天', tags: ['实习'], company: '字节跳动旗下的某公司', area: '北京·海淀区', hr: '王女士', active: '本月活跃', inviteText: '5人沟通' },
  { id: 'J4', name: '算法工程师', salary: '25-40K', tags: ['Python', 'NLP'], company: '正常科技', area: '上海·浦东', hr: '赵经理', active: '', inviteText: '' },
  { id: 'J5', name: '前台接待', salary: '面议', tags: [], company: '饭店集团', area: '广州', hr: '钱主管', active: '在线', inviteText: '' }
];

function buildCard(dom, spec) {
  const li = dom.makeEl('li', 'job-card-box');
  const left = dom.makeEl('div', 'job-card-left');
  const a = dom.makeEl('a', '', '', { href: 'https://www.zhipin.com/job_detail/' + spec.id + '.html?ka=search_list', ka: 'search_list_job' });
  a.offsetParent = {};
  a.appendChild(dom.makeEl('span', 'job-name', spec.name));
  a.appendChild(dom.makeEl('span', 'job-salary', spec.salary));
  const tags = dom.makeEl('ul', 'tag-list');
  (spec.tags || []).forEach(tg => tags.appendChild(dom.makeEl('li', '', tg)));
  a.appendChild(tags);
  const areaWrap = dom.makeEl('span', 'job-area-wrapper');
  areaWrap.appendChild(dom.makeEl('span', 'job-area', spec.area));
  a.appendChild(areaWrap);
  left.appendChild(a);
  li.appendChild(left);
  const footer = dom.makeEl('div', 'job-card-footer');
  const cinfo = dom.makeEl('div', 'company-info');
  cinfo.appendChild(dom.makeEl('a', 'company-name', spec.company));
  footer.appendChild(cinfo);
  const boss = dom.makeEl('div', 'boss-info');
  boss.appendChild(dom.makeEl('span', 'boss-name', spec.hr));
  if (spec.active) {
    const at = dom.makeEl('span', 'boss-online-tag', spec.active);
    at.offsetParent = {};
    boss.appendChild(at);
  }
  footer.appendChild(boss);
  li.appendChild(footer);
  if (spec.inviteText) li.appendChild(dom.makeEl('span', 'job-invite', spec.inviteText));
  li.offsetParent = {};
  return li;
}

function loadSearch(build) {
  const dom = makeDom();
  if (build) build(dom);
  const listeners = [];
  const chromeStub = { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } } };
  const ctx = {
    console, chrome: chromeStub, document: dom.document, window: dom.window,
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readSrc('selectors.js'), ctx, { filename: 'selectors.js' });
  vm.runInContext(readSrc('content-search.js'), ctx, { filename: 'content-search.js' });
  return {
    dom,
    send(msg) {
      return new Promise(resolve => {
        let done = false;
        for (const fn of listeners) {
          const keep = fn(msg, {}, r => { if (!done) { done = true; resolve(r); } });
          if (keep !== true && !done) resolve(undefined);
        }
      });
    }
  };
}

define('content-search.js 抓取与建联', t => {

  t('SCRAPE：解析岗位全部字段', async () => {
    const env = loadSearch(dom => {
      const list = dom.makeEl('div', 'job-list-box');
      dom.body.appendChild(list);
      CARD_SPECS.forEach(s => list.appendChild(buildCard(dom, s)));
    });
    const r = await env.send({ type: 'SCRAPE', count: 10 });
    assert.ok(r && r.success, 'SCRAPE 成功');
    assert.strictEqual(r.jobs.length, 5);
    const j1 = r.jobs[0];
    assert.strictEqual(j1.id, 'J1');
    assert.strictEqual(j1.name, '数据分析师');
    assert.strictEqual(j1.salary, '10-15K');
    assert.strictEqual(JSON.stringify(j1.tags), JSON.stringify(['SQL', 'Python']), 'tags 数组');
    assert.strictEqual(j1.company, '阿里科技有限公司');
    assert.strictEqual(j1.area, '北京·朝阳区');
    assert.strictEqual(j1.activeState, 'online');
    assert.strictEqual(j1.inviteCount, 32);
    assert.ok(j1.link.indexOf('/job_detail/J1.html') > 0);
    assert.strictEqual(r.jobs[1].activeState, 'week');
    assert.strictEqual(r.jobs[2].activeState, 'month');
    assert.strictEqual(r.jobs[2].inviteCount, 5);
    assert.strictEqual(r.jobs[3].activeState, 'unknown');
    assert.strictEqual(r.jobs[3].inviteCount, -1);
  });

  t('SCRAPE：清理图标字体/零宽乱码字符', async () => {
    const env = loadSearch(dom => {
      const list = dom.makeEl('div', 'job-list-box');
      dom.body.appendChild(list);
      const li = dom.makeEl('li', 'job-card-box');
      const a = dom.makeEl('a', '', '', { href: 'https://www.zhipin.com/job_detail/JX.html?ka=1' });
      a.appendChild(dom.makeEl('span', 'job-name', '\uE6A1数据\u200B分析师\uE6B2'));
      a.appendChild(dom.makeEl('span', 'job-salary', '10-15K\uE6C3'));
      const tags = dom.makeEl('ul', 'tag-list');
      tags.appendChild(dom.makeEl('li', '', '\uE6D4')); // 纯图标标签应被丢弃
      tags.appendChild(dom.makeEl('li', '', 'Python\uE6E5'));
      a.appendChild(tags);
      const areaWrap = dom.makeEl('span', 'job-area-wrapper');
      areaWrap.appendChild(dom.makeEl('span', 'job-area', '北京\uE700·朝阳区'));
      a.appendChild(areaWrap);
      li.appendChild(a);
      const footer = dom.makeEl('div', 'job-card-footer');
      const cinfo = dom.makeEl('div', 'company-info');
      cinfo.appendChild(dom.makeEl('a', 'company-name', '\uE701阿里科技\uE702有限公司'));
      footer.appendChild(cinfo);
      li.appendChild(footer);
      list.appendChild(li);
    });
    const r = await env.send({ type: 'SCRAPE', count: 10 });
    assert.strictEqual(r.jobs.length, 1);
    const j = r.jobs[0];
    assert.strictEqual(j.name, '数据分析师');
    assert.strictEqual(j.salary, '10-15K');
    assert.strictEqual(JSON.stringify(j.tags), JSON.stringify(['Python']), '纯图标标签被丢弃');
    assert.strictEqual(j.company, '阿里科技有限公司');
    assert.strictEqual(j.area, '北京·朝阳区');
  });

  t('SCRAPE：count 截断', async () => {
    const env = loadSearch(dom => {
      const list = dom.makeEl('div', 'job-list-box');
      dom.body.appendChild(list);
      CARD_SPECS.forEach(s => list.appendChild(buildCard(dom, s)));
    });
    const r = await env.send({ type: 'SCRAPE', count: 3 });
    assert.strictEqual(r.jobs.length, 3);
  });

  t('SCRAPE：数量超出时 stall 收敛不卡死', async () => {
    const env = loadSearch(dom => {
      const list = dom.makeEl('div', 'job-list-box');
      dom.body.appendChild(list);
      CARD_SPECS.forEach(s => list.appendChild(buildCard(dom, s)));
    });
    const r = await env.send({ type: 'SCRAPE', count: 50 });
    assert.strictEqual(r.jobs.length, 5);
  });

  t('OPEN_JD：抓 JD + HR 名 + 工作地址 + 注册资本', async () => {
    const env = loadSearch(dom => {
      const list = dom.makeEl('div', 'job-list-box');
      dom.body.appendChild(list);
      CARD_SPECS.forEach(s => list.appendChild(buildCard(dom, s)));
      const det = dom.makeEl('div', 'job-detail-box');
      det.appendChild(dom.makeEl('span', 'name', '王女士'));
      det.appendChild(dom.makeEl('div', 'job-sec-text', '岗位职责：负责数据分析工作'));
      det.appendChild(dom.makeEl('div', 'job-sec-text', '工作地址：北京市海淀区中关村软件园'));
      det.appendChild(dom.makeEl('div', 'job-sec-text', '注册资本：1000万人民币'));
      dom.body.appendChild(det);
    });
    const r = await env.send({ type: 'OPEN_JD', job: { id: 'J1', name: '数据分析师', company: '阿里科技有限公司' } });
    assert.ok(r && r.success);
    assert.strictEqual(r.hrName, '王', 'HR 名会去掉"女士"称谓保证键一致');
    assert.ok(r.jd.indexOf('岗位职责') >= 0);
    assert.ok(r.addr.indexOf('北京市海淀区') >= 0);
    assert.ok(r.fundText.indexOf('注册资本') === 0);
  });

  t('OPEN_JD：无 .name 时走短行兜底提取 HR', async () => {
    const env = loadSearch(dom => {
      const list = dom.makeEl('div', 'job-list-box');
      dom.body.appendChild(list);
      CARD_SPECS.forEach(s => list.appendChild(buildCard(dom, s)));
      const det = dom.makeEl('div', 'job-detail-box');
      det.appendChild(dom.makeEl('div', 'job-sec-text', '公司简介：一家好公司'));
      det.appendChild(dom.makeEl('div', 'job-sec-text', '张三'));
      dom.body.appendChild(det);
    });
    const r = await env.send({ type: 'OPEN_JD', job: { id: 'J1', name: '数据分析师', company: '阿里科技有限公司' } });
    assert.ok(r && r.success);
    assert.strictEqual(r.hrName, '张三', '第一行含"公司"被排除，取到张三');
  });

  t('OPEN_JD：id 不匹配时按岗位名+公司兜底找卡片', async () => {
    const env = loadSearch(dom => {
      const list = dom.makeEl('div', 'job-list-box');
      dom.body.appendChild(list);
      CARD_SPECS.forEach(s => list.appendChild(buildCard(dom, s)));
      const det = dom.makeEl('div', 'job-detail-box');
      det.appendChild(dom.makeEl('span', 'name', '王女士'));
      dom.body.appendChild(det);
    });
    const r = await env.send({ type: 'OPEN_JD', job: { id: 'UNKNOWN-ID', name: '算法工程师', company: '正常科技' } });
    assert.ok(r && r.success, '应通过名称兜底找到卡片');
  });

  t('GO_CHAT：立即沟通 → 继续沟通 弹窗确认', async () => {
    const env = loadSearch(dom => {
      const list = dom.makeEl('div', 'job-list-box');
      dom.body.appendChild(list);
      CARD_SPECS.forEach(s => list.appendChild(buildCard(dom, s)));
      const btn = dom.makeEl('a', 'op-btn-chat', '立即沟通');
      btn.offsetParent = {};
      list.children[0].appendChild(btn);
      const go = dom.makeEl('span', 'dialog-btn', '继续沟通');
      go.offsetParent = {};
      dom.body.appendChild(go);
    });
    const r = await env.send({ type: 'GO_CHAT', job: { id: 'J1', name: '数据分析师', company: '阿里科技有限公司' } });
    assert.ok(r && r.success && r.navigated === true);
  });

  t('GO_CHAT：无按钮时返回明确错误', async () => {
    const env = loadSearch(dom => {
      const list = dom.makeEl('div', 'job-list-box');
      dom.body.appendChild(list);
      CARD_SPECS.forEach(s => list.appendChild(buildCard(dom, s)));
    });
    const r = await env.send({ type: 'GO_CHAT', job: { id: 'J1', name: '数据分析师', company: '阿里科技有限公司' } });
    assert.ok(r && r.success === false && r.error === '未找到立即沟通按钮');
  });
});
