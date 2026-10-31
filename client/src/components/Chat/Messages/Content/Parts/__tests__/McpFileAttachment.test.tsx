import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { FileContext, FileSources } from 'librechat-data-provider';
import type { TAttachment } from 'librechat-data-provider';
import Attachment, { AttachmentGroup } from '../Attachment';

jest.mock('@librechat/client', () => ({
  useRemScale: () => 1,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAttachmentPreviewSync: () => ({ status: 'ready', previewError: undefined, isPolling: false }),
  useExpandCollapse: (isExpanded: boolean) => ({
    style: { display: 'grid', gridTemplateRows: isExpanded ? '1fr' : '0fr' },
    ref: { current: null },
  }),
}));

const mockUseAttachmentLink = jest.fn();
const mockHandleDownload = jest.fn();
jest.mock('../LogLink', () => ({
  useAttachmentLink: (options: unknown) => {
    mockUseAttachmentLink(options);
    return { handleDownload: mockHandleDownload };
  },
}));

jest.mock('@librechat/chat/components', () => ({
  ...jest.requireActual('@librechat/chat/components'),
  FileContainer: ({ file, onClick }: { file: { filename?: string }; onClick?: () => void }) => (
    <button type="button" data-testid="file-container" onClick={onClick}>
      {file.filename ?? ''}
    </button>
  ),
}));

jest.mock('~/components/Chat/Messages/Content/Image', () => ({
  __esModule: true,
  default: () => <img alt="" data-testid="image" />,
}));

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  getFileType: () => ({ paths: [], color: '', title: 'File' }),
  logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  isArtifactRoute: () => false,
}));

/** The record `saveMCPFileOutput` stores and the tool-end callback streams (fork). */
const mcpOutput = (filename: string, type: string): TAttachment =>
  ({
    file_id: `id-${filename}`,
    filename,
    filepath: `/uploads/user-1/id-${filename}__${filename}`,
    type,
    bytes: 34816,
    source: FileSources.local,
    context: FileContext.mcp_output,
    object: 'file',
    user: 'user-1',
    messageId: 'msg-1',
    toolCallId: 'call-1',
    conversationId: 'convo-1',
  }) as unknown as TAttachment;

describe('MCP file outputs in the message', () => {
  beforeEach(() => {
    mockHandleDownload.mockReset();
    mockUseAttachmentLink.mockReset();
  });

  it('renders a PDF from an MCP tool as a download chip that downloads through the file API', () => {
    render(<Attachment attachment={mcpOutput('RE-2026-001.pdf', 'application/pdf')} />);
    const chip = screen.getByTestId('file-container');
    expect(chip).toHaveTextContent('RE-2026-001.pdf');
    expect(mockUseAttachmentLink).toHaveBeenCalledWith({
      href: '/uploads/user-1/id-RE-2026-001.pdf__RE-2026-001.pdf',
      filename: 'RE-2026-001.pdf',
      file_id: 'id-RE-2026-001.pdf',
      user: 'user-1',
      source: FileSources.local,
    });
    fireEvent.click(chip);
    expect(mockHandleDownload).toHaveBeenCalledTimes(1);
  });

  it('groups several outputs, office files without preview text included, as downloads', () => {
    const attachments = [
      mcpOutput('RE-2026-001.pdf', 'application/pdf'),
      mcpOutput('RE-2026-001.xml', 'application/xml'),
      mcpOutput(
        'positions.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ];
    const { container } = render(<AttachmentGroup attachments={attachments} />);
    expect(container.querySelector('pre')).toBeNull();
    expect(screen.getAllByTestId('file-container').map((chip) => chip.textContent)).toEqual([
      'RE-2026-001.pdf',
      'RE-2026-001.xml',
      'positions.xlsx',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_show_n_files' }));
    expect(screen.getByRole('button', { name: 'com_ui_hide_n_files' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
});
