import { FileContext, FileSources } from 'librechat-data-provider';
import type { MCPFileOutputRecord, SaveMCPFileOutputDeps } from './files';
import type * as t from './types';
import {
  saveMCPFileOutput,
  getMCPOutputFilename,
  readMCPFileOutput,
  resolveMCPFileOutputs,
  extractMCPFileOutputs,
  isAllowedMCPFileMimeType,
  MCP_FILE_OUTPUTS_ARTIFACT_KEY,
  DEFAULT_MCP_FILE_OUTPUT_MAX_BYTES,
  DEFAULT_MCP_FILE_OUTPUT_MIME_TYPES,
} from './files';
import { formatToolContent } from './parsers';

const PDF = Buffer.from('%PDF-1.7\n\0binary invoice body\n%%EOF');
const PDF_BASE64 = PDF.toString('base64');

const pdfResource = (uri = 'invoice://RE-2026-001.pdf', blob = PDF_BASE64): t.ToolContentPart => ({
  type: 'resource',
  resource: { uri, mimeType: 'application/pdf', blob },
});

const policy = resolveMCPFileOutputs({ fileOutputs: true })!;

describe('resolveMCPFileOutputs', () => {
  it('is off unless the server opts in', () => {
    expect(resolveMCPFileOutputs(undefined)).toBeUndefined();
    expect(resolveMCPFileOutputs({})).toBeUndefined();
    expect(resolveMCPFileOutputs({ fileOutputs: false })).toBeUndefined();
  });

  it('uses the defaults for true and fills what an object leaves out', () => {
    expect(resolveMCPFileOutputs({ fileOutputs: true })).toEqual({
      mimeTypes: DEFAULT_MCP_FILE_OUTPUT_MIME_TYPES,
      maxBytes: DEFAULT_MCP_FILE_OUTPUT_MAX_BYTES,
    });
    expect(resolveMCPFileOutputs({ fileOutputs: { maxBytes: 5 } })).toEqual({
      mimeTypes: DEFAULT_MCP_FILE_OUTPUT_MIME_TYPES,
      maxBytes: 5,
    });
    expect(resolveMCPFileOutputs({ fileOutputs: { mimeTypes: ['text/plain'] } })).toEqual({
      mimeTypes: ['text/plain'],
      maxBytes: DEFAULT_MCP_FILE_OUTPUT_MAX_BYTES,
    });
  });
});

describe('isAllowedMCPFileMimeType', () => {
  it('matches exactly, by prefix for a trailing *, ignoring case and parameters', () => {
    const allowed = DEFAULT_MCP_FILE_OUTPUT_MIME_TYPES;
    expect(isAllowedMCPFileMimeType('application/pdf', allowed)).toBe(true);
    expect(isAllowedMCPFileMimeType('Application/PDF; name=x', allowed)).toBe(true);
    expect(
      isAllowedMCPFileMimeType(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        allowed,
      ),
    ).toBe(true);
    expect(isAllowedMCPFileMimeType('application/octet-stream', allowed)).toBe(false);
    expect(isAllowedMCPFileMimeType('application/pdfx', allowed)).toBe(false);
    expect(isAllowedMCPFileMimeType('', allowed)).toBe(false);
  });
});

