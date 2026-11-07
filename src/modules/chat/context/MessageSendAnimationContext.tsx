import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';

type SendOrigin = { scope: string; content: string; rect: DOMRect; createdAt: number };
const origins: SendOrigin[] = [];
const ScopeContext = createContext<string | null>(null);
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/** Used by the composer to capture a local send before its textarea is cleared. Returns cancellation for failed sends. */
export function rememberMessageSendOrigin(scope: string | null, content: string, textarea: HTMLTextAreaElement | null): () => void {
  if (!scope || !textarea || reducedMotion() || typeof Element.prototype.animate !== 'function') return () => {};
  const rect = (textarea.closest<HTMLElement>('[data-message-composer]') ?? textarea).getBoundingClientRect();
  if (!rect.width || !rect.height) return () => {};
  const now = Date.now();
  for (let i = origins.length - 1; i >= 0; i -= 1) if (now - origins[i].createdAt > 40_000) origins.splice(i, 1);
  const origin = { scope, content: content.trim(), rect, createdAt: now };
  origins.push(origin);
  if (origins.length > 32) origins.shift();
  return () => { const index = origins.indexOf(origin); if (index >= 0) origins.splice(index, 1); };
}

/** Used by ChatMessagesPane to keep send effects within the currently viewed session. Adds no layout elements. */
export function MessageSendAnimationProvider({ scope, children }: { scope: string | null; children: ReactNode }) {
  useLayoutEffect(() => () => {
    // Leaving a session cancels sends still waiting for their visible row.
    for (let index = origins.length - 1; index >= 0; index -= 1) if (origins[index].scope === scope) origins.splice(index, 1);
  }, [scope]);
  return <ScopeContext.Provider value={scope}>{children}</ScopeContext.Provider>;
}

/** Used by user-message and queue bubbles to move a one-shot visual copy from the composer without changing scroll layout. */
export function useMessageSendAnimation(content: string, enabled = true, timestamp?: string | number | Date) {
  const scope = useContext(ScopeContext);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!enabled || !node || !scope || reducedMotion() || typeof node.animate !== 'function') return;
    const now = Date.now();
    const index = origins.findIndex((origin) => origin.scope === scope && origin.content === content.trim()
      && now - origin.createdAt < 40_000 && (!timestamp || new Date(timestamp).getTime() >= origin.createdAt - 2000));
    if (index < 0) return;
    const [origin] = origins.splice(index, 1);
    const initial = node.getBoundingClientRect();
    if (!initial.width || !initial.height) return;
    const clone = node.cloneNode(true) as HTMLDivElement;
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
    clone.setAttribute('aria-hidden', 'true');
    clone.inert = true;
    clone.dataset.messageSendOverlay = 'true';
    const computed = getComputedStyle(node);
    const sourceX = origin.rect.left;
    const sourceY = origin.rect.top;
    Object.assign(clone.style, {
      position: 'fixed', left: '0', top: '0', width: `${origin.rect.width}px`, height: `${origin.rect.height}px`, maxWidth: 'none',
      maxHeight: `${window.innerHeight}px`, overflow: 'hidden', margin: '0', pointerEvents: 'none',
      zIndex: '80', willChange: 'transform, width, height, opacity', transformOrigin: 'top left', visibility: 'visible',
      fontFamily: computed.fontFamily, fontSize: computed.fontSize, lineHeight: computed.lineHeight,
      transform: `translate(${sourceX}px, ${sourceY}px)`, opacity: '0.7',
    });
    // Resize the floating bubble instead of stretching its text. Only this fixed
    // copy reflows; the transcript and its scroll height remain unchanged.
    const bubble = clone.querySelector<HTMLElement>('.group.rounded-2xl');
    if (bubble) {
      bubble.style.width = '100%';
      bubble.style.boxSizing = 'border-box';
      if (clone.childElementCount === 1) bubble.style.height = '100%';
    }
    document.body.appendChild(clone);
    // Reserve the identity column's space, but reveal it only after bubble travel.
    const identity = node.parentElement?.querySelector<HTMLElement>('[data-message-send-identity]');
    const previousIdentityVisibility = identity?.style.visibility ?? '';
    if (identity) identity.style.visibility = 'hidden';
    const previousVisibility = node.style.visibility;
    node.style.visibility = 'hidden';
    let animation: Animation | undefined;
    let identityAnimation: Animation | undefined;
    let firstFrame = 0;
    let secondFrame = 0;
    let startTimer = 0;
    let timeout = 0;
    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      node.style.visibility = previousVisibility;
      if (identity) identity.style.visibility = previousIdentityVisibility;
      clone.remove();
      cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame);
      window.clearTimeout(startTimer); window.clearTimeout(timeout);
      window.removeEventListener('wheel', cleanup); window.removeEventListener('touchmove', cleanup);
      if (animation) { animation.onfinish = null; animation.oncancel = null; animation.cancel(); }
    };
    // The existing auto-scroll can finish its layout before the destination is measured.
    startTimer = window.setTimeout(() => {
      firstFrame = requestAnimationFrame(() => {
        if (finished) return;
        secondFrame = requestAnimationFrame(() => {
          if (finished) return;
          const target = node.getBoundingClientRect();
          if (target.bottom < 0 || target.top > window.innerHeight || reducedMotion()) { cleanup(); return; }
          animation = clone.animate([
            { transform: `translate(${sourceX}px, ${sourceY}px)`, width: `${origin.rect.width}px`, height: `${origin.rect.height}px`, opacity: 0.7 },
            { transform: `translate(${target.left}px, ${target.top}px)`, width: `${target.width}px`, height: `${target.height}px`, opacity: 1 },
          ], { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' });
          animation.onfinish = () => {
            cleanup();
            if (identity?.isConnected && !reducedMotion()) {
              identityAnimation = identity.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
              identityAnimation.onfinish = () => { identityAnimation?.cancel(); identityAnimation = undefined; };
            }
          };
          animation.oncancel = cleanup;
        });
      });
    }, 120);
    // A scroll while the bubble is travelling should immediately reveal the real row.
    window.addEventListener('wheel', cleanup, { passive: true });
    window.addEventListener('touchmove', cleanup, { passive: true });
    timeout = window.setTimeout(cleanup, 650);
    return () => { cleanup(); identityAnimation?.cancel(); };
  }, [scope, content, enabled, timestamp]);
  return ref;
}
