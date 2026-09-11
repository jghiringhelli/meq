import { useMemo, useState } from 'react';
import type { Catalog, HeroState } from '../engine/types';
import { moveOptions, validateMovePayment } from '../engine/game';
import { combatCardArt } from '../data/art';

interface Props {
  cat: Catalog;
  hero: HeroState;
  to: string;
  onConfirm: (cards: string[]) => void;
  onCancel: () => void;
}

const pretty = (id: string) => id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Interactive Travel window (rulebook p.22): pick which card(s) to spend to
 *  cross the path — one matching-terrain card, or the printed number of any
 *  cards. Travel lights up only when the selection is a legal payment. */
export default function TravelModal({ cat, hero, to, onConfirm, onCancel }: Props) {
  const opt = useMemo(() => moveOptions(cat, hero).find((o) => o.to === to), [cat, hero, to]);

  // Pre-select a sensible default so common moves are one click: the first
  // matching-terrain card, else the first `anyCardCost` cards.
  const [sel, setSel] = useState<string[]>(() => {
    if (!opt) return [];
    if (opt.terrainPayable) {
      const idx = hero.hand.findIndex((cid) => cat.combatCards[cid]?.terrain === opt.terrain);
      if (idx >= 0) return [`${hero.hand[idx]}#${idx}`];
    }
    return hero.hand.slice(0, opt.anyCardCost).map((cid, i) => `${cid}#${i}`);
  });

  if (!opt) { onCancel(); return null; }

  const toggle = (cid: string, idx: number) => {
    const key = `${cid}#${idx}`;
    setSel((cur) => cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]);
  };
  // sel holds `${cid}#${idx}` keys so duplicate card ids in hand toggle
  // independently; strip to bare ids for validation/confirm.
  const selIds = sel.map((k) => k.split('#')[0]);
  const validSel = validateMovePayment(cat, hero, to, selIds);

  return (
    <div className="choice-overlay" onClick={onCancel}>
      <div className="travel-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Travel to <b>{cat.locations[to]?.name ?? pretty(to)}</b></h3>
        <p className="travel-req">
          <span className={`terrain-chip terrain-${opt.terrain}`}>{opt.terrain || 'any'}</span>
          {opt.water && <span className="water-chip">water</span>}
          {' — '}
          {opt.terrainPayable
            ? <>discard <b>1 {opt.terrain}</b> card, or <b>{opt.anyCardCost}</b> card(s) of any type</>
            : <>discard <b>{opt.anyCardCost}</b> card(s) of any type</>}
        </p>
        <div className="travel-hand">
          {hero.hand.map((cid, i) => {
            const c = cat.combatCards[cid];
            const key = `${cid}#${i}`;
            const on = sel.includes(key);
            const match = c?.terrain === opt.terrain && !!opt.terrain;
            const img = c ? combatCardArt(c, hero.id) : '';
            return (
              <div key={key}
                className={`card terrain-${c?.terrain} travel-card${on ? ' selected' : ''}${match ? ' match' : ''}`}
                title={c ? `${c.name} · ${c.type} · A${c.attack}/D${c.defense} · ${c.terrain || 'any terrain'}${c.ability ? `\n${c.ability}` : ''}` : cid}
                onClick={() => toggle(cid, i)}>
                {img && <img className="card-art" src={img} alt="" />}
                <div className="card-name">{c?.name ?? cid}</div>
                <div className="card-line">{c ? `${c.type} · A${c.attack}/D${c.defense}` : ''}</div>
                <div className="card-terrain">{c?.terrain || '—'}</div>
              </div>
            );
          })}
        </div>
        <div className="travel-actions">
          <span className="travel-count">{sel.length} selected</span>
          <button className="ghost" onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={!validSel} onClick={() => onConfirm(selIds)}>Travel ▶</button>
        </div>
      </div>
    </div>
  );
}
