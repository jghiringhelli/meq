import type { Catalog, GameState } from '../engine/types';
import { heroArt } from '../data/art';

interface Props { state: GameState; cat: Catalog; }

// Turn-cycle indicator: within a round, show whose turn it is. For a lone hero
// (2-player game) the hero takes two turns, so mark turn 1 vs turn 2. For a
// party, show who is active now, who already played, and who is still to come —
// then Sauron.
export default function TurnCycle({ state, cat }: Props) {
  const heroSide = state.activeSide === 'Hero';
  const lone = state.heroes.length === 1;

  if (lone) {
    const h = state.heroes[0];
    const turnNo = state.heroSecondTurnPending ? 2 : 1;
    return (
      <div className="turn-cycle" data-testid="turn-cycle">
        <span className="tc-title">Turn</span>
        <div className="tc-seat active">
          <HeroFace state={state} cat={cat} id={h.id} />
          <span className="tc-name">{cat.heroes[h.id]?.name ?? h.id}</span>
        </div>
        <span className={`tc-step ${heroSide ? 'active' : 'played'}`}>
          {heroSide ? `Turn ${turnNo} of 2` : 'played'}
        </span>
        <span className={`tc-seat sauron ${heroSide ? '' : 'active'}`}>Sauron</span>
      </div>
    );
  }

  return (
    <div className="turn-cycle" data-testid="turn-cycle">
      <span className="tc-title">Turn order</span>
      {state.heroes.map((h, i) => {
        const cls = !heroSide ? 'played'
          : i === state.activeHeroIndex ? 'active'
          : i < state.activeHeroIndex ? 'played' : 'next';
        return (
          <div key={h.id} className={`tc-seat ${cls} ${h.status !== 'active' ? 'out' : ''}`}
            title={`${cat.heroes[h.id]?.name ?? h.id} — ${cls === 'active' ? 'playing now'
              : cls === 'played' ? 'already played' : 'up next'}`}>
            <HeroFace state={state} cat={cat} id={h.id} />
            <span className="tc-name">{cat.heroes[h.id]?.name ?? h.id}</span>
          </div>
        );
      })}
      <span className={`tc-seat sauron ${heroSide ? '' : 'active'}`}>Sauron</span>
    </div>
  );
}

function HeroFace({ state, cat, id }: { state: GameState; cat: Catalog; id: string }) {
  void state; void cat;
  const face = heroArt(id)?.figure;
  return face
    ? <img className="tc-face" src={face} alt="" />
    : <span className="tc-face tc-face-fallback">{id[0].toUpperCase()}</span>;
}
