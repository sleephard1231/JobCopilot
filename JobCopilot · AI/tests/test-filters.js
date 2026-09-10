// ===== filters.js 单元测试 =====
'use strict';
const assert = require('assert');
const { define, readSrc } = require('./helpers');

function loadBPFilters() {
  const module_ = { exports: {} };
  const fn = new Function('module', 'exports', 'self', 'window', readSrc('filters.js'));
  fn(module_, module_.exports, globalThis, globalThis);
  return module_.exports;
}

define('filters.js 过滤引擎', t => {
  const F = loadBPFilters();

  t('薪资解析 8-12K', () => assert.deepStrictEqual(F.parseSalary('8-12K'), { min: 8, max: 12 }));
  t('薪资解析 10-15K·13薪', () => assert.deepStrictEqual(F.parseSalary('10-15K·13薪'), { min: 10, max: 15 }));
  t('薪资解析 1.5-2.5万', () => assert.deepStrictEqual(F.parseSalary('1.5-2.5万'), { min: 15, max: 25 }));
  t('薪资解析 8千-1.2万（混合单位）', () => assert.deepStrictEqual(F.parseSalary('8千-1.2万'), { min: 8, max: 12 }));
  t('薪资解析 5000-8000元/月', () => assert.deepStrictEqual(F.parseSalary('5000-8000元/月'), { min: 5, max: 8 }));
  t('薪资解析 200-400元/天（折月）', () => { const r = F.parseSalary('200-400元/天'); assert.ok(Math.abs(r.min - 4.4) < 0.01 && Math.abs(r.max - 8.8) < 0.01); });
  t('薪资解析 面议 → null', () => assert.strictEqual(F.parseSalary('面议'), null));
  t('薪资解析 空 → null', () => assert.strictEqual(F.parseSalary(''), null));
  t('薪资解析 2-3万', () => assert.deepStrictEqual(F.parseSalary('2-3万'), { min: 20, max: 30 }));
  t('薪资解析 15-25K', () => assert.deepStrictEqual(F.parseSalary('15-25K'), { min: 15, max: 25 }));

  t('名单解析 @kw/注释行', () => assert.deepStrictEqual(
    F.parseListText('某某科技\n字节跳动 @kw\n#注释'),
    [{ name: '某某科技', mode: 'exact' }, { name: '字节跳动', mode: 'keyword' }]));
  t('名单序列化往返', () => assert.strictEqual(F.serializeListText(F.parseListText('a\nb @kw')), 'a\nb @kw'));
  t('匹配 exact 全等', () => assert.ok(F.matchList('某某科技有限公司', [{ name: '某某科技有限公司', mode: 'exact' }])));
  t('匹配 exact 不做子串', () => assert.strictEqual(F.matchList('某某科技有限公司', [{ name: '某某', mode: 'exact' }]), null));
  t('匹配 keyword 子串', () => assert.ok(F.matchList('北京字节跳动网络科技', [{ name: '字节跳动', mode: 'keyword' }])));
  t('匹配 空公司名不误伤', () => assert.strictEqual(F.matchList('', [{ name: 'x', mode: 'exact' }]), null));

  const jobs = [
    { id: 1, name: '数据分析师', salary: '10-15K', company: '某某科技有限公司', tags: ['SQL'], area: '北京·朝阳区', activeState: 'online', inviteCount: 10 },
    { id: 2, name: '销售', salary: '5-8K', company: '字节跳动网络科技', tags: [], area: '北京', activeState: 'week', inviteCount: 20 },
    { id: 3, name: '前台', salary: '面议', company: '正常公司', tags: [], area: '上海', activeState: 'month', inviteCount: -1 }
  ];

  t('黑名单 keyword 剔除', () => {
    const fr = F.applyFilters(jobs, { listMode: 'black', blacklist: [{ name: '字节跳动', mode: 'keyword' }] });
    assert.ok(fr.dropped.some(j => j.id === 2 && j._dropReason.indexOf('黑名单') === 0));
    assert.deepStrictEqual(fr.kept.map(j => j.id).sort(), [1, 3]);
  });
  t('薪资下限剔除', () => {
    const fr = F.applyFilters([{ id: 9, name: 'x', salary: '3-4K', company: 'a' }], { salary: { min: 8, max: 0 } });
    assert.ok(fr.dropped.length === 1 && fr.dropped[0]._dropReason.indexOf('薪资低于下限') === 0);
  });
  t('薪资上限剔除', () => {
    const fr = F.applyFilters([{ id: 10, name: 'x', salary: '40-50K', company: 'a' }], { salary: { min: 0, max: 30 } });
    assert.ok(fr.dropped.length === 1 && fr.dropped[0]._dropReason.indexOf('薪资高于上限') === 0);
  });
  t('面议不受薪资上下限影响', () => {
    const fr = F.applyFilters([{ id: 3, name: '前台', salary: '面议', company: '正常公司' }], { salary: { min: 8, max: 30 } });
    assert.deepStrictEqual(fr.kept.map(j => j.id), [3]);
  });
  t('白名单模式仅保留命中', () => {
    const fr = F.applyFilters(jobs, { listMode: 'white', whitelist: [{ name: '正常公司', mode: 'exact' }] });
    assert.deepStrictEqual(fr.kept.map(j => j.id), [3]);
  });
  t('关键词 include 模式', () => {
    const fr = F.applyFilters(jobs, { kwMode: 'include', keywords: ['分析'] });
    assert.deepStrictEqual(fr.kept.map(j => j.id), [1]);
  });
  t('关键词 exclude 模式', () => {
    const fr = F.applyFilters(jobs, { kwMode: 'exclude', keywords: ['销售'] });
    assert.ok(!fr.kept.some(j => j.id === 2));
  });
  t('城市不符剔除', () => {
    const fr = F.applyFilters([jobs[2]], { cities: ['北京'] });
    assert.ok(fr.dropped.length === 1 && fr.dropped[0]._dropReason.indexOf('城市不符') === 0);
  });
  t('地址排除剔除', () => {
    const fr = F.applyFilters([jobs[0]], { addrExclude: ['朝阳'] });
    assert.ok(fr.dropped.length === 1);
  });
  t('城市字符串输入归一化', () => {
    const fr = F.applyFilters([jobs[2]], { cities: '北京, 上海' });
    assert.strictEqual(fr.kept.length, 1);
  });
  t('活跃度不符剔除', () => {
    const fr = F.applyFilters([jobs[1]], { active: { online: true } });
    assert.ok(fr.dropped.length === 1 && fr.dropped[0]._dropReason.indexOf('活跃度不符') === 0);
  });
  t('活跃度 unknown 放行（不误伤缺数据岗位）', () => {
    const fr = F.applyFilters([{ id: 11, name: 'x', company: 'a', activeState: 'unknown' }], { active: { online: true } });
    assert.strictEqual(fr.kept.length, 1);
  });
  t('邀请量过高剔除且未知放行', () => {
    assert.ok(F.applyFilters([jobs[1]], { inviteMax: 15 }).dropped.length === 1);
    assert.ok(F.applyFilters([jobs[2]], { inviteMax: 15 }).kept.length === 1);
  });
  t('注册资金解析 cny/美元/亿', () => {
    assert.deepStrictEqual(F.parseFund('注册资本 1000万人民币'), { fund: 1000, currency: 'cny' });
    assert.deepStrictEqual(F.parseFund('注册资本：50万美元'), { fund: 50, currency: 'usd' });
    assert.deepStrictEqual(F.parseFund('注册资本 1.2亿元'), { fund: 12000, currency: 'cny' });
    assert.strictEqual(F.parseFund('没有这块'), null);
  });
  t('投递期资金规则', () => {
    assert.strictEqual(F.checkFund({ fund: 50, fundCurrency: 'usd' }, { skipUsdFund: true }), '美元注册资金');
    assert.ok(F.checkFund({ fund: 50, fundCurrency: 'cny' }, { fundMin: 100 }).indexOf('注册资金低于下限') === 0);
    assert.strictEqual(F.checkFund({ fund: 2000, fundCurrency: 'cny' }, { fundMin: 100 }), '');
    assert.strictEqual(F.checkFund({}, { fundMin: 100 }), '');
  });
  t('默认配置全放行', () => {
    const fr = F.applyFilters(jobs, {});
    assert.strictEqual(fr.kept.length, 3);
  });
  t('normalize 容错（非法值回退默认）', () => {
    const c = F.normalize({ listMode: 'xxx', kwMode: 'yyy', jobHandle: 'zzz', salary: 'bad', inviteMax: 'abc' });
    assert.strictEqual(c.listMode, 'off');
    assert.strictEqual(c.kwMode, 'off');
    assert.strictEqual(c.jobHandle, 'skip');
    assert.deepStrictEqual(c.salary, { min: 0, max: 0 });
    assert.strictEqual(c.inviteMax, 0);
  });
  t('短路顺序：黑名单优先于薪资', () => {
    const fr = F.applyFilters([{ id: 12, name: 'x', salary: '1-2K', company: '字节跳动网络科技' }],
      { listMode: 'black', blacklist: [{ name: '字节跳动', mode: 'keyword' }], salary: { min: 8, max: 0 } });
    assert.ok(fr.dropped[0]._dropReason.indexOf('黑名单') === 0);
  });
});
