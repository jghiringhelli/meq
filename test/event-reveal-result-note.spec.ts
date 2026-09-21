// Regression: the Event Step's reveal tray only showed the card's flavour
// text, never whether the mechanical effect actually did anything. A hero
// with 0 favor resolving "Trust in Friendship" (bankFavor) saw no
// explanation that the card fizzled. runSauronEvents now stamps a
// `resultNote` on pendingReveal summarising the real outcome (or an explicit
// no-op message) so the reveal window itself explains it.
import { describe, it, expect } from 'vitest';
import { freshGame, cat } from './helpers';
import { sauronResolveEvents } from '../src/engine/game';

describe('Event Step reveal tray shows the resolved effect', () => {
  it('explains a no-op event (hero has no favor to bank)', () => {
    let s = freshGame();
    s.phase = 'SauronEvents';
    s.story.sauron = { yellow: 0, red: 0, black: 0 }; // gameStage() -> 1
    s.sauron.eventStage = 1;
    s.sauron.eventDeck = ['event-t1-trust-in-friendship'];
    s.sauron.eventDiscard = [];
    for (const h of s.heroes) h.favor = 0;

    s = sauronResolveEvents(s, cat);
    expect(s.pendingReveal?.resultNote).toBeTruthy();
    expect(s.pendingReveal!.resultNote).toMatch(/no favor to bank/i);
  });

  it('reports the actual effect when the card does something', () => {
    let s = freshGame();
    s.phase = 'SauronEvents';
    s.story.sauron = { yellow: 0, red: 0, black: 0 };
    s.sauron.eventStage = 1;
    s.sauron.eventDeck = ['event-t1-trust-in-friendship'];
    s.sauron.eventDiscard = [];
    for (const h of s.heroes) h.favor = 3;

    s = sauronResolveEvents(s, cat);
    expect(s.pendingReveal?.resultNote).toBeTruthy();
    expect(s.pendingReveal!.resultNote).toMatch(/banked 1 favor/i);
  });
});
