import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadProject, repoRoot, zonedLocalToUtc } from "./calendar-lib.mjs";

const MAX_REVISION = 2_147_483_647;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_FORECAST_LINE = "官方数据源不提供市场一致预期";
const DEFAULT_PENDING_LINE = "等待官方公布";
const DEFAULT_UNAVAILABLE_LINE = "免费官方数据源暂未覆盖";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }

  assert(!quoted, "CSV contains an unterminated quoted field");
  if (cell !== "" || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    if (row.some((value) => value !== "")) rows.push(row);
  }
  return rows;
}

export function parseFredCsv(text, seriesId) {
  assert(typeof text === "string" && text.trim(), `${seriesId}: empty FRED response`);
  assert(!/<(?:!doctype|html)\b/i.test(text), `${seriesId}: FRED returned HTML instead of CSV`);
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ""));
  assert(rows.length > 0, `${seriesId}: FRED CSV has no header`);
  const columnIndex = rows[0].indexOf(seriesId);
  assert(columnIndex > 0, `${seriesId}: FRED CSV does not contain the requested series column`);

  const observations = [];
  for (const row of rows.slice(1)) {
    const date = row[0];
    const rawValue = row[columnIndex];
    if (!ISO_DATE.test(date ?? "") || rawValue === undefined || rawValue === "" || rawValue === ".") continue;
    const value = Number(rawValue);
    assert(Number.isFinite(value), `${seriesId}: invalid value ${rawValue} at ${date}`);
    observations.push({ date, value });
  }
  observations.sort((left, right) => left.date.localeCompare(right.date));
  return observations;
}

function dbnomicsPeriodDate(period) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) return period;
  if (/^\d{4}-\d{2}$/.test(period)) return `${period}-01`;
  const quarterly = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarterly) return `${quarterly[1]}-${String((Number(quarterly[2]) - 1) * 3 + 1).padStart(2, "0")}-01`;
  return null;
}

export function parseDbnomicsJson(text, seriesId) {
  const document = typeof text === "string" ? JSON.parse(text) : text;
  const docs = document?.series?.docs;
  assert(Array.isArray(docs) && docs.length === 1, `${seriesId}: DBnomics response must contain exactly one series`);
  const periods = docs[0].period;
  const values = docs[0].value;
  const startDays = docs[0].period_start_day;
  assert(Array.isArray(periods) && Array.isArray(values) && periods.length === values.length,
    `${seriesId}: DBnomics period/value arrays are missing or misaligned`);
  if (startDays !== undefined) {
    assert(Array.isArray(startDays) && startDays.length === periods.length,
      `${seriesId}: DBnomics period_start_day array is misaligned`);
  }

  const observations = [];
  for (let index = 0; index < periods.length; index += 1) {
    if (values[index] === null || values[index] === undefined || values[index] === "NA") continue;
    const date = dbnomicsPeriodDate(startDays?.[index] ?? periods[index]);
    if (!date) continue;
    const value = Number(values[index]);
    assert(Number.isFinite(value), `${seriesId}: invalid DBnomics value at ${periods[index]}`);
    observations.push({ date, value });
  }
  observations.sort((left, right) => left.date.localeCompare(right.date));
  return observations;
}

export function parseChinaMoneyLprJson(text, tenor) {
  const document = typeof text === "string" ? JSON.parse(text) : text;
  assert(Array.isArray(document?.records), `${tenor}: ChinaMoney response is missing records`);
  const observations = [];
  for (const record of document.records) {
    if (!ISO_DATE.test(record.showDateCN ?? "") || record[tenor] === undefined) continue;
    const value = Number(record[tenor]);
    assert(Number.isFinite(value), `${tenor}: invalid ChinaMoney LPR value at ${record.showDateCN}`);
    observations.push({ date: record.showDateCN, value });
  }
  observations.sort((left, right) => left.date.localeCompare(right.date));
  return observations;
}

