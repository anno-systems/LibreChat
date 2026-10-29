import { memo, useCallback, Suspense } from 'react';
import { SquarePen } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { Skeleton, Sidebar, Button, TooltipAnchor } from '@librechat/client';
import type { NavLink } from '~/common';
import { useShortcutAriaKey, useShortcutHint } from '~/hooks/useKeyboardShortcuts';
import { useActivePanel, resolveActivePanel, DEFAULT_PANEL } from '~/Providers';
import AgentMarketplaceButton from '~/components/Nav/AgentMarketplaceButton';
import { CLOSE_SIDEBAR_ID } from '~/components/Chat/Menus/OpenSidebar';
import useDirection, { inlineSide } from '~/hooks/Nav/useDirection';
import useNewChat from '~/hooks/Conversations/useNewChat';
import { lazyWithRecovery } from '~/lib/assets/lazy';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const AccountSettings = lazyWithRecovery(() => import('~/components/Nav/AccountSettings'));

/** The new chat link's look in the labelled rail, matching the Button size `rail` of the other
 *  entries (fork: sidebar labels). */
const LABELED_ENTRY = 'h-9 w-full justify-start gap-3 px-2';
const ENTRY_LABEL = 'text-text-primary min-w-0 truncate text-sm font-medium';

const NewChatButton = memo(function NewChatButton({
  setActive,
  switchToHistory,
  labeled,
}: {
  setActive: (id: string) => void;
  switchToHistory: boolean;
  labeled: boolean;
}) {
  const localize = useLocalize();
  const tooltipSide = inlineSide(useDirection(), 'end');
  const tooltipDescription = useShortcutHint('newChat', localize('com_ui_new_chat'));
  const ariaKey = useShortcutAriaKey('newChat');

  const handlePanelSwitch = useCallback(() => {
    if (switchToHistory) {
      setActive(DEFAULT_PANEL);
    }
  }, [switchToHistory, setActive]);

  const { handleNewChatClick } = useNewChat({ onNewChat: handlePanelSwitch });

  const link = (
    <a
      href="/c/new"
      data-testid="new-chat-button"
      aria-label={labeled ? undefined : localize('com_ui_new_chat')}
      aria-keyshortcuts={ariaKey}
      className={cn(
        'hover:bg-surface-nav-hover flex items-center rounded-lg transition-colors',
        labeled ? LABELED_ENTRY : 'h-9 w-9 justify-center',
      )}
      onClick={handleNewChatClick}
    >
      <SquarePen className="text-text-primary h-5 w-5 shrink-0" aria-hidden="true" />
      {labeled && <span className={ENTRY_LABEL}>{localize('com_ui_new_chat')}</span>}
    </a>
  );

  if (labeled) {
    return link;
  }

  return <TooltipAnchor side={tooltipSide} description={tooltipDescription} render={link} />;
});

const NavIconButton = memo(function NavIconButton({
  link,
  isActive,
  expanded,
  setActive,
  onExpand,
  onCollapse,
  onNavigate,
  onLeaveInsights,
  labeled,
}: {
  link: NavLink;
  isActive: boolean;
  expanded: boolean;
  labeled: boolean;
  setActive: (id: string) => void;
  onExpand?: () => void;
  onCollapse?: () => void;
  onNavigate?: () => void;
  onLeaveInsights?: () => void;
}) {
  const localize = useLocalize();
  const tooltipSide = inlineSide(useDirection(), 'end');

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (link.onClick) {
        link.onClick(e);
        onNavigate?.();
        return;
      }
      if (isActive && expanded) {
        onCollapse?.();
        return;
      }
      if (!isActive) {
        setActive(link.id);
      }
      if (!expanded) {
        onExpand?.();
      } else {
        onLeaveInsights?.();
      }
    },
    [link, isActive, setActive, expanded, onExpand, onCollapse, onNavigate, onLeaveInsights],
  );

  const button = (
    <Button
      size={labeled ? 'rail' : 'icon'}
      variant="nav"
      aria-label={labeled ? undefined : localize(link.title)}
      aria-pressed={isActive}
      disabled={link.disabled}
      data-testid={`nav-panel-${link.id}`}
      className={labeled ? undefined : 'h-9 w-9 rounded-lg'}
      onClick={handleClick}
    >
      <link.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
      {labeled && <span className={ENTRY_LABEL}>{localize(link.title)}</span>}
    </Button>
  );

  if (labeled) {
    return button;
  }

  return <TooltipAnchor description={localize(link.title)} side={tooltipSide} render={button} />;
});

