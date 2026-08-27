# Claude 审查结论：水果店月度报表自动化

> 审查对象：`docs/claude-review-fruit-store-automation-2026-08-24.md`（审查包）+ 仓库工作树
> 基线：`main` = `5ff074b58443b0df59b1fd967d3cbcdb1e847402`，工作树除本文件与审查包外干净
> 方式：只读静态审查。未登录、未抓取、未推送钉钉、未触发修复、未改动生产。
> 审查时间：2026-08-24

## 0. 证据边界（先说我没做什么）

- **没有运行测试**。本机没有可用的 `node`/`pnpm`（`which node` 为空）。审查包里的 `198/198` 是 Codex 记录的结果，不是我复核过的。
- 下面每条都标注了「已在代码中确认」与「需要运行验证」。凡是标「推测」的，都没有充分依据，不要当结论用。
- 没有读取 `.env`、Cookie、浏览器 profile、`output/` 运行产物。

## 1. 总体判断

架构分层是清楚的：失败关闭是默认姿态，锁、watchdog、告警声明、内容寻址归档都实现得比较扎实，
跨午夜和分页完整性这类容易被忽略的边界都有显式守卫。**没有发现 P0。**

主要风险不在状态机——状态机是这套代码里做得最细的部分——而在**数据解析层的信任假设**，
以及**几处"看起来有保护、实际是恒真断言或不可达分支"的假保证**。
审查包第 2 节的结论表基本准确，但第 3 节「完整性与对账门槛」和第 9 节的测试覆盖描述，
比代码实际提供的保证要强。

---

## 2. P1

### P1-1 抖音未启用时，正式夜间报表静默降级，并被记为发送成功

`scripts/daily-report.cjs:653`

```js
const douyin = process.env.DOUYIN_ENABLED === "true" ? await retryStep(...) : null;
```

`douyin === null` 时 `buildMarkdown` 走「抖音数据未启用，综合营业额和毛利暂不计算」分支，
照常渲染、照常归档、照常推送钉钉。`run-scheduled-report.cjs:171` 看到子进程退出码 0，
写入 `status: "sent"` 并调用 `markReportHealthOk()`。

结果：**一份没有线上营业额、没有本月总营业额、没有毛利的报表被当作当晚正式报表发出，
且被计入"最近一日定时发送成功"，不触发任何告警。**

放大这条风险的是 `.env.example:11` 就是 `DOUYIN_ENABLED=false`。
任何一次从模板重建 `.env`、或运维改环境变量时漏掉这一行，都会落到这个状态。
审查包第 2 节把「最近正式日报 sent」当作健康证据，而这个证据无法区分完整报表和降级报表。

- 状态：**已在代码中确认**（不需要运行即可判定）。
- 最小修复：正式路径（`REPORT_MANAGED_BY_SCHEDULED=1` 或 `REPORT_FORMAL_WRAPPER=1`）加一条前置断言，
  `DOUYIN_ENABLED !== "true"` 直接失败关闭；或者把「本次报表是否包含抖音」写进
  `scheduled-report-state.json`，让健康证据能区分两种 sent。
- 回归测试：纯离线，构造两种 env 调用正式入口的守卫函数即可。

### P1-2 芝麻地金额解析没有有限性校验，NaN 会绕过对账断言并把进货额变成 0

`scripts/read-current-zhimadi.cjs:38-50`（解析）、`:72-80`（对账）、`:96`（计算）

三个缺陷叠在一起：

1. 解析用裸 `Number(row["销售金额"])`，**不去千分位逗号**。
   同仓库的乐檬解析器 `read-current-lemeng.cjs:4` 专门写了 `.replace(/[,\s]/g, "")`，
   说明这类后台表格确实会出现逗号格式。芝麻地这边没有。`Number("1,234.56")` → `NaN`。
2. 对账断言挡不住 NaN：`Math.abs(roundMoney(NaN) - detailTotal) > 0.01` 求值为 `false`，
   **不抛错，静默通过**。
3. 下游 `calculateOperatingTotals` 里 `roundMoney(purchaseAmount || 0)`——`NaN` 是 falsy，
   于是 `purchase` 变成 **0**，`profit = netRevenue - 0`。

完整失败链：芝麻地某天改成千分位渲染 → 所有 `sales` 为 NaN → 汇总断言静默放行 →
报表显示「芝麻地进货额：0.00」、「本月毛利 = 本月扣费后营业额」→ **毛利被虚增为全部营业额，
且没有任何告警**。同一条链也可以由合计行里出现一个空单元格触发
（`parts` 做了 `.filter(Boolean)`，空格会让 `parts.slice(totalIndex+1, totalIndex+9)` 整体错位）。

另外：`parseZhimadiText` **在 18 个测试文件里没有任何一条测试覆盖**
（`tests/report-calculations.test.cjs` 只覆盖到 `buildMarkdown` 及以下）。
这是整条链路上财务权重最高的解析器，也是唯一完全没有 fixture 的。

- 状态：**代码路径已确认**；「芝麻地现在会不会输出逗号」**需要一份真实 frame text 才能判定**——
  当前生产数字正常，说明目前不带逗号，所以这是潜伏风险而不是现存错误。
