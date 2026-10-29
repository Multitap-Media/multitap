import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../src/http/app.ts';
import { bearer, testApp } from './helpers.ts';

describe('OpenAPI document', () => {
  it('is generated without a server or database', () => {
    const doc = openApiDocument();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBeTruthy();
    expect(doc.components?.securitySchemes?.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    expect(doc.components?.schemas).toHaveProperty('Problem');
    expect(doc.components?.schemas).toHaveProperty('ApiKey');
    expect(doc.components?.schemas).toHaveProperty('CreatedApiKey');
  });

  it('declares the admin routes with their auth responses and security', () => {
    const paths = openApiDocument().paths ?? {};
    const operations = [
      paths['/v1/admin/api-keys']?.get,
      paths['/v1/admin/api-keys']?.post,
      paths['/v1/admin/api-keys/{id}']?.delete,
    ];
    for (const op of operations) {
      expect(op).toBeDefined();
      expect(op?.security).toEqual([{ bearerAuth: [] }]);
      expect(Object.keys(op?.responses ?? {})).toEqual(expect.arrayContaining(['403', '404']));
      expect(op?.responses?.['404']).toMatchObject({
        content: {
          'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
        },
      });
    }
    expect(Object.keys(paths['/v1/admin/api-keys']?.post?.responses ?? {})).toEqual(
      expect.arrayContaining(['201', '400']),
    );
    expect(paths['/healthz']?.get?.security).toBeUndefined();
    expect(paths['/openapi.json']?.get).toBeDefined();
  });

  it('is what /openapi.json serves', async () => {
    const { app, keyFor } = await testApp();
    const res = await app.request('/openapi.json', { headers: bearer(await keyFor('client')) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(openApiDocument())));
  });
});
