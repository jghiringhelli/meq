# Middle-earth Quest — Digital Edition (fan-made, unofficial)

A free, fan-made digital adaptation of *Middle-earth Quest* (Fantasy Flight
Games, 2009). Built for playtesting with friends online or solo against an AI.

**▶ Play here:** https://jghiringhelli.github.io/meq/

> **This is an unofficial, non-commercial fan project.** Middle-earth Quest,
> its setting, art, and all associated trademarks belong to Fantasy Flight
> Games / Asmodee and the Tolkien Estate / Middle-earth Enterprises. This
> project is not affiliated with, endorsed by, or sponsored by any of them,
> is not for sale, and exists only so a small group of friends (and now
> anyone curious) can play the game digitally. If you enjoy it, please
> support the official game — get the physical copy if you can find one.

## What this is

- A from-scratch TypeScript/React implementation of the full rules: quests,
  combat, corruption, Sauron's shadow/plot/minion economy, favor & training,
  travel & the location graph, and both a solo AI opponent and real
  peer-to-peer online multiplayer (host + up to 4 clients, no server/backend
  required — WebRTC via PeerJS).
- Still actively being fixed and refined against the rulebook. It's playable
  and (as far as we know) rules-accurate, but this is a fan project made in
  spare time, not a polished commercial release — expect occasional rough
  edges, especially in newer/less-tested corners of the rules.

## First run: load the art (once)

This project ships **no artwork**. Download the free community VASSAL module (Middle_Earth_Quest_1.6.vmod, https://obj.vassalengine.org/images/0/05/Middle_Earth_Quest_1.6.vmod) and pick it with **Load VASSAL module (.vmod)** on the start screen. It is read in your browser, never uploaded, and saved in the browser's local storage, so you only do it once per browser. Without it the map is blank.

## Beta status

This is a beta made in spare time. Rules follow the official rulebook (no balance changes). Bugs and quality-of-life suggestions are welcome via GitHub issues (templates include screenshots); fan content is optional. No timelines promised.

Known limitations:

- **Hero AI is decent but not smart.** It has been improved (stops at havens, avoids loops, doesn't give up combats early, heads for plots when it has favor), but in simulations AI-only heroes still lose to the Sauron AI most of the time. Playing the Heroes yourself is the better-tested side.
- **Playing Sauron as a human is new** and the least tested part of the game; expect rough edges.
- **Online play is experimental.** It is peer-to-peer and host-authoritative: the host's browser holds the game, so nobody can play while the host is offline. To continue later, the host resumes the slot with 🌐 Host and friends rejoin with the new code.
- **Saves live only in your browser** (several slots, oldest evicted if storage fills). Clearing site data deletes them.
- **The Finale and some rarer card interactions are lightly tested**, and the mobile layout is experimental.

Artwork: no official art is shipped, out of respect for the IP. If you own the original game, load your copy of the VASSAL module in the browser and the real card art is used locally (never uploaded).

## Reporting a bug

Found something that looks wrong, or the app crashed? From inside the game,
click **"Report a problem"** (top-right of the header, or on the crash screen
if the app broke entirely). It will:

1. Ask you to briefly describe what happened.
2. Download a JSON file with the full game state, log, and your browser info
   (nothing about you personally — this never leaves your device automatically).
3. Open a pre-filled GitHub issue in a new tab.

Just **drag the downloaded JSON file into that issue** and submit it. That's
the single most useful thing you can attach — it lets us reproduce almost any
bug exactly as it happened.

No GitHub account? You can also just describe the bug (and if possible, the
turn/seed number shown in the in-app log) as a reply on the BGG thread instead.

## Running it locally / contributing

```bash
npm install
npm run dev       # http://localhost:5173
npm run test:all  # full test suite (unit + integration)
```

Contributions are open to everyone: read [CONTRIBUTING.md](CONTRIBUTING.md)
first (ground rules, where things live, how to test). Code is MIT-licensed
(see `LICENSE`; game content and art are not).

See `src/engine/` for the rules engine (pure functions, no UI dependencies),
`src/play/` for the React UI, and `src/net/` for the peer-to-peer multiplayer
layer. Issues and PRs welcome — this is a hobby project, so response time
varies, but bug reports (especially with an attached report JSON) are always
appreciated.
