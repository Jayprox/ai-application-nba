// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import Guide, { SECTIONS } from './Guide.jsx';

describe('Guide', () => {
  it('every jump-nav entry has its section (and nothing is left out of the nav)', () => {
    const { container } = render(<MemoryRouter><Guide /></MemoryRouter>);
    const sections = [...container.querySelectorAll('section[id]')].map((s) => s.id);
    expect(sections).toEqual(SECTIONS.map(([id]) => id));
    const nav = within(screen.getByRole('navigation', { name: 'Guide sections' }));
    for (const [id, label] of SECTIONS) {
      expect(nav.getByRole('link', { name: label }).getAttribute('href')).toBe(`#${id}`);
      expect(container.querySelector(`#${id} h2`).textContent.length).toBeGreaterThan(0);
    }
  });

  it('links into the app point at real routes', () => {
    const { container } = render(<MemoryRouter><Guide /></MemoryRouter>);
    const routes = new Set(['/', '/standings', '/teams', '/players', '/leaders', '/rankings', '/props', '/ask']);
    const hrefs = [...container.querySelectorAll('a[href^="/"]')].map((a) => a.getAttribute('href'));
    expect(hrefs.length).toBeGreaterThan(5);
    for (const h of hrefs) expect(routes.has(h)).toBe(true);
  });
});