export function parseBlsJson(text, seriesId) {
  const document = typeof text === "string" ? JSON.parse(text) : text;
  const messages = Array.isArray(document?.message) ? document.message.filter(Boolean) : [];
  assert(document?.status === "REQUEST_SUCCEEDED",
    `${seriesId}: BLS request failed${messages.length ? `: ${messages.join("; ")}` : ""}`);
  const series = document?.Results?.series;
  assert(Array.isArray(series), `${seriesId}: BLS response is missing Results.series`);
  const requested = series.find((candidate) => candidate.seriesID === seriesId);
  assert(requested && Array.isArray(requested.data), `${seriesId}: BLS response does not contain the requested series`);

  const observations = [];
  for (const observation of requested.data) {
    const month = /^M(0[1-9]|1[0-2])$/.exec(observation.period ?? "")?.[1];
    if (!/^\d{4}$/.test(observation.year ?? "") || !month || observation.value === undefined) continue;
    const value = Number(observation.value);
    assert(Number.isFinite(value), `${seriesId}: invalid BLS value for ${observation.year}-${month}`);
    observations.push({ date: `${observation.year}-${month}-01`, value });
  }
  observations.sort((left, right) => left.date.localeCompare(right.date));
  return observations;
}

function periodsPerYear(frequency) {
  if (frequency === "monthly") return 12;
  if (frequency === "quarterly") return 4;
  throw new Error(`Unsupported frequency: ${frequency}`);
}

function addIsoDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  assert(!Number.isNaN(date.valueOf()), `Invalid date: ${dateText}`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function eventPeriodIndex(event, mapping) {
  const match = new RegExp(mapping.idPattern).exec(event.id);
  assert(match?.groups?.year, `${event.id}: does not match ${mapping.idPattern} with a named year group`);
  const year = Number(match.groups.year);
  assert(Number.isInteger(year), `${event.id}: invalid period year`);

  if (mapping.frequency === "monthly") {
    const month = Number(match.groups.month);
    assert(month >= 1 && month <= 12, `${event.id}: monthly mapping requires a named month group`);
    return year * 12 + month - 1 + (mapping.periodOffset ?? 0);
  }
  if (mapping.frequency === "quarterly") {
    const alias = match.groups.period ? mapping.quarterAliases?.[match.groups.period] : undefined;
    const quarter = Number(match.groups.quarter ?? alias ?? mapping.defaultQuarter);
    assert(quarter >= 1 && quarter <= 4, `${event.id}: quarterly mapping requires a named quarter group`);
    return year * 4 + quarter - 1 + (mapping.periodOffset ?? 0);
  }
  throw new Error(`${event.id}: unsupported frequency ${mapping.frequency}`);
}

function observationPeriodIndex(date, frequency) {
  assert(ISO_DATE.test(date), `Invalid observation date: ${date}`);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return frequency === "monthly"
    ? year * 12 + month - 1
    : year * 4 + Math.floor((month - 1) / 3);
}

function observationsByPeriod(observations, frequency) {
  const byPeriod = new Map();
  for (const observation of observations) {
    byPeriod.set(observationPeriodIndex(observation.date, frequency), observation);
  }
  return byPeriod;
}

function comparisonPeriods(metric, frequency) {
  if (Number.isInteger(metric.comparisonPeriods) && metric.comparisonPeriods > 0) return metric.comparisonPeriods;
  if (metric.transformation === "percent-change-year-over-year") return periodsPerYear(frequency);
  return 1;
}

export function calculateMetric(metric, targetPeriod, observations, frequency) {
  const current = observations.get(targetPeriod + (metric.periodOffset ?? 0));
  if (!current) return null;

  let value;
  if (metric.transformation === "value") {
    value = current.value;
  } else {
    const reference = observations.get(targetPeriod + (metric.periodOffset ?? 0) - comparisonPeriods(metric, frequency));
    if (!reference) return null;
    if (metric.transformation === "change") {
      value = current.value - reference.value;
    } else if (metric.transformation === "percent-change" || metric.transformation === "percent-change-year-over-year") {
      if (reference.value === 0) return null;
      value = ((current.value / reference.value) - 1) * 100;
    } else if (metric.transformation === "annualized-percent-change") {
      if (reference.value <= 0 || current.value < 0) return null;
      value = ((current.value / reference.value) ** periodsPerYear(frequency) - 1) * 100;
    } else {
      throw new Error(`Unsupported transformation: ${metric.transformation}`);
    }
  }

  value = value * (metric.scale ?? 1) + (metric.valueOffset ?? 0);
  return Number.isFinite(value) ? { value, asOf: current.date } : null;
}

function formatMetric(metric, result) {
  const decimals = metric.decimals ?? 1;
  assert(Number.isInteger(decimals) && decimals >= 0 && decimals <= 8, `${metric.seriesId}: invalid decimals`);
  const threshold = 0.5 * (10 ** -decimals);
  const normalized = Math.abs(result.value) < threshold ? 0 : result.value;
  const prefix = metric.showPlus && normalized > 0 ? "+" : "";
  const formatted = normalized.toLocaleString("zh-CN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: metric.useGrouping ?? true
  });
  return `${metric.label}：${prefix}${formatted}${metric.unit ?? ""}`;
}

