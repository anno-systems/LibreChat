import { useEffect, useMemo, useRef } from 'react';
import { useRecoilState } from 'recoil';
import { Button, cn } from '@librechat/client';
import { XIcon, Wrench, OctagonAlert, TriangleAlert } from 'lucide-react';
import type { BannerKind } from 'librechat-data-provider';
import type { LucideIcon } from 'lucide-react';
import type { TranslationKeys } from '~/hooks';
import {
  CONFIG_HTML_TEXT_TAGS,
  CONFIG_HTML_CLASS_ATTR,
  createConfigHtmlSanitizer,
} from '~/utils/configHtml';
import { useGetBannerQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';
import store from '~/store';

type KindStyle = { icon: LucideIcon; label: TranslationKeys; surface: string; iconColor: string };

/** Fork: the platform operator's banner kinds; `info` and tenant banners keep upstream's look. */
const kindStyles: Partial<Record<BannerKind, KindStyle>> = {
  maintenance: {
    icon: Wrench,
    label: 'com_ui_banner_kind_maintenance',
    surface: 'bg-status-info-subtle border-status-info-border',
    iconColor: 'text-status-info',
  },
  warning: {
    icon: TriangleAlert,
    label: 'com_ui_banner_kind_warning',
    surface: 'bg-status-warning-subtle border-status-warning-border',
    iconColor: 'text-status-warning',
  },
  outage: {
    icon: OctagonAlert,
    label: 'com_ui_banner_kind_outage',
    surface: 'bg-status-error-subtle border-status-error-border',
    iconColor: 'text-status-error',
  },
};

export const Banner = ({ onHeightChange }: { onHeightChange?: (height: number) => void }) => {
  const localize = useLocalize();
  const { data: banner } = useGetBannerQuery();
  const [hideBannerHint, setHideBannerHint] = useRecoilState<string[]>(store.hideBannerHint);
  const bannerRef = useRef<HTMLDivElement>(null);
  const sanitize = useMemo(
    () =>
      createConfigHtmlSanitizer({
        allowedTags: CONFIG_HTML_TEXT_TAGS,
        allowedAttr: CONFIG_HTML_CLASS_ATTR,
      }),
    [],
  );

  const sanitizedMessage = useMemo(() => {
    if (!banner?.message) {
      return '';
    }
    return sanitize(banner.message);
  }, [banner?.message, sanitize]);

  useEffect(() => {
    if (onHeightChange && bannerRef.current) {
      onHeightChange(bannerRef.current.offsetHeight);
    }
  }, [banner, hideBannerHint, onHeightChange]);

  if (
    !banner ||
    (banner.bannerId && !banner.persistable && hideBannerHint.includes(banner.bannerId))
  ) {
    return null;
  }

  const onClick = () => {
    if (banner.persistable) {
      return;
    }

    setHideBannerHint([...hideBannerHint, banner.bannerId]);

    if (onHeightChange) {
      onHeightChange(0);
    }
  };

  const kind = banner.kind ? kindStyles[banner.kind] : undefined;
  const KindIcon = kind?.icon;

  return (
    <div
      ref={bannerRef}
      role={banner.kind === 'outage' ? 'alert' : undefined}
      data-kind={banner.kind}
      className={cn(
        'text-text-primary sticky top-0 z-20 flex items-center px-2 py-1 md:relative',
        kind ? cn('border-b', kind.surface) : 'bg-presentation',
      )}
    >
      {kind && KindIcon ? (
        <div
          className={cn(
            'flex w-full min-w-0 items-center justify-center gap-2',
            !banner.persistable && 'px-4',
          )}
        >
          <KindIcon className={cn('size-4 shrink-0', kind.iconColor)} aria-hidden="true" />
          <span className="sr-only">{localize(kind.label)}: </span>
          <div
            className="[&_a]:text-link min-w-0 truncate text-base [&_a]:underline"
            dangerouslySetInnerHTML={{ __html: sanitizedMessage }}
          ></div>
        </div>
      ) : (
        <div
          className={cn(
            '[&_a]:text-link w-full truncate text-center text-base [&_a]:underline',
            !banner.persistable && 'px-4',
          )}
          dangerouslySetInnerHTML={{ __html: sanitizedMessage }}
        ></div>
      )}
      {!banner.persistable && (
        <Button
          size="icon"
          variant="ghost"
          aria-label="Dismiss banner"
          className="size-8"
          onClick={onClick}
        >
          <XIcon className="text-text-primary mx-auto h-4 w-4" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
};
