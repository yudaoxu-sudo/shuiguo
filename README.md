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
- 抖音本月到店核销券额：本月核销账单 `coupon_pay` 按券去重汇总
- 到店销售（不含抖音券）：乐檬含券销售额 - 抖音本月到店核销券额
- 抖音券手续费：抖音本月到店核销券额 × 2.5%
- 到店销售手续费：到店销售（不含抖音券）× 0.3%
- 扣手续费后销售额：乐檬含券销售额 - 抖音券手续费 - 到店销售手续费
- 手续费后毛利：扣手续费后销售额 - 芝麻地本月门店进货额
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

抖音模块只调用开放平台官方接口，默认读取北京时间昨天的数据。原有芝麻地、乐檬、钉钉和定时任务保持不变。

### 权限开通

开放平台路径：

```text
控制台 > 生活服务商家应用 > 马哥的数据 > 解决方案
> 到综团购解决方案 > 按能力开通
```

当前应用已开通：

- `订单查询`：读取昨日下单和成交数据。
- `团购核销`：应用具备团购券核销能力。
- `团购核销对账`：读取核销历史和预计分账账单。
- `团购退款`：为订单退款状态补充能力，本日报暂不主动退款。
- `门店管理`：读取抖音 POI ID 和门店名称，用于逐店匹配乐檬销售。

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
2. 订单查询
   - `GET https://open.douyin.com/goodlife/v1/trade/order/query/`
   - 权限：`life.capacity.order.query`
   - 必传：`account_id`、`page_num`、`page_size`
   - 日报另传：`cursor`、`create_order_start_time`、`create_order_end_time`
   - 使用：`orders[].order_status`、`count`、`pay_amount`、`order_sale_info.sale_channel`
3. 验券历史
   - `GET https://open.douyin.com/goodlife/v1/fulfilment/certificate/verify_record/query/`
   - 权限：`life.capacity.billing`
   - 必传：`account_id`、`cursor`、`size`
   - 日报另传：`start_time`、`end_time`
   - 使用：`records_v2[].status`、`verify_time`、`amount.coupon_pay_amount`
4. 账单查询
   - `GET https://open.douyin.com/goodlife/v1/settle/ledger/query/`
   - 权限：`life.capacity.billing`
   - 必传：`account_id`、`bill_date`、`cursor`、`size`
   - 使用：`ledger_records[].amount.goods`、`amount.coupon_pay`、`order_attrribute.source`
5. 门店信息查询
   - `GET https://open.douyin.com/goodlife/v1/shop/poi/query/`
   - 权限：`life.capacity.shop`
   - 必传：`account_id`、`page`、`size`
   - 使用：`pois[].poi.poi_id`、`pois[].poi.poi_name`

### 数据口径

- 下单量：昨日创建的全部订单，包含取消订单。
- 成交订单/成交券：订单状态为已支付、待使用、已完成或部分支付。
- 销售额：成交订单的 `pay_amount`，单位由分转换为元。
- 核销量：昨日有效核销记录，撤销核销记录不计。
- 核销金额：有效核销记录的 `coupon_pay_amount`。
- 核销率：昨日核销券数 / 昨日成交券数。两者不是同一批券，结果可能超过 100%。
- 预计分账收入：账单 `amount.goods` 汇总。官方说明分账单约在核销一小时后生成，这个金额不代表已经提现到账。
- 直播来源：订单 `sale_channel=直播`，账单 `source=livebroadcasting`。
- 门店拆分：账单 `poi_id` 与门店信息接口返回的 `poi_id` 关联，再按门店别名匹配乐檬门店名称。
- 本月核销账单按天缓存到 `output/douyin-ledger-daily`。今天的数据缓存 10 分钟，昨天会在次日重新拉取一次以补齐延迟账单，更早日期直接使用缓存。

当前生活服务商家应用可读取直播来源成交和核销数据。直播观看人数、峰值在线、观看时长属于抖音小程序数据分析能力，当前应用类型没有对应的官方接口，因此日报不填造这些指标。

### 配置与运行

在服务器 `.env` 中填写：

```bash
DOUYIN_ENABLED=true
DOUYIN_CLIENT_KEY=
DOUYIN_CLIENT_SECRET=
DOUYIN_ACCOUNT_ID=
```

独立测试：

```bash
.venv/bin/python scripts/douyin_client.py --pretty
```

模块会缓存两小时有效的 `access_token`，提前五分钟刷新；网络错误、平台繁忙、限流和 token 失效会自动重试。订单接口单应用默认最大 20 QPS，代码使用串行分页，不会主动压满限流。建议在次日读取完整昨日数据，账单至少给核销后留出一小时生成时间。
