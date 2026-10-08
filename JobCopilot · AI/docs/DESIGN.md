# 小北智能招聘 融合设计文档

> 版本：v0.1（设计稿）
> 日期：2026-09-09
> 目标：将 boss-plus（闭源油猴脚本）的高价值功能**重写移植**进 JobCopilot（开源 MV3 扩展），形成「规则过滤 + AI 筛选 + 受控自动投递」的完整求职智能体。

---

## 1. 背景与目标

### 1.1 背景

| 项目 | 形态 | 授权 | 核心能力 | 局限 |
|------|------|------|----------|------|
| JobCopilot | MV3 浏览器扩展（侧边栏） | MIT 开源，可自由修改 | AI 岗位筛选（DeepSeek）、千岗千面招呼语、自动投递闭环、联系人去重 | 过滤能力弱、无节奏护栏、无定时、无自定义用语 |
| boss-plus | Tampermonkey 油猴脚本（SystemJS 混淆） | 闭源，仅可观察其功能 | 黑/白名单公司、多维度岗位过滤、定时投递、节奏控制、自动回复、消息清理 | 代码混淆不可改、依赖油猴环境、无 AI |

**结论**：以 JobCopilot 为底座，把 boss-plus 的功能**按界面逻辑重写**为原生模块，AI 部分复用现有 `callLLM()`。boss-plus 代码不可复用（混淆 + 闭源），只移植"功能概念"。

### 1.2 目标

1. **省 API**：纯规则过滤前置，只把真正值得判断的岗位送进 LLM，显著降低 DeepSeek 调用量。
2. **更安全**：投递节奏护栏（间隔、单次上限、每日目标、自动暂停），降低账号风控风险。
3. **更自动**：定时投递、自动回复，减少人工盯守。
4. **不打架**：与 boss-plus 可同时安装使用；本项目的功能全部原生实现，不依赖油猴。

### 1.3 非目标（本期不做）

- 不逆向/解密 boss-plus 代码，不复制其任何代码片段。
- 不做多平台（仅 BOSS 直聘 zhipin.com）。
- 不做简历生成、面试辅导等衍生功能。

---

## 2. 现状盘点（基线 v1.0.0）

### 2.1 现有架构

```
manifest.json (MV3)
  ├── permissions: storage, tabs, scripting, sidePanel
  ├── host_permissions: *://*.zhipin.com/*, https://api.deepseek.com/*, https://opencode.ai/*, https://open.bigmodel.cn/*, https://restapi.amap.com/*
  ├── optional_host_permissions: *://*/*（自定义 LLM 端点按 origin 动态申请）
  ├── service_worker: src/background.js
  └── content_scripts:
        ├─ /web/geek/job*   → selectors.js + content-search.js
        └─ /web/geek/chat*  → selectors.js + content-chat.js
```

### 2.2 现有核心流程

```
配置条件 → runCollect(): SCRAPE 收集岗位 → AI 逐岗筛选(并发3) → 存盘 sw_screened
        → 侧边栏审核勾选 → runDeliver(jobIds): 逐个闭环
          OPEN_JD(读JD+HR名) → 联系人去重 → genGreetingFromJD(现场生成招呼语)
          → GO_CHAT(建联) → SEND_ACTIVE(发简历图+招呼语) → 记录 sentContacts
```

状态机：`idle → collecting → screening → review → delivering → done`。

### 2.3 现有存储键

| 键 | 内容 |
|----|------|
| `apiBaseUrl` / `apiKey` / `apiModel` | OpenAI 兼容端点配置 |
| `resumeText` / `resumeImage` | 简历文字 / 简历图片(base64) |
| `keyword` / `city` / `count` | 搜索条件 |
| `sentContacts` | 联系人去重：`{ "公司｜HR名": {company, hrName, count, firstSentAt, lastSentAt} }` |
| `processed` / `sw_jobs` / `sw_greetings` / `sw_screened` | 本轮投递状态与 SW 回收恢复数据 |

### 2.4 现有消息协议

| 消息 | 方向 | 说明 |
|------|------|------|
| `SCRAPE` / `OPEN_JD` / `GO_CHAT` | SW → content-search | 收集 / 读详情 / 建联 |
| `SEND` / `SEND_ACTIVE` | SW → content-chat | 定向发送 / 发当前会话 |
| `START_COLLECT` / `START_DELIVER` / `PAUSE` / `RESUME` / `STOP` / `RESET` / `GET_STATE` | 侧边栏 → SW | 流程控制 |
| `LOG` / `PROGRESS` / `PHASE` / `SCREENED` / `DONE` / `COMPANIES_UPDATED` | SW → 侧边栏 | 状态回传 |
| `GET_COMPANIES` / `CLEAR_COMPANIES` | 侧边栏 → SW | 去重记录管理 |