function released(event, now) {
  if (event.allDay) return event.date < now.toISOString().slice(0, 10);
  return zonedLocalToUtc(event.date, event.time, event.timezone) <= now;
}

function valueRecord(status, lines, mapping, asOf) {
  const record = { status, lines };
  if (asOf) record.asOf = asOf;
  if (mapping.sourceName) record.sourceName = mapping.sourceName;
  if (mapping.sourceUrl) record.sourceUrl = mapping.sourceUrl;
  return record;
}

function metricValueRecord(mapping, targetPeriod, providerData, fallbackStatus, fallbackLine) {
  const lines = [];
  const dates = [];
  for (const metric of mapping.metrics ?? []) {
    const observations = providerData.get(metric.seriesId);
    const result = observations ? calculateMetric(metric, targetPeriod, observations, mapping.frequency) : null;
    if (!result) {
      const latest = observations ? [...observations.values()].sort((left, right) => left.date.localeCompare(right.date)).at(-1) : null;
      const reason = providerData.failures?.has(metric.seriesId)
        ? "本次自动获取失败"
        : "免费数据源尚未提供本统计期数值";
      lines.push(`${metric.label}：${reason}${latest ? `（源端最新数据期 ${latest.date}）` : ""}`);
      continue;
    }
    lines.push(formatMetric(metric, result));
    dates.push(result.asOf);
  }
  if (dates.length === 0) return valueRecord(fallbackStatus, lines.length > 0 ? lines : [fallbackLine], mapping);
  return valueRecord("available", lines, mapping, dates.sort().at(-1));
}

function policyObservation(rawObservations, event, lookaheadDays, field) {
  if (!Array.isArray(rawObservations) || rawObservations.length === 0) return null;
  const previous = rawObservations.filter((item) => item.date < event.date).at(-1) ?? null;
  if (field === "previous") return previous;

  const onDecisionDate = rawObservations.filter((item) => item.date <= event.date).at(-1) ?? previous;
  const baseline = previous ?? onDecisionDate;
  const lookaheadEnd = addIsoDays(event.date, lookaheadDays);
  const effectiveChange = baseline
    ? rawObservations.find((item) => item.date >= event.date && item.date <= lookaheadEnd && item.value !== baseline.value)
    : null;
  return effectiveChange ?? onDecisionDate;
}

function policyValueRecord(mapping, event, providerData, field, fallbackStatus, fallbackLine) {
  const lines = [];
  const dates = [];
  for (const metric of mapping.metrics ?? []) {
    const observation = policyObservation(
      providerData.raw?.get(metric.seriesId),
      event,
      mapping.lookaheadDays ?? 7,
      field
    );
    if (!observation) {
      const reason = providerData.failures?.has(metric.seriesId)
        ? "本次自动获取失败"
        : "免费数据源尚未提供会议时点数值";
      lines.push(`${metric.label}：${reason}`);
      continue;
    }
    lines.push(formatMetric(metric, { value: observation.value, asOf: observation.date }));
    dates.push(observation.date);
  }
  if (dates.length === 0) return valueRecord(fallbackStatus, lines.length > 0 ? lines : [fallbackLine], mapping);
  return valueRecord("available", lines, mapping, dates.sort().at(-1));
}

function unavailableEventValues(event, mapping, now, reason) {
  return {
    forecast: { status: "unavailable", lines: [mapping.forecastLine ?? DEFAULT_FORECAST_LINE] },
    actual: valueRecord(
      released(event, now) ? "unavailable" : "pending",
      [released(event, now) ? reason : DEFAULT_PENDING_LINE],
      mapping
    ),
    previous: valueRecord("unavailable", [reason], mapping)
  };
}

function narrativeEventValues() {
  const value = { status: "not-applicable", lines: ["不适用（此类事件不以单一数值衡量）"] };
  return { actual: value, forecast: value, previous: value };
}

