import { useEffect, useRef, useState } from 'react';
import type { Catalog, GameState, CardId, Combatant } from '../engine/types';
import { monsterArt, minionArt, heroArt, combatCardArt, battleBoardArt } from '../data/art';
import { useInspect } from './CardInspector';

interface Props {
  state: GameState; cat: Catalog;
  onChoose?: (optionId: string) => void;
}

// A small stat pill (attribute name + value).
function Stat({ label, val }: { label: string; val: number | string }) {
  return <span className="cb-stat"><em>{label}</em><b>{val}</b></span>;
}

// One revealed combat card (art + name + attack/defense/type), or an empty slot.
function CardFace({ cat, card, ownerRef, kind }: { cat: Catalog; card?: CardId; ownerRef: string; kind: 'atk' | 'def' }) {
  const c = card ? cat.combatCards[card] : undefined;
  if (!c) return <div className={`cb-card cb-card-empty ${kind}`}><span>—</span></div>;
  const img = combatCardArt(c, ownerRef);
  return (
    <div className={`cb-card ${kind}`}>
      {img && <img src={img} alt="" />}
      <div className="cb-card-info">
        <span className="cb-card-name">{c.name}</span>
        <span className="cb-card-nums">⚔{c.attack} · 🛡{c.defense} · {c.type}{c.strengthCost ? ` · ✊${c.strengthCost}` : ''}</span>
        {c.ability && <span className="cb-card-ab">{c.ability}</span>}
      </div>
    </div>
  );
}

