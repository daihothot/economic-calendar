import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildMappedEventValues,
  calculateMetric,
  fetchProviderData,
  parseBlsJson,
  parseChinaMoneyLprJson,
  parseDbnomicsJson,
  parseFredCsv,
  updateValues
} from "./update-values.mjs";
import { loadProject } from "./calendar-lib.mjs";

const SOURCE = {
  sourceName: "FRED（测试数据）",
  sourceUrl: "https://fred.stlouisfed.org/series/TEST"
};

function monthlyMapping(overrides = {}) {
  return {
    schemaVersion: 1,
    providers: {
      fred: { kind: "fred-csv", baseUrl: "https://fred.example.test/graph.csv" }
    },
    types: {
      "test-cpi": {
        provider: "fred",
        idPattern: "^test-cpi-(?<year>\\d{4})-(?<month>\\d{2})$",
        frequency: "monthly",
        metrics: [{
          seriesId: "TEST",
          label: "CPI 同比",
          transformation: "percent-change-year-over-year",
          decimals: 1,
          unit: "%"
        }],
        ...SOURCE,
        ...overrides
      }
    }
  };
}

function projectWith(...events) {
  return { events };
}

function event(id, date = "2026-02-13") {
  return {
    id,
    type: "test-cpi",
    date,
    time: "08:30",
    timezone: "America/New_York"
  };
}

function csvResponse(text) {
  return async () => ({ ok: true, status: 200, text: async () => text });
}

const fredCsv = [
  "observation_date,TEST",
  "2024-12-01,100",
  "2025-01-01,101",
  "2025-12-01,105",
  "2026-01-01,111.1",
  ""
].join("\n");

test("parseFredCsv accepts quoted headers and skips missing observations", () => {
  assert.deepEqual(parseFredCsv('observation_date,"TEST"\r\n2026-01-01,1.5\r\n2026-02-01,.\r\n', "TEST"), [
    { date: "2026-01-01", value: 1.5 }
  ]);
});

test("parseDbnomicsJson aligns periods and values", () => {
  const document = {
    series: {
      docs: [{
        period: ["2025-Q4", "2026-Q1", "2026-Q2"],
        value: [100, null, 102.5]
      }]
    }
  };
  assert.deepEqual(parseDbnomicsJson(document, "TEST/GDP/REAL"), [
    { date: "2025-10-01", value: 100 },
    { date: "2026-04-01", value: 102.5 }
  ]);
});

test("parseChinaMoneyLprJson extracts official 1Y and 5Y records", () => {
  const document = {
    records: [
      { showDateCN: "2026-07-20", "1Y": "3.00", "5Y": "3.50" },
      { showDateCN: "2026-06-22", "1Y": "3.00", "5Y": "3.50" }
    ]
  };
  assert.deepEqual(parseChinaMoneyLprJson(document, "1Y"), [
    { date: "2026-06-22", value: 3 },
    { date: "2026-07-20", value: 3 }
  ]);
});

const blsFixture = {
  status: "REQUEST_SUCCEEDED",
  responseTime: 42,
  message: [],
  Results: {
    series: [{
      seriesID: "WPUFD4",
      data: [
        { year: "2026", period: "M02", periodName: "February", value: "141.200" },
        { year: "2026", period: "M01", periodName: "January", value: "140.100" },
        { year: "2025", period: "M13", periodName: "Annual", value: "139.000" }
      ]
    }]
  }
};

test("parseBlsJson converts M01-M12 observations and ignores M13", () => {
  assert.deepEqual(parseBlsJson(blsFixture, "WPUFD4"), [
    { date: "2026-01-01", value: 140.1 },
    { date: "2026-02-01", value: 141.2 }
  ]);
  assert.throws(() => parseBlsJson({
    status: "REQUEST_FAILED",
    message: ["Request could not be serviced."],
    Results: {}
  }, "WPUFD4"), /BLS request failed: Request could not be serviced/);
});

