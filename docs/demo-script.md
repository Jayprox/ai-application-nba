# Chalk That NBA: 2-minute demo

The point to land: **every number is real, verified against NBA.com, and
nothing is predicted.** Even the AI search only picks the query.

1. **Search (30 s).** Type *"Jokić on the second night of back-to-backs"*.
   One sentence with the numbers, the filters it used as chips, "Open the
   full view". Remove the back-to-back chip: the number changes, with no AI
   call. Then *"how is LA doing"*: it asks Lakers or Clippers instead of
   guessing.
2. **Player page (30 s).** Open the full view. Switch Season Avg → Last 10,
   set Venue: Away. "Last 10 + Away" = his last 10 road games (splits apply
   first). Toggle rest "His games" / "Team's schedule": NBA.com counts a
   player's own games, so a player back from injury is rested.
3. **Rankings → Matchups (20 s).** Centers, Points allowed: the 5 stingiest
   and 5 most generous defenses, per game and against league average. The
   same rank shows next to every prop line.
4. **Props (20 s, in season).** DraftKings lines for today, how often each
   player went over that exact line in his last 10 and this season, and the
   result once the game ends. Counts, not picks.
5. **Standings → Playoffs (10 s).** The bracket from the play-in to the
   Finals (2025-26: Knicks over Spurs, 4-1).
6. **The proof (10 s).** README "Verified against NBA.com": LeBron's rookie
   splits by days of rest match NBA.com game for game; the tests pin them.

If asked "how": NBA.com history loaded from a laptop (it blocks cloud IPs),
Highlightly for live games, The Odds API for props, one shared query engine
for web, the planned iOS app and AI agents, Claude Haiku only for turning a
question into a query (36/36 on real questions).