---

## 3. 总体设计

### 3.1 融合流水线

核心原则：**规则过滤前置（零成本）→ 名单过滤（零成本）→ AI 筛选（花钱）→ 人工审核 → 受控投递**。

```
                ┌─────────────── 新增 filters.js（纯规则，零 API 成本）───────────────┐
                │  ① 名单过滤：黑名单剔除 / 白名单模式仅留白名单                       │
                │  ② 硬性规则：薪资范围、地区/工作地址、活跃状态、高邀请量、            │
                │     注册资金(跳过美元/过低)、岗位关键词(包含/排除模式)                │
                └──────────────────────────────┬───────────────────────────────────┘
                                               ▼
SCRAPE 收集 ──► 规则过滤 ──► AI 筛选(现有 screenJob) ──► 人工审核 ──► 受控投递
   │                                              │                    │
   │ (boss-plus 投递来源：搜索列表 / 收藏夹 favlist)│                     ├─ 节奏控制：发送前/后等待、随机延迟
   │                                              │                    ├─ 上限护栏：单次上限、每日目标、到量自动暂停
   └──────────────────────────────────────────────┘                    └─ 定时调度：chrome.alarms 到点自动开跑
```

### 3.2 新增模块与改动落位

| 文件 | 动作 | 职责 |
|------|------|------|
| `src/filters.js` | **新增** | 岗位过滤引擎：名单 + 硬性规则，纯函数可单测 |
| `src/scheduler.js` | **新增** | 定时投递（chrome.alarms）、每日/单次配额计算 |
| `src/content-fav.js` | **新增** | 收藏夹页抓取岗位（投递来源之二） |
| `manifest.json` | 修改 | +`alarms` 权限；content_scripts 增加 favlist 匹配 |
| `src/selectors.js` | 修改 | 新增收藏页/活跃状态/邀请量/薪资结构等选择器，统一集中管理 |
| `src/background.js` | 修改 | runCollect 插入过滤管线；runDeliver 接入节奏/配额；新增调度与统计消息 |
| `src/content-search.js` | 修改 | parseCard 增采字段（活跃状态、邀请量、薪资解析）；GO_CHAT 前置检查 |
| `src/content-chat.js` | 修改 | 新增自动回复监听、消息清理命令 |
| `src/sidepanel.{html,css,js}` | 修改 | 新增：过滤规则、名单管理、定时/节奏、招呼语库、统计、主题 六个区块 |

### 3.3 数据模型设计（新增存储键）

全部存 `chrome.storage.local`，与现有键共存，**不改已有键的语义**。

```js
// ── 过滤配置（sidepanel 写入，background/filters 读取）──
filterConfig: {
  listMode: 'off' | 'black' | 'white',      // 名单模式：关闭/黑名单/白名单
  blacklist:   [ { name, mode:'exact'|'keyword', note, createdAt } ],
  whitelist:   [ { name, mode:'exact'|'keyword', note, createdAt } ],
  salary:   { min: 0, max: 0 },             // K/月；0 表示不限
  cities:   [],                             // 地区关键词（工作地址含任一即保留）
  addrExclude: [],                          // 工作地址排除关键词
  active:   { online: false, week: false, month: false },  // 活跃门槛（勾选=只留该档）
  skipHighInvite: false,                    // 跳过高邀请量岗位
  skipUsdFund: false,                       // 跳过美元注册资金
  fundMin: 0,                               // 注册资金下限（万）
  kwMode: 'off' | 'include' | 'exclude',    // 岗位名/标签关键词模式
  keywords: [],
  jobHandle: 'skip' | 'collect'             // 命中过滤的岗位处理方式：直接跳过/仅标记
}

// ── 定时与节奏 ──
scheduleConfig: {
  enabled: false,
  times: ['09:30', '14:00', '20:00'],       // 每日触发时段
  autoDeliver: false,                       // 到点是否自动投递（否则只收集+筛选）
  source: 'search' | 'fav'                  // 定时任务投递来源
}
paceConfig: {
  preSendDelay: [2, 6],        // 秒，发送前随机等待区间
  postDeliverRest: [20, 60],   // 秒，投递后休息区间（现有固定 rand(2500,4500) 升级）
  skipRest: [3, 8],            // 秒，跳过后休息
  maxPerRun: 30,               // 单次投递上限
  dailyGoal: 60,               // 每日目标数（达到后自动暂停）
  pauseOnGoal: true            // 达标自动暂停
}

// ── 招呼语库与自动回复 ──
greetTemplates: [ { id, name, content, useName: bool, enabled: bool } ],
autoReplyConfig: {
  enabled: false,
  mode: 'ai' | 'fixed',                     // AI 生成 / 固定用语
  fixedTexts: [],
  cooldownMin: 30,                          // 同一 HR 冷却分钟数
  quietHours: { from: '23:00', to: '08:30' }  // 免打扰时段
}

// ── 统计 ──
deliverStats: { '2026-09-09': { ok: 12, fail: 3, skip: 5 }, ... },
statGoal: { monthly: 300 }                  // 月目标（进度条展示）

// ── 外观 ──
uiTheme: 'dark' | 'light'
```

