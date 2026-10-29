import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import type { AppConfig } from '@librechat/data-schemas';
import { buildAgentsOpenApiDocument } from './document';
import { createOpenApiRouter } from './router';

describe('Agents API document naming', () => {
  it('titles the document without naming upstream', () => {
    const { info } = buildAgentsOpenApiDocument() as { info: Record<string, string> };
    expect(info.title).toBe('Agents API');
    expect(info.description).toContain('of the Agents API');
    expect(JSON.stringify(info)).not.toContain('LibreChat');
  });

  it('keeps the generated document in step with the builder', () => {
    const generated = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../openapi/agents.openapi.json'), 'utf8'),
    ) as { info: Record<string, string> };
    expect(generated.info).toEqual(
      (buildAgentsOpenApiDocument() as { info: Record<string, string> }).info,
    );
  });

  it('titles the docs page "Agents API"', async () => {
    const app = express();
    app.use(
      '/api',
      createOpenApiRouter({
        getAppConfig: async () => ({ config: { openapi: { enabled: true } } }) as AppConfig,
        swaggerAssetsPath: __dirname,
      }),
    );
    const response = await request(app).get('/api/docs');
    expect(response.status).toBe(200);
    expect(response.text).toContain('<title>Agents API</title>');
    expect(response.text).not.toContain('LibreChat');
  });
});
