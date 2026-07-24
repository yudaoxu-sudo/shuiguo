# 水果店月度报表自动化

本项目先做本地验证，跑通后再部署到服务器。

## 当前口径

- 芝麻地：销售 > 销售报表 > 销售汇总表(按客户)
- 芝麻地日期：本月 1 日到当天
- 芝麻地进货额：销售金额
- 乐檬：报表 > 营业分析 > 营业收款报表 > 门店汇总
- 乐檬日期：本月
- 线下营业额：乐檬 `营业额(不含券)`
- 抖音本月到账：抖音来客 > 资金 > 账单统计 > 本月 `商家应得`
- 抖音实际到账：本月商家应得 - 按日期汇总中的待结算金额
- 抖音预计到账：按日期汇总中的待结算金额
- 抖音门店到账：账单统计 > 本月 > 按门店 `商家应得`
- 抖音实际到账和预计到账均已扣平台扣点，不再扣 2.5%
- 线上营业额：抖音实际到账 + 抖音预计到账
- 本月总营业额：线下营业额 + 线上营业额
- 线下手续费：线下营业额 × 0.3%
- 本月扣费后营业额：本月总营业额 - 线下手续费
- 本月毛利：本月扣费后营业额 - 芝麻地本月门店进货额
- 钉钉推送格式：手机窄版列表，避免 Markdown 表格横向滚动。
- 推送时间：每天 22:00 后
- 推送渠道：钉钉机器人

## 本地配置

```bash
cp .env.example .env
```

把账号密码、钉钉 Webhook、钉钉加签 secret 填进 `.env`。

## 本地运行

```bash
pnpm install
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
pnpm setup-login
pnpm report
pnpm listen
```

当前 Mac shell 没有系统 Node 时，可临时用 Codex 内置 Node：

```bash
NODE_PATH=/Users/xuyufan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules \
/Users/xuyufan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/daily-report.cjs
```

如果后台要求验证码，先运行 `setup-login`，在弹出的浏览器里手动完成芝麻地和乐檬登录。脚本会把登录态保存在 `output/browser-profile`，后续日报任务复用。

## 钉钉实时触发

启动监听：

```bash
pnpm listen
```

群里发送：

```text
@水果店月报 666
```

监听脚本收到后会运行月报脚本，并把结果推送到配置的钉钉群。

## 服务器定时

服务器跑通后，加 cron：

```cron
5,20,35,50 22 * * * ubuntu cd /opt/fruit-store-report-bot && /usr/bin/pnpm report:scheduled >> output/cron-report.log 2>&1
5,20,35 23 * * * ubuntu cd /opt/fruit-store-report-bot && /usr/bin/pnpm report:scheduled >> output/cron-report.log 2>&1
50 23 * * * ubuntu cd /opt/fruit-store-report-bot && SCHEDULED_REPORT_FINAL_ATTEMPT=1 /usr/bin/pnpm report:scheduled >> output/cron-report.log 2>&1
*/5 * * * * ubuntu cd /opt/fruit-store-report-bot && /usr/bin/pnpm healthcheck >> output/cron-healthcheck.log 2>&1
7 */2 * * * ubuntu cd /opt/fruit-store-report-bot && /usr/bin/pnpm login-healthcheck >> output/cron-login-healthcheck.log 2>&1
17 9-21/3 * * * ubuntu cd /opt/fruit-store-report-bot && /usr/bin/pnpm report-healthcheck >> output/cron-report-healthcheck.log 2>&1
```

监听常驻用 `systemd`，模板在 `deploy/fruit-store-listener.service`。健康检查会读取 `output/listener-heartbeat.json`；超过 3 分钟没有心跳会推送钉钉告警。

`report-healthcheck` 会用 `NO_DINGTALK=1` 做真实抓取预检，不推送正式报表；失败时走钉钉报警。日报、登录检查和手动芝麻地登录共用 `output/browser-profile.lock`，避免多个浏览器进程同时抢同一个登录态目录。

`report:scheduled` 从 22:05 到 23:50 每 15 分钟获得一次执行机会。当天推送成功后会写入 `output/scheduled-report-state.json`，后续任务直接跳过，避免重复推送；全部补跑失败时只在最后一轮发送一次告警。

芝麻地登录过期时，登录检查或月报请求会直接触发验证码图；回复 `验证码ABCD` 即可恢复服务器登录态。

可选装 ddddocr 后，监听脚本会先本地识别芝麻地的简单图形验证码；识别成功会自动提交，失败再发验证码图到钉钉让人回复。

## 抖音来客月度汇总

正式日报默认使用服务器浏览器读取抖音来客后台已经计算好的本月总额和门店汇总。钉钉手动 `@水果店月报 666` 和晚间定时任务共用同一份月报代码。

项目另有月度聚合接口读取器。它复用同一份抖音来客浏览器登录态，请求账单页自身使用的本月到账汇总和门店汇总接口，各一次，不读取逐笔订单或账单明细，也不消耗开放平台逐笔账单接口额度：

```bash
pnpm douyin:aggregate-api
```

需要在某一天核对两条来源时，在服务器 `.env` 设置：

```bash
DUAL_DOUYIN_REPORT_DATE=2026-07-25
```

当天晚间定时任务会发送两份完整报告：`聚合接口版` 和 `网页版`。两份共用同一份芝麻地、乐檬快照，只更换抖音来源。两份都成功后才记录当天任务完成；单份推送成功后会写状态，补跑时不会重复发送该份。

服务器首次配置：

```bash
pnpm douyin:login
```

配置抖音来客手机号和密码后运行。没有配置密码时，脚本会提示输入短信验证码。登录态保存在 `output/browser-profile`，后续日报直接复用。

在服务器 `.env` 中配置：

```bash
DOUYIN_ENABLED=true
DOUYIN_FINANCE_URL=https://life.douyin.com/p/finance/v2/home
DOUYIN_PHONE=
DOUYIN_PASSWORD=
```

独立测试本月汇总：

```bash
pnpm douyin:monthly
```

页面读取会校验三组关系：

- `实际到账 + 预计到账 = 本月商家应得`
- `所有门店商家应得 + 未归属金额 = 本月商家应得`
- 抖音金额均使用页面的扣点后金额，不再重复扣 2.5%

抖音登录失效或页面临时异常时，正式月报会停止并发送失败提醒，避免推送缺少线上营业额和毛利的残缺报表。两条抖音来源都复用 `output/browser-profile` 登录态，均不会主动退出或重新登录。日报只读取财务页面的本月聚合数据，不请求逐笔订单或账单明细。
