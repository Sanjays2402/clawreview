import { minimatch } from './minimatch.js';

export function filterIgnored<T extends { path: string }>(items: T[], patterns: string[]): T[] {
  if (patterns.length === 0) return items;
  return items.filter((item) => !patterns.some((p) => minimatch(item.path, p)));
}
