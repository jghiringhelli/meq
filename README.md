# Middle-earth Quest — Digital Edition (fan-made, unofficial)

A free, fan-made digital adaptation of *Middle-earth Quest* (Fantasy Flight
Games, 2009). Built for playtesting with friends online or solo against an AI.

**▶ Play here:** https://middle-earth-quest-board-game.netlify.app

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

See `src/engine/` for the rules engine (pure functions, no UI dependencies),
`src/play/` for the React UI, and `src/net/` for the peer-to-peer multiplayer
layer. Issues and PRs welcome — this is a hobby project, so response time
varies, but bug reports (especially with an attached report JSON) are always
appreciated.
