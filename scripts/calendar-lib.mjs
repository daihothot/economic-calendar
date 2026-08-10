import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const dataDir = path.join(repoRoot, "data");
export const distDir = path.join(repoRoot, "dist");

const REQUIRED_EVENT_FIELDS = ["id", "type", "date", "time", "timezone", "period"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^\d{2}:\d{2}$/;
const OBSOLETE_PLACEHOLDER = "\uFF08\u9884\u7559\uFF09";
const VALUE_FIELDS = ["actual", "forecast", "previous"];
const VALUE_STATUSES = new Set(["available", "unavailable", "pending", "not-applicable"]);
const VALUE_MODES = new Set(["quantitative", "narrative"]);
const VALUE_OBJECT_FIELDS = new Set(["status", "lines", "asOf", "sourceName", "sourceUrl"]);
const ALLOWED_EVENT_FIELDS = new Set([
  "id", "type", "date", "time", "timezone", "period", "durationMinutes", "scheduleStatus",
  "note", "title", "verifiedAt", "timePrecision", "status", "sourceStatus", "scheduleUrl",
  "allDay", "revision", ...VALUE_FIELDS
]);

const TIMEZONE_COMPONENTS = {
  "America/New_York": [
    "BEGIN:VTIMEZONE",
    "TZID:America/New_York",
    "X-LIC-LOCATION:America/New_York",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:-0500",
    "TZOFFSETTO:-0400",
    "TZNAME:EDT",
    "DTSTART:20070311T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:-0400",
    "TZOFFSETTO:-0500",
    "TZNAME:EST",
    "DTSTART:20071104T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
    "END:STANDARD",
    "END:VTIMEZONE"
  ],
  "Europe/Brussels": [
    "BEGIN:VTIMEZONE",
    "TZID:Europe/Brussels",
    "X-LIC-LOCATION:Europe/Brussels",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0200",
    "TZNAME:CEST",
    "DTSTART:19810329T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0200",
    "TZOFFSETTO:+0100",
    "TZNAME:CET",
    "DTSTART:19961027T030000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "END:STANDARD",
    "END:VTIMEZONE"
  ],
  "Asia/Tokyo": [
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Tokyo",
    "X-LIC-LOCATION:Asia/Tokyo",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0900",
    "TZOFFSETTO:+0900",
    "TZNAME:JST",
    "DTSTART:19700101T000000",
    "END:STANDARD",
    "END:VTIMEZONE"
  ],
  "Asia/Shanghai": [
    "BEGIN:VTIMEZONE",
    "TZID:Asia/Shanghai",
    "X-LIC-LOCATION:Asia/Shanghai",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0800",
    "TZOFFSETTO:+0800",
    "TZNAME:CST",
    "DTSTART:19910915T020000",
    "END:STANDARD",
    "END:VTIMEZONE"
  ]
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isRealIsoDate(value) {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isRealLocalTime(value) {
  if (!LOCAL_TIME.test(value)) return false;
  const [hour, minute] = value.split(":").map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readOptionalJson(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

function isHttpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function isAsOf(value) {
  return isRealIsoDate(value) || isIsoInstant(value);
}

function validateValueObject(value, context) {
  assert(isPlainObject(value), `${context} must be an object`);
  for (const field of Object.keys(value)) {
    assert(VALUE_OBJECT_FIELDS.has(field), `${context} has unknown field ${field}`);
  }
  assert(VALUE_STATUSES.has(value.status), `${context}.status must be available, unavailable, pending, or not-applicable`);
  assert(Array.isArray(value.lines) && value.lines.length > 0, `${context}.lines must be a non-empty array`);
  for (const [index, line] of value.lines.entries()) {
    assert(typeof line === "string" && line.trim().length > 0, `${context}.lines[${index}] must be a non-empty string`);
    assert(!line.includes(OBSOLETE_PLACEHOLDER), `${context}.lines[${index}] cannot contain a placeholder`);
  }
  assert(value.asOf === undefined || isAsOf(value.asOf), `${context}.asOf must be a real YYYY-MM-DD date or UTC ISO timestamp`);
  assert(value.sourceName === undefined || (typeof value.sourceName === "string" && value.sourceName.trim().length > 0), `${context}.sourceName must be a non-empty string`);
  assert(value.sourceUrl === undefined || isHttpsUrl(value.sourceUrl), `${context}.sourceUrl must be a valid https URL`);
  assert((value.sourceName === undefined) === (value.sourceUrl === undefined), `${context}.sourceName and sourceUrl must be provided together`);
}

function validateCatalog(catalog) {
  assert(isPlainObject(catalog.regions) && Object.keys(catalog.regions).length > 0, "catalog.json regions must be a non-empty object");
  assert(isPlainObject(catalog.categories) && Object.keys(catalog.categories).length > 0, "catalog.json categories must be a non-empty object");
  assert(isPlainObject(catalog.types) && Object.keys(catalog.types).length > 0, "catalog.json types must be a non-empty object");

  const expectedMarketFocus = {
    us: [
      "💱 外汇｜美元与主要货币对　↗｜↘",
      "🏛️ 债券｜美国国债收益率　↗｜↘",
      "🥇 贵金属｜黄金　↗｜↘",
      "📊 股票｜美股　↗｜↘",
      "₿ 加密资产｜Bitcoin　↗｜↘"
    ],
    eurozone: [
      "💱 外汇｜欧元与主要货币对　↗｜↘",
      "🏛️ 债券｜德国国债与欧元区收益率　↗｜↘",
      "🥇 贵金属｜黄金　↗｜↘",
      "📊 股票｜欧洲股市　↗｜↘",
      "₿ 加密资产｜Bitcoin　↗｜↘"
    ],
    japan: [
      "💱 外汇｜日元与主要货币对　↗｜↘",
      "🏛️ 债券｜日本国债收益率　↗｜↘",
      "🥇 贵金属｜黄金　↗｜↘",
      "📊 股票｜日经指数　↗｜↘",
      "₿ 加密资产｜Bitcoin　↗｜↘"
    ],
    china: [
      "💱 外汇｜人民币与离岸人民币　↗｜↘",
      "🏛️ 债券｜中国国债收益率　↗｜↘",
      "🥇 贵金属｜黄金　↗｜↘",
      "📊 股票｜A 股与港股　↗｜↘",
      "₿ 加密资产｜Bitcoin　↗｜↘"
    ]
  };

  for (const [typeId, type] of Object.entries(catalog.types)) {
    assert(isPlainObject(type), `catalog.json type ${typeId} must be an object`);
    assert(catalog.regions[type.region], `catalog.json type ${typeId} has unknown region ${type.region}`);
    assert(catalog.categories[type.category], `catalog.json type ${typeId} has unknown category ${type.category}`);
    assert(VALUE_MODES.has(type.valueMode), `catalog.json type ${typeId} valueMode must be quantitative or narrative`);
    for (const field of ["title", "description", "sourceName", "location"]) {
      assert(typeof type[field] === "string" && type[field].trim().length > 0, `catalog.json type ${typeId} ${field} must be a non-empty string`);
    }
    assert(Array.isArray(type.marketFocus) && type.marketFocus.length > 0, `catalog.json type ${typeId} marketFocus must be a non-empty array`);
    for (const [index, line] of type.marketFocus.entries()) {
      assert(typeof line === "string" && line.trim().length > 0, `catalog.json type ${typeId} marketFocus[${index}] must be a non-empty string`);
    }
    assert(isHttpsUrl(type.sourceUrl), `catalog.json type ${typeId} sourceUrl must be a valid https URL`);
    assert(isHttpsUrl(type.scheduleUrl), `catalog.json type ${typeId} scheduleUrl must be a valid https URL`);
    assert(
      JSON.stringify(type.marketFocus) === JSON.stringify(expectedMarketFocus[type.region]),
      `catalog.json type ${typeId} must use the standard ${type.region} marketFocus list`
    );
  }
}

export async function loadProject(options = {}) {
  const { includeValues = true } = options;
  const catalog = await readJson(path.join(dataDir, "catalog.json"));
  const values = includeValues ? await readOptionalJson(path.join(dataDir, "values.json")) : null;
  const names = (await readdir(dataDir))
    .filter((name) => /^events-\d{4}\.json$/.test(name))
    .sort();

  assert(catalog.schemaVersion === 1, "catalog.json schemaVersion must be 1");
  assert(Number.isInteger(catalog.calendarRevision) && catalog.calendarRevision > 0 && catalog.calendarRevision <= 2_147_483_647, "catalog.json calendarRevision must be a positive 32-bit integer");
  validateCatalog(catalog);
  assert(names.length > 0, "At least one data/events-YYYY.json file is required");

  if (values) {
    assert(isPlainObject(values), "values.json must contain an object");
    const allowedFields = new Set(["schemaVersion", "revision", "updatedAt", "events"]);
    for (const field of Object.keys(values)) assert(allowedFields.has(field), `values.json has unknown field ${field}`);
    assert(values.schemaVersion === 1, "values.json schemaVersion must be 1");
    assert(Number.isInteger(values.revision) && values.revision > 0 && values.revision <= 2_147_483_647, "values.json revision must be a positive 32-bit integer");
    assert(isIsoInstant(values.updatedAt), "values.json updatedAt must be a UTC ISO timestamp");
    assert(isPlainObject(values.events), "values.json events must be an object keyed by event id");
  }

  const datasets = [];
  const events = [];
  const ids = new Set();

  for (const name of names) {
    const dataset = await readJson(path.join(dataDir, name));
    assert(dataset.schemaVersion === 1, `${name}: schemaVersion must be 1`);
    assert(Number.isInteger(dataset.year), `${name}: year must be an integer`);
    assert(name === `events-${dataset.year}.json`, `${name}: file name and year do not match`);
    assert(isRealIsoDate(dataset.verifiedAt), `${name}: verifiedAt must be a real YYYY-MM-DD date`);
    assert(Number.isInteger(dataset.revision) && dataset.revision > 0 && dataset.revision <= 2_147_483_647, `${name}: revision must be a positive 32-bit integer`);
    assert(["partial", "complete"].includes(dataset.coverageStatus), `${name}: coverageStatus must be partial or complete`);
    assert(Array.isArray(dataset.events) || Array.isArray(dataset.series), `${name}: events or series must be an array`);

    const expandedSeries = (dataset.series ?? []).flatMap((series, seriesIndex) => {
      assert(series.type, `${name}: series ${seriesIndex + 1} is missing type`);
      assert(series.time, `${name}: series ${seriesIndex + 1} is missing time`);
      assert(series.timezone, `${name}: series ${seriesIndex + 1} is missing timezone`);
      assert(Array.isArray(series.entries), `${name}: series ${seriesIndex + 1} entries must be an array`);
      const { entries, ...defaults } = series;
      return entries.map((entry) => ({ ...defaults, ...entry }));
    });
    const rawEvents = [...(dataset.events ?? []), ...expandedSeries];

    for (const event of rawEvents) {
      for (const field of Object.keys(event)) assert(ALLOWED_EVENT_FIELDS.has(field), `${name}: ${event.id ?? "event"} has unknown field ${field}`);
      for (const field of REQUIRED_EVENT_FIELDS) {
        assert(event[field], `${name}: event is missing ${field}`);
      }
      assert(/^[a-z0-9][a-z0-9-]*$/.test(event.id), `${event.id}: invalid stable id`);
      assert(!ids.has(event.id), `${event.id}: duplicate stable id`);
      ids.add(event.id);
      assert(catalog.types[event.type], `${event.id}: unknown type ${event.type}`);
      assert(isRealIsoDate(event.date), `${event.id}: invalid date`);
      assert(Number(event.date.slice(0, 4)) === dataset.year, `${event.id}: release year does not match dataset year`);
      assert(isRealLocalTime(event.time), `${event.id}: invalid local time`);
      assert(TIMEZONE_COMPONENTS[event.timezone], `${event.id}: unsupported timezone ${event.timezone}`);
      assert(Number.isInteger(event.durationMinutes ?? 30) && (event.durationMinutes ?? 30) > 0, `${event.id}: durationMinutes must be a positive integer`);
      assert(!event.status || ["CONFIRMED", "TENTATIVE", "CANCELLED"].includes(event.status), `${event.id}: invalid status`);
      assert(!event.sourceStatus || ["OFFICIAL", "ESTIMATED"].includes(event.sourceStatus), `${event.id}: invalid sourceStatus`);
      assert(!event.timePrecision || event.timePrecision === "approximate", `${event.id}: invalid timePrecision`);
      assert(event.allDay === undefined || typeof event.allDay === "boolean", `${event.id}: allDay must be boolean`);
      assert(!event.verifiedAt || isRealIsoDate(event.verifiedAt), `${event.id}: verifiedAt must be a real date`);
      assert(!event.revision || (Number.isInteger(event.revision) && event.revision > 0 && event.revision <= 2_147_483_647), `${event.id}: revision must be a positive 32-bit integer`);
      for (const valueField of VALUE_FIELDS) {
        if (event[valueField] !== undefined) validateValueObject(event[valueField], `${event.id}.${valueField}`);
      }

      const type = catalog.types[event.type];
      assert(catalog.regions[type.region], `${event.id}: unknown region ${type.region}`);
      assert(catalog.categories[type.category], `${event.id}: unknown category ${type.category}`);
      assert(isHttpsUrl(type.sourceUrl), `${event.id}: sourceUrl must be a valid https URL`);
      assert(isHttpsUrl(event.scheduleUrl ?? type.scheduleUrl), `${event.id}: scheduleUrl must be a valid https URL`);

      events.push({
        ...event,
        releaseYear: dataset.year,
        verifiedAt: event.verifiedAt ?? dataset.verifiedAt,
        revision: Math.max(event.revision ?? 0, dataset.revision, catalog.calendarRevision)
      });
    }

    datasets.push({ ...dataset, fileName: name });
  }

  if (values) {
    const eventsById = new Map(events.map((event) => [event.id, event]));
    for (const [eventId, externalValues] of Object.entries(values.events)) {
      assert(eventsById.has(eventId), `values.json references unknown event id ${eventId}`);
      assert(isPlainObject(externalValues), `values.json event ${eventId} must be an object`);
      const allowedFields = new Set(["revision", "updatedAt", ...VALUE_FIELDS]);
      for (const field of Object.keys(externalValues)) {
        assert(allowedFields.has(field), `values.json event ${eventId} has unknown field ${field}`);
      }
      assert(
        Number.isInteger(externalValues.revision) && externalValues.revision > 0 && externalValues.revision <= 2_147_483_647,
        `values.json event ${eventId} revision must be a positive 32-bit integer`
      );
      assert(isIsoInstant(externalValues.updatedAt), `values.json event ${eventId} updatedAt must be a UTC ISO timestamp`);
      assert(VALUE_FIELDS.some((field) => externalValues[field] !== undefined), `values.json event ${eventId} must contain at least one value`);
      for (const field of VALUE_FIELDS) {
        if (externalValues[field] !== undefined) {
          validateValueObject(externalValues[field], `values.json event ${eventId}.${field}`);
        }
      }

      const event = eventsById.get(eventId);
      for (const field of VALUE_FIELDS) {
        if (externalValues[field] !== undefined && event[field] === undefined) event[field] = externalValues[field];
      }
      event.revision += externalValues.revision;
      assert(event.revision <= 2_147_483_647, `${event.id}: combined calendar and values revision exceeds 32-bit SEQUENCE`);
      const verifiedInstant = `${event.verifiedAt}T00:00:00Z`;
      event.lastModifiedAt = Date.parse(externalValues.updatedAt) > Date.parse(verifiedInstant)
        ? externalValues.updatedAt
        : verifiedInstant;
    }
  }

  events.sort((a, b) => `${a.date}T${a.time}:${a.id}`.localeCompare(`${b.date}T${b.time}:${b.id}`));
  return { catalog, datasets, events, values };
}

function partsInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function zonedLocalToUtc(dateText, timeText, timeZone) {
  const [year, month, day] = dateText.split("-").map(Number);
  const [hour, minute] = timeText.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = desired;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const parts = partsInTimezone(new Date(instant), timeZone);
    const represented = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    instant += desired - represented;
  }

  const result = new Date(instant);
  const finalParts = partsInTimezone(result, timeZone);
  assert(
    `${finalParts.year}-${finalParts.month}-${finalParts.day} ${finalParts.hour}:${finalParts.minute}` === `${dateText} ${timeText}`,
    `Unable to resolve ${dateText} ${timeText} in ${timeZone}`
  );
  return result;
}

function formatBeijing(instant) {
  const parts = partsInTimezone(instant, "Asia/Shanghai");
  return `${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}`;
}

function formatChineseDate(dateText) {
  const [year, month, day] = dateText.split("-");
  return `${year}年${month}月${day}日`;
}

function escapeText(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function foldLine(line) {
  assert(!/[\r\n]/.test(line), "Logical iCalendar lines cannot contain raw newlines");
  const output = [];
  let current = "";
  let currentBytes = 0;

  for (const character of line) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (currentBytes + characterBytes > 75) {
      const trailingWhitespace = current.match(/[ \t]+$/)?.[0] ?? "";
      if (trailingWhitespace && current.length > trailingWhitespace.length) {
        output.push(current.slice(0, -trailingWhitespace.length));
        current = ` ${trailingWhitespace}${character}`;
      } else {
        output.push(current);
        current = ` ${character}`;
      }
      currentBytes = Buffer.byteLength(current, "utf8");
    } else {
      current += character;
      currentBytes += characterBytes;
    }
  }

  output.push(current);
  return output;
}

function formatLocalDateTime(dateText, timeText) {
  return `${dateText.replaceAll("-", "")}T${timeText.replace(":", "")}00`;
}

function addLocalMinutes(dateText, timeText, minutesToAdd) {
  const [year, month, day] = dateText.split("-").map(Number);
  const [hour, minute] = timeText.split(":").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day, hour, minute + minutesToAdd));
  const pad = (number) => String(number).padStart(2, "0");
  return {
    date: `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`,
    time: `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`
  };
}

function displayTitle(event, type, region) {
  return `${region.flag} ${event.title ?? type.title}`;
}

const VALUE_HEADINGS = {
  actual: "✅ 实际值：",
  forecast: "🔮 预测值：",
  previous: "📌 前值："
};

function defaultValueLines(type, field) {
  if (type.valueMode === "narrative") return ["不适用（此类事件不以单一数值衡量）"];
  if (field === "forecast") return ["官方来源不提供市场一致预期。"];
  if (field === "previous") return ["等待官方数据更新。"];
  return [];
}

function displayValueLines(value) {
  const lines = [...value.lines];
  if (value.asOf) lines.push(`数据期：${value.asOf}`);
  if (value.sourceName) lines.push(`数据来源：${value.sourceName}`, value.sourceUrl);
  return lines;
}

function appendValueSection(lines, event, type, field) {
  const value = event[field];
  if (field === "actual" && value?.status !== "available") return;
  const valueLines = value ? displayValueLines(value) : defaultValueLines(type, field);
  if (valueLines.length === 0) return;
  lines.push("", VALUE_HEADINGS[field], ...valueLines);
}

function descriptionFor(event, type, region) {
  const title = displayTitle(event, type, region);
  const instant = event.allDay ? null : zonedLocalToUtc(event.date, event.time, event.timezone);
  const timePrefix = event.timePrecision === "approximate" ? "约 " : "";
  const displayedTime = event.allDay
    ? `${formatChineseDate(event.date)}（全天事件；官方未设固定发布时间）`
    : `${timePrefix}${formatBeijing(instant)}（北京时间；日历会自动转换为你的本地时区）`;
  const sourceTime = event.allDay
    ? `原始时区：${event.timezone}；会议结束后立即发布`
    : `原始时区：${event.date} ${event.time}（${event.timezone}）`;
  const scheduleStatus = event.scheduleStatus ?? `已核对至 ${event.verifiedAt}；后续以官方最新公告为准。`;
  const lines = [
    title,
    "⭐⭐⭐ 高影响",
    "",
    "⏰ 公布时间：",
    displayedTime,
    sourceTime,
    "",
    "🗓️ 统计期：",
    event.period,
    "",
    "🧭 事件说明：",
    type.description,
    "",
    "🎯 市场关注：",
    ...type.marketFocus
  ];

  appendValueSection(lines, event, type, "actual");
  appendValueSection(lines, event, type, "forecast");
  appendValueSection(lines, event, type, "previous");
  lines.push(
    "",
    "🏛️ 官方来源：",
    type.sourceName,
    type.sourceUrl,
    "",
    "🔗 官方日程：",
    event.scheduleUrl ?? type.scheduleUrl,
    "",
    "📋 日程状态：",
    scheduleStatus
  );

  if (event.note) lines.push("", "💡 特别说明：", event.note);
  return lines.join("\n");
}

function calendarDateStamp(value) {
  if (ISO_DATE.test(value)) return `${value.replaceAll("-", "")}T000000Z`;
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function eventLines(event, catalog) {
  const type = catalog.types[event.type];
  const region = catalog.regions[type.region];
  const category = catalog.categories[type.category];
  const end = addLocalMinutes(event.date, event.time, event.allDay ? 1_440 : (event.durationMinutes ?? type.durationMinutes ?? 30));
  const title = displayTitle(event, type, region);
  const summary = `${title}（⭐⭐⭐ 高影响）`;
  const categories = [category.label, region.label, "高影响"].map(escapeText).join(",");

  const startLine = event.allDay
    ? `DTSTART;VALUE=DATE:${event.date.replaceAll("-", "")}`
    : `DTSTART;TZID=${event.timezone}:${formatLocalDateTime(event.date, event.time)}`;
  const endLine = event.allDay
    ? `DTEND;VALUE=DATE:${end.date.replaceAll("-", "")}`
    : `DTEND;TZID=${event.timezone}:${formatLocalDateTime(end.date, end.time)}`;

  return [
    "BEGIN:VEVENT",
    `UID:${event.id}@economic-calendar-pro`,
    `DTSTAMP:${calendarDateStamp(event.verifiedAt)}`,
    `LAST-MODIFIED:${calendarDateStamp(event.lastModifiedAt ?? event.verifiedAt)}`,
    `SEQUENCE:${event.revision}`,
    startLine,
    endLine,
    `SUMMARY:${escapeText(summary)}`,
    `DESCRIPTION:${escapeText(descriptionFor(event, type, region))}`,
    `LOCATION:${escapeText(type.location)}`,
    `URL:${type.sourceUrl}`,
    `CATEGORIES:${categories}`,
    `COLOR:${category.color}`,
    `X-EVENT-COLOR:${category.color}`,
    `STATUS:${event.status ?? (event.timePrecision === "approximate" ? "TENTATIVE" : "CONFIRMED")}`,
    `X-SOURCE-STATUS:${event.sourceStatus ?? (event.status === "TENTATIVE" || event.timePrecision === "approximate" ? "ESTIMATED" : "OFFICIAL")}`,
    ...(event.allDay ? ["X-MICROSOFT-CDO-ALLDAYEVENT:TRUE"] : []),
    "TRANSP:TRANSPARENT",
    "CLASS:PUBLIC",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER:-P1D",
    `DESCRIPTION:${escapeText(`提醒：明天 ${title}`)}`,
    "END:VALARM",
    ...(!event.allDay ? [
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "TRIGGER:-PT1H",
      `DESCRIPTION:${escapeText(`提醒：1 小时后 ${title}`)}`,
      "END:VALARM"
    ] : []),
    "END:VEVENT"
  ];
}

export function buildCalendar(events, catalog, options) {
  assert(events.length > 0, `${options.fileName}: feed cannot be empty`);
  const verifiedAt = events.map((event) => event.verifiedAt).sort().at(-1);
  const timezones = [...new Set(events.map((event) => event.timezone))].sort();
  const logicalLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Economic Calendar Pro//ZH-CN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `NAME:${escapeText(options.name)}`,
    `X-WR-CALNAME:${escapeText(options.name)}`,
    `X-WR-CALDESC:${escapeText(options.description)}`,
    `X-WR-TIMEZONE:${options.primaryTimezone ?? "Asia/Shanghai"}`,
    "REFRESH-INTERVAL;VALUE=DURATION:P1D",
    "X-PUBLISHED-TTL:PT12H",
    `COLOR:${options.color}`,
    `X-APPLE-CALENDAR-COLOR:${options.color}`
  ];

  for (const timezone of timezones) logicalLines.push(...TIMEZONE_COMPONENTS[timezone]);
  for (const event of events) logicalLines.push(...eventLines(event, catalog));
  logicalLines.push("END:VCALENDAR");

  return `${logicalLines.flatMap(foldLine).join("\r\n")}\r\n`;
}

export async function projectSourceHash(project) {
  const buildFiles = ["package.json", "scripts/calendar-lib.mjs", "scripts/build.mjs"];
  const buildInputs = Object.fromEntries(
    await Promise.all(buildFiles.map(async (fileName) => [fileName, await readFile(path.join(repoRoot, fileName), "utf8")]))
  );
  const payload = JSON.stringify({ catalog: project.catalog, datasets: project.datasets, values: project.values, buildInputs });
  return createHash("sha256").update(payload).digest("hex");
}

function feedDefinitions(catalog, events, datasets) {
  const definitions = [
    {
      fileName: "economic-calendar-pro.ics",
      name: "全球高影响财经日历 Pro",
      description: "美国、欧元区、日本和中国的高影响宏观事件；中文说明、官方来源、定时事件双提醒。",
      color: catalog.masterColor,
      filter: () => true
    }
  ];

  for (const [regionId, region] of Object.entries(catalog.regions)) {
    definitions.push({
      fileName: `feeds/${regionId}.ics`,
      name: `${region.label}高影响财经日历 Pro`,
      description: `${region.label}高影响宏观事件；中文说明、官方来源、定时事件双提醒。`,
      color: region.color,
      primaryTimezone: region.timezone,
      filter: (event) => catalog.types[event.type].region === regionId
    });
  }

  for (const [categoryId, category] of Object.entries(catalog.categories)) {
    definitions.push({
      fileName: `feeds/${categoryId}.ics`,
      name: `${category.label}事件 Pro`,
      description: `全球${category.label}类高影响事件；适合在 Apple 日历中独立设置颜色。`,
      color: category.color,
      filter: (event) => catalog.types[event.type].category === categoryId
    });
  }

  for (const year of [...new Set(events.map((event) => event.releaseYear))].sort()) {
    const dataset = datasets.find((item) => item.year === year);
    if (dataset?.coverageStatus !== "complete") continue;
    definitions.push({
      fileName: `${year}_中文财经日历_全球高影响_Pro.ics`,
      name: `${year} 中文财经日历（全球高影响 Pro）`,
      description: `${year} 年美国、欧元区、日本和中国高影响宏观事件归档。`,
      color: catalog.masterColor,
      filter: (event) => event.releaseYear === year
    });
    definitions.push({
      fileName: `${year}_中文财经日历_US_高影响_Pro.ics`,
      name: `${year} 中文财经日历（美国高影响 Pro）`,
      description: `${year} 年美国高影响宏观事件归档。`,
      color: catalog.regions.us.color,
      primaryTimezone: catalog.regions.us.timezone,
      filter: (event) => event.releaseYear === year && catalog.types[event.type].region === "us"
    });
  }

  return definitions;
}

export async function writeAllCalendars(project) {
  // dist contains generated artifacts only; replacing it prevents retired feeds from being republished.
  await rm(distDir, { recursive: true, force: true });
  await mkdir(path.join(distDir, "feeds"), { recursive: true });
  const feeds = [];

  for (const definition of feedDefinitions(project.catalog, project.events, project.datasets)) {
    const selected = project.events.filter(definition.filter);
    if (selected.length === 0) continue;
    const content = buildCalendar(selected, project.catalog, definition);
    const outputPath = path.join(distDir, definition.fileName);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, content, "utf8");
    feeds.push({
      fileName: definition.fileName,
      name: definition.name,
      eventCount: selected.length,
      sha256: createHash("sha256").update(content).digest("hex")
    });
  }

  const verifiedAt = project.datasets.map((dataset) => dataset.verifiedAt).sort().at(-1);
  const manifest = {
    schemaVersion: 1,
    verifiedAt,
    sourceSha256: await projectSourceHash(project),
    sourceFiles: [
      ...project.datasets.map((dataset) => dataset.fileName),
      ...(project.values ? ["values.json"] : [])
    ],
    coverage: Object.fromEntries(project.datasets.map((dataset) => [dataset.year, dataset.coverageStatus])),
    totalEventCount: project.events.length,
    feeds
  };
  await writeFile(path.join(distDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(distDir, ".nojekyll"), "", "utf8");
  return manifest;
}

export function unfoldIcs(text) {
  return text.replace(/\r\n[ \t]/g, "");
}
