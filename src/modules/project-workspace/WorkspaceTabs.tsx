import { MessageSquare, Terminal, Folder, GitBranch, ClipboardCheck, MonitorPlay, ChevronDown, type LucideIcon } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip, PillBar, Pill } from '@/shared/ui';
import type { AppTab } from '@/shared/types';
import { usePlugins,PluginIcon } from '@/modules/plugins';

type WorkspaceTabsProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
};

type BuiltInTab = {
  kind: 'builtin';
  id: AppTab;
  labelKey: string;
  icon: LucideIcon;
};

type PluginTab = {
  kind: 'plugin';
  id: AppTab;
  label: string;
  pluginName: string;
  iconFile: string;
};

type TabDefinition = BuiltInTab | PluginTab;

const BASE_TABS: BuiltInTab[] = [
  { kind: 'builtin', id: 'chat',  labelKey: 'tabs.chat',  icon: MessageSquare },
  { kind: 'builtin', id: 'shell', labelKey: 'tabs.shell', icon: Terminal },
  { kind: 'builtin', id: 'files', labelKey: 'tabs.files', icon: Folder },
  { kind: 'builtin', id: 'git',   labelKey: 'tabs.git',   icon: GitBranch },
];

const BROWSER_TAB: BuiltInTab = {
  kind: 'builtin',
  id: 'browser',
  labelKey: 'tabs.browser',
  icon: MonitorPlay,
};

const TASKS_TAB: BuiltInTab = {
  kind: 'builtin',
  id: 'tasks',
  labelKey: 'tabs.tasks',
  icon: ClipboardCheck,
};

/** Rendered by WorkspaceHeader to show the built-in workspace tabs plus any enabled plugin tabs. */
export default function WorkspaceTabs({
  activeTab,
  setActiveTab,
  shouldShowTasksTab,
  shouldShowBrowserTab,
}: WorkspaceTabsProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();
  const containerRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  // The tab strip stays mounted for measurement when it is replaced by the dropdown.
  const [isCollapsed, setIsCollapsed] = useState(false);
  // The dropdown is only open while the user is choosing a workspace view.
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const builtInTabs: BuiltInTab[] = [
    ...BASE_TABS,
    ...(shouldShowBrowserTab ? [BROWSER_TAB] : []),
    ...(shouldShowTasksTab ? [TASKS_TAB] : []),
  ];

  const pluginTabs: PluginTab[] = plugins
    .filter((p) => p.enabled)
    .map((p) => ({
      kind: 'plugin',
      id: `plugin:${p.name}` as AppTab,
      label: p.displayName,
      pluginName: p.name,
      iconFile: p.icon,
    }));

  const tabs: TabDefinition[] = [...builtInTabs, ...pluginTabs];
  const selectedTab = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];

  useEffect(() => {
    const container = containerRef.current;
    const strip = tabsRef.current;
    if (!container || !strip || typeof ResizeObserver === 'undefined') return;
    const measure = () => setIsCollapsed(strip.scrollWidth > container.clientWidth + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(strip);
    measure();
    return () => observer.disconnect();
  }, [tabs.length, activeTab]);

  useEffect(() => {
    if (!isMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsMenuOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setIsMenuOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [isMenuOpen]);

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const tabList = event.currentTarget.closest('[role="tablist"]');
    if (!tabList) return;

    const tabButtons = Array.from(tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const currentIndex = tabButtons.indexOf(event.currentTarget);
    let nextIndex: number;

    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabButtons.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabButtons.length - 1;
    else return;

    event.preventDefault();
    tabButtons[nextIndex]?.focus();
    tabButtons[nextIndex]?.click();
  };

  return (
    <div ref={containerRef} className="relative ml-auto w-full min-w-0">
    <div ref={tabsRef} className={isCollapsed ? 'pointer-events-none invisible absolute right-0 top-0' : 'ml-auto w-max max-w-full'}>
    <PillBar
      role="tablist"
      aria-label={t('tabs.views', { defaultValue: 'Workspace views' })}
      className="min-w-max border border-border/40 bg-muted/50 shadow-inner shadow-black/[0.025] dark:shadow-black/10"
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTab;
        const displayLabel = tab.kind === 'builtin' ? t(tab.labelKey) : tab.label;

        return (
          <Fragment key={`${tab.id}-${index}`}>
            {index === builtInTabs.length && pluginTabs.length > 0 && (
              <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
            )}
            <Tooltip content={displayLabel} position="bottom">
              <Pill
                role="tab"
                aria-label={displayLabel}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                isActive={isActive}
                onClick={() => setActiveTab(tab.id)}
                onKeyDown={handleTabKeyDown}
                className="h-8 max-w-44 px-2.5 py-[5px]"
              >
                {tab.kind === 'builtin' ? (
                  <tab.icon className="h-3.5 w-3.5 shrink-0" strokeWidth={isActive ? 2.2 : 1.8} />
                ) : (
                  <PluginIcon
                    pluginName={tab.pluginName}
                    iconFile={tab.iconFile}
                    className="flex h-3.5 w-3.5 shrink-0 items-center justify-center [&>svg]:h-full [&>svg]:w-full"
                  />
                )}
                <span className={`${isActive ? 'inline max-w-28' : 'hidden'} truncate sm:max-w-36 lg:inline`}>
                  {displayLabel}
                </span>
              </Pill>
            </Tooltip>
          </Fragment>
        );
      })}
    </PillBar>
    </div>
    {isCollapsed && selectedTab && (
      <div className="ml-auto w-fit max-w-full">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
          aria-label={t('tabs.views', { defaultValue: 'Workspace views' })}
          onClick={() => setIsMenuOpen((open) => !open)}
          className="flex h-8 max-w-full items-center gap-2 rounded-lg border border-border/60 bg-muted/50 px-2.5 text-sm text-foreground"
        >
          {selectedTab.kind === 'builtin' ? <selectedTab.icon className="h-4 w-4 shrink-0" /> : <PluginIcon pluginName={selectedTab.pluginName} iconFile={selectedTab.iconFile} className="h-4 w-4 shrink-0" />}
          <span className="min-w-0 truncate">{selectedTab.kind === 'builtin' ? t(selectedTab.labelKey) : selectedTab.label}</span>
          <ChevronDown className="h-4 w-4 shrink-0" />
        </button>
        {isMenuOpen && (
          <div role="menu" aria-label={t('tabs.views', { defaultValue: 'Workspace views' })} className="absolute right-0 top-full z-50 mt-1 max-h-[min(70vh,28rem)] min-w-44 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-xl">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="menuitemradio"
                aria-checked={tab.id === activeTab}
                onClick={() => { setActiveTab(tab.id); setIsMenuOpen(false); }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                {tab.kind === 'builtin' ? <tab.icon className="h-4 w-4 shrink-0" /> : <PluginIcon pluginName={tab.pluginName} iconFile={tab.iconFile} className="h-4 w-4 shrink-0" />}
                <span className="truncate">{tab.kind === 'builtin' ? t(tab.labelKey) : tab.label}</span>
                {tab.id === activeTab && <span className="ml-auto text-primary">✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    )}
    </div>
  );
}
