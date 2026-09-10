# 小北智能招聘 融合开发文档

> 配套文档：[DESIGN.md](./DESIGN.md)（设计稿 v0.1）
> 本文面向实现者：环境搭建、模块实现指南、接口/协议参考、测试验收、排错手册。
> 基线代码：`JobCopilot · AI/` v1.0.0（MV3，无框架原生 JS）。

---

## 1. 环境搭建

### 1.1 加载扩展

1. Edge 打开 `edge://extensions`（Chrome 为 `chrome://extensions`）
2. 打开右上角 **开发人员模式**
3. 点 **加载解压缩的扩展** → 选择 `JobCopilot · AI/` 文件夹
4. 点击扩展图标打开侧边栏；`docs/投递流程图.html` 有流程示意

### 1.2 调试入口

| 对象 | 调试方法 |
|------|----------|
| Service Worker（background.js / 新 scheduler） | `edge://extensions` → 本扩展 →「服务工作进程」链接，弹出独立 DevTools |
| content script（search/chat/fav） | 在 zhipin.com 对应页面按 F12，Console 顶部上下文切到内容脚本 |
| 侧边栏 | 侧边栏内右键 →「检查」 |
| 存储 | 上述任意 DevTools Console：`chrome.storage.local.get(null, console.table)` |

### 1.3 开发约定

- 原生 JS（ES2020，SW 里 `importScripts`，无打包器），**不引入框架/依赖**
- 命名沿用现有风格：消息类型大写下划线（`FAV_SCRAPE`）、storage 键小驼峰
- **所有 DOM 选择器必须集中写入 `src/selectors.js`**，禁止散落在业务代码
- 每个新增 content script 顶部沿用防重入模式：`if (window.__bossXxx) return; window.__bossXxx = true;`
- 新增异步消息监听一律 `return true` 保持 sendResponse 通道（现有代码约定）
- 不加注释外的日志噪音：`log()` 只打用户可读的事件

---

## 2. Manifest 变更（第一步先做）

```jsonc
// manifest.json 差异
{
  "version": "1.1.0",                              // 每个里程碑 +0.1
  "permissions": ["storage", "tabs", "scripting", "sidePanel", "alarms"],  // + alarms (M3)
  "content_scripts": [
    { "matches": ["*://*.zhipin.com/web/geek/job*"],
      "js": ["src/selectors.js", "src/filters.js", "src/content-search.js"],   // filters 前置注入(M1)
      "run_at": "document_idle" },
    { "matches": ["*://*.zhipin.com/web/geek/chat*"],
      "js": ["src/selectors.js", "src/content-chat.js"], "run_at": "document_idle" },
    { "matches": ["*://*.zhipin.com/web/geek/favlist*"],                                       // M5
      "js": ["src/selectors.js", "src/content-fav.js"], "run_at": "document_idle" }
  ]
}
```

> 注：`filters.js` 若只在 SW 使用则不需要注入页面；按 §3.1 的"页面本地预过滤"方案才需要。二选一，见 §3.1。

---

## 3. 模块实现指南

### 3.1 `src/filters.js`（M1）

**职责**：纯函数过滤引擎，无副作用。

```js
// 导出（SW 用 importScripts 后直接可用；页面注入时挂 window.BPFilters）
const BPFilters = {
  parseSalary(text)        // '10-15K·13薪' → {min:10, max:15, months:13}；失败返回 null
  matchList(name, list)    // 名单匹配：exact 全等优先，再 keyword includes（都 trim、不区分大小写）
  applyFilters(jobs, cfg)  // 主入口 → { kept, dropped:[{job, reason}] }
};
```

**实现要点**

1. `applyFilters` 命中即短路 drop，reason 必须是中文短句（直接进日志与审核列表）：
   - 黑名单命中 → `'黑名单：' + 命中项`
   - 白名单模式未命中 → `'白名单外'`
   - 薪资 → `'薪资不符（期望 x-yK，岗位 a-bK）'`
   - 活跃 → `'活跃度不符（仅接受在线，岗位为本周活跃）'`
   - 其余同理。
