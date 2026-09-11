// ===== 高德真实 API 冒烟测试（需要 src/secrets.js 里的 __AMAP_KEY__）=====
// 运行：node tests/manual-amap-check.js [住址] [公司地址] [驾车km上限] [步行分钟上限]
// 输出不回显 key。真实请求 restapi.amap.com，验证 geocode + distance + checkCommute 闭环。
'use strict';
const fs = require('fs');
const path = require('path');

// 从 secrets.js 提取 key（不打印）
const secretsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'secrets.js'), 'utf8');
const m = secretsSrc.match(/__AMAP_KEY__\s*=\s*"([^"]+)"/);
if (!m || !m[1]) { console.log('✗ secrets.js 中未找到 __AMAP_KEY__'); process.exit(1); }
const KEY = m[1];

const BPAmap = require('../src/amap.js');

const origin = process.argv[2] || '北京市海淀区中关村';
const dest = process.argv[3] || '北京市朝阳区望京SOHO';
const driveMaxKm = parseFloat(process.argv[4] || '5');
const walkMaxMin = parseFloat(process.argv[5] || '0');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  PASS ' + name + (detail ? ' :: ' + detail : '')); pass++; }
  else { console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); fail++; }
}

(async () => {
  console.log('=== 高德 API 真实冒烟测试 ===');
  console.log('住址: ' + origin + ' | 公司: ' + dest + ' | 阈值: 驾车 ' + driveMaxKm + 'km, 步行 ' + walkMaxMin + 'min');

  // 1. 地理编码
  const o = await BPAmap.geocode(origin, KEY);
  check('住址地理编码', !!o, '→ ' + (o || '失败'));
  const d = await BPAmap.geocode(dest, KEY);
  check('公司地址地理编码', !!d, '→ ' + (d || '失败'));

  if (!o || !d) { console.log('\n地理编码失败：请检查 key 是否有效（Web服务类型）或地址是否可解析'); finish(); return; }

  // 2. 距离计算
  const t = await BPAmap.commuteTimes(o, d, KEY);
  check('驾车+步行距离计算', !!(t && t.drive && t.walk),
    t && t.drive ? ('驾车 ' + t.drive.km + 'km / ' + t.drive.min + 'min · 步行 ' + (t.walk ? t.walk.km + 'km / ' + t.walk.min + 'min' : '失败')) : '失败');
  if (t && t.drive) check('缓存命中（同路线第二次调用返回同一对象）', (await BPAmap.commuteTimes(o, d, KEY)) === t);

  // 3. checkCommute 闭环：严格阈值 → 应剔除
  const job = { name: '测试岗位', addr: dest };
  const strict = await BPAmap.checkCommute(job, { key: KEY, origin: origin, driveMaxKm: driveMaxKm, walkMaxMin: walkMaxMin });
  const strictlyExceeded = !!strict && /超/.test(strict);
  check('checkCommute 严格阈值判定', typeof strict === 'string', strict ? ('剔除理由: ' + strict) : '放行');
  if (t && t.drive) check('判定与实测一致（驾车 ' + t.drive.km + 'km vs 上限 ' + driveMaxKm + 'km）',
    (t.drive.km > driveMaxKm) ? strictlyExceeded : true, '理由=' + (strict || '(空)'));
  check('job.commute 已挂回', !!(job.commute && typeof job.commute.driveKm === 'number'),
    job.commute ? JSON.stringify(job.commute) : '无');

  // 4. 宽松阈值 → 应放行
  const job2 = { name: '测试岗位', addr: dest };
  const loose = await BPAmap.checkCommute(job2, { key: KEY, origin: origin, driveMaxKm: 9999, driveMaxMin: 9999 });
  check('checkCommute 宽松阈值放行', loose === '', '返回: "' + loose + '"');

  // 5. 无法解析的地址 → 放行不误伤
  const job3 = { name: '模糊岗位', addr: '火星乌托邦大道99号' };
  const fuzzy = await BPAmap.checkCommute(job3, { key: KEY, origin: origin, driveMaxKm: 1 });
  check('无法解析地址放行（不误伤）', fuzzy === '', '返回: "' + fuzzy + '"');

  // 6. 无 key / 无住址 → 直接放行
  const nk = await BPAmap.checkCommute({ addr: dest }, { key: '', origin: origin, driveMaxKm: 1 });
  check('未配置 key 放行', nk === '');
  const no = await BPAmap.checkCommute({ addr: dest }, { key: KEY, origin: '', driveMaxKm: 1 });
  check('未配置住址放行', no === '');

  finish();

  function finish() {
    console.log('\n==== 高德冒烟: ' + pass + ' passed, ' + fail + ' failed ====');
    process.exitCode = fail ? 1 : 0;
  }
})();
