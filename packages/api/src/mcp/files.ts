import crypto from 'node:crypto';
import { FileContext } from 'librechat-data-provider';
import type { TMCPFileOutputs } from 'librechat-data-provider';
import type { StoredUploadRef } from '~/files/orphan';
import type * as t from './types';
import { withStoredUploadCleanup } from '~/files/orphan';
import { getStorageMetadata } from '~/storage/metadata';

/** Artifact key under which a formatted MCP tool result carries files for the user (fork). */
export const MCP_FILE_OUTPUTS_ARTIFACT_KEY = 'mcp_files' as const;

/** MIME types a server with `fileOutputs: true` may return as files. */
export const DEFAULT_MCP_FILE_OUTPUT_MIME_TYPES: readonly string[] = [
  'application/pdf',
  'application/xml',
  'text/xml',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.*',
  'application/zip',
];

export const DEFAULT_MCP_FILE_OUTPUT_MAX_BYTES: number = 10 * 1024 * 1024;

/** Longest filename kept from a resource URI, extension included. */
export const MAX_MCP_FILE_OUTPUT_NAME_LENGTH: number = 128;

export interface MCPFileOutputsPolicy {
  mimeTypes: readonly string[];
  maxBytes: number;
}

const EXTENSIONS: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/* Control characters, line and paragraph separators, path separators and characters that
 * Windows refuses in a filename. */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029/\\:*?"<>|]/g;

/**
 * The file output policy of an admin-defined server, or undefined when the server has not opted
 * in. The caller decides whether the server is admin-defined; user-created servers never pass one.
 */
export function resolveMCPFileOutputs(
  config: { fileOutputs?: TMCPFileOutputs } | null | undefined,
): MCPFileOutputsPolicy | undefined {
  const setting = config?.fileOutputs;
  if (setting == null || setting === false) {
    return undefined;
  }
  if (setting === true) {
    return {
      mimeTypes: DEFAULT_MCP_FILE_OUTPUT_MIME_TYPES,
      maxBytes: DEFAULT_MCP_FILE_OUTPUT_MAX_BYTES,
    };
  }
  return {
    mimeTypes: setting.mimeTypes ?? DEFAULT_MCP_FILE_OUTPUT_MIME_TYPES,
    maxBytes: setting.maxBytes ?? DEFAULT_MCP_FILE_OUTPUT_MAX_BYTES,
  };
}

/** Lower-cased media type without parameters (`Application/PDF; x=y` → `application/pdf`). */
function baseMimeType(mimeType: string): string {
  return mimeType.split(';')[0].trim().toLowerCase();
}

export function isAllowedMCPFileMimeType(mimeType: string, allowed: readonly string[]): boolean {
  const type = baseMimeType(mimeType);
  if (!type) {
    return false;
  }
  return allowed.some((entry) => {
    const pattern = entry.trim().toLowerCase();
    return pattern.endsWith('*') ? type.startsWith(pattern.slice(0, -1)) : type === pattern;
  });
}