2. `salary` 判断用**区间重叠**：岗位 `salaryMin ≤ cfg.max && salaryMin ≥ cfg.min`（boss-plus 的"范围重叠/完整符合"两档：`overlap|contain` 可作为 cfg 扩展项，默认 overlap）。
3. 名单数据结构每项 `{name, mode:'exact'|'keyword'}`；批量导入解析：每行一条，` @kw` 后缀表示关键词模式，如 `字节跳动 @kw`。
4. **落位二选一**（实现时定死一种）：
   - **方案 A（推荐，M1 先做）**：只在 SW 用——`runCollect()` 拿到 `state.jobs` 后、AI 循环前调用。改动小。
   - **方案 B（进阶）**：content-search 收集时本地预过滤（需注入 filters.js 到页面），减少 `sendResponse` 数据量。M5 之后再考虑。
5. `RUN_FILTER_DRY` 消息：SW 收到后读 storage 的 `filterConfig` + `sw_screened` 跑 `applyFilters`，把 `{kept, dropped}` 以 `SCREENED` 消息推给侧边栏（复用渲染，dropped 显示为灰色项）。

**顺带改造 `content-search.js`**

`parseCard()` 增采字段（选择器进 `SELECTORS.jobs`）：

```js
salaryMin, salaryMax,      // 用 BPFilters.parseSalary(salEl.textContent)
activeState,               // 卡片活跃图标 class：online→'online'，本周→'week'，本月→'month'，无→'unknown'
inviteCount                // 角标 '√ 30人沟通' 类文本 → 30；取不到 → -1（视为不高）
```

`openJD()` 顺带抓 `addr`（工作地址行）与 `fund`/`fundCurrency`（公司信息区"注册资本：1000万人民币"）。正则参考：

```js
const m = info.match(/注册资本[：:]\s*([\d.]+)\s*(万[美元美圆]|万|亿)/);  // 美元/美圆 → skipUsdFund 命中
```

### 3.2 节奏控制改造 `background.js`（M2）

**改动点 1：`getCfg()` 扩展读取**

```js
function getCfg() { return chrome.storage.local.get(['apiBaseUrl', ...现有..., 'paceConfig', 'scheduleConfig', 'statGoal']); }
```

**改动点 2：`runDeliver()` 头部配额计算**

```js
// 伪代码
const pace = cfg.paceConfig || DEFAULT_PACE;
const today = todayKey();                       // 'YYYY-MM-DD' 本地时区
const stats = (await chrome.storage.local.get('deliverStats')).deliverStats || {};
const todayOk = stats[today]?.ok || 0;
const quota = Math.min(pace.maxPerRun, pace.dailyGoal - todayOk);
if (quota <= 0) { log('已达今日目标/上限，自动暂停', 'warn'); pushPauseReason('goal'); ... }
```

**改动点 3：循环内**

- 每次迭代开始：`await waitIfPaused()` **并重新检查配额**（投递途中跨天/达标的情况）
- `await rand(...preSendDelay)` 替换建联前的固定等待
- `rand(2500,4500)` → `rand(...pace.postDeliverRest)`；跳过分支 → `rand(...pace.skipRest)`

**改动点 4：统计写入（`recordOk` / `recordFail` / 跳过分支）**

```js
async function bumpStat(field) {   // field: 'ok' | 'fail' | 'skip'
  // 读 deliverStats → stats[today][field]++ → 写回（读改写要串行，或用 get 后立即 set）
}
```

**新增 `PAUSE_REASON`**：`pushPauseReason(reason)` = `chrome.runtime.sendMessage({type:'PHASE', phase:'idle', reason})`，侧边栏据此显示「达标暂停 / 单次上限暂停」而非笼统"已完成"。

### 3.3 `src/scheduler.js`（M3）

