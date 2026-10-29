import React from 'react';
import { render, screen } from '@testing-library/react';
import About, { LICENSES_PATH } from './About';

const mockUseGetStartupConfig = jest.fn();
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockUseGetStartupConfig(),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    values ? `${key} ${Object.values(values).join(' ')}` : key,
}));

beforeEach(() => {
  mockUseGetStartupConfig.mockReturnValue({
    data: { appTitle: 'OfficeChat', buildInfo: { version: '2026-10-29' } },
  });
});

describe('About', () => {
  it('shows the app title and the deployment version', () => {
    render(<About />);

    expect(screen.getByText('com_nav_about_name')).toBeInTheDocument();
    expect(screen.getByText('OfficeChat')).toBeInTheDocument();
    expect(screen.getByText('com_nav_about_version')).toBeInTheDocument();
    expect(screen.getByText('2026-10-29')).toBeInTheDocument();
  });

  it('shows the copyright line for this year and links the license page', () => {
    render(<About />);

    expect(
      screen.getByText(`com_nav_about_copyright ${new Date().getFullYear()}`),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'com_nav_about_licenses' });
    expect(link).toHaveAttribute('href', LICENSES_PATH);
    expect(LICENSES_PATH).toBe('/hilfe/lizenzen/');
  });

  it('never shows upstream build details or the user agent', () => {
    mockUseGetStartupConfig.mockReturnValue({
      data: {
        appTitle: 'OfficeChat',
        buildInfo: { version: '2026-10-29', commitShort: 'abcdef1', branch: 'dev' },
      },
    });
    const { container } = render(<About />);

    expect(container).not.toHaveTextContent('abcdef1');
    expect(container).not.toHaveTextContent('dev');
    expect(container).not.toHaveTextContent('LibreChat');
    expect(container).not.toHaveTextContent(navigator.userAgent);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows placeholders before the config answers', () => {
    mockUseGetStartupConfig.mockReturnValue({ data: undefined });
    render(<About />);

    expect(screen.getAllByText('—')).toHaveLength(2);
  });
});
