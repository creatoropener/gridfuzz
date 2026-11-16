import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleHelp, X, XCircle } from 'lucide-react';
import type { RuleStatus } from '../types/testing';
import { useApp } from '../state/AppContext';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** A square with a dashed seam: the stitch that holds the product's metaphor together. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" fill="var(--accent)" />
      <path d="M6.5 17.5 17.5 6.5" stroke="var(--accent-ink)" strokeWidth="2.2" strokeDasharray="2.4 2.8" strokeLinecap="round" />
    </svg>
  );
}

const STATUS_LABEL: Record<RuleStatus, string> = {
  passed: 'No violation found',
  failed: 'Violation found',
  inconclusive: 'Inconclusive',
};

export function StatusBadge({ status, stale }: { status: RuleStatus; stale?: boolean }) {
  const Icon = status === 'passed' ? CheckCircle2 : status === 'failed' ? XCircle : CircleHelp;
  const tone = status === 'passed' ? 'pass' : status === 'failed' ? 'fail' : 'warn';
  return (
    <span className={cx('badge', `badge--${tone}`)}>
      <Icon size={12} aria-hidden="true" />
      {STATUS_LABEL[status]}
      {stale ? ' (outdated)' : ''}
    </span>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__title">{title}</div>
      {children ? <div>{children}</div> : null}
      {action}
    </div>
  );
}

export function Callout({ tone, title, children }: { tone: 'fail' | 'warn' | 'info' | 'pass'; title?: string; children?: ReactNode }) {
  const Icon = tone === 'pass' ? CheckCircle2 : tone === 'fail' ? XCircle : tone === 'warn' ? AlertTriangle : CircleHelp;
  return (
    <div className={cx('callout', `callout--${tone}`)} role={tone === 'fail' ? 'alert' : undefined}>
      <Icon size={16} aria-hidden="true" />
      <div>
        {title ? <div className="callout__title">{title}</div> : null}
        {children}
      </div>
    </div>
  );
}

/** A button that opens a small panel of actions. Closes on outside click and Escape. */
export function Menu({ label, icon, children }: { label: string; icon: ReactNode; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu" ref={root}>
      <button type="button" className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {icon}
        <span className="btn__label">{label}</span>
      </button>
      {open ? (
        <div className="menu__panel" role="menu">
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', t.tone === 'fail' && 'toast--fail', t.tone === 'pass' && 'toast--pass')} role={t.tone === 'fail' ? 'alert' : 'status'}>
          <div style={{ flex: 1 }}>{t.text}</div>
          <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label="Dismiss message" onClick={() => dismissToast(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
