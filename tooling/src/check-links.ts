import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadJsonl } from "./lib/load.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(__dirname, "../../data");

interface Species {
  id: string;
  wikipedia?: string;
}

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
  const species = loadJsonl<Species>(resolve(dataDir, "species.jsonl")).map(
    (r) => r.record
  );

  const withWikipedia = species.filter((sp) => sp.wikipedia != null);

  if (withWikipedia.length === 0) {
    console.log("No species with wikipedia fields to check.");
    return;
  }

  console.log(`Checking ${withWikipedia.length} Wikipedia link(s)...`);

  const queue = [...withWikipedia];
  const active: Promise<void>[] = [];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const sp = queue.shift()!;
      await checkSlug(sp.id, sp.wikipedia!);
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
