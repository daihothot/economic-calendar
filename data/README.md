# 事件数据维护

每个 `events-YYYY.json` 只保存该年实际发布的事件。机构改期时修改 `date`，不要修改 `id`；稳定 ID 会让订阅客户端更新原事件，避免生成重复项。

年度文件使用 `coverageStatus` 标记覆盖范围：只录入了部分核心系列时为 `partial`，所有约定的核心系列都已有条目后改为 `complete`。单个日期是否已被一手来源逐项确认，另由事件的 `STATUS`、`X-SOURCE-STATUS` 和说明表示；`complete` 年份仍可包含明确标注的候选日期。下一年度检查不会把只含央行日程的文件误判成完整覆盖。

`revision` 是单调递增的事件版本号。同一天再次改期或修改说明时，也必须递增年度文件的 `revision`；修改公共模板时递增 `catalog.json` 的 `calendarRevision`。自动数值文件中的每个事件另有独立的 `revision`，合并时只叠加到对应事件的基础修订号，使真实数值变化只提高该事件的 iCalendar `SEQUENCE`，客户端据此更新原事件。

事件按系列维护：

```json
{
  "type": "us-cpi",
  "time": "08:30",
  "timezone": "America/New_York",
  "scheduleStatus": "官方日程，核对日期为 YYYY-MM-DD。",
  "entries": [
    {
      "id": "us-cpi-2026-12",
      "date": "2027-01-13",
      "period": "2026年12月"
    }
  ]
}
```

规则：

- `id` 表示指标与统计期，不要包含可能变化的发布日期。
- `date` 与 `time` 必须是发布机构当地时间。
- `timezone` 使用 IANA 名称；当前支持 `America/New_York`、`Europe/Brussels`、`Asia/Tokyo`、`Asia/Shanghai`。
- 没有固定发布时间且只确认日期的事件使用 `"allDay": true`；这类事件只提供提前 1 天提醒。已知通常时点但尚待当日确认时，使用 `"timePrecision": "approximate"`。
- 机构临时改期时，在条目中增加 `note`，并更新年度文件的 `verifiedAt`。
- 新指标先在 `catalog.json` 中登记中文说明、类别、颜色、官方链接与 `valueMode`。有实际值、预测值、前值等可量化数据时使用 `"quantitative"`；新闻发布会、会议纪要等不以单一数值衡量的事件使用 `"narrative"`。

## 数值对象

事件可选填 `actual`、`forecast` 和 `previous`。三个字段使用相同结构：

```json
{
  "status": "available",
  "lines": [
    "总体 CPI：同比 +2.4%",
    "核心 CPI：同比 +2.6%"
  ],
  "asOf": "2026-07-01",
  "sourceName": "美国劳工统计局（BLS）",
  "sourceUrl": "https://www.bls.gov/cpi/"
}
```

规则：

- `status` 只能是 `available`、`unavailable`、`pending` 或 `not-applicable`。
- `lines` 必须是非空字符串数组，可容纳一个报告中的多个官方指标。
- `asOf` 可选，使用 `YYYY-MM-DD` 或 UTC ISO 时间戳；日历中以“数据期”展示，不把统计期误写为抓取时间。
- `sourceName` 与 `sourceUrl` 可选；如填写，必须成对出现，且链接使用 HTTPS。
- 叙事型事件默认显示“不适用”；量化事件未填值时，预测值显示“官方来源不提供市场一致预期”，前值显示“等待官方数据更新”。
- 只有状态为 `available` 的 `actual` 才会出现在日历说明中。

需要手工纠正某个事件时，可直接把数值对象写在系列默认值或具体条目中。具体条目的对象优先于系列默认值，也优先于自动数值文件中的同名对象。

## 自动数值文件

`values.json` 由免费官方数据更新程序维护，顶层格式如下：

```json
{
  "schemaVersion": 1,
  "revision": 2026081101,
  "updatedAt": "2026-08-11T12:00:00Z",
  "events": {
    "us-cpi-2026-07": {
      "revision": 2,
      "updatedAt": "2026-08-11T12:00:00Z",
      "actual": {
        "status": "available",
        "lines": ["总体 CPI：同比 +2.4%"],
        "asOf": "2026-07-01",
        "sourceName": "美国劳工统计局（BLS）",
        "sourceUrl": "https://www.bls.gov/cpi/"
      }
    }
  }
}
```

`events` 必须以现有稳定事件 ID 为键。每个事件必须包含正整数 `revision`、UTC ISO 格式的 `updatedAt`，以及至少一个 `actual`、`forecast` 或 `previous`。程序仅在该事件的数值内容真正变化时递增它自己的 `revision`；事件级 `updatedAt` 直接用于该事件的 `LAST-MODIFIED`。顶层 `revision` 和 `updatedAt` 仍用于记录、校验整个文件的版本与更新时间，但不会叠加到所有事件。手工写在年度事件文件中的同名对象始终优先，可用于有审计记录的纠正。

更新程序可通过 `loadProject({ includeValues: false })` 只加载目录和年度事件；此模式不会读取、校验或合并 `values.json`，因此可以先清理已经不在日历中的旧数值记录。

提交前运行：

```bash
npm test
```

每年 9 月开始准备下一年度数据。每周覆盖检查会在距离新年 120 天以内且下一年度仍不完整时失败，以提醒维护者补齐官方日程。