export default function CombatBoard({ state, cat, onChoose }: Props) {
  const pc = state.pendingCombat!;
  const ch = state.pendingChoice;
  const inspect = useInspect();
  const [min, setMin] = useState(false);

  const hero = pc.attacker;
  const foe = pc.defender;
  const heroDef = cat.heroes[hero.refId];
  const foeDef = cat.monsters[foe.refId] ?? cat.minions[foe.refId];
  const foeArt = monsterArt(foe.refId) || minionArt(cat.minions[foe.refId]?.image ?? '');
  const heroImg = heroArt(hero.refId).portrait || heroArt(hero.refId).figure;
  const bg = battleBoardArt();
  const foeMaxLife: number | undefined = cat.minions[foe.refId]?.health;

  // Latest resolved bout drives the "what happened" line + damage pop.
  const last = pc.report.length ? pc.report[pc.report.length - 1] : undefined;
  const revA = pc.reveal.attacker ?? last?.attackerCard;
  const revD = pc.reveal.defender ?? last?.defenderCard;

  // Fading red damage numbers: re-mount on every new bout via a changing key so
  // the CSS animation replays. One pop per side that actually took damage.
  const boutKey = pc.report.length;
  const dmgFoe = last?.damageToDefender ?? 0;
  const dmgHero = last?.damageToAttacker ?? 0;

  // Auto-restore from a momentary minimize when it becomes the human's turn to
  // pick a card, so a pending choice is never hidden and forgotten.
  const wasChoice = useRef(false);
  useEffect(() => {
    if (ch && onChoose && !wasChoice.current) setMin(false);
    wasChoice.current = !!(ch && onChoose);
  }, [ch, onChoose]);

  if (min) {
    return (
      <div className="cb-min" role="dialog" aria-label="Combat (minimized)">
        <span className="cb-min-txt">
          ⚔ Combat r{pc.round} — <b>{hero.name}</b> vs <b>{foe.name}</b> (♥{foe.life}{foeMaxLife ? `/${foeMaxLife}` : ''})
        </span>
        <button className="primary" onClick={() => setMin(false)}>Return to combat ▸</button>
      </div>
    );
  }

  const Side = ({ c, isHero }: { c: Combatant; isHero: boolean }) => {
    const stackIds = pc.stack?.[isHero ? 'attacker' : 'defender'] ?? [];
    return (
      <div className={`cb-side ${isHero ? 'hero' : 'foe'}`}>
        <div className="cb-portrait-wrap">
          {(isHero ? heroImg : foeArt) && (
            <img className="cb-portrait" src={isHero ? heroImg : foeArt} alt=""
              onClick={() => inspect(isHero
                ? { title: c.name, img: heroImg, subtitle: heroDef?.abilityName ?? 'Hero', text: heroDef?.abilityText ?? '' }
                : { title: c.name, img: foeArt, subtitle: `Foe · ♥ ${c.life}${foeMaxLife ? `/${foeMaxLife}` : ''}`, text: foeDef?.ability ?? '' })}
              style={{ cursor: 'pointer' }} />
          )}
          {((isHero && dmgHero > 0) || (!isHero && dmgFoe > 0)) && (
            <span key={boutKey} className="cb-dmg-pop">−{isHero ? dmgHero : dmgFoe}</span>
          )}
          {c.exhausted && <span className="cb-exhausted">EXHAUSTED</span>}
        </div>
        <div className="cb-name">{c.name}</div>
        <div className="cb-stats">
          {isHero && heroDef ? (
            <>
              <Stat label="Fort" val={heroDef.fortitude} />
              <Stat label="Str" val={heroDef.strength} />
              <Stat label="Agi" val={heroDef.agility} />
              <Stat label="Wis" val={heroDef.wisdom} />
            </>
          ) : foeDef ? (
            <>
              <Stat label="Fort" val={foeDef.fortitude} />
              <Stat label="Str" val={foeDef.strength} />
              <Stat label="Wis" val={foeDef.wisdom} />
            </>
          ) : null}
        </div>
        <div className="cb-str">Combat strength <b>{c.strengthSpent}/{c.strength}</b></div>
        {isHero ? (
          <div className="cb-life">
            <span title="Life pool — the hero's deck of cards">🂠 deck <b>{c.deck.length}</b></span>
            <span title="Cards in hand">✋ hand <b>{c.hand.length}</b></span>
            <span title="Damage taken" className="dmg">🩸 damage <b>{c.damagePool.length}</b></span>
          </div>
        ) : (
          <div className="cb-life">
            <span className="foe-hp" title="Monster / minion health">♥ HP <b>{c.life}</b>{foeMaxLife ? <i>/{foeMaxLife}</i> : null}</span>
          </div>
        )}
        {!isHero && foeDef?.ability && <div className="cb-ability">{foeDef.ability}</div>}
        <div className="cb-stack">
          <span className="cb-stack-h">Cards used ({stackIds.length})</span>
          <div className="cb-stack-row">
            {stackIds.map((id, i) => {
              const cc = cat.combatCards[id];
              const img = cc ? combatCardArt(cc, c.refId) : '';
              return img
                ? <img key={i} className="cb-stack-card" src={img} alt="" title={cc?.name} />
                : <span key={i} className="cb-stack-chip" title={cc?.name}>{cc?.name?.[0] ?? '?'}</span>;
            })}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="cb-overlay">
      <div className="cb-board" style={bg ? { backgroundImage: `url(${bg})` } : undefined}>
        <div className="cb-head">
          <h2>⚔ Combat — round {pc.round} <span className="cb-loc">at {cat.locations[pc.locationId]?.name ?? pc.locationId}</span></h2>
          <button className="cb-min-btn" onClick={() => setMin(true)} title="Minimize to peek at the map">▁ Minimize</button>
        </div>

        <div className="cb-arena">
          <Side c={hero} isHero />

          <div className="cb-center">
            <div className="cb-reveal">
              <CardFace cat={cat} card={revA} ownerRef={hero.refId} kind="atk" />
              <div className="cb-vs">
                <span className="cb-round-badge">r{pc.round}</span>
                <span className="cb-vs-x">VS</span>
              </div>
              <CardFace cat={cat} card={revD} ownerRef={foe.refId} kind="def" />
            </div>

            {last && (
              <div key={boutKey} className="cb-happened">
                <span className="cb-happened-note">{last.note}</span>
                <span className="cb-happened-dmg">
                  {dmgFoe > 0 && <b className="to-foe">{foe.name} −{dmgFoe}</b>}
                  {dmgHero > 0 && <b className="to-hero">{hero.name} −{dmgHero}</b>}
                  {dmgFoe === 0 && dmgHero === 0 && <span className="muted">no damage</span>}
                </span>
              </div>
            )}

            <div className="cb-report">
              <div className="cb-report-head"><span>#</span><span>{hero.name}</span><span>{foe.name}</span><span>dmg</span></div>
              <div className="cb-report-body">
                {pc.report.slice(-8).map((r, i) => (
                  <div key={i} className="cb-report-row">
                    <span>r{r.round}</span>
                    <span>{r.attackerCard ? cat.combatCards[r.attackerCard]?.name ?? '—' : '—'}</span>
                    <span>{r.defenderCard ? cat.combatCards[r.defenderCard]?.name ?? '—' : '—'}</span>
                    <span className="cb-report-dmg">{r.damageToDefender > 0 && <em className="d-foe">foe −{r.damageToDefender}</em>}{r.damageToAttacker > 0 && <em className="d-hero">you −{r.damageToAttacker}</em>}{r.damageToDefender === 0 && r.damageToAttacker === 0 && '·'}</span>
                  </div>
                ))}
              </div>
            </div>

            {ch && onChoose && (
              <div className={`cb-choice ${ch.kind === 'combat-prep' ? 'prep' : 'hand'}`}>
                <p className="cb-prompt">{ch.prompt}</p>
                <div className="cb-options">
                  {ch.options.map((o) => {
                    const card = cat.combatCards[o.id];
                    const img = card ? combatCardArt(card, hero.refId) : '';
                    const declare = o.id === '__exhaust__';
                    return (
                      <button key={o.id}
                        className={declare ? 'cb-opt declare' : 'cb-opt'}
                        onClick={() => onChoose(o.id)}
                        title={card?.ability ?? ''}>
                        {img && <img className="cb-opt-art" src={img} alt="" />}
                        <span className="cb-opt-label">{o.label}</span>
                        {card && <span className="cb-opt-nums">⚔{card.attack} 🛡{card.defense}{card.strengthCost ? ` ✊${card.strengthCost}` : ''}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <Side c={foe} isHero={false} />
        </div>
      </div>
    </div>
  );
}
