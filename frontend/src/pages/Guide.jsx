import { Link } from 'react-router';
import { PageTitle } from '../components/Controls.jsx';

/**
 * Guide: a permanent reference for what every screen does and how to read
 * its numbers. It's a real nav item, not a one-time tour, so a returning
 * user can look up what "usage (est.)" or "rest measured by his games" means.
 * Same idea as Chalk That NFL's Guide page.
 *
 * Static content, no API calls. Written from what each page actually does
 * (2026-09-28). Keep it in sync when a page changes: a stale guide is worse
 * than none. Every SECTIONS entry needs a matching <Section id> below
 * (Guide.test.jsx checks this).
 */

export const SECTIONS = [
  ['principles', 'How this app works'],
  ['scoreboard', 'Scoreboard & box scores'],
  ['standings', 'Standings'],
  ['teams', 'Teams'],
  ['players', 'Players'],
  ['splits', 'Splits'],
  ['leaders', 'Leaders'],
  ['rankings', 'Rankings'],
  ['props', 'Props'],
  ['ask', 'Ask'],
  ['glossary', 'Stat glossary'],
  ['data', 'Where the data comes from'],
];

const A = ({ to, children }) => <Link to={to}>{children}</Link>;
const B = ({ children }) => <strong className="font-semibold text-ink">{children}</strong>;

function Section({ id, title, children }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-6 border-b border-line py-7 last:border-b-0">
      <h2 id={`${id}-h`} className="m-0 mb-3 font-display text-[26px] font-bold leading-tight">{title}</h2>
      <div className="flex max-w-[760px] flex-col gap-3 text-[15px] leading-relaxed text-muted">{children}</div>
    </section>
  );
}

