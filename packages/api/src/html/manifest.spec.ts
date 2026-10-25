import os from 'os';
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { brandManifest, createManifestHandler } from './manifest';

const MANIFEST = JSON.stringify({
  name: 'LibreChat',
  short_name: 'LibreChat',
  display: 'standalone',
  icons: [{ src: 'assets/icon-192x192.png', sizes: '192x192', type: 'image/png' }],
});

describe('brandManifest', () => {
  it('leaves the manifest as built without a title', () => {
    expect(brandManifest(MANIFEST)).toBe(MANIFEST);
    expect(brandManifest(MANIFEST, null)).toBe(MANIFEST);
    expect(brandManifest(MANIFEST, '  ')).toBe(MANIFEST);
  });

  it('names the deployment and keeps every other field', () => {
    const branded = JSON.parse(brandManifest(MANIFEST, ' OfficeChat '));

    expect(branded).toEqual({
      ...JSON.parse(MANIFEST),
      name: 'OfficeChat',
      short_name: 'OfficeChat',
    });
  });

  it('leaves a manifest that is not a JSON object alone', () => {
    expect(brandManifest('not json', 'OfficeChat')).toBe('not json');
    expect(brandManifest('[1]', 'OfficeChat')).toBe('[1]');
    expect(brandManifest('null', 'OfficeChat')).toBe('null');
  });
});

describe('createManifestHandler', () => {
  let dir: string;
  let manifestPath: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
    manifestPath = path.join(dir, 'manifest.webmanifest');
    fs.writeFileSync(manifestPath, MANIFEST);
  });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const appWith = (handler: express.RequestHandler) => {
    const app = express();
    app.get('/manifest.webmanifest', handler);
    app.use((_req, res) => {
      res.status(404).send('static');
    });
    return app;
  };

  it('serves the built manifest with the deployment name, uncached', async () => {
    const res = await request(appWith(createManifestHandler(manifestPath, 'OfficeChat'))).get(
      '/manifest.webmanifest',
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/manifest\+json/);
    expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');
    expect(JSON.parse(res.text)).toMatchObject({ name: 'OfficeChat', display: 'standalone' });
  });

  it('falls through to the static files without a title or a built manifest', async () => {
    const untitled = await request(appWith(createManifestHandler(manifestPath))).get(
      '/manifest.webmanifest',
    );
    const missing = await request(
      appWith(createManifestHandler(path.join(dir, 'missing.webmanifest'), 'OfficeChat')),
    ).get('/manifest.webmanifest');

    expect(untitled.text).toBe('static');
    expect(missing.text).toBe('static');
  });
});
