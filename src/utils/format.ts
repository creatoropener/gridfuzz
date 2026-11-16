import type { ScalarJson } from '../types/testing';

const NUMBER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
const INTEGER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Formats a number deterministically (en-US) so reports and tests do not depend on the browser locale. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  // Intl prints negative zero (and tiny negatives that round to zero) as "-0".
  const text = NUMBER_FORMAT.format(value);
  return text === '-0' ? '0' : text;
}

export function formatInteger(value: number): string {
  return INTEGER_FORMAT.format(value);
}

export function formatSigned(value: number): string {
  if (value === 0) return '0';
  const body = formatNumber(Math.abs(value));
  return value > 0 ? `+${body}` : `−${body}`;
}

export function formatPercent(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatScalar(value: ScalarJson): string {
  if (value === null) return '(empty)';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return value;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatInteger(count)} ${count === 1 ? singular : plural}`;
}