- 最小修复：解析层统一走乐檬那套 `parseAmount`（去逗号 + `Number.isFinite` 校验，非有限直接抛错）；
  `assertMoneyTotal` 开头加 `Number.isFinite` 检查；`calculateOperatingTotals` 里把 `|| 0` 换成显式校验。
- 回归测试：纯离线，给 `parseZhimadiText` 加三条 fixture——带逗号、合计行含空单元格、列数不足——都断言抛错。

### P1-3 发送成功之后的任何异常都会导致整轮重跑并重复推送

`scripts/daily-report.cjs:687-688`

```js
      await runGuardedAction(guardReportDate, "正式发送前", () => sendDingTalk(markdown));
    } finally {
      await context.close();
    }
```

`context.close()` 在 `sendDingTalk` **之后**执行，且它的异常会向上传播。
`main()` 只捕获芝麻地登录错误，其余直接抛出 → 退出码 1 →
`run-scheduled-report.cjs:171` 判定失败、写 `status: "failed"` → 15 分钟后 cron 重跑 → **钉钉收到第二份报表**。

同一类窗口还有：子进程被 watchdog 在发送后、退出前 SIGTERM/SIGKILL；父进程在写 `sent` 状态前被 cron 超时或重启打断。

审查包第 11 节把重复投递描述为「钉钉已接受、状态尚未落盘时进程崩溃」的极小窗口。
实际窗口比这个宽：**浏览器关闭失败是一个常规的、非崩溃的路径**（远端浏览器已死时 `close()` 抛错并不罕见）。

- 状态：**已在代码中确认**。发生概率取决于 `context.close()` 的实际失败率，**需要看生产日志才能量化**。
- 最小修复：发送成功后立刻在子进程内写一个按日期的 sentinel（例如 `output/sent-<date>.json`），
  父进程在判定失败前先查 sentinel，命中就记 `sent` 而不是 `failed`；
  同时把 `await context.close()` 包成 `.catch(() => {})`。
- 回归测试：纯离线，桩掉 `sendDingTalk` 成功 + `context.close()` 抛错，断言不产生第二次发送意图。

### P1-4 报表预检的恢复循环上界是事件截止时间（可达 3 小时），不是 cron 周期

`scripts/check-report-health.cjs:605`、`scripts/zhimadi-repair-coordinator.cjs:391`

芝麻地修复事件的 `deadlineAt = incidentStartedAt + 3 小时`（`silentWindowMs = 3 * 60 * minute`）。
这个截止时间会被 deferral 分支写进 `report-health-state.json` 的 `recoveryDeadlineAt`，
之后 `incidentFromState` 会原样继承它。

一旦某轮 `deferFailure` 不再返回 active（例如修复状态处于 `escalating` 但 `promptSentAt`/`escalationAttemptedAt`
都还没写，`zhimadiRepairDeferral` 此时返回 `null`），而故障 problemKey 仍是 `zhimadi-login`，
就会落到 `failure.retryable && failedAt < incident.deadline` 分支：
**每 60 秒重试一次，一直循环到 3 小时截止**，每轮都是一次完整的三源抓取，每轮都占用 `browser-profile` 锁。

后果：21:17 那次预检最坏可以一直跑到 00:17，横跨整个 22:05–23:50 的正式报表窗口，
和正式报表争抢 `browser-profile` 锁（正式报表等锁上限 10 分钟）。
`report-healthcheck` 锁的 `staleMs` 是 45 分钟，但对活着的进程无效，所以也不会自我解除。

- 状态：**代码路径已确认**；「`escalating` 且两个时间戳都未写」这个窗口有多宽**需要读
  `zhimadi-repair-coordinator.cjs` 的状态写入顺序才能确定**，我没有逐行核到那一层——标为待验证。
- 最小修复：给恢复循环加一个独立的墙钟上界（例如 `min(incident.deadline, 启动时间 + 30 分钟)`），
  并在 21:30 之后直接不进入循环、留给正式报表。
- 回归测试：纯离线，注入假 `now`/`sleep`，断言循环总时长有界。

---

## 3. P2

### P2-1 `assertDouyinMonthlyTotals` 对浏览器路径是恒真断言

`read-current-zhimadi.cjs:229-267` 校验「门店合计 === 商家应得」和「实际 + 预计 === 商家应得」。
但这两条恒等式都是上游**按构造造出来的**：
`douyin-store-reconciliation.cjs` 把残差作为「未归属门店」或「平台同步差额」行补进 `stores`，
`read-current-douyin-browser.cjs:92` 的 `actualReceivedCents = merchantDueCents - expectedReceivedCents`。

所以浏览器路径上这个断言**永远不可能失败**。它校验的是自己刚算出来的算术，不是源数据一致性。
审查包第 3 节把它列为「完整性与对账门槛」，实际保证弱于描述。
真正在挡事的是 `assertCompleteTablePage`（分页完整性）和 `reconcileDouyinStoreRows` 的 500 元 / 0.5% 上限——
这两个是实打实的。

