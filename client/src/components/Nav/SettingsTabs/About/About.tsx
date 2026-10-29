import { memo } from 'react';
import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';

const UNKNOWN_PLACEHOLDER = '—';

/** The static page that lists the open-source licenses (served by the platform's proxy). */
export const LICENSES_PATH = '/hilfe/lizenzen/';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 first:pt-0 last:pb-0">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="text-text-primary text-end break-all">{value}</dd>
    </div>
  );
}

/**
 * The deployment's About page (fork-only): its name, its own version and the license line. The
 * upstream version, commit, branch and user agent are not shown, and the server no longer sends
 * them.
 */
function About() {
  const localize = useLocalize();
  const { data: startupConfig } = useGetStartupConfig();

  const name = startupConfig?.appTitle?.trim() || UNKNOWN_PLACEHOLDER;
  const version = startupConfig?.buildInfo?.version?.trim() || UNKNOWN_PLACEHOLDER;
  const year = new Date().getFullYear();

  return (
    <div className="text-text-primary flex flex-col text-sm">
      <dl className="divide-border-light flex flex-col divide-y">
        <Row label={localize('com_nav_about_name')} value={name} />
        <Row label={localize('com_nav_about_version')} value={version} />
      </dl>

      <p className="border-border-light text-text-secondary mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-4 text-xs">
        <span>{localize('com_nav_about_copyright', { 0: String(year) })}</span>
        <a
          href={LICENSES_PATH}
          target="_blank"
          rel="noreferrer"
          className="text-text-primary underline underline-offset-2"
        >
          {localize('com_nav_about_licenses')}
        </a>
      </p>
    </div>
  );
}

export default memo(About);