/* Not `new URL`: a custom scheme such as `invoice://RE-1.pdf` parses the name as the host. */
function lastPathSegment(uri: string): string {
  const path = uri.replace(/^[a-z][a-z0-9+.-]*:/i, '').split(/[?#]/)[0];
  const segment = path.split(/[/\\]/).pop() ?? '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function truncateKeepingExtension(name: string, max: number): string {
  if (name.length <= max) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  return name.slice(0, max - extension.length) + extension;
}

/**
 * The filename shown to the user: the resource URI's last path segment, without control
 * characters or path separators, at most {@link MAX_MCP_FILE_OUTPUT_NAME_LENGTH} characters with
 * its extension kept. A name without an extension gets the MIME type's; an empty one becomes
 * `file.<extension>`.
 */
export function getMCPOutputFilename(uri: string | undefined, mimeType: string): string {
  const extension = EXTENSIONS[baseMimeType(mimeType)];
  let name = lastPathSegment(uri ?? '')
    .replace(UNSAFE_FILENAME_CHARS, '')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  if (!name) {
    return extension ? `file.${extension}` : 'file';
  }
  if (extension && !name.includes('.')) {
    name = `${name}.${extension}`;
  }
  return truncateKeepingExtension(name, MAX_MCP_FILE_OUTPUT_NAME_LENGTH);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The line the model reads in place of a file's bytes. */
export function describeMCPFileOutput(file: t.MCPFileOutput): string {
  return `File attached for the user: ${file.filename} (${file.mimeType}, ${formatSize(file.bytes)})`;
}

/**
 * A resource's base64 blob as a file for the user, or undefined when the policy does not admit
 * it: no blob, an image (images keep their own path), a MIME type outside the list, invalid
 * base64, or more bytes than the limit. The size is checked before anything is decoded.
 */
export function readMCPFileOutput(
  resource: t.ResourceContents,
  policy: MCPFileOutputsPolicy,
): t.MCPFileOutput | undefined {
  if (!('blob' in resource) || typeof resource.blob !== 'string' || !resource.blob) {
    return undefined;
  }
  const rawMimeType = resource.mimeType ?? '';
  const mimeType = baseMimeType(rawMimeType);
  if (mimeType.startsWith('image/') || !isAllowedMCPFileMimeType(mimeType, policy.mimeTypes)) {
    return undefined;
  }
  const data = resource.blob.replace(/[\t\n\f\r ]/g, '');
  const padding = data.length - data.replace(/=+$/, '').length;
  const bytes = Math.floor((data.length * 3) / 4) - padding;
  if (bytes <= 0 || bytes > policy.maxBytes || !BASE64.test(data)) {
    return undefined;
  }
  return { filename: getMCPOutputFilename(resource.uri, mimeType), mimeType, bytes, data };
}

/**
 * Takes the file outputs out of a tool result: each admitted resource is replaced by a text item
 * that tells the model the file was attached, so neither path that formats the result for the
 * model ever sees the bytes. Returns undefined when nothing was taken out.
 */
export function extractMCPFileOutputs(
  result: t.MCPToolCallResponse,
  policy: MCPFileOutputsPolicy | undefined,
): { result: t.MCPToolCallResponse; files: t.MCPFileOutput[] } | undefined {
  const content = result?.content;
  if (!policy || !content?.length) {
    return undefined;
  }
  const files: t.MCPFileOutput[] = [];
  const nextContent = content.map((item): t.ToolContentPart => {
    if (item.type !== 'resource' || item.resource.uri?.startsWith('ui://')) {
      return item;
    }
    const file = readMCPFileOutput(item.resource, policy);
    if (!file) {
      return item;
    }
    files.push(file);
    return { type: 'text', text: describeMCPFileOutput(file) };
  });
  if (!files.length) {
    return undefined;
  }
  return { result: { ...result, content: nextContent }, files };
}

/** What the saved file record holds; mirrors the generated-image record. */
export interface MCPFileOutputRecord {
  file_id: string;
  filepath: string;
  source: string;
  context: string;
  type: string;
  bytes: number;
  filename: string;
  object: 'file';
  user: string;
  tenantId?: string;
  conversationId?: string;
  messageId?: string;
  storageKey?: string;
  storageRegion?: string;
  expiredAt?: Date | null;
}

export interface SaveMCPFileOutputDeps<TFile> {
  req: { user?: { id?: string; tenantId?: string } };
  /** The file strategy for documents (`getFileStrategy(appConfig)`). */
  source: string;
  saveBuffer: (params: {
    userId: string;
    buffer: Buffer;
    fileName: string;
    basePath?: string;
    tenantId?: string;
  }) => Promise<string>;
  resolveDeleteFile: () => ((req: never, file: StoredUploadRef) => Promise<unknown>) | undefined;
  recordExists: (stored: StoredUploadRef) => Promise<boolean>;
  createFile: (data: MCPFileOutputRecord, disableTTL?: boolean) => Promise<TFile | null>;
  /** The request's retention fields (`getRetentionExpiry(req)`), spread into the record. */
  retentionExpiry: Promise<{ expiredAt?: Date | null }>;
  logger: { error: (message: string, meta?: unknown) => void };
  conversationId?: string;
  messageId?: string;
}

/**
 * Stores a file an MCP server returned through the file strategy and creates its record, the way
 * a generated image is stored, but byte for byte: no resize or re-encode. A failure after the
 * upload removes the stored object again.
 */
export async function saveMCPFileOutput<TFile>(
  file: t.MCPFileOutput,
  deps: SaveMCPFileOutputDeps<TFile>,
): Promise<TFile | null> {
  const userId = deps.req.user?.id;
  if (!userId) {
    throw new Error('[saveMCPFileOutput] Missing user');
  }
  /* Awaited only once the upload succeeded; a failed upload must not leave it unhandled. */
  deps.retentionExpiry.catch(() => undefined);
  const tenantId = deps.req.user?.tenantId;
  const file_id = crypto.randomUUID();
  const buffer = Buffer.from(file.data, 'base64');
  const filepath = await deps.saveBuffer({
    userId,
    buffer,
    fileName: `${file_id}__${file.filename}`,
    basePath: 'uploads',
    tenantId,
  });
  const storageMetadata = getStorageMetadata({ filepath, source: deps.source });
  return withStoredUploadCleanup(
    {
      req: deps.req,
      logger: deps.logger,
      recordExists: deps.recordExists,
      resolveDeleteFile: deps.resolveDeleteFile,
      stored: { file_id, filepath, source: deps.source, ...storageMetadata },
      trackWrite: true,
    },
    async (beginWrite) => {
      const retentionExpiry = await deps.retentionExpiry;
      beginWrite();
      return deps.createFile(
        {
          file_id,
          filepath,
          ...storageMetadata,
          source: deps.source,
          context: FileContext.mcp_output,
          type: file.mimeType,
          bytes: buffer.length,
          filename: file.filename,
          object: 'file',
          user: userId,
          ...(tenantId ? { tenantId } : {}),
          ...(deps.conversationId ? { conversationId: deps.conversationId } : {}),
          ...(deps.messageId ? { messageId: deps.messageId } : {}),
          ...retentionExpiry,
        },
        true,
      );
    },
  );
}
