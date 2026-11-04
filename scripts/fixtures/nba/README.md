# NBA.com synthetic fixtures (M6)

No live NBA.com recording was authorised. Everything here is **synthetic**: it simulates NBA.com being
unreachable or answering with nothing, so the weekly best-effort path can be tested without a network.
Real recorded NBA.com files are not stored in this repo.

| Directory | Use (`SEED_FIXTURES=<dir>`) |
|---|---|
| `synthetic_unreachable/` | `_nba_unreachable.json` makes every NBA.com call fail like a blocked host (`{"kind":"timeout"}`). Only honoured with `--nba-best-effort`. |
| `synthetic_zero_rows/` | NBA.com "answers" with an empty season schedule, empty standings and no game logs (missing `gamelog_*` files default to empty). Weekly drill case W31. |