### 3.4 消息协议扩展

新增消息（沿用现有 `chrome.runtime.onMessage` 风格）：

| 消息 | 方向 | 说明 |
|------|------|------|
| `RUN_FILTER_DRY` | 侧边栏 → SW | 用当前 filterConfig 对最近一次 `sw_screened` 重跑过滤（试算，不改状态） |
| `AUTO_REPLY_GEN` | content-chat → SW | HR 新消息文本 → SW 调 `callLLM` 生成回复（content script 不直接连 API） |
| `SCHED_TICK` | SW 内部(alarms) | 定时器触发：读 scheduleConfig 决定是否开跑 |
| `GET_STATS` / `CLEAR_STATS` | 侧边栏 → SW | 读取/清空投递统计 |
| `FAV_SCRAPE` | SW → content-fav | 抓取收藏夹岗位 |
| `CLEAN_MESSAGES` | 侧边栏 → SW → content-chat | 一键清理消息列表 |
| `PAUSE_REASON` | SW → 侧边栏 | 携带暂停原因（达标/配额/免打扰），UI 区分展示 |

### 3.5 投递状态机扩展

在现有 `idle/collecting/screening/review/delivering/done` 基础上：

- 新增 `scheduled`（定时等待中）与 `paused-goal`（达标自动暂停）两个展示态（映射到现有 paused 语义，UI 只改文案）。
- `runDeliver()` 进入时先读 `paceConfig` 与 `deliverStats` 计算**本次配额** `min(maxPerRun, dailyGoal - 今日已投)`，投递循环每次迭代前检查配额与暂停标志。

---

## 4. 功能模块设计

### 4.1 过滤引擎 `filters.js`（最高优先级）

**设计要点**

- 纯函数式：`applyFilters(jobs, filterConfig) → { kept, dropped: [{job, reason}] }`，不碰 DOM、不碰 storage，输入输出都是纯数据 → 可离线单测。
- 名单匹配两级：`exact`（trim 后全等）与 `keyword`（公司名 `includes` 关键词，大小写不敏感）。与现有 `contactKey()` 的"精确双键"哲学一致。
- 匹配顺序（命中即 drop，短路）：

```
黑名单(exact → keyword) → 薪资范围重叠判断 → 地区/地址关键词 → 活跃状态
→ 高邀请量 → 注册资金(美元/下限) → 岗位关键词(include/exclude) → 白名单模式兜底
```

- 白名单模式：`listMode='white'` 时**只保留**命中白名单的岗位，其余 drop，reason 标注"白名单外"。
- **岗位字段依赖**：需要 `content-search.js` 的 `parseCard()` 增采：

| 字段 | 来源 | 用途 |
|------|------|------|
| `salaryMin/salaryMax`（K） | 薪资文本解析，支持 `8-12K`、`8-15K·13薪` | 薪资范围过滤 |
| `activeState`（`online`/`week`/`month`/`unknown`） | 卡片活跃图标的 class | 活跃门槛 |
| `inviteCount` | 卡片"X人投递/沟通"角标 | 跳过高邀请量 |
| `addr` | 详情页 JD 抓取（OPEN_JD 时已顺带拿到） | 地址/地铁过滤 |
| `fund`（万）/ `fundCurrency` | 详情页"公司信息"区 | 注册资金规则 |