function ExpandedPanel({
  links,
  expanded = true,
  onCollapse,
  onExpand,
  onNavigate,
  onLeaveInsights,
  switchToHistory,
  labeled = false,
}: {
  links: NavLink[];
  expanded?: boolean;
  onCollapse?: () => void;
  onExpand?: () => void;
  onNavigate?: () => void;
  onLeaveInsights?: () => void;
  switchToHistory: boolean;
  /** Shows each entry's label beside its icon, in a wider rail (fork: sidebar labels). The
   *  host passes the user's layout preference; icon-only entries carry tooltips instead. */
  labeled?: boolean;
}) {
  const localize = useLocalize();
  const tooltipSide = inlineSide(useDirection(), 'end');
  const location = useLocation();
  const { active, setActive } = useActivePanel();
  const effectiveActive = resolveActivePanel(active, links);
  const isInsightsRoute = location.pathname.startsWith('/insights');

  const toggleLabel = expanded ? 'com_nav_close_sidebar' : 'com_nav_open_sidebar';
  const toggleClick = expanded ? onCollapse : onExpand;
  const toggleSidebarHint = useShortcutHint('toggleSidebar', localize(toggleLabel));
  const toggleSidebarAriaKey = useShortcutAriaKey('toggleSidebar');

  return (
    <div
      data-testid="sidebar-rail"
      className={cn(
        'border-border-inset bg-surface-sidebar flex h-full shrink-0 flex-col gap-2 border-e px-2 py-2',
        labeled && 'w-52',
      )}
    >
      <TooltipAnchor
        side={tooltipSide}
        description={toggleSidebarHint}
        render={
          <Button
            id={expanded ? CLOSE_SIDEBAR_ID : undefined}
            data-testid={expanded ? 'close-sidebar-button' : 'open-sidebar-button'}
            size="icon"
            variant="nav"
            aria-label={localize(toggleLabel)}
            aria-expanded={expanded}
            aria-keyshortcuts={toggleSidebarAriaKey}
            className="h-9 w-9"
            onClick={toggleClick}
          >
            <Sidebar aria-hidden="true" className="text-text-primary h-5 w-5 rtl:-scale-x-100" />
          </Button>
        }
      />
      <NewChatButton setActive={setActive} switchToHistory={switchToHistory} labeled={labeled} />
      <AgentMarketplaceButton layout={labeled ? 'label' : 'icon'} />
      <div className="border-border-inset mx-2 border-b" />
      <div className="flex flex-col gap-1 overflow-y-auto">
        {links.map((link) => (
          <NavIconButton
            key={link.id}
            link={link}
            isActive={
              link.id === 'insights'
                ? isInsightsRoute
                : !isInsightsRoute && link.id === effectiveActive
            }
            expanded={expanded ?? true}
            labeled={labeled}
            setActive={setActive}
            onExpand={onExpand}
            onCollapse={onCollapse}
            onNavigate={onNavigate}
            onLeaveInsights={isInsightsRoute ? onLeaveInsights : undefined}
          />
        ))}
      </div>

      <div className="mt-auto">
        <Suspense fallback={<Skeleton className="h-9 w-9 rounded-lg" />}>
          <AccountSettings collapsed={!labeled} />
        </Suspense>
      </div>
    </div>
  );
}

export default memo(ExpandedPanel);