function Terms({ items }) {
  return (
    <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[180px_1fr]">
      {items.map(([term, def]) => (
        <div key={term} className="contents">
          <dt className="font-semibold text-ink">{term}</dt>
          <dd className="m-0 mb-2 sm:mb-0">{def}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function Guide() {
  return (
    <>
      <PageTitle eyebrow="How to use Chalk That NBA">Guide</PageTitle>
      <p className="m-0 max-w-[760px] text-[15px] leading-relaxed text-muted">
        What every screen does and how to read its numbers. The guide is always one click away in the menu.
      </p>

      <nav aria-label="Guide sections" className="flex flex-wrap gap-2 border-b border-line pb-5">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`}
            className="rounded-md border border-line bg-card px-3 py-1.5 text-[13px] font-medium text-muted no-underline hover:bg-card-2 hover:text-ink">
            {label}
          </a>
        ))}
      </nav>

      <div>
        <Section id="principles" title="How this app works">
          <p>
            <B>Every number is a real, recorded one.</B> Averages, splits, leaderboards and hit rates are counted from actual
            NBA box scores at the moment you ask. There are no projections, win probabilities or confidence scores anywhere
            in the app.
          </p>
          <p>
            <B>Every number comes with its sample size.</B> "38 games" or "his team went 21-17 in these games" sits next to
            the stats, because 27 points a game over 4 games means something different than over 60. Small samples are
            shown, not hidden, so read the count.
          </p>
          <p>
            <B>The numbers are checked against NBA.com.</B> Season averages, rest splits, TS% and standings are tested
            against NBA.com's published figures. A few stats have to be estimated from box scores because NBA.com builds them
            from play-by-play; those are always marked <B>est.</B> (team ratings, pace, and usage rate).
          </p>
          <p>
            <B>Notes under a result are part of the answer.</B> When a filter leaves games out (for example, neutral-site games
            aren't home or away), a short note says so.
          </p>
        </Section>

        <Section id="scoreboard" title="Scoreboard & box scores">
          <p>
            The <A to="/">Scoreboard</A> is the home page: every game on a date, with the score or tip-off time (in your own
            time zone), the TV network, and context like the playoff round, NBA Cup stage, or "in Mexico City" for
            neutral-site games. The arrows jump to the previous or next date that <em>has</em> games, so the All-Star break
            and the offseason are skipped.
          </p>
          <p>
            Tap a game for its <B>box score</B>: both teams' player lines (S = starter), who didn't play and why, team
            totals, and the <B>split tags</B> for each team: home, away or neutral; days of rest; night 1 or 2 of a
            back-to-back; altitude; and national TV. These are the same tags the filters on player and team pages use, so a
            game you see tagged "2nd night of a back-to-back" is exactly a game the B2B filter counts.
          </p>
        </Section>

        <Section id="standings" title="Standings">
          <p>
            <A to="/standings">Standings</A> has two views. <B>Standings</B> shows each conference with W-L, win %, games
            back, home and road records (neutral-site games count for neither, as on NBA.com), conference record, last 10,
            streak, and clinch marks. Lines mark the playoff and play-in cutoffs, which change by era: 8 playoff teams before
            2019-20, the 2020 bubble's 8-vs-9 play-in, and 6 + a 7-10 play-in since 2020-21.
          </p>
          <p>
            Ranks use NBA.com's official standings, so ties are broken by the NBA's own tiebreakers. If the official
            standings haven't synced yet, teams are ordered by win % and a note says so. <B>Playoffs</B> shows the bracket
            and play-in for any season, with each series score.
          </p>
        </Section>

        <Section id="teams" title="Teams">
          <p>
            <A to="/teams">Teams</A> lists all 30 by conference and division. A team page has the same stat explorer as a
            player page (season, last 5, last 10, game log, every season type and split) with team numbers: points for and
            against, and offensive, defensive and net rating (est.).
          </p>
          <p>
            It also shows <B>everyone who played for the team</B> that season, with players traded in or out counted for the
            games they played there, and <B>defense by position</B>: what opposing guards, forwards and centers average
            against this team, ranked 1-30 (see <a href="#rankings">Rankings</a>).
          </p>
        </Section>

        <Section id="players" title="Players">
          <p>
            <A to="/players">Players</A> searches by name, ignoring accents and punctuation ("jokic" finds Jokić). The{' '}
            <B>Active</B> toggle is on by default; turn it off to search everyone back to 2003-04, retired players included.
            You can also filter by team.
          </p>
          <p>A player page is the heart of the app. From the top:</p>
          <Terms items={[
            ['Scope tabs', 'Season Avg, Last 5, Last 10, Career (every season since 2003-04, plus totals) and Game Log (every game, newest first; tap one for its box score).'],
            ['Season & type', 'Pick any season he played, and Regular season (default), Play-In, Playoffs, NBA Cup, or All. Types never mix unless you choose All. If he didn\'t play in the playoffs that year, the page says so instead of showing zeros.'],
            ['Splits', 'Narrow to certain kinds of games: home or away, back-to-backs, days of rest, national TV, altitude (see Splits below). Splits apply first, then the window, so Last 10 + Away means his last 10 road games.'],
            ['Tiles', 'Per-game averages for the games that match, then Efficiency & usage: TS%, eFG%, FT rate, points, rebounds and assists per 36 minutes, and usage rate (est.). See the glossary.'],
            ['Prop check', 'On game days, his DraftKings lines for tonight and how he did against those exact numbers in the games you\'ve selected, e.g. "over 25.5 in 7 of his last 10 road games".'],
            ['Game log', 'Every game with his line, the split tags, and the DraftKings points line for that game and whether he went over or under (from 2026-27 on).'],
          ]} />
        </Section>

        <Section id="splits" title="Splits">
          <Terms items={[
            ['Rest measured by', <>"His games" (default) counts rest from <em>his</em> last game; that's how NBA.com splits players. "Team's schedule" counts from the team's last game. They differ only around games he sat out.</>],
            ['Venue', 'Home or away. Neutral-site games (international games, NBA Cup knockouts in Las Vegas, the 2020 bubble) count for neither, but are in All.'],
            ['Back-to-back', 'Night 1 = he (or the team) plays again tomorrow. Night 2 = he played yesterday too, the classic tired-legs game.'],
            ['Rest days', '0 (a back-to-back), 1, 2, or 3+ days off before the game. A season opener counts rest from the last preseason game, as NBA.com does.'],
            ['National TV', 'Major (ESPN, ABC, TNT, NBC, Prime), NBA TV, or Local.'],
            ['Altitude', 'Games at arenas 4,000 ft up or higher: Denver, Utah and Mexico City.'],
          ]} />
          <p>Combine as many as you like. The header always shows how many games matched and the team's record in them.</p>
        </Section>

        <Section id="leaders" title="Leaders">
          <p>
            <A to="/leaders">Leaders</A> ranks per-game averages in points, rebounds, assists, 3-pointers, steals, blocks and
            usage, for any season and for the regular season, playoffs, or all games.
          </p>
          <p>
            To qualify, a player must have played in <B>at least 70% of his team's games</B> so far. This is Chalk That's
            own rule, not the NBA's official one; it scales with the season, so it works in November too, and a hot
            3-game stretch can't top the list. The <B>usage</B> board also needs 15+ minutes per game, so a player who
            gets 4 minutes a night can't lead it. The "Who qualifies" box shows the exact cutoff.
          </p>
        </Section>

        <Section id="rankings" title="Rankings">
          <p><A to="/rankings">Rankings</A> has three views, each for the full season or the last 10 games:</p>
          <Terms items={[
            ['Players', 'Guards, forwards and centers ranked by a score: how far above or below the average qualified player at his position he is in points, rebounds, assists, steals, blocks, 3PM, TS% and turnovers (fewer is better), each counting equally. 0 = average for the position. Every piece of the score is shown, so you can see why someone ranks where he does.'],
            ['Teams', 'Offensive, defensive and net rating and pace, each ranked 1-30. Ratings are points per 100 possessions, with possessions estimated from the box score (est.), so they differ slightly from NBA.com.'],
            ['Matchups', 'What each defense allows per game to guards, forwards and centers, in every prop stat. Rank 1 = allows the fewest (a tough matchup); the best 5 are marked strong and the worst 5 weak.'],
          ]} />
          <p>Positions come from NBA.com's listing; a hybrid like G-F counts as his first position.</p>
        </Section>

        <Section id="props" title="Props">
          <p>
            <A to="/props">Props</A> shows <B>DraftKings player lines</B> for a date in 12 markets (points, rebounds, assists,
            3-pointers, the combos like Pts + Reb + Ast, steals, blocks, steals + blocks, turnovers). Lines are pulled twice
            per game: the opening line in the morning and the closing line about 30 minutes before tip. The board shows the
            closing line once it exists, and the move from the open.
          </p>
          <p>
            Next to each line: how often he went <B>over this exact line</B> in his last 10 games and this season, counting
            only games <em>before</em> this date. Before he has played this season, last season's rate is shown instead. After the game, the result
            is graded: over, under, push (only possible on a whole-number line), or no action if he didn't play.
          </p>
          <p>
            The <B>matchup note</B> says where tonight's opponent ranks against his position in that stat (e.g. "NYK: 27th
            of 30 vs forwards", 1 = allows the fewest), once the opponent has played 5 games. These are counts from real games, not picks; the
            app never says which side to take.
          </p>
        </Section>

        <Section id="ask" title="Ask">
          <p>
            <A to="/ask">Ask</A> answers questions in plain English: "Jokić on the second night of back-to-backs", "who leads
            the league in steals", "which teams give up the most points to centers", "has Edwards gone over 27.5 points
            lately".
          </p>
          <p>
            An AI model (Claude) only works out <em>which</em> query to run. The numbers come from the same database and
            checks as every other page, and the answer sentence is built from those numbers, so the AI never writes a stat.
            Each filter it chose shows as a chip; remove one to re-run without it. If a name is ambiguous ("LA"), it asks
            which one instead of guessing.
          </p>
          <p>
            It won't answer predictions ("who will win"), betting advice, injuries, news, or other sports. Searches are
            limited to 20 a minute and 300 a day per account.
          </p>
        </Section>

        <Section id="glossary" title="Stat glossary">
          <Terms items={[
            ['TS%', 'True shooting: points per shooting attempt, counting 3s and free throws. The best single measure of scoring efficiency. Shown like .612.'],
            ['eFG%', 'Effective FG%: field-goal % with a made 3 worth 1.5 makes.'],
            ['FT rate', 'Free-throw attempts per field-goal attempt: how often he gets to the line.'],
            ['Per 36', 'Points, rebounds or assists per 36 minutes played, to compare starters and bench players on equal minutes.'],
            ['Usage (est.)', 'The share of his team\'s plays (shots, free-throw trips, turnovers) he used while on the floor. About 20% is average; stars run 30%+. Estimated from box scores.'],
            ['Off / Def rtg (est.)', 'Points scored / allowed per 100 possessions. Net rating = offense minus defense.'],
            ['Pace (est.)', 'Possessions per game.'],
            ['+/-', 'The score difference while he was on the floor.'],
            ['Record', 'His team\'s W-L in the games you\'re looking at.'],
          ]} />
          <p>Percentages and ratios are computed from season totals (sums), the way NBA.com does, not by averaging each game's percentage.</p>
        </Section>

        <Section id="data" title="Where the data comes from">
          <Terms items={[
            ['History', 'NBA.com game logs, every game since 2003-04. Careers that started earlier are partial, and the page says so.'],
            ['This season', 'Scores update about every 5 minutes during games and box scores land at the final buzzer. NBA.com is re-checked weekly so any late stat corrections are picked up.'],
            ['Freshness', '"Synced 1 day ago" under a result is when the data was last updated.'],
            ['Prop lines', 'DraftKings, via The Odds API, from the 2026-27 season on.'],
            ['Injuries', 'Not shown yet: an injury feed is still being tested. When it\'s ready, a badge will appear on player pages.'],
          ]} />
        </Section>
      </div>
    </>
  );
}