- **与 AI 的关系**：过滤是前置闸门；`jobHandle='collect'` 时被规则掉的岗位仍进审核列表但标灰、默认不勾选（对应 boss-plus 的"岗位处理方式"）。

**UI（侧边栏新增卡片「岗位过滤」）**

- 名单模式三态切换 + 黑/白名单两个可编辑列表（增删改、支持批量粘贴导入：每行一条，`公司名 @关键词` 语法可选）。
- 薪资双滑块/双输入、城市多选（复用 `CITY_MAP`）、活跃档位 checkbox、其余开关。
- 「按最新名单重新试算」按钮 → `RUN_FILTER_DRY`，在不重新收集的情况下预览过滤结果。

### 4.2 定时投递 `scheduler.js`

- **触发**：`chrome.alarms.create('bp-schedule', { periodInMinutes: 1 })` 每分钟 tick；tick 内比对当前时间与 `scheduleConfig.times`（精确到分钟，同一时段去重：当日已触发过的时间戳记在 `scheduleConfig.lastFired`）。
- **动作**：到点 → 若 `phase !== 'idle'` 跳过 → 按 `source` 组装搜索 URL（或收藏页）→ `runCollect()` → 若 `autoDeliver` 且 `phase==='review'`：自动勾选全部匹配岗位（可配：只投 AI match 的）→ `runDeliver(ids)`。
- **静默条件**：免打扰时段（复用 `autoReplyConfig.quietHours`）、SW 醒来发现浏览器未登录 zhipin 时打日志退出。
- **权限**：manifest 增加 `"alarms"`。MV3 SW 会被回收，调度状态一律落 storage，SW 唤醒后从 storage 重建（沿用现有 `sw_jobs` 恢复模式）。

### 4.3 节奏控制（并入 background.js runDeliver）

- 现状：投递后固定 `rand(2500,4500)`、跳过后 `rand(1500,2500)`。
- 升级：全部改读 `paceConfig` 区间；发送前新增 `preSendDelay`。
- **配额护栏**：

```
quota = min( maxPerRun, dailyGoal - todayOk )     // todayOk 取 deliverStats[今天].ok
for job of ids:
  if (deliveredThisRun >= quota) → PAUSE_REASON('达到单次上限') 或 done
  if (pauseOnGoal && todayOk >= dailyGoal) → PAUSE_REASON('达到今日目标')
```

- 达标暂停不 `RESET`：保留审核列表，用户手动继续需先清目标或调大 `dailyGoal`。
- 统计写入：投递成功/失败/跳过分别累加到 `deliverStats[YYYY-MM-DD]`（`recordOk/recordFail` 处顺带写）。

### 4.4 自定义招呼语 + 自动回复

**招呼语库（投递侧）**

- `greetTemplates` 多套启用，投递时**轮换**取用（顺序/随机可配），每套支持：
  - `{称呼}` 占位：HR 名有则替换为「X先生/X女士」或姓氏+职位（boss-plus 的"姓名称呼"），无 HR 名降级为「您好」；
  - `useName` 开关控制是否带称呼。
- **优先级**：`固定用语库(启用中) → AI 千岗千面(现有 genGreetingFromJD 兜底)`。即：语库非空时先用语库，空/全部禁用时走 AI，保证无 AI Key 也能跑纯 boss-plus 模式。
- **防重**：同岗位若历史上已发过同一条语（记 `sentContacts[key].lastGreet`），轮换下一条（boss-plus 的"跳过已发过自定义招呼语的职位"）。

**自动回复（聊天侧）**

- `content-chat.js` 挂 `MutationObserver` 监听消息列表（`.item-his` 等 HR 气泡选择器）：
  - 新增 HR 消息 → 检查 `autoReplyConfig.enabled`、免打扰时段、该 HR 冷却（`chrome.storage` 记 `autoReplyLog[hrKey] = lastAt`，同现有联系人键）→ 通过则发 `AUTO_REPLY_GEN` 给 SW；
  - SW 用 `callLLM`（上下文带：最近几条对话 + 我的简历摘要）生成回复 → 回发 content script 用现有 `sendText()` 发出；
  - 冷却期内不回复，页面角标提示"自动回复冷却中"。
- **安全阀**：默认关闭；单会话最多自动回复 N 轮（默认 3），防止死循环；免打扰时段只标记不发送。

### 4.5 投递来源：收藏夹

