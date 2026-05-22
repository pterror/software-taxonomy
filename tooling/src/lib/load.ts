import { readFileSync } from "fs";

export interface LoadedRecord<T = unknown> {
  record: T;
  line: number;
  file: string;
}

export function loadJsonl<T = unknown>(filePath: string): LoadedRecord<T>[] {
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read ${filePath}: ${msg}`);
  }

  const results: LoadedRecord<T>[] = [];
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === "") continue;

    let record: T;
    try {
      record = JSON.parse(raw) as T;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`${filePath}:${i + 1}: JSON parse error: ${msg}`);
    }

    results.push({ record, line: i + 1, file: filePath });
  }

  return results;
}