```js
// importScripts('src/scheduler.js') 加在 background.js 顶部
function ensureAlarm() {
  chrome.alarms.create('bp-schedule', { periodInMinutes: 1 });   // create 幂等，覆盖同名
}
chrome.alarms.onAlarm.addListener(al => {
  if (al.name !== 'bp-schedule') return;
  onScheduleTick();
});
async function onScheduleTick() {
  const { scheduleConfig, phase } = ...;                         // phase 从 storage/sw_state 读
  if (!scheduleConfig.enabled) return;
  const now = hhmmNow();                                         // 'HH:MM'
  const fired = scheduleConfig.lastFired || {};                  // {'2026-09-09': ['09:30']}
  if (!scheduleConfig.times.includes(now)) return;               // 分钟级精确匹配
  if ((fired[todayKey()] || []).includes(now)) return;           // 当日去重
  if (phase !== 'idle') return;                                  // 正在跑则跳过
  if (inQuietHours()) return;
  fired[todayKey()] = (fired[todayKey()] || []).concat(now);
  await chrome.storage.local.set({ scheduleConfig: { ...scheduleConfig, lastFired: fired } });
  // 开跑：组装 source 对应的收集流程；autoDeliver 时在 phase==='review' 后自动全选投递
}
```

**注意**

- MV3 SW 随时休眠：`ensureAlarm()` 要在 `onInstalled` 与 SW 顶层各调一次。
- `periodInMinutes:1` 是 alarms 最小可靠粒度；`times` 只支持到分钟。
- 定时触发的 `runCollect` 若 `autoDeliver=true`，复用侧边栏"投递选中"路径：筛完后取全部 `match=true` 的 id 调 `runDeliver(ids)`，并先弹 `LOG`（用户回来能在日志看到全过程）。

### 3.4 用语库与自动回复（M4）

**投递侧（background.js）**

```js
async function pickGreeting(cfg, job, hrName) {
  const tpl = (cfg.greetTemplates || []).filter(t => t.enabled);
  if (!tpl.length) return genGreetingFromJD(cfg, job, job.jd);   // AI 兜底
  const pick = tpl[(greetCursor++) % tpl.length];                // 顺序轮换（游标存 storage 防重启归零）
  return fillTemplate(pick.content, { hrName, jobName: job.name, useName: pick.useName });
}
// fillTemplate: '{称呼}' → hrName ? 姓+先生/女士(可配) : '您好'
// 防重：读 sentContacts[key].lastGreet === pick.id 时换下一条，轮满一圈才允许重复
```

- `runDeliver` 中 `genGreetingFromJD` 调用点替换为 `pickGreeting`；生成后写 `sentContacts[key].lastGreet = pick.id`。

**聊天侧（content-chat.js）**

```js
// 1) MutationObserver 监听消息容器（SELECTORS.chat.messageList / itemHis）
// 2) 新 HR 气泡 → 取最近 1-2 条文本 → chrome.runtime.sendMessage({type:'AUTO_REPLY_GEN', text})
// 3) SW: 查 autoReplyLog 冷却 + quietHours + 轮数上限(autoReplyCount[key] < 3)
//    → callLLM(系统提示词：以求职者身份简短回复，带简历摘要上下文)
//    → 响应 {ok, text} → content script sendText(text)
// 4) 冷却记录: autoReplyLog[contactKey] = Date.now()（键与 sentContacts 同构）
```

**安全阀（必须实现）**：默认 `enabled:false`；单会话轮数上限；免打扰时段只记不回；AI 失败静默跳过并打日志。

### 3.5 `src/content-fav.js`（M5）

- 结构复制 `content-search.js` 的骨架（防重入 + `chrome.runtime.onMessage`）。
- 只实现 `FAV_SCRAPE`：复用 `parseCard`（从 selectors 拿 `SELECTORS.fav.jobCard`），返回 `jobs`。
- **不做建联**：收藏夹页无"立即沟通"按钮群，投递走标准闭环（回搜索页/详情建联），即 `runDeliver` 现有流程天然兼容，无需改动——收藏只影响"收集"环节。
- `favMode:'favOnly'` 时：逐卡片点击收藏星标（记录进度到 storage，支持断点续点），不投递。

