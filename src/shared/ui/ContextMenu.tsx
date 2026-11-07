import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Copy, ExternalLink, RefreshCw, Scissors, ClipboardPaste, CheckSquare, Undo2, Redo2 } from 'lucide-react';

import type { ActionMenuItem } from '@/shared/types';
import { copyTextToClipboard, cn } from '@/shared/utils';

type MenuEvent = MouseEvent | ReactMouseEvent<HTMLElement>;
type OpenMenu = (event: MenuEvent, items?: ActionMenuItem[]) => void;
type MenuState = { x: number; y: number; items: ActionMenuItem[]; origin: HTMLElement | null };
const ContextMenuContext = createContext<OpenMenu>(() => {});

async function copy(text: string) {
  if (!await copyTextToClipboard(text)) throw new Error('无法复制，请检查浏览器剪贴板权限。');
}

function genericActions(target: HTMLElement): ActionMenuItem[] {
  const items: ActionMenuItem[] = [];
  const field = target.closest('input,textarea');
  if (field instanceof HTMLTextAreaElement || (field instanceof HTMLInputElement && !['checkbox', 'radio', 'file', 'range', 'color', 'button', 'submit', 'reset', 'hidden'].includes(field.type))) {
    const start = field.selectionStart ?? 0;
    const end = field.selectionEnd ?? start;
    const isPassword = field instanceof HTMLInputElement && field.type === 'password';
    const valueAtOpen = field.value;
    const selection = field.value.slice(start, end);
    const writable = !field.readOnly && !field.disabled;
    // Use the native setter so controlled React fields receive their normal input event.
    const replace = (text: string) => {
      if (!field.isConnected || field.value !== valueAtOpen) throw new Error('输入内容已变化，请重新打开菜单后操作。');
      field.focus();
      try { field.setSelectionRange(start, end); } catch { /* Non-text input. */ }
      if (typeof document.execCommand === 'function' && document.execCommand(text ? 'insertText' : 'delete', false, text)) return;
      const value = field.value.slice(0, start) + text + field.value.slice(end);
      const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      try { field.setSelectionRange(start + text.length, start + text.length); } catch { /* Non-text input. */ }
    };
    items.push(
      { key: 'undo', label: '撤销', icon: Undo2, disabled: !writable || !document.queryCommandEnabled?.('undo'), onSelect: () => { field.focus(); document.execCommand('undo'); } },
      { key: 'redo', label: '重做', icon: Redo2, disabled: !writable || !document.queryCommandEnabled?.('redo'), onSelect: () => { field.focus(); document.execCommand('redo'); }, showDividerBefore: false },
      { key: 'copy-selection', label: '复制', icon: Copy, disabled: !selection || isPassword, onSelect: () => copy(selection) },
      { key: 'cut', label: '剪切', icon: Scissors, disabled: !writable || !selection || isPassword, onSelect: async () => { await copy(selection); replace(''); } },
      { key: 'paste', label: '粘贴', icon: ClipboardPaste, disabled: !writable || !navigator.clipboard?.readText, onSelect: async () => { replace(await navigator.clipboard.readText()); } },
      { key: 'select-all', label: '全选', icon: CheckSquare, disabled: field.disabled, onSelect: () => { field.focus(); field.select(); } },
    );
    return items;
  }
  const selection = window.getSelection();
  const selectedText = selection?.toString() ?? '';
  const editable = target.closest<HTMLElement>('[contenteditable="true"]');
  const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
  if (selectedText) items.push({ key: 'copy-selection', label: '复制选中文字', icon: Copy, onSelect: () => copy(selectedText) });
  if (editable) {
    const restore = () => { editable.focus(); if (range) { const current = window.getSelection(); current?.removeAllRanges(); current?.addRange(range); } };
    items.push(
      { key: 'cut', label: '剪切', icon: Scissors, disabled: !selectedText, onSelect: async () => { await copy(selectedText); restore(); document.execCommand('delete'); } },
      { key: 'paste', label: '粘贴', icon: ClipboardPaste, disabled: !navigator.clipboard?.readText, onSelect: async () => { const text = await navigator.clipboard.readText(); restore(); document.execCommand('insertText', false, text); } },
      { key: 'select-all', label: '全选', icon: CheckSquare, onSelect: () => { editable.focus(); const all = document.createRange(); all.selectNodeContents(editable); const current = window.getSelection(); current?.removeAllRanges(); current?.addRange(all); } },
    );
    return items;
  }
  const link = target.closest<HTMLAnchorElement>('a[href]');
  if (link) {
    const href = link.href;
    const canOpen = /^(https?:|mailto:|tel:)/i.test(href);
    items.push(
      { key: 'open-link', label: '在新标签页打开链接', icon: ExternalLink, disabled: !canOpen, onSelect: () => { window.open(href, '_blank', 'noopener,noreferrer'); } },
      { key: 'copy-link', label: '复制链接地址', icon: Copy, onSelect: () => copy(href) },
    );
  }
  const image = target.closest<HTMLImageElement>('img');
  if (image?.src) {
    const src = image.currentSrc || image.src;
    items.push(
      { key: 'open-image', label: '打开原图', icon: ExternalLink, disabled: !/^(https?:|blob:)/i.test(src), onSelect: () => { window.open(src, '_blank', 'noopener,noreferrer'); } },
      { key: 'copy-image-url', label: '复制图片地址', icon: Copy, onSelect: () => copy(src) },
    );
  }
  const pre = target.closest('pre');
  if (pre) items.push({ key: 'copy-code', label: '复制代码', icon: Copy, onSelect: () => copy(pre.textContent ?? '') });
  return items;
}

