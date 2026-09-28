// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { PropCheck } from './StatExplorer.jsx';

const upcoming = {
  game: { id: 'g', date: '2026-10-21', tipoff_utc: '2026-10-21T23:30:00Z', status: 'scheduled', home: 'DEN', away: 'OKC' },
  lines: [
    { market: 'pts', label: 'Points', line: 27.5, over_price: -115, under_price: -105, snapshot: 'close', open_line: 28.5 },
    { market: 'pra', label: 'Pts + Reb + Ast', line: 50.5, over_price: -110, under_price: -110, snapshot: 'close', open_line: null },
  ],
};

it('shows each line with how often he went over it in the selected games, plus his record vs past lines', () => {
  render(<PropCheck upcoming={upcoming} hits={{ pts: { line: 27.5, over: 7, under: 3, push: 0, games: 10 }, pra: { line: 50.5, over: 0, under: 0, push: 0, games: 0 } }}
    record={{ pts: { label: 'Points', over: 5, under: 3, push: 1, games: 9 } }} />);
  const text = document.body.textContent;
  expect(text).toContain('OKC @ DEN');
  expect(text).toContain('closing lines');
  expect(text).toContain('PTS 27.5');
  expect(text).toContain('Over 7 of 10');
  expect(text).toContain('no games');
  expect(text).toContain('PTS 5–3–1');
});

it('renders nothing with no lines and no history', () => {
  const { container } = render(<PropCheck upcoming={null} hits={undefined} record={{}} />);
  expect(container.innerHTML).toBe('');
});
