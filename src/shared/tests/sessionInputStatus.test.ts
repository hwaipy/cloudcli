import { act, renderHook, cleanup } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { receiveSessionInputEvent, reconcileSessionInputStatus, scopeSessionInputStatus, useSessionNeedsInput } from '@/shared/context/SessionInputStatus';
afterEach(() => { cleanup(); scopeSessionInputStatus(''); vi.useRealTimers(); sessionStorage.clear(); });
test('async question badge clears only on the matching user reply, survives reload scope, and isolates accounts', () => {
  scopeSessionInputStatus('account-one');
  const view = renderHook(() => useSessionNeedsInput('session-one'));
  act(() => receiveSessionInputEvent({ sessionId: 'session-one', codexQuestions: [{ title: 'Pick?' }] }));
  expect(view.result.current).toBe(true);
  act(() => receiveSessionInputEvent({ sessionId: 'session-one', role: 'user', content: 'An unrelated message' }));
  expect(view.result.current).toBe(true);
  act(() => scopeSessionInputStatus('other-account'));
  expect(view.result.current).toBe(false);
  act(() => scopeSessionInputStatus('account-one'));
  expect(view.result.current).toBe(true);
  act(() => receiveSessionInputEvent({ sessionId: 'session-one', role: 'user', content: '回答「Pick?」：Yes' }));
  expect(view.result.current).toBe(false);
});
test('history rebuilds status and native resolution clears native requests', () => {
  scopeSessionInputStatus('history-account');
  const view = renderHook(() => useSessionNeedsInput('history'));
  act(() => reconcileSessionInputStatus('history', [{ title: 'One' }, { title: 'Two', answered: true }]));
  expect(view.result.current).toBe(true);
  act(() => reconcileSessionInputStatus('history', [{ title: 'One', answered: true }]));
  expect(view.result.current).toBe(false);
  act(() => receiveSessionInputEvent({ sessionId: 'history', kind: 'permission_request', toolName: 'AskUserQuestion', requestId: 'native-one' }));
  expect(view.result.current).toBe(true);
  act(() => receiveSessionInputEvent({ sessionId: 'history', kind: 'permission_resolved', requestId: 'native-one' }));
  expect(view.result.current).toBe(false);
});


test('an old-round badge expires at ten minutes without another websocket event', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T00:00:00Z'));
  scopeSessionInputStatus('expiry');
  const view = renderHook(() => useSessionNeedsInput('session'));
  const askedAt = Date.now();
  act(() => receiveSessionInputEvent({ sessionId: 'session', timestamp: askedAt, runStartedAt: askedAt - 1000, codexQuestions: [{ title: 'Old question' }] }));
  act(() => vi.advanceTimersByTime(9 * 60_000));
  act(() => receiveSessionInputEvent({ sessionId: 'session', kind: 'status', runStartedAt: Date.now() }));
  expect(view.result.current).toBe(true);
  act(() => vi.advanceTimersByTime(60_000));
  expect(view.result.current).toBe(false);
});

test('latest-round input remains visible even after an hour; only a newer round ages it out', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T00:00:00Z'));
  scopeSessionInputStatus('latest');
  const view = renderHook(() => useSessionNeedsInput('session'));
  act(() => receiveSessionInputEvent({ sessionId: 'session', timestamp: Date.now(), runStartedAt: Date.now() - 1000, kind: 'permission_request', toolName: 'request_user_input', requestId: 'native' }));
  act(() => vi.advanceTimersByTime(60 * 60_000));
  expect(view.result.current).toBe(true);
  act(() => receiveSessionInputEvent({ sessionId: 'session', kind: 'status', runStartedAt: Date.now() }));
  expect(view.result.current).toBe(false);
});

test('history timing and account reload preserve expiry while a new question can reuse an old title', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T01:00:00Z'));
  scopeSessionInputStatus('history-expiry');
  const view = renderHook(() => useSessionNeedsInput('session'));
  act(() => reconcileSessionInputStatus('session', [{ title: 'Same title', askedAt: Date.now() - 20 * 60_000 }], Date.now() - 5 * 60_000));
  expect(view.result.current).toBe(false);
  act(() => { scopeSessionInputStatus('different'); scopeSessionInputStatus('history-expiry'); });
  expect(view.result.current).toBe(false);
  act(() => receiveSessionInputEvent({ sessionId: 'session', runStartedAt: Date.now(), timestamp: Date.now(), codexQuestions: [{ title: 'Same title' }] }));
  expect(view.result.current).toBe(true);
});
