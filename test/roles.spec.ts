import { describe, it, expect } from 'vitest';
import { cat, freshGame } from './helpers';
import {
  allRoles, emptyRoster, activeRole, actionRole, mayDispatch,
  assignRole, releasePlayer, aiRoles, rolesOf, SAURON_ROLE,
  markDisconnected, markReconnected,
} from '../src/net/roles';

const heroId = (s: ReturnType<typeof freshGame>) => s.heroes[s.activeHeroIndex].id;

describe('multiplayer role / controller model', () => {
  it('allRoles is one per hero plus Sauron', () => {
    const s = freshGame();
    const roles = allRoles(s);
    expect(roles).toContain(SAURON_ROLE);
    expect(roles.filter((r) => r !== SAURON_ROLE).sort()).toEqual(s.heroes.map((h) => h.id).sort());
    expect(roles.length).toBe(s.heroes.length + 1);
  });

  it('emptyRoster starts every role open', () => {
    const s = freshGame();
    const r = emptyRoster(s);
    expect(Object.values(r).every((c) => c.kind === 'open')).toBe(true);
    expect(aiRoles(r).sort()).toEqual(allRoles(s).sort());
  });

  it('actionRole maps hero actions to the acting hero', () => {
    const s = freshGame();
    const h = heroId(s);
    expect(actionRole(s, { t: 'move', heroId: h, to: 'bree' })).toBe(h);
    expect(actionRole(s, { t: 'rest', heroId: h })).toBe(h);
    expect(actionRole(s, { t: 'survey', heroId: h })).toBe(h);
  });

  it('actionRole maps phase flow to "flow" and shared prompts to the active role', () => {
    const s = freshGame();
    expect(actionRole(s, { t: 'advance' })).toBe('flow');
    // Ending YOUR hero's turn is per-hero, not shared flow — the active role
    // (whichever hero is up) owns it, so its own claimant may end it themselves.
    expect(actionRole(s, { t: 'endHeroActions' })).toBe(activeRole(s));
    expect(actionRole(s, { t: 'choice', optionId: 'x' })).toBe(activeRole(s));
    expect(actionRole(s, { t: 'dismissReveal' })).toBe(activeRole(s));
  });

  it('the host may dispatch anything (referee)', () => {
    const s = freshGame();
    const r = emptyRoster(s);
    expect(mayDispatch(r, 'host', true, s, { t: 'advance' })).toBe(true);
    expect(mayDispatch(r, 'host', true, s, { t: 'move', heroId: heroId(s), to: 'bree' })).toBe(true);
  });

  it('a non-host may only dispatch for a role they own', () => {
    const s = freshGame();
    const h = heroId(s);
    let r = emptyRoster(s);
    // unclaimed → not allowed
    expect(mayDispatch(r, 'p1', false, s, { t: 'move', heroId: h, to: 'bree' })).toBe(false);
    // claim → allowed
    r = assignRole(r, h, { kind: 'human', playerId: 'p1', name: 'Ann' });
    expect(mayDispatch(r, 'p1', false, s, { t: 'move', heroId: h, to: 'bree' })).toBe(true);
    // someone else still cannot
    expect(mayDispatch(r, 'p2', false, s, { t: 'move', heroId: h, to: 'bree' })).toBe(false);
    // and non-hosts can never drive phase flow
    expect(mayDispatch(r, 'p1', false, s, { t: 'advance' })).toBe(false);
  });

  it('releasePlayer frees every role a player held', () => {
    const s = freshGame();
    const h = heroId(s);
    let r = emptyRoster(s);
    r = assignRole(r, h, { kind: 'human', playerId: 'p1', name: 'Ann' });
    r = assignRole(r, SAURON_ROLE, { kind: 'human', playerId: 'p1', name: 'Ann' });
    expect(rolesOf(r, 'p1').sort()).toEqual([SAURON_ROLE, h].sort());
    r = releasePlayer(r, 'p1');
    expect(rolesOf(r, 'p1')).toEqual([]);
    expect(r[h].kind).toBe('open');
    expect(r[SAURON_ROLE].kind).toBe('open');
  });

  it('markDisconnected reserves a dropped player\'s role(s) instead of freeing them (regression: reconnection support)', () => {
    const s = freshGame();
    const h = heroId(s);
    let r = emptyRoster(s);
    r = assignRole(r, h, { kind: 'human', playerId: 'p1', name: 'Ann' });
    r = markDisconnected(r, 'p1');
    // still owned by p1 (not 'open'/AI) — nobody else may claim it...
    expect(r[h]).toMatchObject({ kind: 'human', playerId: 'p1', connected: false });
    expect(mayDispatch(r, 'p2', false, s, { t: 'move', heroId: h, to: 'bree' })).toBe(false);
    // ...and rolesOf still reports p1 as the owner (used for viewer-side gating).
    expect(rolesOf(r, 'p1')).toEqual([h]);
  });

  it('markReconnected restores connected:true when the same persistent id returns', () => {
    const s = freshGame();
    const h = heroId(s);
    let r = emptyRoster(s);
    r = assignRole(r, h, { kind: 'human', playerId: 'p1', name: 'Ann' });
    r = markDisconnected(r, 'p1');
    r = markReconnected(r, 'p1');
    expect(r[h]).toMatchObject({ kind: 'human', playerId: 'p1', connected: true });
    // p1 can dispatch again immediately, without re-claiming.
    expect(mayDispatch(r, 'p1', false, s, { t: 'move', heroId: h, to: 'bree' })).toBe(true);
  });

  it('actionRole maps every interactive-Sauron-turn action to SAURON_ROLE (regression: a networked client controlling Sauron needs sauronStoryStep/sauronPlayPlot/etc. to route through the same role check as combatOrPeril/shadowReaction)', () => {
    const s = freshGame();
    expect(actionRole(s, { t: 'sauronStoryStep' })).toBe(SAURON_ROLE);
    expect(actionRole(s, { t: 'sauronPlayPlot', plotId: 'x' })).toBe(SAURON_ROLE);
    expect(actionRole(s, { t: 'sauronResolveEvents' })).toBe(SAURON_ROLE);
    expect(actionRole(s, { t: 'sauronBeginAction', track: 'influence' })).toBe(SAURON_ROLE);
    expect(actionRole(s, { t: 'sauronPlaceInfluence', loc: 'bree' })).toBe(SAURON_ROLE);
    expect(actionRole(s, { t: 'sauronSpawnMonster', monsterId: 'mon-crebain', loc: 'bree' })).toBe(SAURON_ROLE);
    expect(actionRole(s, { t: 'sauronDeployMinion', minionId: 'min-x', loc: 'bree' })).toBe(SAURON_ROLE);
    expect(actionRole(s, { t: 'sauronMoveFigure', kind: 'monster', id: 'x', from: 'bree', to: 'archet' })).toBe(SAURON_ROLE);
    expect(actionRole(s, { t: 'sauronHealMinion', minionId: 'min-x' })).toBe(SAURON_ROLE);
    expect(actionRole(s, { t: 'sauronPlayShadow', cardId: 'x' })).toBe(SAURON_ROLE);
    expect(actionRole(s, { t: 'sauronEndActionStep' })).toBe(SAURON_ROLE);
  });

  it('only the player who claimed Sauron may dispatch a sauron* action (regression: remote-Sauron gameplay must be role-checked like any other action)', () => {
    const s = freshGame();
    let r = emptyRoster(s);
    // unclaimed → nobody but the host may act as Sauron
    expect(mayDispatch(r, 'p1', false, s, { t: 'sauronStoryStep' })).toBe(false);
    r = assignRole(r, SAURON_ROLE, { kind: 'human', playerId: 'p1', name: 'Sam' });
    expect(mayDispatch(r, 'p1', false, s, { t: 'sauronStoryStep' })).toBe(true);
    expect(mayDispatch(r, 'p2', false, s, { t: 'sauronStoryStep' })).toBe(false);
    // and a hero-role player still cannot act as Sauron
    const h = heroId(s);
    r = assignRole(r, h, { kind: 'human', playerId: 'p2', name: 'Ann' });
    expect(mayDispatch(r, 'p2', false, s, { t: 'sauronEndActionStep' })).toBe(false);
  });

  it('the host may always dispatch sauron* actions (referee)', () => {
    const s = freshGame();
    const r = emptyRoster(s);
    expect(mayDispatch(r, 'host', true, s, { t: 'sauronStoryStep' })).toBe(true);
  });
});
