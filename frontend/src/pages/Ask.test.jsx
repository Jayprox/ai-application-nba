// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { AskBox, withoutChip } from './Ask.jsx';

it('removing a chip drops exactly that field from the plan', () => {
  const plan = { kind: 'player_stats', player: 'Jokic', b2b: 2, venue: 'away' };
  expect(withoutChip(plan, 'venue')).toEqual({ kind: 'player_stats', player: 'Jokic', b2b: 2 });
  expect(plan.venue).toBe('away');
});

it('the search box sends you to /ask?q=…', () => {
  let loc;
  const Spy = () => { loc = useLocation(); return null; };
  render(<MemoryRouter initialEntries={['/']}><Routes><Route path="*" element={<><AskBox /><Spy /></>} /></Routes></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Ask a stats question'), { target: { value: 'Jokić on back-to-backs' } });
  fireEvent.submit(screen.getByRole('search'));
  expect(loc.pathname).toBe('/ask');
  expect(new URLSearchParams(loc.search).get('q')).toBe('Jokić on back-to-backs');
});
