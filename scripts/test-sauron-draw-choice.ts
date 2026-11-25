// Human Sauron's Draw action: draws N Shadow (all kept) and N Plot cards, then the
// PLAYER picks the one Plot to keep; the rest go to the bottom of the Plot deck.
import { loadCatalog } from '../src/data/loadAssets';
import { newGame } from '../src/engine/setup';
import { sauronBeginAction, sauronKeepDrawnPlot } from '../src/engine/sauronPlay';

const cat = loadCatalog();
let fails = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

const s0 = newGame(cat, 7, ['beravor']);
s0.phase = 'SauronMinions';
s0.sauronActionsLeft = 3;
s0.sauronPending = undefined;
s0.sauron.eye = { influence: 0, draw: 0, command: 0 };
const shadowBefore = s0.sauron.shadowHand.length;
const plotBefore = (s0.sauron.plotHand ?? []).length;
const deckBefore = (s0.sauron.plotDeck ?? []).length;

const s1 = sauronBeginAction(s0, cat, 'draw');
const pend = s1.sauronPending;
check(pend?.track === 'draw' && (pend.drawnPlots?.length ?? 0) >= 2, 'Draw (first space = 2) leaves a pending Plot choice');
check(s1.sauron.shadowHand.length === shadowBefore + 2, 'draws 2 Shadow cards on top of the hand (all kept)');
check((s1.sauron.plotHand ?? []).length === plotBefore, 'no Plot card is kept automatically');
check(sauronBeginAction(s1, cat, 'influence') === s1, 'cannot begin another action while the choice is pending');

const drawn = pend!.drawnPlots!;
const pick = drawn[drawn.length - 1];
check(sauronKeepDrawnPlot(s1, cat, 'not-a-drawn-card') === s1, 'rejects a card that was not drawn');
const s2 = sauronKeepDrawnPlot(s1, cat, pick);
check(!s2.sauronPending && (s2.sauron.plotHand ?? []).includes(pick), 'chosen Plot goes to the hand and the pending choice clears');
check((s2.sauron.plotDeck ?? []).length === deckBefore - 1, 'the other drawn Plot returns to the deck');
check(s2.sauron.plotDeck![s2.sauron.plotDeck!.length - 1] === drawn.find((id) => id !== pick), 'unchosen Plot is at the bottom of the deck');

console.log(`FAIL (${fails})`);
process.exit(fails ? 1 : 0);
