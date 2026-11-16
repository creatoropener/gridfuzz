/**
 * Thin wrapper over localStorage. Storage can be missing or throw (private windows, blocked site
 * data), so every call is guarded and the app always works without it.
 * Only metadata and rules are stored. Workbook contents are never written to storage.
 */
const PREFIX = 'gridfuzz.';

export function readJson<T>(key: string, fallback: T, validate?: (value: unknown) => value is T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (validate && !validate(parsed)) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    /* storage unavailable: nothing to remove */
  }
}

/** Removes every key that starts with the given prefix (after the app prefix). Used by "Clear local data". */
export function removeByPrefix(prefix: string): void {
  try {
    const full = PREFIX + prefix;
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(full)) doomed.push(key);
    }
    for (const key of doomed) window.localStorage.removeItem(key);
  } catch {
    /* storage unavailable: nothing to remove */
  }
}
