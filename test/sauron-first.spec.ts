import { describe, it, expect } from 'vitest';
import { cat, toHeroActions } from './helpers';
import { newGame } from '../src/engine/game';
import { applyAction } from '../src/engine/actions';
import { sauronPlayPlot } from '../src/engine/sauronPlay';

describe('Sauron-first opening', () => {
  it('starts on Sauron, with the hero turn following his', () => {
    const s = newGame(cat, 7, ['thalin', 'argalad']);
    expect(s.activeSide).toBe('Sauron');
    expect(s.phase).toBe('SauronRefresh');
    const h = toHeroActions(s);
    expect(h.activeSide).toBe('Hero');
    expect(h.story.turn).toBe(1);
  });

  it('a human Sauron picks the starting hand per the plot card, and cannot play a plot on turn 1', () => {
    let s = newGame(cat, 7, ['thalin', 'argalad'], 'Sauron', true);
    s.setupInfluencePending = undefined;
    const p = s.setupHandPending!;
    expect(p).toBeTruthy();
    expect(s.sauron.shadowHand).toEqual([]);
    // wrong counts are refused
    const bad = applyAction(s, cat, { t: 'sauronKeepStartingHand', shadow: [], plot: [] });
    expect(bad.setupHandPending).toBeTruthy();
    s = applyAction(s, cat, {
      t: 'sauronKeepStartingHand',
      shadow: p.shadowOffered.slice(0, p.shadowKeep),
      plot: p.plotOffered.slice(0, p.plotKeep),
    });
    expect(s.setupHandPending).toBeUndefined();
    expect(s.sauron.shadowHand).toHaveLength(p.shadowKeep);
    expect(s.sauron.plotHand).toHaveLength(p.plotKeep);
    s.sauron.influence = 99;
    const after = sauronPlayPlot(s, cat, s.sauron.plotHand![0]);
    expect(after.sauron.activePlots).toEqual(s.sauron.activePlots);
  });
});
