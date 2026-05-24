// check-links2.ts — same CLI surface as check-links.ts, backed by the data2 store.
// Checks all source/url values via HEAD requests (concurrently, rate-limited).
//
// Unlike check-links.ts (which checked wikipedia slugs), this checks the full URL
// stored in each source record. Wikipedia links are also covered since sources
// store the canonical URL.

import { loadData2 } from "./lib/load2.js";
import { q } from "./lib/store.js";

const CONCURRENCY = 4;
const DELAY_MS    = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function checkUrl(sourceId: string, url: string): Promise<void> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    if (res.status === 404) {
      console.error(`404  ${sourceId}  ${url}`);
    } else if (res.status !== 200) {
      console.warn(`${res.status}  ${sourceId}  ${url}`);
    } else {
      console.log(`200  ${sourceId}  ${url}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERR  ${sourceId}  ${url}  ${msg}`);
  }
}

async function run(): Promise<void> {
  const db = loadData2();

  const rows = q(
    { q: [{ where: [["?e", "source/id", "?id"], ["?e", "source/url", "?url"]] }],
      select: ["id", "url"] },
    db,
  );

  const sources: Array<{ id: string; url: string }> = [];
  for (const row of rows) {
    sources.push({ id: row["id"] as string, url: row["url"] as string });
  }

  if (sources.length === 0) {
    console.log("No sources with URLs to check.");
    return;
  }

  console.log(`Checking ${sources.length} source URL(s)...`);

  const queue = [...sources];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift()!;
      await checkUrl(item.id, item.url);
      if (queue.length > 0) await sleep(DELAY_MS);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
  console.log("Done.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
