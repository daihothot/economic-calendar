import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { distDir, loadProject, projectSourceHash, unfoldIcs } from "./calendar-lib.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function validateNesting(lines, fileName) {
  const stack = [];
  for (const line of lines) {
    if (line.startsWith("BEGIN:")) stack.push(line.slice(6));
    if (line.startsWith("END:")) {
      const component = line.slice(4);
      assert(stack.pop() === component, `${fileName}: mismatched END:${component}`);
    }
  }
  assert(stack.length === 0, `${fileName}: unclosed iCalendar component`);
}

function unescapeIcsText(value) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\" || index === value.length - 1) {
      result += value[index];
      continue;
    }
    index += 1;
    result += value[index] === "n" || value[index] === "N" ? "\n" : value[index];
  }
  return result;
}

function propertyValue(block, name) {
  return block.match(new RegExp(`(?:^|\\r\\n)${name}:([^\\r\\n]*)`))?.[1];
}

function expectedFallback(type, field) {
  if (type.valueMode === "narrative") return "不适用（此类事件不以单一数值衡量）";
  if (field === "forecast") return "官方来源不提供市场一致预期。";
  return "等待官方数据更新。";
}

function calendarDateStamp(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value.replaceAll("-", "")}T000000Z`;
  return new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

const project = await loadProject();
const eventsByUid = new Map(project.events.map((event) => [`${event.id}@economic-calendar-pro`, event]));
const manifest = JSON.parse(await readFile(path.join(distDir, "manifest.json"), "utf8"));
assert(manifest.totalEventCount === project.events.length, "manifest total does not match source data");
assert(manifest.sourceSha256 === await projectSourceHash(project), "dist is stale: manifest source hash does not match current build inputs");

for (const feed of manifest.feeds) {
  const filePath = path.join(distDir, feed.fileName);
  const text = await readFile(filePath, "utf8");
  const actualSha256 = createHash("sha256").update(text).digest("hex");
  assert(actualSha256 === feed.sha256, `${feed.fileName}: content hash does not match manifest`);
  assert(!text.includes("\uFF08\u9884\u7559\uFF09"), `${feed.fileName}: obsolete placeholder remains`);
  assert(!text.replace(/\r\n/g, "").match(/[\r\n]/), `${feed.fileName}: line endings must be CRLF`);
  assert(text.endsWith("\r\n"), `${feed.fileName}: missing final CRLF`);

  const physicalLines = text.slice(0, -2).split("\r\n");
  for (const [index, line] of physicalLines.entries()) {
    assert(Buffer.byteLength(line, "utf8") <= 75, `${feed.fileName}:${index + 1}: line exceeds 75 octets`);
  }

  const unfolded = unfoldIcs(text);
  const logicalLines = unfolded.trimEnd().split("\r\n");
  validateNesting(logicalLines, feed.fileName);
  assert(logicalLines[0] === "BEGIN:VCALENDAR", `${feed.fileName}: invalid first line`);
  assert(logicalLines.at(-1) === "END:VCALENDAR", `${feed.fileName}: invalid last line`);

  const eventBlocks = unfolded.split("BEGIN:VEVENT\r\n").slice(1).map((block) => block.split("END:VEVENT\r\n")[0]);
  assert(eventBlocks.length === feed.eventCount, `${feed.fileName}: event count mismatch`);
  const uids = new Set();

  for (const block of eventBlocks) {
    const required = ["UID:", "DTSTAMP:", "SUMMARY:", "DESCRIPTION:", "URL:https://", "CATEGORIES:", "COLOR:", "STATUS:", "X-SOURCE-STATUS:"];
    for (const prefix of required) assert(block.includes(`\r\n${prefix}`) || block.startsWith(prefix), `${feed.fileName}: missing ${prefix}`);
    assert(block.includes("DTSTART;TZID=") || block.includes("DTSTART;VALUE=DATE:"), `${feed.fileName}: missing DTSTART`);
    assert(block.includes("DTEND;TZID=") || block.includes("DTEND;VALUE=DATE:"), `${feed.fileName}: missing DTEND`);
    const isAllDay = block.includes("DTSTART;VALUE=DATE:");
    const expectedAlarmCount = isAllDay ? 1 : 2;
    assert((block.match(/BEGIN:VALARM/g) ?? []).length === expectedAlarmCount, `${feed.fileName}: unexpected alarm count`);
    assert(block.includes("TRIGGER:-P1D"), `${feed.fileName}: missing one-day alarm`);
    assert(isAllDay || block.includes("TRIGGER:-PT1H"), `${feed.fileName}: timed event is missing one-hour alarm`);
    assert(!isAllDay || !block.includes("TRIGGER:-PT1H"), `${feed.fileName}: all-day event cannot claim a one-hour-before-release alarm`);
    const uid = block.match(/(?:^|\r\n)UID:([^\r\n]+)/)?.[1];
    assert(uid, `${feed.fileName}: missing UID value`);
    assert(!uids.has(uid), `${feed.fileName}: duplicate UID ${uid}`);
    uids.add(uid);

    const event = eventsByUid.get(uid);
    assert(event, `${feed.fileName}: UID ${uid} does not match source data`);
    const type = project.catalog.types[event.type];
    const descriptionValue = propertyValue(block, "DESCRIPTION");
    assert(descriptionValue !== undefined, `${feed.fileName}: missing event DESCRIPTION value`);
    const description = unescapeIcsText(descriptionValue);
    const descriptionLines = description.split("\n");
    for (const heading of [
      "⏰ 公布时间：",
      "🗓️ 统计期：",
      "🧭 事件说明：",
      "🎯 市场关注：",
      "🔮 预测值：",
      "📌 前值：",
      "🏛️ 官方来源：",
      "🔗 官方日程：",
      "📋 日程状态："
    ]) {
      assert(description.includes(heading), `${feed.fileName}: ${uid} is missing ${heading}`);
    }
    assert(!/[\u{1F4C8}\u{1F4C9}]/u.test(description), `${feed.fileName}: ${uid} contains directional market arrows`);
    const marketHeadingIndex = descriptionLines.indexOf("🎯 市场关注：");
    const marketFocusLines = descriptionLines.slice(marketHeadingIndex + 1, marketHeadingIndex + 1 + type.marketFocus.length);
    assert(
      JSON.stringify(marketFocusLines) === JSON.stringify(type.marketFocus),
      `${feed.fileName}: ${uid} market focus section must use the standard ↗｜↘ lines`
    );
    const officialSourceHeadings = descriptionLines.filter((line) => /官方来源[：:]$/.test(line));
    assert(
      officialSourceHeadings.length === 1 && officialSourceHeadings[0] === "🏛️ 官方来源：",
      `${feed.fileName}: ${uid} official source heading must not contain an arrow`
    );

    for (const field of ["forecast", "previous"]) {
      const expectedLines = event[field]?.lines ?? [expectedFallback(type, field)];
      for (const line of expectedLines) {
        assert(description.includes(line), `${feed.fileName}: ${uid} is missing ${field} line ${line}`);
      }
      if (event[field]?.asOf) assert(description.includes(`数据期：${event[field].asOf}`), `${feed.fileName}: ${uid} is missing ${field} asOf`);
      if (event[field]?.sourceName) {
        assert(description.includes(`数据来源：${event[field].sourceName}`), `${feed.fileName}: ${uid} is missing ${field} sourceName`);
        assert(description.includes(event[field].sourceUrl), `${feed.fileName}: ${uid} is missing ${field} sourceUrl`);
      }
    }

    const hasAvailableActual = event.actual?.status === "available";
    assert(description.includes("✅ 实际值：") === hasAvailableActual, `${feed.fileName}: ${uid} actual section does not match value status`);
    if (hasAvailableActual) {
      for (const line of event.actual.lines) assert(description.includes(line), `${feed.fileName}: ${uid} is missing actual line ${line}`);
      if (event.actual.asOf) assert(description.includes(`数据期：${event.actual.asOf}`), `${feed.fileName}: ${uid} is missing actual asOf`);
      if (event.actual.sourceName) {
        assert(description.includes(`数据来源：${event.actual.sourceName}`), `${feed.fileName}: ${uid} is missing actual sourceName`);
        assert(description.includes(event.actual.sourceUrl), `${feed.fileName}: ${uid} is missing actual sourceUrl`);
      }
    }

    assert(description.includes(type.sourceName) && description.includes(type.sourceUrl), `${feed.fileName}: ${uid} is missing official source`);
    assert(Number(propertyValue(block, "SEQUENCE")) === event.revision, `${feed.fileName}: ${uid} sequence does not match source revision`);
    const expectedLastModified = calendarDateStamp(event.lastModifiedAt ?? event.verifiedAt);
    assert(propertyValue(block, "LAST-MODIFIED") === expectedLastModified, `${feed.fileName}: ${uid} LAST-MODIFIED is stale`);
  }
}

console.log(`Validated ${manifest.feeds.length} feeds and ${manifest.totalEventCount} source events.`);
