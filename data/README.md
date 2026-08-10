# 事件数据维护

每个 `events-YYYY.json` 只保存该年实际发布的事件。机构改期时修改 `date`，不要修改 `id`；稳定 ID 会让订阅客户端更新原事件，避免生成重复项。

年度文件使用 `coverageStatus` 标记覆盖范围：只录入了部分核心系列时为 `partial`，所有约定的核心系列都已有条目后改为 `complete`。单个日期是否已被一手来源逐项确认，另由事件的 `STATUS`、`X-SOURCE-STATUS` 和说明表示；`complete` 年份仍可包含明确标注的候选日期。下一年度检查不会把只含央行日程的文件误判成完整覆盖。

`revision` 是单调递增的事件版本号。同一天再次改期或修改说明时，也必须递增年度文件的 `revision`；修改公共模板时递增 `catalog.json` 的 `calendarRevision`。客户端据此更新原事件。

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
- 新指标先在 `catalog.json` 中登记中文说明、类别、颜色与官方链接。

提交前运行：

```bash
npm test
```

每年 9 月开始准备下一年度数据。每周覆盖检查会在距离新年 120 天以内且下一年度仍不完整时失败，以提醒维护者补齐官方日程。