### 3.6 侧边栏 UI（随各里程碑交付）

**新增卡片顺序**（沿用 `01/02/03...` 编号体系）：

| # | 卡片 | 内容 | 里程碑 |
|---|------|------|--------|
| 02 | 运行控制 | + 投递来源单选（搜索/收藏） | M5 |
| 03 | **岗位过滤** | 名单模式切换、黑/白名单列表编辑器、薪资/城市/活跃/关键词规则、试算按钮 | M1 |
| 04 | **定时与节奏** | 定时开关+时段列表+autoDeliver 开关；节奏区间/上限/日目标 | M2+M3 |
| 05 | **用语与回复** | 招呼语库 CRUD+启用开关、自动回复开关/模式/冷却/免打扰 | M4 |
| 06 | **投递统计** | 今日/本周/月进度条、14 天迷你柱状图、清空按钮 | M2 |
| — | 审核确认 | dropped 项灰色展示（`RUN_FILTER_DRY` 结果复用渲染） | M1 |

**实现约定**

- 配置读写沿用 `chrome.storage.local` + `CFG_FIELDS` 模式，新键追加到数组。
- 列表编辑器（黑名单）参考现有「已投递企业」面板的 `co-row` 结构与 `refreshCompanies()` 模式。
- 导出/导入复用 `downloadJSON()`，`_type` 分别为 `JobCopilot.Filters` / `JobCopilot.Schedule`。
- 统计柱状图纯 CSS（flex 高度百分比），不引图表库。

---

## 4. 协议与数据参考（新增部分汇总）

### 4.1 消息协议

| 消息 | 方向 | 载荷 | 响应 |
|------|------|------|------|
| `RUN_FILTER_DRY` | panel → SW | 无 | `{ok, kept:n, dropped:n}`（并推 `SCREENED`） |
| `AUTO_REPLY_GEN` | chat → SW | `{text, contactKey}` | `{ok, text}` |
| `FAV_SCRAPE` | SW → content-fav | `{count}` | `{success, jobs}` |
| `CLEAN_MESSAGES` | panel → SW → chat | `{confirm:true}` | `{success, removed}` |
| `GET_STATS` / `CLEAR_STATS` | panel → SW | — | `{ok, stats, goal}` |
| `PHASE`（扩展） | SW → panel | `{phase, reason?}` | reason: `goal`/`quota`/`quiet`/`manual` |

### 4.2 storage 键（新增）

见设计文档 §3.3。**默认值兜底**：background 顶层加 `ensureDefaults()`：

```js
const DEFAULT_PACE = { preSendDelay:[2,6], postDeliverRest:[20,60], skipRest:[3,8], maxPerRun:30, dailyGoal:60, pauseOnGoal:true };
const DEFAULT_FILTER = { listMode:'off', blacklist:[], whitelist:[], salary:{min:0,max:0}, cities:[], addrExclude:[], active:{online:false,week:false,month:false}, skipHighInvite:false, skipUsdFund:false, fundMin:0, kwMode:'off', keywords:[], jobHandle:'skip' };
// storage.local.get 各键 → 缺失即 set 默认值
```

---

## 5. 测试与验收

### 5.0 自动化测试（已建成，提交前必跑）

```bash
cd "JobCopilot · AI"
node tests/run-all.js          # 全部 Node 层测试（~69 用例，约 10s）
node tests/run-all.js 过滤引擎  # 只跑某个套件（子串匹配）
node tests/smoke-edge.js       # 真实 Edge 冒烟测试（headless，独立临时配置，不碰用户浏览器）
```

