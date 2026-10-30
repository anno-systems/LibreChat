import { memo, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { atom, useAtom } from 'jotai';
import type { TModelMigrationNotice } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/** Notices shown in this session, so a cached copy is not shown twice. */
const seenNoticesAtom = atom<ReadonlySet<string>>(new Set<string>());

/** The key under which a migration counts as seen, wherever it was shown. */
export const migrationKey = (notice: TModelMigrationNotice) => `migration:${notice.id}`;

/**
 * Shows a model migration notice once: the first time it arrives it is kept on screen until
 * dismissed or the view changes, and `markSeen` tells the server, which then stops sending it.
 * `scope` names where it was shown; the migration itself counts as seen in this session too.
 */
export function useOneTimeNotice(
  scope: string | ((notice: TModelMigrationNotice) => string),
  notice: TModelMigrationNotice | null | undefined,
  markSeen: (notice: TModelMigrationNotice) => void,
): [TModelMigrationNotice | null, () => void] {
  const [seen, setSeen] = useAtom(seenNoticesAtom);
  const [shown, setShown] = useState<TModelMigrationNotice | null>(null);
  const markSeenRef = useRef(markSeen);
  markSeenRef.current = markSeen;

  useEffect(() => {
    if (!notice || shown) return;
    const key = typeof scope === 'function' ? scope(notice) : `${scope}:${notice.id}`;
    if (seen.has(key)) return;
    setShown(notice);
    setSeen((previous) => new Set(previous).add(key).add(migrationKey(notice)));
    markSeenRef.current(notice);
  }, [scope, notice, shown, seen, setSeen]);

  return [shown, () => setShown(null)];
}

function Notice({
  notice,
  onDismiss,
  className,
}: {
  notice: TModelMigrationNotice;
  onDismiss: () => void;
  className?: string;
}) {
  const localize = useLocalize();
  return (
    <div
      role="status"
      className={cn(
        'border-border-light bg-surface-secondary text-text-secondary flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
        className,
      )}
    >
      <span className="min-w-0 flex-1">
        {localize('com_ui_model_migrated', {
          to: notice.to.label ?? notice.to.model,
          from: notice.from.label ?? notice.from.model,
        })}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={localize('com_ui_dismiss')}
        className="text-text-secondary hover:text-text-primary focus-visible:ring-ring-primary rounded p-0.5 focus-visible:ring-2 focus-visible:outline-none"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export default memo(Notice);
