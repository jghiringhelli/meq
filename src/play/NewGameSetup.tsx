import { useState } from 'react';
import type { Catalog, HeroId } from '../engine/types';
import { heroArt } from '../data/art';

type Side = 'Hero' | 'Sauron';

interface Props {
  cat: Catalog;
  onStart: (heroIds: HeroId[], side: Side) => void;
  onCancel: () => void;
}

const MAX_HEROES = 3;

export default function NewGameSetup({ cat, onStart, onCancel }: Props) {
  const roster = Object.keys(cat.heroes) as HeroId[];
  const [side, setSide] = useState<Side>('Hero');
  const [selected, setSelected] = useState<HeroId[]>(() => roster.slice(0, 2));

  const toggle = (id: HeroId) => {
    setSelected((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      if (cur.length >= MAX_HEROES) return cur;
      return [...cur, id];
    });
  };

  const canStart = selected.length >= 1;

  return (
    <div className="app">
      <header className="app-header">
        <h1>Middle-earth Quest</h1>
        <span className="subtitle">new game setup</span>
      </header>
      <main className="app-main setup">
        <section className="setup-block">
          <h2>Choose your side</h2>
          <div className="side-pick">
            <button
              className={`side-btn${side === 'Hero' ? ' active' : ''}`}
              onClick={() => setSide('Hero')}>
              <strong>The Heroes</strong>
              <span>Guide 1–3 heroes of the Free Peoples.</span>
            </button>
            <button
              className={`side-btn${side === 'Sauron' ? ' active' : ''}`}
              onClick={() => setSide('Sauron')}>
              <strong>Sauron</strong>
              <span>Command the Lidless Eye vs AI-driven heroes.</span>
            </button>
          </div>
          {side === 'Sauron' && (
            <p className="setup-note">
              You play Sauron interactively — plots, influence, minions and shadow cards.
              The heroes you pick below are controlled by the AI. Choose how many (1–3)
              oppose you.
            </p>
          )}
        </section>

        <section className="setup-block">
          <h2>Choose the heroes {side === 'Sauron' ? '(your AI opponents)' : ''} <span className="count">({selected.length}/{MAX_HEROES})</span></h2>
          <div className="hero-pick">
            {roster.map((id) => {
              const h = cat.heroes[id];
              const on = selected.includes(id);
              const art = heroArt(id);
              const img = art.sheet || art.figure || '';
              return (
                <button key={id}
                  className={`hero-card${on ? ' on' : ''}`}
                  onClick={() => toggle(id)}>
                  {img && <img src={img} alt="" className="hero-card-art" />}
                  <span className="hero-card-name">{h.name}</span>
                  <span className="hero-card-stats">
                    ♥ {h.fortitude} · STR {h.strength} · AGI {h.agility}
                  </span>
                  {on && <span className="hero-card-check">✓</span>}
                </button>
              );
            })}
          </div>
        </section>

        <div className="setup-actions">
          <button className="ghost" onClick={onCancel}>Back</button>
          <button className="primary" disabled={!canStart}
            onClick={() => onStart(selected, side)}>
            {side === 'Sauron' ? 'Command Sauron' : 'Begin quest'}
          </button>
        </div>
      </main>
    </div>
  );
}