| 测试文件 | 覆盖内容 |
|----------|----------|
| `tests/helpers.js` | chrome.* mock（storage 惰性求值/tabs/scripting/runtime 消息总线）、vm 沙箱 SW 加载器、迷你 DOM（支持本项目全部选择器形态） |
| `tests/test-filters.js` | 过滤引擎：薪资解析 9 种格式、名单 @kw、黑/白/关键词/城市/活跃/邀请量/资金、容错、短路顺序 |
| `tests/test-background.js` | 集成：初始化默认值 → 收集 → 规则过滤（skip/collect 两模式）→ AI 筛选 → RUN_FILTER_DRY 试算持久化 → 投递闭环 → 联系人去重 → 资金拦截 → 发送失败容错 → 暂停/停止/重置 → GET/CLEAR_COMPANIES → 投递统计（ok/fail/skip、GET/CLEAR_STATS）→ 单次上限/每日目标配额拦截（reason=quota/goal）→ 消息全链路 |
| `tests/test-content-search.js` | 迷你 DOM 驱动：SCRAPE 全字段解析、count 截断、stall 收敛、OPEN_JD（HR 名/兜底/JD/地址/注册资本）、GO_CHAT 成功/失败 |
| `tests/test-content-chat.js` | contenteditable 输入、回车发送、发送按钮兜底、会话匹配/兜底、发送未确认失败路径、诊断输出 |
| `tests/test-sidepanel.js` | 默认值填充、collectFilterCfg/applyFilterCfgToUI 往返一致、保存持久化、试算与开始收集的保存时序、renderReview 分区渲染、配置回填 |
| `tests/smoke-edge.js` | 真机：`--headless --load-extension` 加载扩展 → CDP 验证 SW（版本/BPFilters/黑名单端到端/默认值）→ 打开侧边栏页面验证 UI 与「UI保存→storage」全链路 |

**注意事项**
- mock 的 `storage.get` 是惰性求值（微任务时才读数据），与真实 chrome.storage 时序一致；新增 SW 代码依赖 storage 时按真实语义写即可。
- `makeFetchQueue` 队列耗尽会抛错——fetch 调用次数超出脚本预期会立刻暴露，测试中断言调用次数时要把"筛选+招呼语"两阶段都算进去。
- 跨 vm realm 的对象不能用 `deepStrictEqual`（原型不同 realm），统一用 `JSON.stringify` 比较。
- 冒烟测试需要 Edge 152+（`--headless` 即新版 headless；`--headless=new` 已废弃）；如需换浏览器路径设 `EDGE_PATH` 环境变量。
- 冒烟测试若报 `CDP 端口未就绪`：换 `smoke-edge.js` 顶部 `PORT` 再试（旧进程残占端口时会发生）。

### 5.1 单测（filters.js）

`filters.js` 设计为纯函数，可脱离浏览器测：Node 下 `node -e "require('./src/filters.js')"` 式跑（导出挂 `module.exports` + `window` 双端）或临时复制到 Node REPL。用例覆盖：

- 薪资解析：`'8-12K'`、`'10-15K·13薪'`、`'面议'`、`'2-3万'`、异常输入
- 名单：exact 大小写/空格、keyword 子串、空名单
- 组合：黑名单 + 薪资同时命中时 reason 只报前者（短路顺序）

### 5.2 手工验收清单

**M1 过滤**
- [ ] 黑名单公司（exact + keyword 各一条）在收集后直接消失，日志有「规则过滤掉 N 个」
- [ ] 白名单模式下仅白名单公司进审核
- [ ] 「试算」按钮对上轮数据重跑，不发起网络请求、不重置已投记录

