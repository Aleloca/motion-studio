/**
 * Temp files the core itself created in this process (a render's `.<name>.render-<hex>.tmp`, an atomic JSON write's
 * `<name>.<hex>.tmp`), by absolute path: the turn's check of earlier output folders (carry-over.ts `withoutCoreWrites`)
 * hides exactly these, never a temp-looking name someone else wrote. Bounded; in memory (the check runs in this process).
 */
const temps = new Set<string>();
const MAX = 5000;

export function noteCoreTemp(path: string): void {
  temps.delete(path);
  temps.add(path);
  while (temps.size > MAX) temps.delete(temps.values().next().value!);
}

export function isCoreTemp(path: string): boolean {
  return temps.has(path);
}
