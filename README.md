# 中文财经日历 Pro

面向 iPhone、Mac、Google Calendar 和 Outlook 的长期订阅型中文财经日历，覆盖美国、欧元区、日本和中国的高影响宏观事件。

## 稳定订阅地址

全球主日历：

```text
https://daihothot.github.io/economic-calendar/dist/economic-calendar-pro.ics
```

在 iPhone 中进入“设置 → Apps → 日历 → 日历账户 → 添加账户 → 其他 → 添加已订阅的日历”，粘贴上面的地址即可。不要下载后一次性导入主文件；使用订阅 URL 才能接收后续改期和新增年份。

添加订阅时如果出现“移除提醒”选项，请保持关闭；开启后 iOS 会忽略文件内的提醒。

## 内容与提醒

- 中文标题与中文专业说明
- 按“资产类别｜标的　↗｜↘”整理市场关注清单，以克制的双向箭头提示波动关注
- 免费官方数据源自动补充已公布的实际值与可核实的前值
- 官方机构不提供市场一致预期时，预测值会如实标注，不抓取来源不明的第三方数字
- 新闻发布会、会议纪要等叙事型事件将数值字段标为“不适用”
- 官方来源和官方日程链接
- 所有事件提前 1 天提醒
- 有官方时点的事件额外提前 1 小时提醒
- 机构当地时区，设备自动换算本地时间
- 稳定事件 ID，官方改期不会产生重复事件

首批数据包含 2026 年全球核心日程，以及已由美联储、欧洲央行和日本银行公布的 2027 央行日程。2027 文件暂标为 `partial`；BLS、BEA、Eurostat、国家统计局等机构发布年度表后再补齐，不提前猜日期。年度数据保存在 `data/events-YYYY.json`，新增年份后主订阅地址保持不变。

日本央行政策决定没有官方固定时刻，因此按全天事件保存，只提供提前 1 天提醒；其记者会按“通常 15:30”标为待确认。日历不会用虚构时刻制造一个不真实的“一小时前”提醒。

## 免费官方数据更新

项目使用无需 API 密钥的官方公开数据源。自动程序每 6 小时检查一次已配置指标，并在数据得到官方确认后更新 `data/values.json`：

- `✅ 实际值`：发布后取得的官方数据；仅在已获得可靠数值时显示
- `🔮 预测值`：官方数据源通常不发布市场一致预期，因此显示“官方来源不提供市场一致预期”
- `📌 前值`：从官方历史序列取得；尚未取得时显示“等待官方数据更新”

这套免费方案不会把估算值、新闻网站数字或模型推测伪装成官方数据。数值旁会保留数据期与具体来源链接，便于复核。自动更新可在 GitHub Actions 中手动触发，也可在本地运行：

```bash
node scripts/update-values.mjs
```

离线夹具测试使用 `node scripts/test-update-values.mjs`，无需访问网络。

GitHub Pages 发布源应选择 **GitHub Actions**。更新流程会保留现有 `/dist/` 路径并直接发布，因此 iPhone 上已经订阅的地址无需更换。

## 颜色分类

主日历写入标准 `CATEGORIES`、`COLOR` 和兼容扩展。Apple 日历通常对一个订阅源只显示一种颜色；需要真正的分类颜色时，可分别订阅：

- 央行政策：`https://daihothot.github.io/economic-calendar/dist/feeds/central-bank.ics`
- 通胀：`https://daihothot.github.io/economic-calendar/dist/feeds/inflation.ics`
- 经济增长：`https://daihothot.github.io/economic-calendar/dist/feeds/growth.ics`
- 就业：`https://daihothot.github.io/economic-calendar/dist/feeds/employment.ics`
- PMI 与景气调查：`https://daihothot.github.io/economic-calendar/dist/feeds/pmi.ics`

也可按地区订阅 `dist/feeds/us.ics`、`dist/feeds/eurozone.ics`、`dist/feeds/japan.ics` 和 `dist/feeds/china.ics`。

主日历、地区日历、类别日历和年度归档包含重叠事件。请选择一种订阅方式，不要同时订阅主日历及其子集，否则同一事件可能重复显示和提醒。

## 长期维护方式

1. 从发布机构的官方日程核对下一年度日期。
2. 新增或修订 `data/events-YYYY.json`，保留稳定 `id`。
3. 运行 `npm test`；校验会检查 CRLF、75 字节折行、时区、重复 ID、官方链接、数值状态与提醒规则。
4. 提交生成后的 `dist/` 并推送到 `master`；GitHub Actions 校验后自动发布所有订阅源。

仓库每周检查下一年度覆盖范围。发布日程可能被机构临时调整，因此事件说明始终保留核对日期和“以官方最新公告为准”。

## GitHub Pages

当前仓库使用 GitHub Actions 作为 GitHub Pages 来源。发布包会保留 `dist/` 目录层级；之后每次推送及定时数值更新都会自动发布到上述稳定 URL。
