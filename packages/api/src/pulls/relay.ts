import { PULL_REQUEST_OAUTH_CALLBACK_PATH } from './oauth';
import { getOAuthCallbackUrl } from '~/oauth/url';

/**
 * One callback URL for every tenant host. The provider is registered with the deployment's
 * callback (`DOMAIN_SERVER`), but a user signed in on a tenant's own host (`TENANT_DOMAIN_SERVER`
 * or a custom domain) holds the flow's CSRF cookie and session there. The flow therefore signs the
 * public server URL it started on into its `state`, and a callback that arrives elsewhere sends
 * the browser on to that URL's callback with the same query. The target comes only from a state
 * this server signed, so the relay cannot be pointed at another host.
 */

/** `url` without a trailing slash, query or fragment; undefined unless it is an http(s) URL. */
export function serverUrlOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    if (parsed.username || parsed.password) return undefined;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

/** The server URL a flow must return to, when it is not the one the provider calls back. */
export function flowServerUrl(
  serverDomain: string | undefined,
  callbackUrl: string,
): string | undefined {
  const server = serverUrlOf(serverDomain);
  if (server == null) return undefined;
  const callback = getOAuthCallbackUrl(server, PULL_REQUEST_OAUTH_CALLBACK_PATH);
  return callback === callbackUrl ? undefined : server;
}

/** Where to send a callback that arrived on `serverDomain` for a flow started on `flowServer`. */
export function relayTarget(
  flowServer: string | undefined,
  serverDomain: string | undefined,
  originalUrl: string,
): string | undefined {
  if (flowServer == null || serverUrlOf(serverDomain) === flowServer) return undefined;
  const query = originalUrl.includes('?') ? originalUrl.slice(originalUrl.indexOf('?')) : '';
  return `${getOAuthCallbackUrl(flowServer, PULL_REQUEST_OAUTH_CALLBACK_PATH)}${query}`;
}
