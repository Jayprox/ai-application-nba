import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import ErrorBoundary from './ErrorBoundary.jsx';
import { useAuth } from '../lib/auth.jsx';

const LINKS = [['/', 'Scoreboard'], ['/standings', 'Standings'], ['/teams', 'Teams'], ['/players', 'Players'], ['/leaders', 'Leaders'], ['/rankings', 'Rankings'], ['/props', 'Props']];
const link = ({ isActive }) =>
  `shrink-0 rounded-md px-2.5 py-2 text-[14px] font-medium no-underline hover:bg-nav-hover hover:text-white sm:px-3 sm:text-[15px] ${isActive ? 'bg-nav-hover text-white' : 'text-nav-text'}`;

export default function Layout() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <div className="min-h-dvh">
      <header className="bg-ink">
        <nav aria-label="Main" className="mx-auto flex max-w-[1280px] flex-wrap items-center gap-x-4 gap-y-1 px-4 md:gap-x-8 py-2 sm:px-10 md:h-14 md:flex-nowrap md:py-0">
          <NavLink to="/" className="font-display text-xl font-bold sm:text-2xl tracking-[0.04em] text-paper no-underline hover:text-paper">
            CHALK THAT <span className="text-nav-accent">NBA</span>
          </NavLink>
          <button type="button" onClick={async () => { await logout(); navigate('/login'); }}
            className="ml-auto shrink-0 cursor-pointer rounded-md px-3 py-2 text-[15px] font-medium text-nav-text hover:bg-nav-hover hover:text-white md:order-last">
            Sign out
          </button>
          <div className="-mx-1 flex w-full gap-1 overflow-x-auto pr-6 [mask-image:linear-gradient(to_right,black_85%,transparent)] md:mx-0 md:w-auto md:grow md:pr-0 md:[mask-image:none]">
            {LINKS.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'} className={link}>{label}</NavLink>)}
          </div>
        </nav>
      </header>
      <main className="mx-auto flex max-w-[1280px] flex-col gap-6 px-4 py-6 sm:px-10 sm:py-8">
        <ErrorBoundary key={pathname}><Outlet /></ErrorBoundary>
      </main>
    </div>
  );
}