export function buildMappedEventValues(project, mappingDocument, providerData, now = new Date()) {
  assert(mappingDocument.schemaVersion === 1, "value-series.json schemaVersion must be 1");
  assert(mappingDocument.types && typeof mappingDocument.types === "object", "value-series.json types must be an object");
  assert(!Number.isNaN(now.valueOf()), "Invalid updater timestamp");

  const events = {};
  for (const event of project.events) {
    const mapping = mappingDocument.types[event.type];
    if (!mapping) continue;
    assert(!mapping.sourceUrl || /^https:\/\//.test(mapping.sourceUrl), `${event.type}: sourceUrl must use https`);
    assert(Boolean(mapping.sourceName) === Boolean(mapping.sourceUrl),
      `${event.type}: sourceName and sourceUrl must be provided together`);
    const provider = mappingDocument.providers?.[mapping.provider];
    const providerKind = provider?.kind ?? mapping.provider;

    if (project.catalog?.types?.[event.type]?.valueMode === "narrative") {
      events[event.id] = narrativeEventValues();
      continue;
    }

    if (!["fred-csv", "bls-json", "dbnomics", "dbnomics-json", "chinamoney-lpr"].includes(providerKind)) {
      const reason = mapping.unavailableReason ?? `当前更新器暂不支持数据源：${providerKind ?? "未配置"}`;
      events[event.id] = unavailableEventValues(event, mapping, now, reason);
      continue;
    }

    assert(typeof mapping.idPattern === "string", `${event.type}: mapping is missing idPattern`);
    assert(["monthly", "quarterly"].includes(mapping.frequency), `${event.type}: invalid mapping frequency`);
    const targetPeriod = eventPeriodIndex(event, mapping);
    const actualStatus = released(event, now) ? "unavailable" : "pending";
    const actualLine = released(event, now) ? "官方数据源暂未提供该统计期数值" : DEFAULT_PENDING_LINE;
    const policyMode = mapping.observationMode === "policy-decision";
    events[event.id] = {
      forecast: { status: "unavailable", lines: [mapping.forecastLine ?? DEFAULT_FORECAST_LINE] },
      actual: policyMode
        ? policyValueRecord(mapping, event, providerData, "actual", actualStatus, actualLine)
        : metricValueRecord(mapping, targetPeriod, providerData, actualStatus, actualLine),
      previous: policyMode
        ? policyValueRecord(mapping, event, providerData, "previous", "unavailable", "官方数据源暂未提供可比前值")
        : metricValueRecord(mapping, targetPeriod - 1, providerData, "unavailable", "官方数据源暂未提供可比前值")
    };

    if (!released(event, now) && events[event.id].actual.status === "available") {
      events[event.id].actual = valueRecord("pending", [DEFAULT_PENDING_LINE], mapping);
    }
  }
  return events;
}

function earliestObservationDate(project, mappingDocument) {
  let earliest = null;
  let largestLookback = 1;
  for (const mapping of Object.values(mappingDocument.types ?? {})) {
    const provider = mappingDocument.providers?.[mapping.provider];
    if (!["fred-csv", "bls-json"].includes(provider?.kind ?? mapping.provider)) continue;
    for (const metric of mapping.metrics ?? []) {
      if (mapping.frequency) largestLookback = Math.max(largestLookback, comparisonPeriods(metric, mapping.frequency) + 1);
    }
  }
  for (const event of project.events) {
    const mapping = mappingDocument.types?.[event.type];
    const provider = mappingDocument.providers?.[mapping?.provider];
    if (!mapping || !["fred-csv", "bls-json"].includes(provider?.kind ?? mapping.provider)) continue;
    assert(["monthly", "quarterly"].includes(mapping.frequency), `${event.type}: invalid mapping frequency`);
    assert(typeof mapping.idPattern === "string", `${event.type}: mapping is missing idPattern`);
    const index = eventPeriodIndex(event, mapping) - largestLookback;
    const divisor = periodsPerYear(mapping.frequency);
    const year = Math.floor(index / divisor);
    const position = ((index % divisor) + divisor) % divisor;
    const month = mapping.frequency === "monthly" ? position + 1 : position * 3 + 1;
    const date = `${year}-${String(month).padStart(2, "0")}-01`;
    if (!earliest || date < earliest) earliest = date;
  }
  return earliest ?? "2000-01-01";
}

export async function fetchProviderData(project, mappingDocument, fetchImpl = globalThis.fetch) {
  assert(typeof fetchImpl === "function", "A fetch implementation is required");
  const fredProviders = Object.values(mappingDocument.providers ?? {}).filter((provider) => provider.kind === "fred-csv");
  const defaultFred = fredProviders[0];
  const series = new Map();
  for (const mapping of Object.values(mappingDocument.types ?? {})) {
    const provider = mappingDocument.providers?.[mapping.provider];
    const providerKind = provider?.kind ?? mapping.provider;
    if (!["fred-csv", "bls-json", "dbnomics", "dbnomics-json", "chinamoney-lpr"].includes(providerKind)) continue;
    for (const metric of mapping.metrics ?? []) {
      if (["fred-csv", "bls-json"].includes(providerKind)) {
        assert(/^[A-Za-z0-9_-]+$/.test(metric.seriesId ?? ""), `${mapping.provider}: invalid ${providerKind} seriesId`);
      } else if (["dbnomics", "dbnomics-json"].includes(providerKind)) {
        assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(metric.seriesId ?? ""),
          `${mapping.provider}: DBnomics seriesId must be provider/dataset/series`);
      } else {
        assert(["1Y", "5Y"].includes(metric.seriesId), `${mapping.provider}: ChinaMoney LPR seriesId must be 1Y or 5Y`);
      }
      series.set(metric.seriesId, { provider: provider ?? defaultFred, providerKind, mapping });
    }
  }

  const startDate = earliestObservationDate(project, mappingDocument);
  const sharedResponses = new Map();
  const entries = [];
  const rawEntries = [];
  const failures = new Map();
  for (const [seriesId, descriptor] of series) {
    try {
      const { provider, providerKind, mapping } = descriptor;
      assert(/^https:\/\//.test(provider?.baseUrl ?? ""), `${seriesId}: provider baseUrl must use https`);
      let url;
      let accept;
      if (providerKind === "fred-csv") {
        url = new URL(provider.baseUrl);
        url.searchParams.set("id", seriesId);
        url.searchParams.set("cosd", startDate);
        accept = "text/csv";
      } else if (providerKind === "bls-json") {
        url = new URL(provider.baseUrl);
        accept = "application/json";
      } else if (["dbnomics", "dbnomics-json"].includes(providerKind)) {
        const baseUrl = provider.baseUrl.endsWith("/") ? provider.baseUrl : `${provider.baseUrl}/`;
        url = new URL(seriesId, baseUrl);
        url.searchParams.set("observations", "1");
        accept = "application/json";
      } else {
        url = new URL(provider.baseUrl);
        accept = "application/json";
      }
      const cacheKey = providerKind === "chinamoney-lpr" ? `${providerKind}:${url}` : `${providerKind}:${seriesId}`;
      const blsSeriesIds = providerKind === "bls-json"
        ? [...series].filter(([, candidate]) =>
          candidate.providerKind === "bls-json" && candidate.provider?.baseUrl === provider.baseUrl).map(([id]) => id)
        : [];
      const currentYear = new Date().getUTCFullYear();
      const requestBody = providerKind === "bls-json"
        ? JSON.stringify({
          seriesid: blsSeriesIds,
          startyear: String(Math.max(Number(startDate.slice(0, 4)), currentYear - 9)),
          endyear: String(currentYear)
        })
        : undefined;
      const effectiveCacheKey = providerKind === "bls-json" ? `${providerKind}:${url}:${requestBody}` : cacheKey;
      if (!sharedResponses.has(effectiveCacheKey)) {
        sharedResponses.set(effectiveCacheKey, (async () => {
          const response = await fetchImpl(url, {
            method: ["bls-json", "chinamoney-lpr"].includes(providerKind) ? "POST" : "GET",
            headers: {
              accept,
              ...(providerKind === "bls-json" ? { "content-type": "application/json" } : {})
            },
            body: requestBody,
            signal: AbortSignal.timeout(30_000)
          });
          assert(response.ok, `${seriesId}: ${providerKind} request failed with HTTP ${response.status}`);
          return response.text();
        })());
      }
      const responseText = await sharedResponses.get(effectiveCacheKey);
      let observations;
      if (providerKind === "fred-csv") observations = parseFredCsv(responseText, seriesId);
      else if (providerKind === "bls-json") observations = parseBlsJson(responseText, seriesId);
      else if (["dbnomics", "dbnomics-json"].includes(providerKind)) observations = parseDbnomicsJson(responseText, seriesId);
      else observations = parseChinaMoneyLprJson(responseText, seriesId);
      assert(observations.length > 0, `${seriesId}: source returned no usable observations`);
      rawEntries.push([seriesId, observations]);
      entries.push([seriesId, observationsByPeriod(observations, mapping.frequency)]);
    } catch (error) {
      failures.set(seriesId, error?.message ?? String(error));
    }
  }

  assert(entries.length > 0 || series.size === 0,
    `All configured value sources failed: ${[...failures.values()].join("; ")}`);
  const result = new Map(entries);
  Object.defineProperties(result, {
    raw: { value: new Map(rawEntries), enumerable: false },
    failures: { value: failures, enumerable: false }
  });
  return result;
}

export const fetchFredProviderData = fetchProviderData;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readExistingValues(outputPath) {
  try {
    const current = await readJson(outputPath);
    assert(current.schemaVersion === 1, "values.json schemaVersion must be 1");
    assert(Number.isInteger(current.revision) && current.revision > 0 && current.revision <= MAX_REVISION, "values.json revision is invalid");
    assert(current.events && typeof current.events === "object", "values.json events must be an object");
    return current;
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: 1, revision: 0, updatedAt: null, events: {} };
    throw error;
  }
}