/** App mounts this provider; chat, sidebar and file-tree supply scoped actions through its hook. */
export function ContextMenuProvider({ children }: { children: ReactNode }) {
  // Only one contextual menu may exist at once, including menus from nested features.
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Clipboard errors are actionable and must not become unhandled promise rejections.
  const [error, setError] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const open = useCallback<OpenMenu>((event, scopedItems = []) => {
    if (event.defaultPrevented) return;
    const target = event.target instanceof HTMLElement ? event.target : event.target instanceof Node ? event.target.parentElement : null;
    if (!target) return;
    event.preventDefault(); event.stopPropagation();
    const candidates = genericActions(target);
    // Inputs keep text-editing commands, even when nested inside a project or message.
    const isEditing = Boolean(target.closest('input,textarea,[contenteditable="true"]'));
    const scoped = isEditing ? [] : scopedItems;
    const scopedKeys = new Set(scoped.map((item) => item.key));
    const generic = candidates.filter((item) => !scopedKeys.has(item.key));
    const items = [...generic, ...scoped.map((item, index) => ({ ...item, showDividerBefore: item.showDividerBefore || (index === 0 && generic.length > 0) }))];
    if (!items.length) items.push(
      { key: 'copy-page-url', label: '复制当前页面地址', icon: Copy, onSelect: () => copy(window.location.href) },
      { key: 'reload', label: '刷新页面', icon: RefreshCw, onSelect: () => window.location.reload() },
    );
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : target;
    const bounds = target.getBoundingClientRect();
    document.dispatchEvent(new Event('cloudcli:context-menu-open'));
    setError('');
    setMenu({ x: event.clientX || bounds.left, y: event.clientY || bounds.bottom, items, origin });
  }, []);
  const close = useCallback((restore = false) => {
    if (restore && menu?.origin?.isConnected) menu.origin.focus({ preventScroll: true });
    setMenu(null);
  }, [menu]);
  useEffect(() => {
    document.addEventListener('contextmenu', open);
    return () => document.removeEventListener('contextmenu', open);
  }, [open]);
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const element = menuRef.current;
    const rect = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))}px`;
    element.focus({ preventScroll: true });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) close(); };
    const scroll = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) close(); };
    const resize = () => close();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(true); }
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('keydown', keyboard, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    window.addEventListener('blur', resize);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('keydown', keyboard, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', resize);
    };
  }, [menu, close]);
  return <ContextMenuContext.Provider value={open}>
    {children}
    {menu && createPortal(<div ref={menuRef} role="menu" tabIndex={-1} aria-label="操作菜单" style={{ position: 'fixed', top: menu.y, left: menu.x, zIndex: 15000, maxHeight: 'calc(100dvh - 16px)' }}
      className="w-60 max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl outline-none border border-border bg-popover p-1.5 text-popover-foreground shadow-xl animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none"
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={(event) => {
        const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length) : -1;
        if (next >= 0) { event.preventDefault(); event.stopPropagation(); buttons[next]?.focus(); }
      }}>
      {menu.items.map((item) => <div key={item.key}>{item.showDividerBefore && <div role="separator" className="my-1 border-t border-border" />}
        <button type="button" role="menuitem" disabled={item.disabled || item.loading} className={cn('flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-accent focus:bg-accent disabled:cursor-default disabled:opacity-40', item.isDanger && 'text-destructive')}
          onClick={() => {
            close(true);
            try { Promise.resolve(item.onSelect()).catch((failure) => setError(failure instanceof Error ? failure.message : '操作失败，请重试。')); }
            catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败，请重试。'); }
          }}>
          {item.icon && <item.icon aria-hidden="true" className="h-4 w-4 shrink-0" />}<span>{item.label}</span>
        </button></div>)}
    </div>, document.body)}
    {error && createPortal(<div role="alert" className="fixed bottom-4 right-4 z-[15001] max-w-sm rounded-xl border border-border bg-popover p-3 text-sm shadow-lg">{error}<button type="button" onClick={() => setError('')} className="ml-3 underline">关闭</button></div>, document.body)}
  </ContextMenuContext.Provider>;
}

/** Sidebar, chat and file-tree use this hook to open the shared menu at the pointer. */
export function useAppContextMenu() { return useContext(ContextMenuContext); }
