// Multiplayer integration test WITHOUT the network: a deterministic in-memory
// harness that models the host-authoritative message flow (clients submit
// Actions → host validates ownership → applies → broadcasts state). It exercises
// the REAL host reducer (applyRemoteAction/claimRole/dropPlayer) and role model,
// with 1 Sauron host + 3 hero clients, proving state converges across peers and
// that ownership is enforced. WebRTC/PeerJS itself is transport-only and covered
// by the browser e2e; this locks the logic that rides on top of it.
import { describe, it, expect } from 'vitest';
import { cat } from './helpers';
import { applyAction, type Action } from '../src/engine/actions';
import { advance, newGame } from '../src/engine/game';
import { legalMoves } from '../src/engine/mechanics';
import { emptyRoster, SAURON_ROLE, type Roster } from '../src/net/roles';
import { applyRemoteAction, claimRole, dropPlayer } from '../src/net/host';

const THREE = Object.keys(cat.heroes).slice(0, 3);

/** A tiny in-memory session: the host owns (game, roster); clients hold a
 *  mirror of the last state the host broadcast to them. */
class Table {
  game = newGame(cat, 5, THREE);
  roster: Roster = emptyRoster(this.game);
  mirrors: Record<string, string> = {}; // playerId → JSON of last broadcast state

  advanceToHeroActions() {
    for (let i = 0; i < 50 && this.game.phase !== 'HeroActions'; i++) this.game = advance(this.game, cat);
    this.broadcast();
  }
  broadcast() {
    const snap = JSON.stringify(this.game);
    for (const pid of Object.keys(this.mirrors)) this.mirrors[pid] = snap;
  }
  connect(pid: string) { this.mirrors[pid] = JSON.stringify(this.game); }
  claim(pid: string, name: string, role: string, release = false) {
    this.roster = claimRole(this.roster, this.game, pid, name, role, release);
  }
  /** A client submits an action; host validates + applies + rebroadcasts. */
  submit(pid: string, action: Action) {
    this.game = applyRemoteAction(this.game, this.roster, cat, pid, action);
    this.broadcast();
  }
  /** The host itself acts (referee) — always allowed. */
  hostAct(action: Action) { this.game = applyAction(this.game, cat, action); this.broadcast(); }
  drop(pid: string) { this.roster = dropPlayer(this.roster, pid)!; delete this.mirrors[pid]; }
}

const activeHero = (t: Table) => t.game.heroes[t.game.activeHeroIndex];

