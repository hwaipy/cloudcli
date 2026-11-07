import { expect, test } from 'vitest';

import { formatDateTime24 } from '@/shared/utils';

test.each(['en-US', 'en-US-u-hc-h12', 'zh-CN', 'en-GB'])('forces 00–23 time in %s, including midnight', locale => {
  const options = { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit' } as const;
  expect(formatDateTime24('2026-11-06T00:05:09Z', options, locale)).toBe('00:05:09');
  expect(formatDateTime24('2026-11-06T18:35:42Z', options, locale)).toBe('18:35:42');
});

test('date/time styles retain language and timezone while removing AM/PM', () => {
  const text = formatDateTime24('2026-11-06T15:59:00Z', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' }, 'en-US');
  expect(text).toContain('23:59');
  expect(text).not.toMatch(/AM|PM/);
});

test('numeric timestamps and Date inputs agree; malformed timestamps are safe', () => {
  const date = new Date('2026-11-06T18:35:42Z');
  const options = { timeStyle: 'short', timeZone: 'UTC' } as const;
  expect(formatDateTime24(date, options, 'en-US')).toBe('18:35');
  expect(formatDateTime24(date.getTime(), options, 'en-US')).toBe('18:35');
  expect(formatDateTime24('invalid')).toBe('—');
});
