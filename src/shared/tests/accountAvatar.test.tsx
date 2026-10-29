import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import { test } from 'vitest';

import { AccountAvatar } from '@/shared/ui';

test('an unset avatar shows the first character of the username', () => {
  render(<AccountAvatar username="Alice" />);
  assert.equal(screen.getByRole('img', { name: 'Alice' }).textContent, 'A');
});

test('built-in and uploaded avatars replace the initial', () => {
  const { rerender } = render(<AccountAvatar username="Alice" avatar="preset:fox" />);
  assert.equal(screen.getByRole('img', { name: 'Alice' }).textContent, '🦊');
  rerender(<AccountAvatar username="Alice" avatar="data:image/png;base64,iVBORw0KGgo=" />);
  assert.equal(screen.getByRole('img', { name: 'Alice' }).getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=');
});