**M2 节奏与统计**（已实现，v1.2.0）
- [x] `maxPerRun=3` 时第 4 个岗位不投、状态显示「单次上限暂停」
- [x] `dailyGoal` 达标后跨"投递选中"重试仍被拦
- [x] 统计卡片数字与日志成功数一致；清空后归零
- 补充实现说明：`deliverStats` 由 `bumpStat()` 串行队列写（防投递并发读改写竞态）；跳过（去重/资金）计入 `skip` 不计入 `fail`；`GET_STATS` 返回 today/week/month 聚合 + 近 14 天 `days` 数组；达标/限额通过 `PHASE` 消息携带 `reason: 'goal' | 'quota'`，UI 状态栏显示「达标暂停 / 单次上限暂停」；节奏区间（preSendDelay/postDeliverRest/skipRest）暂用默认值，UI 暴露单次上限/每日目标/达标暂停三项（M3 定时卡片再补区间设置）

**M3 定时**
- [ ] 设 2 分钟后的时段 → 到点自动开始收集；SW 手动停止后再验证（模拟休眠唤醒）
- [ ] 免打扰时段不触发

**M4 用语/自动回复**
- [ ] 语库 3 条启用 → 连续投 3 个岗位发出的招呼语各不相同且带称呼
- [ ] 语库全部禁用 → 自动回退 AI 招呼语
- [ ] 自动回复：HR 回一句话后 ≤10s 收到 AI 回复；30 分钟冷却内二次回复被拦截并有角标

**M5 收藏/周边**
- [ ] 来源选收藏 → 收集到收藏岗位并可完整投递
- [ ] 消息清理有二次确认，误触可拒绝

### 5.3 回归清单（每里程碑必跑）

- [ ] 原有全流程：收集 → AI 筛选 → 审核勾选 → 投递 1 个真实岗位成功
- [ ] 联系人去重仍生效（同公司同 HR 二次投递被跳过）
- [ ] 导出/导入联系人 JSON 兼容旧文件（`_type: JobCopilot.Contacts`）
- [ ] 暂停/停止/重置行为与 v1.0.0 一致

---

## 6. 排错手册（新功能相关）

| 症状 | 排查 |
|------|------|
| 规则过滤把好岗位也滤掉了 | 审核列表 dropped 的 reason 即规则名；用「试算」快速回放；常见坑：薪资把 `面议(null)` 判死 → 面议放行 |
| 活跃状态全是 unknown | BOSS 卡片结构变了 → DevTools 里查活跃图标新 class，更新 `SELECTORS.jobs.active` |
| 定时不触发 | SW DevTools 里手动 `chrome.alarms.getAll(console.table)`；确认扩展被杀后 alarm 仍存在；`lastFired` 当日去重是否吞掉了触发 |
| 自动回复不响 | 消息容器选择器失效（用 dumpInputs 思路 dump 消息列表结构）；冷却/免打扰/轮数上限三道闸逐一排除 |
| 语库轮换重复 | `greetCursor` 存 storage 未做，SW 重启归零 → 落 storage |
| 收藏页抓到 0 个 | favlist 路由变了（可能是 `favlist` / 其他路径），检查 manifest matches 与 `SELECTORS.fav` |
| 与 boss-plus 冲突（双开自动投递） | 页面出现两套投递浮层/重复发送 → 二选一，本项目日志提示检测 |

---

## 7. 发布流程

1. 每里程碑：改 `manifest.json` version（1.1.0 → 1.5.0）
2. `git`：本仓库非 git repo 的话先 `git init`（`.gitignore` 已存在）；提交信息风格 `feat(M1): filters engine + blacklist UI`
3. 自跑 §5.3 回归清单后打 tag：`v1.1.0-m1`
4. README「功能特性」区块随里程碑补充对应条目（保持开源仓库可读性）

## 8. 风险实现注意

- **stats 读改写竞态**：`bumpStat` 可能与定时投递并发 → 简单方案：SW 内单飞行队列（promise 链）串行化写 storage。
- **SW 休眠**：`state` 内存随时丢失——所有新流程状态（定时游标、语库游标、自动回复计数）必须落 storage，唤醒重建（沿用 `sw_jobs` 模式）。
- **boss-plus 同时在线**：不主动对接它；检测到页面存在 `#bp-root` 类浮层且用户开启本项目自动投递时，日志警告一次即可，不做技术互斥。
