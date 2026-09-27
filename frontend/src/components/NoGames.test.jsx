// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NoGames } from './StatExplorer.jsx';

const p = { season: '2025-26', type: 'playoffs' };

it("explains a game type the player didn't play, and offers the ones he did (Curry 2025-26)", () => {
  const onType = vi.fn();
  render(<NoGames name="Stephen Curry" p={p} where="2025-26 playoffs" splitCount={0} played={['play_in', 'regular']} onType={onType} onClear={() => {}} />);
  expect(document.body.textContent).toContain("Stephen Curry didn't play in the 2025-26 playoffs.");
  fireEvent.click(screen.getByText('Show Play-In'));
  expect(onType).toHaveBeenCalledWith('play_in');
});

it('with splits applied: says the splits are the reason, offers to clear them; team possessive reads right', () => {
  const onClear = vi.fn();
  render(<NoGames name="the Golden State Warriors" p={{ ...p, type: 'regular' }} where="2025-26 regular season" splitCount={2} played={['regular']} onType={() => {}} onClear={onClear} />);
  expect(document.body.textContent).toContain("None of the Golden State Warriors' 2025-26 regular season games match these splits.");
  fireEvent.click(screen.getByText('Clear splits'));
  expect(onClear).toHaveBeenCalled();
});