test("BLS adapter posts the requested series and bounded year range", async () => {
  const mapping = {
    schemaVersion: 1,
    providers: {
      bls: { kind: "bls-json", baseUrl: "https://bls.example.test/publicAPI/v2/timeseries/data/" }
    },
    types: {
      "test-ppi": {
        provider: "bls",
        idPattern: "^test-ppi-(?<year>\\d{4})-(?<month>\\d{2})$",
        frequency: "monthly",
        metrics: [{
          seriesId: "WPUFD4",
          label: "PPI 同比",
          transformation: "percent-change-year-over-year"
        }]
      }
    }
  };
  const project = projectWith({
    ...event("test-ppi-2026-01"),
    type: "test-ppi"
  });
  let request;
  const providerData = await fetchProviderData(project, mapping, async (url, options) => {
    request = { url: String(url), options };
    return { ok: true, status: 200, text: async () => JSON.stringify(blsFixture) };
  });
  const body = JSON.parse(request.options.body);
  assert.equal(request.url, "https://bls.example.test/publicAPI/v2/timeseries/data/");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["content-type"], "application/json");
  assert.deepEqual(body.seriesid, ["WPUFD4"]);
  assert.equal(body.startyear, "2024");
  assert.equal(body.endyear, String(new Date().getUTCFullYear()));
  assert.deepEqual(providerData.get("WPUFD4").get(2026 * 12), {
    date: "2026-01-01",
    value: 140.1
  });
});

test("calculateMetric computes period and year-over-year changes", () => {
  const observations = new Map([
    [2024 * 12, { date: "2024-01-01", value: 100 }],
    [2025 * 12, { date: "2025-01-01", value: 110 }]
  ]);
  assert.deepEqual(calculateMetric(
    { transformation: "percent-change-year-over-year" },
    2025 * 12,
    observations,
    "monthly"
  ), { value: 10.000000000000009, asOf: "2025-01-01" });
  assert.deepEqual(calculateMetric(
    { transformation: "value", valueOffset: -100 },
    2025 * 12,
    observations,
    "monthly"
  ), { value: 10, asOf: "2025-01-01" });
});

test("mapped values contain actual, previous, and an honest unavailable forecast", () => {
  const observations = new Map([
    [2024 * 12 + 11, { date: "2024-12-01", value: 100 }],
    [2025 * 12, { date: "2025-01-01", value: 101 }],
    [2025 * 12 + 11, { date: "2025-12-01", value: 105 }],
    [2026 * 12, { date: "2026-01-01", value: 111.1 }]
  ]);
  const values = buildMappedEventValues(
    projectWith(event("test-cpi-2026-01")),
    monthlyMapping(),
    new Map([["TEST", observations]]),
    new Date("2026-03-01T00:00:00Z")
  );
  assert.deepEqual(values["test-cpi-2026-01"], {
    forecast: { status: "unavailable", lines: ["官方数据源不提供市场一致预期"] },
    actual: {
      status: "available",
      lines: ["CPI 同比：10.0%"],
      asOf: "2026-01-01",
      ...SOURCE
    },
    previous: {
      status: "available",
      lines: ["CPI 同比：5.0%"],
      asOf: "2025-12-01",
      ...SOURCE
    }
  });
});

test("a future release stays pending even if upstream already has the period", () => {
  const observations = new Map([
    [2025 * 12, { date: "2025-01-01", value: 100 }],
    [2026 * 12, { date: "2026-01-01", value: 105 }]
  ]);
  const values = buildMappedEventValues(
    projectWith(event("test-cpi-2026-01", "2026-12-01")),
    monthlyMapping(),
    new Map([["TEST", observations]]),
    new Date("2026-03-01T00:00:00Z")
  );
  assert.equal(values["test-cpi-2026-01"].actual.status, "pending");
  assert.deepEqual(values["test-cpi-2026-01"].actual.lines, ["等待官方公布"]);
});

test("policy decisions use the first effective change after the meeting instead of month end", () => {
  const mapping = monthlyMapping({
    observationMode: "policy-decision",
    lookaheadDays: 14,
    metrics: [{
      seriesId: "TEST",
      label: "政策利率",
      transformation: "value",
      decimals: 2,
      unit: "%"
    }]
  });
  const providerData = new Map([["TEST", new Map()]]);
  Object.defineProperty(providerData, "raw", { value: new Map([["TEST", [
    { date: "2026-06-10", value: 2 },
    { date: "2026-06-11", value: 2 },
    { date: "2026-06-17", value: 2.25 },
    { date: "2026-06-30", value: 2.5 }
  ]]]) });
  const values = buildMappedEventValues(
    projectWith(event("test-cpi-2026-06", "2026-06-11")),
    mapping,
    providerData,
    new Date("2026-07-01T00:00:00Z")
  )["test-cpi-2026-06"];
  assert.deepEqual(values.actual.lines, ["政策利率：2.25%"]);
  assert.equal(values.actual.asOf, "2026-06-17");
  assert.deepEqual(values.previous.lines, ["政策利率：2.00%"]);
  assert.equal(values.previous.asOf, "2026-06-10");
});

