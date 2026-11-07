import { useEffect, useState } from 'react';
import { ArrowUpCircle, Download, Loader2 } from 'lucide-react';

import type { DesktopUpdateBridge, DesktopUpdateState } from '@/shared/types';

/** Sidebar's header action row uses one icon for all native update states; browsers render nothing. */
export function DesktopUpdateButton() {
  // Native download events are external state; the web application has no updater of its own.
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  // Prevent duplicate restart requests; checks and downloads remain native/background work.
  const [applying, setApplying] = useState(false);
  // Failed native operations must remain visible and retryable.
  const [error, setError] = useState('');
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    const connect = () => {
      const bridge = (window as Window & { cloudcliDesktopUpdates?: DesktopUpdateBridge }).cloudcliDesktopUpdates;
      if (!bridge || unsubscribe) return;
      let receivedEvent = false;
      unsubscribe = bridge.onState((next) => { receivedEvent = true; if (!cancelled) setState(next); });
      void bridge.state().then((next) => { if (!cancelled && !receivedEvent) setState(next); }).catch(() => {});
    };
    connect(); window.addEventListener('cloudcli-desktop-ready', connect);
    return () => { cancelled = true; unsubscribe?.(); window.removeEventListener('cloudcli-desktop-ready', connect); };
  }, []);
  if (!state) return null;
  const ready = state.web.phase === 'ready' || state.shell.phase === 'ready';
  const downloading = state.web.phase === 'downloading' ? state.web : state.shell.phase === 'downloading' ? state.shell : null;
  if (!ready && !downloading && !applying) return null;
  const label = applying ? '正在重启…'
    : downloading ? '正在下载更新' : '更新并重启';
  const describe = (part: DesktopUpdateState['web']) => part.phase === 'error' ? part.error || '更新失败'
    : part.phase === 'ready' ? `已下载，可更新${part.version ? `（${part.version}）` : ''}`
      : part.phase === 'downloading' ? `下载中${part.percent === undefined ? '' : ` ${Math.round(part.percent)}%`}` : '暂无待应用更新';
  const details = [label, `当前桌面版本：${state.version}`, `网页资源：${describe(state.web)}`, `桌面壳：${describe(state.shell)}`,
    error, downloading ? '下载完成后可点击更新并重启。' : ready ? '点击更新只重启此客户端，后台任务继续运行。' : '空闲时点击检查更新。'].filter(Boolean).join('\n');
  const busy = Boolean(applying || downloading);
  return (
    <button
      type="button"
      aria-label={label}
      title={details}
      disabled={busy}
      className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg p-0 text-primary transition-colors hover:bg-accent/80 disabled:cursor-default md:h-7 md:w-7"
      onClick={async () => {
        setApplying(true); setError('');
        try {
          const bridge = (window as Window & { cloudcliDesktopUpdates?: DesktopUpdateBridge }).cloudcliDesktopUpdates;
          if (!bridge) throw new Error('桌面更新连接不可用');
          await bridge.apply();
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : '更新失败，请重试'); setApplying(false);
        }
      }}
    >
      {applying ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
        : downloading ? <Download aria-hidden="true" className="h-3.5 w-3.5" />
          : <ArrowUpCircle aria-hidden="true" className="h-3.5 w-3.5" />}
      {ready && !busy && <span aria-hidden="true" className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-emerald-500" />}
    </button>
  );
}
