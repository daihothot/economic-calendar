import { loadProject } from "./calendar-lib.mjs";

const project = await loadProject();
const now = process.env.CHECK_DATE ? new Date(`${process.env.CHECK_DATE}T00:00:00Z`) : new Date();
const currentYear = now.getUTCFullYear();
const nextYear = currentYear + 1;
const nextYearStart = new Date(Date.UTC(nextYear, 0, 1));
const daysUntilNextYear = Math.ceil((nextYearStart - now) / 86_400_000);
const availableYears = new Set(project.datasets.map((dataset) => dataset.year));
const currentYearDataset = project.datasets.find((dataset) => dataset.year === currentYear);
const nextYearDataset = project.datasets.find((dataset) => dataset.year === nextYear);

if (currentYearDataset && currentYearDataset.coverageStatus !== "complete") {
  throw new Error(`data/events-${currentYear}.json is still marked ${currentYearDataset.coverageStatus}.`);
}

if (daysUntilNextYear <= 120 && nextYearDataset?.coverageStatus !== "complete") {
  const state = nextYearDataset ? `is marked ${nextYearDataset.coverageStatus}` : "is missing";
  throw new Error(`Only ${daysUntilNextYear} days remain before ${nextYear}, but data/events-${nextYear}.json ${state}.`);
}

console.log(`Coverage check passed. Available years: ${[...availableYears].sort().join(", ")}.`);
