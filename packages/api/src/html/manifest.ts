import fs from 'fs';
import type { RequestHandler } from 'express';

/**
 * Names the deployment in the web app manifest (fork-only), which the browser reads when a user
 * installs the app or adds it to the home screen. Without a title the manifest stays upstream's;
 * a manifest that is not a JSON object is left as built.
 */
export function brandManifest(manifest: string, title?: string | null): string {
  const name = title?.trim();
  if (!name) {
    return manifest;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest);
  } catch {
    return manifest;
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return manifest;
  }
  return JSON.stringify({ ...parsed, name, short_name: name });
}

/**
 * Serves `/manifest.webmanifest` from the client build with the deployment's name, ahead of the
 * static files. The file is read once; without a title or a built manifest the request falls
 * through to the static files unchanged.
 */
export function createManifestHandler(manifestPath: string, title?: string | null): RequestHandler {
  let body: string | undefined;
  if (title?.trim()) {
    try {
      body = brandManifest(fs.readFileSync(manifestPath, 'utf8'), title);
    } catch {
      body = undefined;
    }
  }
  return (_req, res, next) => {
    if (body == null) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.type('application/manifest+json').send(body);
  };
}
