import fs from "fs";
import path from "path";

export async function walkFiles(dir: string) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkFiles(entryPath)));
    } else if (entry.isFile()) {
      results.push(entryPath);
    }
  }
  return results;
}

export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
) {
  const queue = items.slice();
  const running: Promise<void>[] = [];

  while (queue.length || running.length) {
    while (queue.length && running.length < limit) {
      const item = queue.shift() as T;
      const task = worker(item).finally(() => {
        const idx = running.indexOf(task);
        if (idx >= 0) running.splice(idx, 1);
      });
      running.push(task);
    }
    if (running.length) {
      await Promise.race(running);
    }
  }
}

export function parseIndexList(value: string, max: number) {
  const tokens = value.split(",").map((token) => token.trim()).filter(Boolean);
  const result = new Set<number>();

  for (const token of tokens) {
    if (token.includes("-")) {
      const [startRaw, endRaw] = token.split("-").map((part) => part.trim());
      const start = Number.parseInt(startRaw, 10);
      const end = Number.parseInt(endRaw, 10);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const from = Math.min(start, end);
      const to = Math.max(start, end);
      for (let i = from; i <= to; i += 1) {
        if (i >= 1 && i <= max) result.add(i - 1);
      }
      continue;
    }

    const index = Number.parseInt(token, 10);
    if (Number.isFinite(index) && index >= 1 && index <= max) {
      result.add(index - 1);
    }
  }

  return Array.from(result).sort((a, b) => a - b);
}