async function atomicWriteJson(outputPath, value) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, outputPath);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export async function updateValues({
  project,
  mappingDocument,
  outputPath,
  fetchImpl = globalThis.fetch,
  now = new Date()
}) {
  const current = await readExistingValues(outputPath);
  const providerData = await fetchProviderData(project, mappingDocument, fetchImpl);
  const managed = buildMappedEventValues(project, mappingDocument, providerData, now);
  const projectEvents = new Map(project.events.map((event) => [event.id, event]));
  for (const [eventId, nextValues] of Object.entries(managed)) {
    const oldValues = current.events[eventId];
    if (!oldValues) continue;
    const mapping = mappingDocument.types[projectEvents.get(eventId)?.type];
    const sourceFailed = mapping?.metrics?.some((metric) => providerData.failures?.has(metric.seriesId));
    for (const field of ["actual", "previous"]) {
      const freezeActual = field === "actual"
        && mapping?.freezeReleasedActual
        && released(projectEvents.get(eventId), now)
        && Number.isInteger(oldValues.revision);
      if (oldValues[field]?.status === "available"
        && (sourceFailed || freezeActual || nextValues[field]?.status !== "available")) {
        nextValues[field] = oldValues[field];
      }
    }
  }
  const validEventIds = new Set(project.events.map((event) => event.id));
  const semanticFields = (entry) => Object.fromEntries(
    ["actual", "forecast", "previous"].filter((field) => entry?.[field] !== undefined).map((field) => [field, entry[field]])
  );
  const nextEntries = {};
  for (const eventId of [...validEventIds].sort()) {
    const oldEntry = current.events[eventId];
    const nextSemantic = managed[eventId] ?? semanticFields(oldEntry);
    if (!nextSemantic || Object.keys(nextSemantic).length === 0) continue;
    const unchanged = oldEntry && stableJson(nextSemantic) === stableJson(semanticFields(oldEntry));
    if (unchanged && Number.isInteger(oldEntry.revision) && oldEntry.updatedAt) {
      nextEntries[eventId] = oldEntry;
      continue;
    }
    const oldRevision = Number.isInteger(oldEntry?.revision) ? oldEntry.revision : 0;
    assert(oldRevision < MAX_REVISION, `${eventId}: values revision has reached the 32-bit maximum`);
    nextEntries[eventId] = {
      revision: oldRevision + 1,
      updatedAt: now.toISOString(),
      ...nextSemantic
    };
  }
  const events = nextEntries;

  if (stableJson(events) === stableJson(current.events)) return { changed: false, document: current };
  assert(current.revision < MAX_REVISION, "values.json revision has reached the 32-bit maximum");
  const document = {
    schemaVersion: 1,
    revision: current.revision + 1,
    updatedAt: now.toISOString(),
    events
  };
  await atomicWriteJson(outputPath, document);
  return { changed: true, document };
}

function parseArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--mapping") options.mappingPath = argumentsList[++index];
    else if (argument === "--output") options.outputPath = argumentsList[++index];
    else if (argument === "--now") options.now = new Date(argumentsList[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

export async function main(argumentsList = process.argv.slice(2)) {
  const options = parseArguments(argumentsList);
  const mappingPath = path.resolve(options.mappingPath ?? path.join(repoRoot, "data", "value-series.json"));
  const outputPath = path.resolve(options.outputPath ?? path.join(repoRoot, "data", "values.json"));
  const mappingDocument = await readJson(mappingPath);
  const result = await updateValues({
    project: await loadProject({ includeValues: false }),
    mappingDocument,
    outputPath,
    now: options.now ?? new Date()
  });
  console.log(result.changed
    ? `Updated ${path.relative(repoRoot, outputPath)} to revision ${result.document.revision}.`
    : `${path.relative(repoRoot, outputPath)} is already current.`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
