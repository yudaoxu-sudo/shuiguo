# 水果店月度报表自动化

本项目先做本地验证，跑通后再部署到服务器。

## 当前口径

- 芝麻地：销售 > 销售报表 > 销售汇总表(按客户)
- 芝麻地日期：本月 1 日到当天
- 芝麻地进货额：销售金额
- 芝麻地仓库成本：销售成本
- 乐檬：报表 > 数据指标
- 乐檬月销售累计：本月累计销售里的营业额(券售价)
- 乐檬月销售排名：月销售额排名里的门店Top
- 本月总毛利：乐檬月销售累计 - 芝麻地本月门店进货额
- 本月总毛利率：本月总毛利 / 乐檬月销售累计
- 销售/进货比：乐檬月销售累计 / 芝麻地本月门店进货额
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
5 22 * * * cd /opt/fruit-store-report-bot && /usr/bin/pnpm report >> output/cron-report.log 2>&1
*/5 * * * * cd /opt/fruit-store-report-bot && /usr/bin/pnpm healthcheck >> output/cron-healthcheck.log 2>&1
7 */2 * * * cd /opt/fruit-store-report-bot && /usr/bin/pnpm login-healthcheck >> output/cron-login-healthcheck.log 2>&1
17 9-21/3 * * * cd /opt/fruit-store-report-bot && /usr/bin/pnpm report-healthcheck >> output/cron-report-healthcheck.log 2>&1
```

监听常驻用 `systemd`，模板在 `deploy/fruit-store-listener.service`。健康检查会读取 `output/listener-heartbeat.json`；超过 3 分钟没有心跳会推送钉钉告警。

`report-healthcheck` 会用 `NO_DINGTALK=1` 做真实抓取预检，不推送正式报表；失败时走钉钉报警。日报、登录检查和手动芝麻地登录共用 `output/browser-profile.lock`，避免多个浏览器进程同时抢同一个登录态目录。

芝麻地登录过期时，登录检查或月报请求会直接触发验证码图；回复 `验证码ABCD` 即可恢复服务器登录态。
