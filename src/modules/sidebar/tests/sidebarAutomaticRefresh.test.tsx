import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { test, vi } from 'vitest';

import SidebarHeader from '@/modules/sidebar/SidebarHeader';

vi.mock('@/modules/desktop-updates', () => ({ DesktopUpdateButton: () => null }));
vi.mock('@/modules/sidebar/SidebarModeTabs', () => ({ default: () => null }));

for (const isMobile of [false, true]) {
  test(`${isMobile ? 'mobile' : 'desktop'} project header has no manual refresh button`, () => {
    const view = render(<SidebarHeader
      isPWA={false} isMobile={isMobile} isLoading={false} projectsCount={1}
      runningSessionsCount={0} archivedSessionsCount={0} isArchivedSessionsLoading={false}
      searchFilter="" onSearchFilterChange={() => {}} onClearSearchFilter={() => {}}
      searchMode="projects" onSearchModeChange={() => {}} onCreateProject={() => {}}
      onShowSettings={() => {}} onCollapseSidebar={() => {}} t={((key: string) => key) as TFunction}
    />);
    assert.equal(view.container.querySelector('[title="tooltips.refresh"]'), null);
    assert.equal(view.container.querySelector('.lucide-refresh-cw'), null);
    assert.ok(view.container.querySelector('button'));
    view.unmount();
  });
}