建议：要么把断言下推到源数据（门店表原始合计 vs 页面显示总额，在补残差**之前**比），要么在注释里
明确它只是回归护栏，不要在文档里当作对账门槛。

### P2-2 降级渲染路径在生产中不可达，但有测试为它背书

`buildMarkdown` 里 `monthly.source_error` 和 `missing_dates` / `cached_day_count` 两套降级文案
（`read-current-zhimadi.cjs:328-333, 369-374`），并且
`tests/report-calculations.test.cjs:544`「keeps the monthly report usable when the Douyin summary page fails」
专门测了它。

但全仓库 `grep source_error` 只命中这两处渲染和测试——**没有任何生产代码产生 `source_error`**。
两个抖音读取器要么抛错，要么返回 `complete: true`（`read-current-douyin-browser.cjs:114`、
`read-current-douyin-aggregate-api.cjs:133`），`missing_dates` 恒为 `[]`。

所以真实行为是：抖音故障 → 抛错 → `retryStep` 三次 → 整份报表失败 → 当晚不发。
测试却在描述一个「抖音挂了也能发线下版」的行为，那个行为不存在。

这是**假保证**，不是 bug：失败关闭本身是对的。但要么接上，要么删掉降级分支和这条测试，
否则下一个人会以为有优雅降级。

### P2-3 `unmatchedPurchaseRows` 算了但从不渲染

`read-current-zhimadi.cjs:222-227` 计算了「有芝麻地进货、但乐檬没有对应门店」的行并 return 出来，
`buildMarkdown` 只用了 `unmatchedDouyinStores`，`unmatchedPurchaseRows` 全仓库无人消费（测试里也没有）。

后果：这类门店的进货额在「门店营业与毛利」分项里被静默略去。
总账不受影响（总毛利用的是 `report.totals.sales`），但**分项之和 ≠ 总额**，且报表上看不出差在哪。
建议渲染出来，或者加一行显式对账（分项合计 vs 总额）。

### P2-4 抖音日期状态只识别两种

`read-current-douyin-browser.cjs:81-83` 按 `status.includes("待结算")` / `includes("已结算")` 二分，
只保证「至少有一种可识别状态」。平台若新增第三种状态（冻结、结算中、异常），
这部分金额会被隐式并入「实际到账」。
影响面有限——总额取自 `merchantDue`，所以 `线上营业额` 和毛利不变，只有已到账/预计到账的**展示拆分**会错。
建议加一条「所有行的状态都必须落在已知集合内」的断言。

### P2-5 归档的防篡改只防意外损坏

`report-history.cjs` 的内容寻址 + manifest sha256 + 目录名后缀绑定 digest，
对**意外损坏**是有效的，路径越界和符号链接也都挡住了。
但同一用户可以重算 digest 并重命名目录，构造一份自洽的伪造归档。
在当前威胁模型（本机同用户运维）下这是可以接受的，只是别把它当作抗篡改证据。

---

## 4. 需要业务确认的两个问题（不是代码问题）

1. **抖音故障时，当晚应该完全不发，还是发一份标注清楚的线下版？**
   现在是完全不发（P2-2）。审查包第 3 节的表述倾向于「不发」，但代码里留着降级分支和测试，
   说明这个决策可能没有定死。这是业务口径问题，不该由代码默认值决定。
2. **门店分项毛利之和不等于总毛利（P2-3），是否需要在报表里显式说明？**
   老板看到分项加不起来的时候，需要一行解释，而不是自己算。

---

## 5. 最小且安全的后续验收方案

按「不登录、不抓取、不推送、不写生产」排序，前四条纯离线即可完成：

1. 给 `parseZhimadiText` 补 fixture 测试（带逗号 / 合计行空单元格 / 列数不足），断言全部抛错。→ 覆盖 P1-2
2. 给 `buildMarkdown` 补一条 NaN 断言测试：`totals.sales = NaN` 必须抛错，而不是渲染出 0.00。→ 覆盖 P1-2
3. 给正式入口补一条 env 守卫测试：`DOUYIN_ENABLED !== "true"` 时正式路径必须失败关闭。→ 覆盖 P1-1
4. 给发送后失败补一条测试：`sendDingTalk` 成功、`context.close()` 抛错，断言不产生第二次发送意图。→ 覆盖 P1-3
5. 恢复循环加墙钟上界后，用注入的假 `now`/`sleep` 断言总时长有界。→ 覆盖 P1-4
6. 只有在以上都通过之后，再考虑一次**经明确批准的**无推送三源验收，用来确认芝麻地当前的真实数字格式（P1-2 的前提）。

## 6. 对审查包本身的两处更正

- 第 3 节「完整性与对账门槛」列出的抖音「实际 + 预计 = 月商家应得」和「门店合计对齐」，
  在浏览器路径上是构造出来的恒等式，不构成对账门槛（P2-1）。真正的门槛是分页完整性证明和 500 元 / 0.5% 残差上限。
- 第 3 节「任一正式报告缺少抖音完整数据时，系统停止发送完整日报」——
  对读取失败成立，对 `DOUYIN_ENABLED` 未开启**不成立**（P1-1）。
