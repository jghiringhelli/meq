// Regression test: the "download log" button (LogPane) must never leak a
// secret mission to a viewer who isn't entitled to it — e.g. a human Sauron
// player in an online multiplayer game must not see the heroes' secret
// mission (and vice versa) just by clicking the ordinary JSON export.
import { describe, it, expect } from 'vitest';
import { freshGame } from './helpers';
import { dumpLogJson } from '../src/engine/log';

describe('dumpLogJson — secret mission redaction', () => {
  it('defaults to revealing both missions (solo/dev use — no other human to leak to)', () => {
    const s = freshGame();
    s.secretHeroMission = 'hero-mission-x';
    s.secretSauronMission = 'sauron-mission-y';
    const payload = JSON.parse(dumpLogJson(s));
    expect(payload.heroMission).toBe('hero-mission-x');
    expect(payload.sauronMission).toBe('sauron-mission-y');
  });

  it('a Hero-side viewer sees their own mission but NOT Sauron\'s', () => {
    const s = freshGame();
    s.secretHeroMission = 'hero-mission-x';
    s.secretSauronMission = 'sauron-mission-y';
    const payload = JSON.parse(dumpLogJson(s, true, 'Hero'));
    expect(payload.heroMission).toBe('hero-mission-x');
    expect(payload.sauronMission).toBeUndefined();
  });

  it('a Sauron-side viewer sees their own mission but NOT the heroes\'', () => {
    const s = freshGame();
    s.secretHeroMission = 'hero-mission-x';
    s.secretSauronMission = 'sauron-mission-y';
    const payload = JSON.parse(dumpLogJson(s, true, 'Sauron'));
    expect(payload.sauronMission).toBe('sauron-mission-y');
    expect(payload.heroMission).toBeUndefined();
  });

  it('a spectator (no claimed role) sees neither secret mission', () => {
    const s = freshGame();
    s.secretHeroMission = 'hero-mission-x';
    s.secretSauronMission = 'sauron-mission-y';
    const payload = JSON.parse(dumpLogJson(s, true, 'none'));
    expect(payload.heroMission).toBeUndefined();
    expect(payload.sauronMission).toBeUndefined();
  });

  it('the ordered event log itself is always included regardless of reveal side', () => {
    const s = freshGame();
    const payload = JSON.parse(dumpLogJson(s, true, 'Sauron'));
    expect(Array.isArray(payload.events)).toBe(true);
    expect(payload.events.length).toBe(s.log.length);
  });
});
