import type { BuildInfo } from './build';

/** What `/api/config` tells clients about the build (fork: About page). */
export interface AboutInfo {
  version: string;
}

/**
 * The deployment's own version for the About page (fork-only), in place of upstream's commit,
 * branch and build date, which name the upstream build to every visitor: `BUILD_VERSION` when set,
 * else the build's UTC date with the image tag of its commit (`YYYY-MM-DD (sha-1a2b3c4)`, the
 * `sha-<short>` tag the fork image workflow pushes), or the date alone when the commit is unknown.
 * Without a version or a build date there is nothing to show and the payload is left out, as
 * upstream does without build metadata.
 */
export function resolveAboutInfo(
  info: Pick<BuildInfo, 'buildDate' | 'commitShort'>,
  buildVersion: string | undefined = process.env.BUILD_VERSION,
): AboutInfo | undefined {
  const explicit = buildVersion?.trim();
  if (explicit) {
    return { version: explicit };
  }
  const date = info.buildDate ? new Date(info.buildDate) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return undefined;
  }
  const day = date.toISOString().slice(0, 10);
  return { version: info.commitShort ? `${day} (sha-${info.commitShort})` : day };
}
