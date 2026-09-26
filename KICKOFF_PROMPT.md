# Kickoff prompt

Paste this into a new chat to start building Chalk That NBA.

---

I'm building Chalk That NBA, the second app in the Chalk That platform
(after Chalk That NFL). Read `PLATFORM.md` at this repo's root first — it's
the sport-agnostic pattern established by NFL (query engine, no predictive
calculations in Part 1, canonical ID + crosswalk, ingestion as its own
worker, two-tier auth, the Node/Postgres/Redis/React/Railway stack) and it
applies here unchanged. Then read `docs/architecture.md` in this repo,
which has all of NBA's own decisions already made in a design brainstorm:
the 3-vendor data source split (`nba_api`, Highlightly, The Odds API), the
unified `player_game_stats` schema (no offense/defense-style split, since
NBA stats are positionless), the 5 MVP situational splits (home/away,
back-to-back, rest days, national TV, altitude), and the MVP scope line —
stats app + real leaderboards ship first, player props AND the deterministic
rankings/matchup-insight layer (including team-unit defense/offense
rankings, which don't even exist in Chalk That NFL yet) fast-follow
together once that foundation is proven.

There's also a separate, older `ai-agent-nba` repo in this workspace —
that's explicitly unrelated prior work (different stack, different
philosophy), not a foundation for this app. Don't reference it.

Once you've read both docs: let's work through the actual build the same
way the architecture was decided — real vendor sign-ups and dry-run tests
before trusting any data source, `docs/vibe-coding-checklist.md` (already
copied into this repo) as the phase-by-phase build process, and the real
schema/screens/build order worked out together before writing code, not
picked and started on unilaterally.
