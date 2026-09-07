import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function createFixture() {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "economic-calendar-coverage-"));
  await mkdir(path.join(fixtureRoot, "scripts"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "data"), { recursive: true });
  for (const file of [
    "scripts/check-coverage.mjs",
    "scripts/calendar-lib.mjs",
    "data/catalog.json",
    "data/events-2026.json",
    "data/events-2027.json"
  ]) {
    await cp(path.join(sourceRoot, file), path.join(fixtureRoot, file));
  }
  const nextYearPath = path.join(fixtureRoot, "data/events-2027.json");
  const nextYearDataset = JSON.parse(await readFile(nextYearPath, "utf8"));
  nextYearDataset.coverageStatus = "partial";
  await writeFile(nextYearPath, `${JSON.stringify(nextYearDataset)}\n`);
  return fixtureRoot;
}

async function runCoverage(checkDate, mutate) {
  const fixtureRoot = await createFixture();
  try {
    await mutate?.(fixtureRoot);
    try {
      const result = await execFileAsync(process.execPath, ["scripts/check-coverage.mjs"], {
        cwd: fixtureRoot,
        env: { ...process.env, CHECK_DATE: checkDate },
        maxBuffer: 1024 * 1024
      });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return {
        code: typeof error.code === "number" ? error.code : 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? ""
      };
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

function outputOf(result) {
  return `${result.stdout}\n${result.stderr}`;
}

test("coverage passes more than 120 days before the next year", async () => {
  const result = await runCoverage("2026-09-02");
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Coverage check passed/);
  assert.doesNotMatch(outputOf(result), /::warning::/);
});

test("partial next-year data emits a warning but passes inside the 120-day window", async () => {
  const result = await runCoverage("2026-09-03");
  assert.equal(result.code, 0);
  assert.match(outputOf(result), /::warning::/);
  assert.match(outputOf(result), /events-2027\.json/);
  assert.match(outputOf(result), /partial/);
  assert.match(result.stdout, /Coverage check passed/);
});

test("missing next-year data still fails inside the 120-day window", async () => {
  const result = await runCoverage("2026-09-07", async (fixtureRoot) => {
    await rm(path.join(fixtureRoot, "data/events-2027.json"));
  });
  assert.notEqual(result.code, 0);
  assert.match(outputOf(result), /events-2027\.json/);
  assert.match(outputOf(result), /missing/);
});

test("incomplete current-year data still fails", async () => {
  const result = await runCoverage("2026-09-07", async (fixtureRoot) => {
    const filePath = path.join(fixtureRoot, "data/events-2026.json");
    const dataset = JSON.parse(await readFile(filePath, "utf8"));
    dataset.coverageStatus = "partial";
    await writeFile(filePath, `${JSON.stringify(dataset)}\n`);
  });
  assert.notEqual(result.code, 0);
  assert.match(outputOf(result), /events-2026\.json/);
  assert.match(outputOf(result), /partial/);
});
