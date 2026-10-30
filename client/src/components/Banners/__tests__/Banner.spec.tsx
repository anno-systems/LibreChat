import type { TBanner, BannerKind } from 'librechat-data-provider';
import * as miscDataProvider from '~/data-provider/Misc/queries';
import { render, screen } from 'test/layout-test-utils';
import { Banner } from '~/components/Banners';

const base: TBanner = {
  bannerId: 'notice',
  message: 'Planned work <b>tonight</b>',
  displayFrom: '2026-10-20T00:00:00Z',
  displayTo: '2026-10-31T00:00:00Z',
  createdAt: '2026-10-20T00:00:00Z',
  updatedAt: '2026-10-20T00:00:00Z',
  isPublic: true,
  persistable: true,
};

function renderBanner(banner: TBanner) {
  jest
    .spyOn(miscDataProvider, 'useGetBannerQuery')
    //@ts-ignore - the banner reads only the resolved data
    .mockReturnValue({ data: banner, isLoading: false, isError: false });
  return render(<Banner />);
}

const root = (container: HTMLElement) => container.firstElementChild as HTMLElement;

afterEach(() => jest.restoreAllMocks());

describe('Banner kinds', () => {
  it.each<[string, BannerKind | undefined]>([
    ['a tenant banner without a kind', undefined],
    ['an info banner', 'info'],
  ])('shows %s as upstream does, without an icon or label', (_label, kind) => {
    const { container } = renderBanner({ ...base, kind });

    expect(screen.getByText('tonight')).toBeInTheDocument();
    expect(root(container)).toHaveClass('bg-presentation');
    expect(root(container)).not.toHaveAttribute('role');
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('.sr-only')).toBeNull();
  });

  it.each<[BannerKind, string, string, string | null]>([
    ['maintenance', 'Maintenance', 'bg-status-info-subtle', null],
    ['warning', 'Warning', 'bg-status-warning-subtle', null],
    ['outage', 'Outage', 'bg-status-error-subtle', 'alert'],
  ])('shows the %s kind with its colour, icon and label', (kind, label, surface, role) => {
    const { container } = renderBanner({ ...base, kind });

    expect(screen.getByText('tonight')).toBeInTheDocument();
    expect(root(container)).toHaveClass(surface);
    expect(root(container)).not.toHaveClass('bg-presentation');
    expect(root(container).getAttribute('role')).toBe(role);
    expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(screen.getByText(`${label}:`)).toHaveClass('sr-only');
  });

  it('keeps the dismiss button on a banner users may close', () => {
    renderBanner({ ...base, kind: 'warning', persistable: false });

    expect(screen.getByRole('button', { name: 'Dismiss banner' })).toBeInTheDocument();
  });
});
