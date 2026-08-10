import { loadProject, writeAllCalendars } from "./calendar-lib.mjs";

const project = await loadProject();
const manifest = await writeAllCalendars(project);
console.log(`Built ${manifest.feeds.length} feeds with ${manifest.totalEventCount} events.`);
