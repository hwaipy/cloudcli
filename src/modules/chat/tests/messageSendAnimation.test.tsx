import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { MessageSendAnimationProvider, rememberMessageSendOrigin, useMessageSendAnimation } from '@/modules/chat/context/MessageSendAnimationContext';

const animations: Array<{ cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null; oncancel: (() => void) | null }> = [];
const animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
  const animation = { cancel: vi.fn(), onfinish: null, oncancel: null };
  animations.push(animation);
  return animation;
});
function Bubble({ content = 'message', enabled = true, timestamp }: { content?: string; enabled?: boolean; timestamp?: number }) {
  const ref = useMessageSendAnimation(content, enabled, timestamp);
  return <div ref={ref} data-testid="bubble"><span>{content}</span></div>;
}
function Scene({ scope = 'session-a', content = 'message', timestamp, enabled = true }: { scope?: string; content?: string; timestamp?: number; enabled?: boolean }) {
  return <MessageSendAnimationProvider scope={scope}><div><Bubble content={content} timestamp={timestamp} enabled={enabled} /><div data-message-send-identity>Avatar and username</div></div></MessageSendAnimationProvider>;
}
function remember(scope = 'session-a', content = 'message') {
  const textarea = document.createElement('textarea');
  return rememberMessageSendOrigin(scope, content, textarea);
}
beforeEach(() => {
  vi.useFakeTimers();
  animate.mockClear(); animations.length = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id));
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return this.tagName === 'TEXTAREA' ? new DOMRect(20, 500, 320, 60) : new DOMRect(120, 250, 220, 90);
  });
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test('moves an inert overlay from the textarea to the bubble without removing the row from layout', () => {
  remember();
  const { container } = render(<Scene />);
  const bubble = container.querySelector<HTMLElement>('[data-testid="bubble"]')!;
  expect(bubble.style.visibility).toBe('hidden');
  expect(bubble.style.display).toBe('');
  const overlay = document.querySelector<HTMLElement>('[data-message-send-overlay]')!;
  expect(overlay.style.position).toBe('fixed');
  expect(overlay.getAttribute('aria-hidden')).toBe('true');
  expect(overlay.inert).toBe(true);
  expect(overlay.style.pointerEvents).toBe('none');
  act(() => vi.advanceTimersByTime(160));
  expect(animate).toHaveBeenCalledTimes(1);
  expect(animate.mock.calls[0]).toEqual([
    [{ transform: 'translate(20px, 500px)', width: '320px', height: '60px', opacity: 0.7 }, { transform: 'translate(120px, 250px)', width: '220px', height: '90px', opacity: 1 }],
    { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' },
  ]);
  act(() => animations[0].onfinish!());
  expect(bubble.style.visibility).toBe('');
  expect(document.querySelector('[data-message-send-overlay]')).toBeNull();
});

test('history, other sessions and old identical messages do not animate', () => {
  const cancel = remember('session-other');
  const scene = render(<Scene />);
  expect(document.querySelector('[data-message-send-overlay]')).toBeNull();
  scene.rerender(<Scene scope="session-other" timestamp={Date.now() - 60_000} />);
  expect(document.querySelector('[data-message-send-overlay]')).toBeNull();
  cancel();
});

test('reduced motion and assistant rows have no animation', () => {
  vi.mocked(window.matchMedia).mockReturnValue({ matches: true } as MediaQueryList);
  remember();
  const scene = render(<Scene />);
  expect(document.querySelector('[data-message-send-overlay]')).toBeNull();
  scene.unmount();
  vi.mocked(window.matchMedia).mockReturnValue({ matches: false } as MediaQueryList);
  const cancel = remember();
  render(<Scene enabled={false} />);
  expect(document.querySelector('[data-message-send-overlay]')).toBeNull();
  cancel();
});

test('failed sends cancel pending effects and history remounts never replay a consumed effect', () => {
  const cancel = remember(); cancel();
  const first = render(<Scene />);
  expect(document.querySelector('[data-message-send-overlay]')).toBeNull();
  first.unmount();
  remember();
  const sent = render(<Scene />);
  expect(document.querySelector('[data-message-send-overlay]')).not.toBeNull();
  sent.unmount();
  render(<Scene />);
  act(() => vi.advanceTimersByTime(1000));
  expect(document.querySelector('[data-message-send-overlay]')).toBeNull();
  expect(animate).not.toHaveBeenCalled();
});

test('touch scrolling cancels travel and reveals the row immediately without a late animation', () => {
  remember();
  const { getByTestId } = render(<Scene />);
  act(() => window.dispatchEvent(new Event('touchmove')));
  expect(getByTestId('bubble').style.visibility).toBe('');
  act(() => vi.advanceTimersByTime(1000));
  expect(animate).not.toHaveBeenCalled();
  expect(document.querySelector('[data-message-send-overlay]')).toBeNull();
});

test('measures the destination after the existing delayed auto-scroll has settled', () => {
  remember();
  render(<Scene />);
  act(() => vi.advanceTimersByTime(100));
  vi.mocked(Element.prototype.getBoundingClientRect).mockReturnValue(new DOMRect(120, 150, 220, 90));
  act(() => vi.advanceTimersByTime(60));
  expect(animate.mock.calls[0][0][1].transform).toBe('translate(120px, 150px)');
});

test('fallback timeout always restores the row even if the browser never fires animation finish', () => {
  remember();
  const { getByTestId } = render(<Scene />);
  act(() => vi.advanceTimersByTime(700));
  expect(getByTestId('bubble').style.visibility).toBe('');
  expect(document.querySelector('[data-message-send-overlay]')).toBeNull();
});

test('switching away cancels a pending send so reopening history cannot animate it', () => {
  const scene = render(<Scene />);
  remember();
  scene.rerender(<Scene scope="another-session" />);
  scene.rerender(<Scene />);
  act(() => vi.advanceTimersByTime(1000));
  expect(animate).not.toHaveBeenCalled();
  expect(document.querySelector('[data-message-send-overlay]')).toBeNull();
});

test('identity stays hidden during travel and fades in only after the bubble arrives', () => {
  remember();
  const { container, unmount } = render(<Scene />);
  const identity = container.querySelector<HTMLElement>('[data-message-send-identity]')!;
  expect(identity.style.visibility).toBe('hidden');
  act(() => vi.advanceTimersByTime(160));
  expect(identity.style.visibility).toBe('hidden');
  expect(animate).toHaveBeenCalledTimes(1);
  act(() => animations[0].onfinish!());
  expect(identity.style.visibility).toBe('');
  expect(animate.mock.calls[1]).toEqual([[{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' }]);
  expect(document.querySelector('[data-message-send-overlay]')).toBeNull();
  unmount();
  expect(animations[1].cancel).toHaveBeenCalled();
});

test('scroll cancellation restores identity immediately without starting its fade', () => {
  remember();
  const { container } = render(<Scene />);
  const identity = container.querySelector<HTMLElement>('[data-message-send-identity]')!;
  expect(identity.style.visibility).toBe('hidden');
  act(() => window.dispatchEvent(new Event('touchmove')));
  expect(identity.style.visibility).toBe('');
  act(() => vi.advanceTimersByTime(1000));
  expect(animate).not.toHaveBeenCalled();
});

test('starts at the full composer bounds instead of aligning a small bubble at the right edge', () => {
  const composer = document.createElement('form');
  composer.setAttribute('data-message-composer', '');
  const textarea = document.createElement('textarea');
  composer.appendChild(textarea);
  vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 490, 400, 100));
  rememberMessageSendOrigin('session-a', 'message', textarea);
  render(<Scene />);
  const overlay = document.querySelector<HTMLElement>('[data-message-send-overlay]')!;
  expect(overlay.style.width).toBe('400px');
  expect(overlay.style.height).toBe('100px');
  expect(overlay.style.transform).toBe('translate(10px, 490px)');
  act(() => vi.advanceTimersByTime(160));
  expect(animate.mock.calls[0][0][0]).toEqual({ transform: 'translate(10px, 490px)', width: '400px', height: '100px', opacity: 0.7 });
  expect(animate.mock.calls[0][0][1]).toEqual({ transform: 'translate(120px, 250px)', width: '220px', height: '90px', opacity: 1 });
});
