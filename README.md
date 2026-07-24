# 水果店月度报表自动化

本项目先做本地验证，跑通后再部署到服务器。

## 当前口径

- 芝麻地：销售 > 销售报表 > 销售汇总表(按客户)
- 芝麻地日期：本月 1 日到当天
- 芝麻地进货额：销售金额
- 乐檬：报表 > 营业分析 > 营业收款报表 > 门店汇总
- 乐檬日期：本月
- 线下营业额：乐檬 `营业额(不含券)`
- 抖音本月到账：综合账单正向金额减退款金额，按门店汇总
- 抖音实际到账：账单营业日加 5 个自然日后已结算的金额
- 抖音预计到账：尚未到结算日的金额
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

## 抖音来客官方 API

抖音模块只调用开放平台官方接口，读取北京时间本月 1 日到当天的综合账单。钉钉手动 `@水果店月报 666` 和晚间定时任务共用同一份月报代码。

### 权限开通

开放平台路径：

```text
控制台 > 生活服务商家应用 > 马哥的数据 > 解决方案
> 到综团购解决方案 > 按能力开通
```

月报使用 `团购核销对账`、`账单明细` 和 `门店管理` 权限。门店管理用于把账单 `poi_id` 映射到乐檬门店。

来客商家绑定路径：

```text
抖音来客 > 合作与授权 > 自研 SaaS 绑定
```

服务器 IP 在应用详情的 `开发配置 > IP 白名单` 中添加。生产服务器当前只需配置其公网 IPv4。

### 日报使用的接口

1. 获取调用凭证
   - `POST https://open.douyin.com/oauth/client_token/`
   - 必传：`client_key`、`client_secret`、`grant_type=client_credential`
   - 使用：`data.access_token`、`data.expires_in`
2. 综合账单查询
   - `GET https://open.douyin.com/goodlife/v1/settle/bill/composite_query/`
   - 权限：`life.capacity.billing.detail`
   - 必传：`account_id`、`root_account_id`、`bill_date`、`cursor`、`size`、`biz_type=1`
   - 使用：`ledger_records[].fund_amount`、`fund_amount_type`、`poi_id`、`ledger_id`
3. 门店信息查询
   - `GET https://open.douyin.com/goodlife/v1/shop/poi/query/`
   - 权限：`life.capacity.shop`
   - 必传：`account_id`、`page`、`size`
   - 使用：`pois[].poi.poi_id`、`pois[].poi.poi_name`

### 数据口径

- `fund_amount_type=0` 计正向收入，`fund_amount_type=1` 计退款负数。
- 每条账单按 `ledger_id` 去重，金额单位由分转换为元。
- `实际到账 + 商家预计到账` 等于抖音本月到账合计。
- 两项抖音金额均直接使用平台扣点后的金额，不再计算 2.5% 手续费。
- 账单 `poi_id` 关联门店信息，再用门店别名匹配乐檬和芝麻地。
- 每日综合账单缓存到 `output/douyin-settlement-daily`。当天缓存 10 分钟，昨天在次日刷新，更早日期复用稳定缓存。
- 月度日期缺失时标记数据不完整，不使用部分金额计算综合营业额和毛利。

### 配置与运行

在服务器 `.env` 中填写：

```bash
DOUYIN_ENABLED=true
DOUYIN_CLIENT_KEY=
DOUYIN_CLIENT_SECRET=
DOUYIN_ACCOUNT_ID=
```

独立测试本月数据：

```bash
.venv/bin/python scripts/douyin_client.py --pretty
```

模块会缓存两小时有效的 `access_token`，提前五分钟刷新；网络错误、平台繁忙、限流和 token 失效会自动重试。综合账单按日期串行分页并持续缓存，减少重复调用和限流风险。
