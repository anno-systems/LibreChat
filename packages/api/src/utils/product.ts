/** Upstream's name, used when the deployment sets no `APP_TITLE`. */
export const DEFAULT_PRODUCT_NAME = 'LibreChat';

type ProductEnv = Partial<Record<string, string | undefined>>;

/**
 * The deployment's product name (fork-only): `APP_TITLE` trimmed, else "LibreChat". Messages a
 * user, a model or a third party sees name the product with it instead of upstream.
 */
export function getProductName(env: ProductEnv = process.env): string {
  return env.APP_TITLE?.trim() || DEFAULT_PRODUCT_NAME;
}

/** Characters RFC 9110 allows in a token, such as a User-Agent product. */
const NON_TOKEN_CHARACTERS = /[^A-Za-z0-9!#$%&'*+\-.^_`|~]/g;

/** The product name as an HTTP token: "Office Chat" becomes "OfficeChat". */
export function getProductToken(name: string): string {
  return name.replace(NON_TOKEN_CHARACTERS, '') || DEFAULT_PRODUCT_NAME;
}

/** Upstream's site, sent as the referer when the deployment sets no `DOMAIN_CLIENT`. */
export const DEFAULT_PRODUCT_URL = 'https://librechat.ai';

/** The deployment's public URL for third parties that credit the calling app (OpenRouter). */
export function getProductUrl(env: ProductEnv = process.env): string {
  return env.DOMAIN_CLIENT?.trim() || DEFAULT_PRODUCT_URL;
}

/** A User-Agent product for one of the deployment's integrations: "OfficeChat-Pull-Requests". */
export function getProductUserAgent(name: string, purpose: string): string {
  return `${getProductToken(name)}-${purpose}`;
}