- manifest 增加 `*://*.zhipin.com/web/geek/favlist*` 的 content_scripts（`content-fav.js`）。
- `content-fav.js` 复用 `parseCard` 逻辑（选择器集中到 `SELECTORS.fav`）抓取收藏岗位 → `FAV_SCRAPE`。
- 侧边栏「运行控制」增加**投递来源**单选（搜索 / 收藏），`runCollect` 按来源决定打开的 URL 与注入脚本；收藏模式跳过城市/关键词校验。
- 兼容 boss-plus 的「只点收藏」语义：收藏模式下不建联，仅逐个点收藏（后续手动处理）——作为 `favMode: 'deliver' | 'favOnly'` 配置。

### 4.6 周边功能

| 功能 | 设计 | 落点 |
|------|------|------|
| 消息清理 | content-chat 一键批量删除会话（逐条右键菜单模拟+确认），带二次确认 | `CLEAN_MESSAGES` |
| 投递统计 | 侧边栏卡片：今日/本周/本月成功数、月目标进度条、最近 14 天迷你柱状图（纯 CSS） | `GET_STATS` + `deliverStats` |
| 公司评论 | 在黑名单条目上挂 `note` 备注（弃独立评论系统，降低复杂度） | 名单 UI |
| 主题 | 侧边栏 CSS 变量明暗双主题，`uiTheme` 持久化 | sidepanel.css |
| 数据迁移 | 现有导出/导入 JSON 机制扩展：`_type: 'JobCopilot.Filters'` 导出黑名单+过滤配置 | sidepanel.js |

---

## 5. AI 融合点总结

| 环节 | 策略 |
|------|------|
| 筛选前 | 规则 + 名单过滤掉明显不符（零 API 成本），AI 只看"够得着"的岗位 |
| 招呼语 | 语库优先、AI 兜底；AI prompt 不变（`genGreetingFromJD` 复用） |
| 自动回复 | HR 回复后 AI 生成（带对话上下文），冷却 + 免打扰 + 轮数上限 |
| 成本护栏 | `RUN_FILTER_DRY` 试算 + 过滤统计日志（"规则过滤掉 N 个，AI 只判 M 个"） |

---

## 6. 风控与合规设计

1. **节奏即安全**：所有等待区间默认值取保守档；`preSendDelay/postDeliverRest` 下限不低于人工操作水平。
2. **配额默认**：`maxPerRun=30`、`dailyGoal=60`，宁少勿多。
3. **免打扰**：夜间不投、不自动回复。
4. **免责**：沿用 README 免责声明；仅供学习交流与个人效率提升。
5. **可观测**：所有跳过/暂停都有 `reason` 落日志，用户可审计每一次自动行为。

---

## 7. 里程碑规划

| 里程碑 | 内容 | 交付判据 |
|--------|------|----------|
| **M1 过滤引擎** | filters.js + 名单/规则 UI + parseCard 增采 + 试算 | 黑名单公司 100% 不进 AI；规则可在不收集的情况下重放 |
| **M2 节奏与统计** | paceConfig + 配额护栏 + deliverStats + 统计卡片 | 达单次上限/日目标自动暂停；统计与日志一致 |
| **M3 定时投递** | scheduler.js + alarms 权限 + 定时 UI | 设定时段到点自动收集(+投递)，SW 被回收后仍生效 |
| **M4 用语与自动回复** | greetTemplates + 称呼模板 + 自动回复监听 | 语库轮换无重复；冷却/免打扰/轮数上限生效 |
| **M5 收藏与周边** | content-fav + 消息清理 + 主题 + 数据迁移扩展 | 收藏来源闭环可投；导出导入覆盖新配置 |

每个里程碑独立可发布（版本号 1.1.0 → 1.5.0），回滚点清晰。

---

## 8. 兼容性说明

- 与 boss-plus 同时安装：两者互不读写对方存储（键名前缀不同），DOM 注入的浮层类名均为 `bp-*` / 本项目自有前缀，无样式冲突；若 boss-plus 也开自动投递，**用户需自行二选一**，本项目在 UI 上提示检测到其他投递脚本运行。
- BOSS 改版风险：所有新选择器集中进 `selectors.js`，找不到元素时统一走 `dumpInputs` 式诊断输出（沿用现有模式）。
- 存储兼容：新增键全部带默认值结构，首次运行 `ensureDefaults()` 补齐；旧版本升级无感。
