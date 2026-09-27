// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary.jsx';

it('a render crash shows a recoverable message, not a blank page', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const Boom = () => { throw new Error('bad data shape'); };
  render(<ErrorBoundary><Boom /></ErrorBoundary>);
  expect(screen.getByRole('alert').textContent).toContain('Something went wrong');
  spy.mockRestore();
});
