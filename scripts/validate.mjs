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

const project = await loadProject();
const manifest = JSON.parse(await readFile(path.join(distDir, "manifest.json"), "utf8"));
assert(manifest.totalEventCount === project.events.length, "manifest total does not match source data");
assert(manifest.sourceSha256 === await projectSourceHash(project), "dist is stale: manifest source hash does not match current build inputs");

for (const feed of manifest.feeds) {
  const filePath = path.join(distDir, feed.fileName);
  const text = await readFile(filePath, "utf8");
  const actualSha256 = createHash("sha256").update(text).digest("hex");
  assert(actualSha256 === feed.sha256, `${feed.fileName}: content hash does not match manifest`);
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
    assert(block.includes("预测值：\\n（预留）"), `${feed.fileName}: missing forecast placeholder`);
    assert(block.includes("前值：\\n（预留）"), `${feed.fileName}: missing previous-value placeholder`);
    assert(block.includes("官方来源："), `${feed.fileName}: missing official source`);

    const uid = block.match(/(?:^|\r\n)UID:([^\r\n]+)/)?.[1];
    assert(uid, `${feed.fileName}: missing UID value`);
    assert(!uids.has(uid), `${feed.fileName}: duplicate UID ${uid}`);
    uids.add(uid);
  }
}

console.log(`Validated ${manifest.feeds.length} feeds and ${manifest.totalEventCount} source events.`);