describe('multiplayer — host-authoritative flow (1 Sauron host + 3 hero clients)', () => {
  it('seats a Sauron host and three hero players, each owning their hero', () => {
    const t = new Table();
    const heroes = t.game.heroes.map((h) => h.id);
    expect(heroes.length).toBe(3);
    t.claim('host', 'Host', SAURON_ROLE);
    t.connect('p1'); t.claim('p1', 'Ann', heroes[0]);
    t.connect('p2'); t.claim('p2', 'Bo', heroes[1]);
    t.connect('p3'); t.claim('p3', 'Cy', heroes[2]);
    expect(t.roster[SAURON_ROLE]).toMatchObject({ kind: 'human', playerId: 'host' });
    expect(t.roster[heroes[0]]).toMatchObject({ kind: 'human', playerId: 'p1' });
    expect(t.roster[heroes[1]]).toMatchObject({ kind: 'human', playerId: 'p2' });
    expect(t.roster[heroes[2]]).toMatchObject({ kind: 'human', playerId: 'p3' });
  });

  it('applies an action from the owning player and broadcasts the new state to all mirrors', () => {
    const t = new Table();
    t.connect('p1'); t.connect('p2'); t.connect('p3');
    const h = activeHero(t);
    t.claim('p1', 'Ann', h.id);
    t.advanceToHeroActions();
    const owner = t.game.heroes[t.game.activeHeroIndex];
    // ensure p1 owns the currently-active hero for a clean move
    t.claim('p1', 'Ann', owner.id);
    const dest = legalMoves(cat, owner)[0]?.to;
    expect(dest).toBeTruthy();

    const before = t.game.map ? owner.location : owner.location;
    t.submit('p1', { t: 'move', heroId: owner.id, to: dest });
    const moved = t.game.heroes.find((x) => x.id === owner.id)!;
    expect(moved.location).toBe(dest);
    expect(moved.location).not.toBe(before);
    // every connected client sees the identical authoritative state
    const snap = JSON.stringify(t.game);
    expect(t.mirrors.p1).toBe(snap);
    expect(t.mirrors.p2).toBe(snap);
    expect(t.mirrors.p3).toBe(snap);
  });

  it('rejects an action from a player who does not own that hero (no state change)', () => {
    const t = new Table();
    t.connect('p1'); t.connect('p2');
    t.advanceToHeroActions();
    const owner = t.game.heroes[t.game.activeHeroIndex];
    t.claim('p1', 'Ann', owner.id); // p1 owns it, p2 does not
    const dest = legalMoves(cat, owner)[0]?.to;
    const before = JSON.stringify(t.game);
    t.submit('p2', { t: 'move', heroId: owner.id, to: dest }); // p2 is not the owner
    expect(JSON.stringify(t.game)).toBe(before); // unchanged
  });

  it('never lets a non-host client drive shared phase flow (advance)', () => {
    const t = new Table();
    t.connect('p1');
    t.advanceToHeroActions();
    const before = JSON.stringify(t.game);
    t.submit('p1', { t: 'advance' });
    expect(JSON.stringify(t.game)).toBe(before); // advance is host-only game flow
    // the host, as referee, CAN advance
    t.hostAct({ t: 'endHeroActions' });
    expect(JSON.stringify(t.game)).not.toBe(before);
  });

  it('lets a hero-role client end their own turn without the host\'s help', () => {
    const t = new Table();
    t.connect('p1');
    t.advanceToHeroActions();
    const owner = t.game.heroes[t.game.activeHeroIndex];
    t.claim('p1', 'Ann', owner.id);
    const before = JSON.stringify(t.game);
    t.submit('p1', { t: 'endHeroActions' });
    expect(JSON.stringify(t.game)).not.toBe(before); // their own turn — allowed
  });

  it('still rejects endHeroActions from someone who does not own the active hero', () => {
    const t = new Table();
    t.connect('p1'); t.connect('p2');
    t.advanceToHeroActions();
    const owner = t.game.heroes[t.game.activeHeroIndex];
    t.claim('p1', 'Ann', owner.id); // p1 owns the active hero, p2 owns nothing
    const before = JSON.stringify(t.game);
    t.submit('p2', { t: 'endHeroActions' });
    expect(JSON.stringify(t.game)).toBe(before); // unchanged — not p2's hero
  });

  it('frees a kicked/departed player\'s roles back to open (AI takeover)', () => {
    const t = new Table();
    t.connect('p1');
    const h = activeHero(t);
    t.claim('p1', 'Ann', h.id);
    expect(t.roster[h.id].kind).toBe('human');
    t.drop('p1');
    expect(t.roster[h.id].kind).toBe('open'); // now unowned → AI runs it
    expect(t.mirrors.p1).toBeUndefined();
    // an action from the departed player is now rejected
    const before = JSON.stringify(t.game);
    t.game = applyRemoteAction(t.game, t.roster, cat, 'p1', { t: 'rest', heroId: h.id });
    expect(JSON.stringify(t.game)).toBe(before);
  });

  it('host-applied actions equal a direct single-player engine call (no divergence)', () => {
    const t = new Table();
    t.advanceToHeroActions();
    const solo = JSON.parse(JSON.stringify(t.game));
    t.hostAct({ t: 'endHeroActions' });
    const viaHost = JSON.stringify(t.game);
    const viaEngine = JSON.stringify(applyAction(solo, cat, { t: 'endHeroActions' }));
    expect(viaHost).toBe(viaEngine);
  });

  it('lets a Sauron-role client drive their own turn (story step → events → begin action → end) without the host — regression: SauronPanel used to bypass the Action layer entirely via a raw setState, which only worked for the host and silently did nothing useful for a remote client', () => {
    const t = new Table();
    t.connect('p1');
    t.claim('p1', 'Sam', SAURON_ROLE);
    t.advanceToHeroActions();
    // End every hero's turn (as host/referee) until control passes to Sauron,
    // resolving any incidental pending prompts (tree decisions / choices) that
    // a hero's turn-end can raise along the way.
    for (let i = 0; i < 40 && t.game.phase !== 'SauronRefresh'; i++) {
      if (t.game.pendingTree) { t.hostAct({ t: 'treeDecision', optionIndex: 0 }); continue; }
      if (t.game.pendingChoice) { t.hostAct({ t: 'choice', optionId: t.game.pendingChoice.options[0].id }); continue; }
      t.hostAct({ t: 'endHeroActions' });
    }
    expect(t.game.phase).toBe('SauronRefresh');

    // Any incidental pending prompt (tree decision / choice) raised along the
    // way — by either a hero's turn-end or a Sauron step itself — is resolved
    // by the host (referee) before the Sauron-role client's next step.
    const settle = () => {
      for (let i = 0; i < 10 && (t.game.pendingTree || t.game.pendingChoice); i++) {
        if (t.game.pendingTree) t.hostAct({ t: 'treeDecision', optionIndex: 0 });
        else if (t.game.pendingChoice) t.hostAct({ t: 'choice', optionId: t.game.pendingChoice.options[0].id });
      }
    };

    const beforeStory = JSON.stringify(t.game);
    t.submit('p1', { t: 'sauronStoryStep' });
    expect(JSON.stringify(t.game)).not.toBe(beforeStory);
    settle();
    expect(t.game.phase).toBe('SauronEvents');

    t.submit('p1', { t: 'sauronResolveEvents' });
    settle();
    expect(t.game.phase).toBe('SauronMinions');

    // A player who never claimed Sauron cannot act on their behalf.
    t.connect('p2');
    const beforeReject = JSON.stringify(t.game);
    t.submit('p2', { t: 'sauronEndActionStep' });
    expect(JSON.stringify(t.game)).toBe(beforeReject);

    // The Sauron-role client ends their own Action Step.
    t.submit('p1', { t: 'sauronEndActionStep' });
    settle();
    expect(t.game.phase).not.toBe('SauronMinions');

    // Every connected mirror (including the non-Sauron client) converged on
    // the same authoritative state — this is the crux of the regression: a
    // remote Sauron player's turn must actually reach every other peer.
    const snap = JSON.stringify(t.game);
    expect(t.mirrors.p1).toBe(snap);
    expect(t.mirrors.p2).toBe(snap);
  });
});