describe('getMCPOutputFilename', () => {
  it('takes the last path segment of the URI', () => {
    expect(getMCPOutputFilename('invoice://RE-2026-001.pdf', 'application/pdf')).toBe(
      'RE-2026-001.pdf',
    );
    expect(
      getMCPOutputFilename(
        'https://x.example/a/b/Rechnung%20M%C3%A4rz.pdf?sig=1#p',
        'application/pdf',
      ),
    ).toBe('Rechnung März.pdf');
    expect(getMCPOutputFilename('files/reports/q3.xlsx', 'application/zip')).toBe('q3.xlsx');
  });

  it('strips path separators, control characters and leading dots', () => {
    expect(getMCPOutputFilename('x://a/..%2F..%2Fetc%2Fpasswd', 'text/csv')).toBe('etcpasswd.csv');
    expect(getMCPOutputFilename('x://a/evil%0D%0Aname%E2%80%A8.pdf', 'application/pdf')).toBe(
      'evilname.pdf',
    );
    expect(getMCPOutputFilename('x://a/..\\..\\win.xml', 'text/xml')).toBe('win.xml');
    expect(getMCPOutputFilename('x://a/.hidden', 'application/pdf')).toBe('hidden.pdf');
  });

  it('falls back to file plus the MIME extension', () => {
    expect(getMCPOutputFilename('', 'application/pdf')).toBe('file.pdf');
    expect(getMCPOutputFilename('x://a/', 'text/csv')).toBe('file.csv');
    expect(getMCPOutputFilename(undefined, 'application/x-unknown')).toBe('file');
    expect(getMCPOutputFilename('x://a/report', 'application/pdf')).toBe('report.pdf');
  });

  it('caps the length and keeps the extension', () => {
    const name = getMCPOutputFilename(`x://a/${'n'.repeat(400)}.pdf`, 'application/pdf');
    expect(name).toHaveLength(128);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('readMCPFileOutput', () => {
  it('admits an allowed blob within the limit', () => {
    const item = pdfResource() as Extract<t.ToolContentPart, { type: 'resource' }>;
    expect(readMCPFileOutput(item.resource, policy)).toEqual({
      filename: 'RE-2026-001.pdf',
      mimeType: 'application/pdf',
      bytes: PDF.byteLength,
      data: PDF_BASE64,
    });
  });

  it('refuses text bodies, images, other types, invalid base64 and oversized blobs', () => {
    const read = (resource: t.ResourceContents, p = policy) => readMCPFileOutput(resource, p);
    expect(read({ uri: 'x://a.csv', mimeType: 'text/csv', text: 'a,b' })).toBeUndefined();
    expect(read({ uri: 'x://a.png', mimeType: 'image/png', blob: PDF_BASE64 })).toBeUndefined();
    expect(
      read({ uri: 'x://a', mimeType: 'application/octet-stream', blob: PDF_BASE64 }),
    ).toBeUndefined();
    expect(read({ uri: 'x://a.pdf', mimeType: 'application/pdf', blob: '%%%%' })).toBeUndefined();
    expect(
      read(
        { uri: 'x://a.pdf', mimeType: 'application/pdf', blob: PDF_BASE64 },
        { ...policy, maxBytes: PDF.byteLength - 1 },
      ),
    ).toBeUndefined();
    expect(
      read(
        { uri: 'x://a.pdf', mimeType: 'application/pdf', blob: PDF_BASE64 },
        { ...policy, maxBytes: PDF.byteLength },
      ),
    ).toBeDefined();
  });
});

describe('formatToolContent with file outputs', () => {
  const result: t.MCPToolCallResponse = {
    content: [{ type: 'text', text: 'Invoice RE-2026-001 created.' }, pdfResource()],
  };

  it('attaches the file and gives the model one line instead of the bytes', () => {
    const [text, artifacts] = formatToolContent(result, 'openai', { fileOutputs: policy });
    expect(text).toBe(
      'Invoice RE-2026-001 created.\n\n' +
        `File attached for the user: RE-2026-001.pdf (application/pdf, ${PDF.byteLength} bytes)`,
    );
    expect(text).not.toContain(PDF_BASE64);
    expect(artifacts?.[MCP_FILE_OUTPUTS_ARTIFACT_KEY]).toEqual([
      {
        filename: 'RE-2026-001.pdf',
        mimeType: 'application/pdf',
        bytes: PDF.byteLength,
        data: PDF_BASE64,
      },
    ]);
  });

  it('formats sizes in KB and MB', () => {
    const big = Buffer.alloc(34 * 1024, 1).toString('base64');
    const [text] = formatToolContent({ content: [pdfResource('x://big.pdf', big)] }, 'openai', {
      fileOutputs: policy,
    });
    expect(text).toBe('File attached for the user: big.pdf (application/pdf, 34 KB)');
    const huge = Buffer.alloc(Math.round(1.5 * 1024 * 1024), 1).toString('base64');
    const [hugeText] = formatToolContent(
      { content: [pdfResource('x://huge.pdf', huge)] },
      'openai',
      { fileOutputs: policy },
    );
    expect(hugeText).toBe('File attached for the user: huge.pdf (application/pdf, 1.5 MB)');
  });

  it('attaches the file for providers outside the recognized set too', () => {
    const [text, artifacts] = formatToolContent(result, 'mistralai' as t.Provider, {
      fileOutputs: policy,
    });
    expect(text).toContain('File attached for the user: RE-2026-001.pdf');
    expect(text).not.toContain(PDF_BASE64);
    expect(artifacts?.[MCP_FILE_OUTPUTS_ARTIFACT_KEY]).toHaveLength(1);
  });

  it('keeps the summary when the server has not opted in', () => {
    const [text, artifacts] = formatToolContent(result, 'openai');
    expect(text).toContain(`Resource Content: ${PDF.byteLength} bytes of binary data`);
    expect(artifacts).toBeUndefined();
  });

  it('keeps the summary for a disallowed type or an oversized blob', () => {
    const [text, artifacts] = formatToolContent(result, 'openai', {
      fileOutputs: { mimeTypes: ['text/csv'], maxBytes: 1024 },
    });
    expect(text).toContain('bytes of binary data');
    expect(artifacts).toBeUndefined();
    const [smallText, smallArtifacts] = formatToolContent(result, 'openai', {
      fileOutputs: { ...policy, maxBytes: 4 },
    });
    expect(smallText).toContain('bytes of binary data');
    expect(smallArtifacts).toBeUndefined();
  });

  it('keeps images on their own path alongside a file', () => {
    const png = Buffer.from('png').toString('base64');
    const [, artifacts] = formatToolContent(
      {
        content: [pdfResource(), { type: 'image', data: png, mimeType: 'image/png' }],
      },
      'openai',
      { fileOutputs: policy },
    );
    expect(artifacts?.content).toEqual([
      { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
    ]);
    expect(artifacts?.[MCP_FILE_OUTPUTS_ARTIFACT_KEY]).toHaveLength(1);
  });

  it('leaves ui:// resources alone', () => {
    const ui: t.ToolContentPart = {
      type: 'resource',
      resource: { uri: 'ui://x/report.pdf', mimeType: 'application/pdf', blob: PDF_BASE64 },
    };
    expect(extractMCPFileOutputs({ content: [ui] }, policy)).toBeUndefined();
  });
});

describe('saveMCPFileOutput', () => {
  const file = {
    filename: 'RE-2026-001.pdf',
    mimeType: 'application/pdf',
    bytes: PDF.byteLength,
    data: PDF_BASE64,
  };
  const expiredAt = new Date('2026-12-01T00:00:00Z');

  function deps(
    overrides: Partial<SaveMCPFileOutputDeps<MCPFileOutputRecord>> = {},
  ): SaveMCPFileOutputDeps<MCPFileOutputRecord> & {
    deleteFile: jest.Mock;
    saveBuffer: jest.Mock;
    createFile: jest.Mock;
  } {
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    const base = {
      req: { user: { id: 'user-1', tenantId: 'tenant-a' } },
      source: FileSources.local,
      saveBuffer: jest.fn(
        async ({ userId, fileName }: { userId: string; fileName: string }) =>
          `/uploads/${userId}/${fileName}`,
      ),
      createFile: jest.fn(async (data: MCPFileOutputRecord) => data),
      recordExists: jest.fn().mockResolvedValue(false),
      resolveDeleteFile: () => deleteFile,
      retentionExpiry: Promise.resolve({ expiredAt }),
      logger: { error: jest.fn() },
      conversationId: 'convo-1',
      messageId: 'msg-1',
      deleteFile,
    };
    return { ...base, ...overrides } as ReturnType<typeof deps>;
  }

  it('stores the bytes unchanged and records the file', async () => {
    const d = deps();
    const record = await saveMCPFileOutput(file, d);

    const [{ buffer, fileName, basePath, userId, tenantId }] = d.saveBuffer.mock.calls[0];
    expect(Buffer.compare(buffer, PDF)).toBe(0);
    expect(fileName).toMatch(/^[0-9a-f-]{36}__RE-2026-001\.pdf$/);
    expect({ basePath, userId, tenantId }).toEqual({
      basePath: 'uploads',
      userId: 'user-1',
      tenantId: 'tenant-a',
    });
    expect(d.createFile).toHaveBeenCalledWith(expect.any(Object), true);
    expect(record).toEqual({
      file_id: fileName.split('__')[0],
      filepath: `/uploads/user-1/${fileName}`,
      source: FileSources.local,
      context: FileContext.mcp_output,
      type: 'application/pdf',
      bytes: PDF.byteLength,
      filename: 'RE-2026-001.pdf',
      object: 'file',
      user: 'user-1',
      tenantId: 'tenant-a',
      conversationId: 'convo-1',
      messageId: 'msg-1',
      expiredAt,
    });
  });

  it('removes the stored object when the record cannot be written', async () => {
    const d = deps({ createFile: jest.fn().mockRejectedValue(new Error('db down')) });
    await expect(saveMCPFileOutput(file, d)).rejects.toThrow('db down');
    expect(d.deleteFile).toHaveBeenCalledWith(
      d.req,
      expect.objectContaining({
        source: FileSources.local,
        user: 'user-1',
        tenantId: 'tenant-a',
        filepath: expect.stringMatching(/^\/uploads\/user-1\/.+__RE-2026-001\.pdf$/),
      }),
    );
  });

  it('writes nothing when the upload fails', async () => {
    const d = deps({
      saveBuffer: jest.fn().mockRejectedValue(new Error('storage down')),
      retentionExpiry: Promise.reject(new Error('retention failed')),
    });
    await expect(saveMCPFileOutput(file, d)).rejects.toThrow('storage down');
    expect(d.createFile).not.toHaveBeenCalled();
    expect(d.deleteFile).not.toHaveBeenCalled();
  });
});
