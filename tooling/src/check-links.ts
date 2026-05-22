import { loadEntities } from "./lib/load.ts";

const CONCURRENCY = 4;
const DELAY_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkSlug(id: string, slug: string): Promise<void> {
  const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(slug)}`;
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (res.status === 404) {
      console.error(`404  ${id}  ${url}`);
    } else if (res.status !== 200) {
      console.warn(`${res.status}  ${id}  ${url}`);
    } else {
      console.log(`200  ${id}  ${url}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERR  ${id}  ${url}  ${msg}`);
  }
}

async function run(): Promise<void> {
  const entityRecords = loadEntities();

  // Collect entities that have a wikipedia statement
  const withWikipedia: Array<{ id: string; slug: string }> = [];
  for (const { record } of entityRecords) {
    const wpEntries = record.statements["wikipedia"] ?? [];
    for (const entry of wpEntries) {
      if (typeof entry.value === "string") {
        withWikipedia.push({ id: record.id, slug: entry.value });
      }
    }
  }

  if (withWikipedia.length === 0) {
    console.log("No entities with wikipedia statements to check.");
    return;
  }

  console.log(`Checking ${withWikipedia.length} Wikipedia link(s)...`);

  const queue = [...withWikipedia];
  const active: Promise<void>[] = [];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await checkSlug(item.id, item.slug);
      if (queue.length > 0) await sleep(DELAY_MS);
    }
  }

  for (let i = 0; i < CONCURRENCY; i++) {
    active.push(worker());
  }

  await Promise.all(active);
  console.log("Done.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
