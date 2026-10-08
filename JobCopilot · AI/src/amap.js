// ===== 高德通勤计算：地理编码 + 驾车/步行距离（纯工具，无 DOM 依赖） =====
// 用法：background 在投递期拿到工作地址后调用 BPAmap.checkCommute(job, commuteCfg)，
// 结果以 job.commute = {driveKm, driveMin, walkKm, walkMin} 挂回岗位，filters 纯同步判定。
// 需要用户自备高德 Web服务 Key（免费额度每日 5000 次，个人够用）。
(function (root) {
  'use strict';

  var AMAP_GEO = 'https://restapi.amap.com/v3/geocode/geo';
  var AMAP_DIST = 'https://restapi.amap.com/v3/distance';

  // 内存缓存：SW 生命周期内同地址/同路线不重复请求（高德对重复配额按次计费）
  var geoCache = {};
  var distCache = {};

  function cacheGet(cache, k) { return Object.prototype.hasOwnProperty.call(cache, k) ? cache[k] : undefined; }

  // 带超时的 JSON 请求：高德无响应时不能让投递流程卡死（失败一律返回 null，由上层放行）
  async function fetchJson(url, timeoutMs) {
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { try { controller.abort(); } catch (e) {} }, timeoutMs || 10000) : null;
    try {
      var resp = await fetch(url, controller ? { signal: controller.signal } : undefined);
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // 粗粒度匹配级别：模糊命中"某省/某市/某村庄"这类结果对通勤计算毫无意义，
  // 还会把瞎编地址匹配到千里之外误杀岗位 → 一律视为解析失败（上层放行，不误伤）
  var COARSE_LEVELS = { '省': 1, '市': 1, '区县': 1, '乡镇': 1, '村庄': 1 };

  async function geocode(address, key) {
    var addr = String(address || '').trim();
    if (!addr || !key) return null;
    var cached = cacheGet(geoCache, addr);
    if (cached !== undefined) return cached;
    var url = AMAP_GEO + '?key=' + encodeURIComponent(key) + '&address=' + encodeURIComponent(addr) + '&output=json';
    var loc = null;
    var data = await fetchJson(url, 10000);
    if (data && data.status === '1' && data.geocodes && data.geocodes.length && data.geocodes[0].location) {
      var g = data.geocodes[0];
      if (!COARSE_LEVELS[String(g.level || '').trim()]) loc = g.location; // 粗粒度 → 视为解析失败
    }
    geoCache[addr] = loc;
    return loc;
  }

  // type: 1=驾车 3=步行；返回 {km, min}，失败 null
  async function distanceOne(origin, dest, type, key) {
    var url = AMAP_DIST + '?key=' + encodeURIComponent(key) + '&origins=' + encodeURIComponent(origin)
      + '&destination=' + encodeURIComponent(dest) + '&type=' + type + '&output=json';
    var data = await fetchJson(url, 10000);
    if (!data || data.status !== '1' || !data.results || !data.results.length) return null;
    var r = data.results[0];
    var meters = parseInt(r.distance, 10);
    var seconds = parseInt(r.duration, 10);
    if (!isFinite(meters) || !isFinite(seconds)) return null;
    return { km: Math.round(meters / 100) / 10, min: Math.round(seconds / 60) };
  }

  // 并行取驾车+步行，任一失败返回 null
  async function commuteTimes(origin, dest, key) {
    var cacheKey = origin + '|' + dest;
    var cached = cacheGet(distCache, cacheKey);
    if (cached !== undefined) return cached;
    var drive = null, walk = null;
    var out = { drive: null, walk: null };
    try {
      var rs = await Promise.all([
        distanceOne(origin, dest, 1, key),
        distanceOne(origin, dest, 3, key)
      ]);
      drive = rs[0]; walk = rs[1];
    } catch (e) { drive = walk = null; }
    out.drive = drive; out.walk = walk;
    if (drive || walk) distCache[cacheKey] = out; // 只缓存成功结果：网络/配额失败留给下次重试
    return out;
  }

  // 主入口：给 job 补 job.commute，返回剔除理由（空串=通过/无法判定放行）
  // commuteCfg: { key, origin, driveMaxKm, driveMaxMin, walkMaxKm, walkMaxMin }
  async function checkCommute(job, commuteCfg) {
    var c = commuteCfg || {};
    var key = (c.key || '').trim();
    var origin = (c.origin || '').trim();
    if (!key || !origin) return ''; // 未配置 = 功能关闭，直接放行
    var addr = String((job && (job.addr || job.area)) || '').trim();
    if (!addr) return ''; // 拿不到地址不误伤
    addr = addr.replace(/^工作地址[:：]\s*/, '');
    var originLoc = await geocode(origin, key);
    var destLoc = await geocode(addr, key);
    if (!originLoc || !destLoc) {
      return ''; // 地理编码失败（地址太模糊/配额耗尽）→ 放行，不阻塞投递
    }
    var t = await commuteTimes(originLoc, destLoc, key);
    if (!t) return '';
    job.commute = {
      driveKm: t.drive ? t.drive.km : null,
      driveMin: t.drive ? t.drive.min : null,
      walkKm: t.walk ? t.walk.km : null,
      walkMin: t.walk ? t.walk.min : null
    };
    var reasons = [];
    if (c.driveMaxKm > 0 && t.drive && t.drive.km > c.driveMaxKm) reasons.push('驾车距离超 ' + c.driveMaxKm + 'km（实际 ' + t.drive.km + 'km）');
    if (c.driveMaxMin > 0 && t.drive && t.drive.min > c.driveMaxMin) reasons.push('驾车时间超 ' + c.driveMaxMin + ' 分钟（实际 ' + t.drive.min + ' 分钟）');
    if (c.walkMaxKm > 0 && t.walk && t.walk.km > c.walkMaxKm) reasons.push('步行距离超 ' + c.walkMaxKm + 'km（实际 ' + t.walk.km + 'km）');
    if (c.walkMaxMin > 0 && t.walk && t.walk.min > c.walkMaxMin) reasons.push('步行时间超 ' + c.walkMaxMin + ' 分钟（实际 ' + t.walk.min + ' 分钟）');
    return reasons.join('；');
  }

  var BPAmap = {
    geocode: geocode,
    commuteTimes: commuteTimes,
    checkCommute: checkCommute
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BPAmap;
  root.BPAmap = BPAmap;
})(typeof self !== 'undefined' ? self : this);