test("multi-metric reports explicitly retain missing lines", () => {
  const mapping = monthlyMapping({
    metrics: [
      { seriesId: "TEST", label: "总体指标", transformation: "value" },
      { seriesId: "MISSING", label: "核心指标", transformation: "value" }
    ]
  });
  const values = buildMappedEventValues(
    projectWith(event("test-cpi-2026-01")),
    mapping,
    new Map([["TEST", new Map([[2026 * 12, { date: "2026-01-01", value: 101 }]])]]),
    new Date("2026-03-01T00:00:00Z")
  )["test-cpi-2026-01"];
  assert.equal(values.actual.status, "available");
  assert.deepEqual(values.actual.lines, [
    "总体指标：101.0",
    "核心指标：免费数据源尚未提供本统计期数值"
  ]);
});

test("unsupported providers are explicit rather than silently empty", () => {
  const mapping = monthlyMapping({ provider: "other", unavailableReason: "该免费来源尚未接入" });
  mapping.providers.other = { kind: "other-json", baseUrl: "https://example.test" };
  const values = buildMappedEventValues(
    projectWith(event("test-cpi-2026-01")),
    mapping,
    new Map(),
    new Date("2026-03-01T00:00:00Z")
  );
  assert.equal(values["test-cpi-2026-01"].actual.status, "unavailable");
  assert.deepEqual(values["test-cpi-2026-01"].actual.lines, ["该免费来源尚未接入"]);
});

test("updateValues does not rewrite revision or updatedAt when values are unchanged", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "economic-calendar-values-"));
  const outputPath = path.join(temporaryDirectory, "values.json");
  const project = projectWith(event("test-cpi-2026-01"));
  const first = await updateValues({
    project,
    mappingDocument: monthlyMapping(),
    outputPath,
    fetchImpl: csvResponse(fredCsv),
    now: new Date("2026-03-01T00:00:00Z")
  });
  const firstText = await readFile(outputPath, "utf8");
  const second = await updateValues({
    project,
    mappingDocument: monthlyMapping(),
    outputPath,
    fetchImpl: csvResponse(fredCsv),
    now: new Date("2026-03-02T00:00:00Z")
  });
  assert.equal(first.changed, true);
  assert.equal(first.document.revision, 1);
  assert.equal(first.document.events["test-cpi-2026-01"].revision, 1);
  assert.equal(first.document.events["test-cpi-2026-01"].updatedAt, "2026-03-01T00:00:00.000Z");
  assert.equal(second.changed, false);
  assert.equal(await readFile(outputPath, "utf8"), firstText);
});

test("only a changed event increments its own revision", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "economic-calendar-values-revision-"));
  const outputPath = path.join(temporaryDirectory, "values.json");
  const project = projectWith(event("test-cpi-2026-01"));
  const first = await updateValues({
    project,
    mappingDocument: monthlyMapping(),
    outputPath,
    fetchImpl: csvResponse(fredCsv),
    now: new Date("2026-03-01T00:00:00Z")
  });
  const changedCsv = fredCsv.replace("2026-01-01,111.1", "2026-01-01,112.2");
  const second = await updateValues({
    project,
    mappingDocument: monthlyMapping(),
    outputPath,
    fetchImpl: csvResponse(changedCsv),
    now: new Date("2026-03-02T00:00:00Z")
  });
  assert.equal(first.document.events["test-cpi-2026-01"].revision, 1);
  assert.equal(second.document.events["test-cpi-2026-01"].revision, 2);
  assert.equal(second.document.events["test-cpi-2026-01"].updatedAt, "2026-03-02T00:00:00.000Z");
});

test("removed events are cleaned from an existing values file", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "economic-calendar-values-cleanup-"));
  const outputPath = path.join(temporaryDirectory, "values.json");
  await writeFile(outputPath, `${JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    updatedAt: "2026-02-28T00:00:00.000Z",
    events: {
      removed: {
        revision: 1,
        updatedAt: "2026-02-28T00:00:00.000Z",
        forecast: { status: "unavailable", lines: ["旧事件"] }
      }
    }
  })}\n`);
  const result = await updateValues({
    project: projectWith(event("test-cpi-2026-01")),
    mappingDocument: monthlyMapping(),
    outputPath,
    fetchImpl: csvResponse(fredCsv),
    now: new Date("2026-03-01T00:00:00Z")
  });
  assert.equal(result.document.events.removed, undefined);
});

test("the real mapping accepts every maintained event id", async () => {
  const mapping = JSON.parse(await readFile(new URL("../data/value-series.json", import.meta.url), "utf8"));
  const project = await loadProject({ includeValues: false });
  const mapped = buildMappedEventValues(project, mapping, new Map(), new Date("2026-08-11T00:00:00Z"));
  assert.equal(Object.keys(mapped).length, project.events.length);
});
