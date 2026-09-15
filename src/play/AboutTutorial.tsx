import { useState } from 'react';
import { VMOD_URL } from './ArtLoader';

/**
 * Start-screen "About / How to play" panel: explains what this project is,
 * how to bring your own art from the VASSAL module (the app ships no
 * copyrighted art), and the available game/online options. Collapsible so it
 * stays out of the way once you know the ropes.
 */
export default function AboutTutorial() {
  const [open, setOpen] = useState(false);
  const [openHow, setOpenHow] = useState(false);
  return (
    <section className="about">
      <button className="about-toggle" onClick={() => setOpenHow((v) => !v)} aria-expanded={openHow}>
        {openHow ? '▾' : '▸'} 📖 How to play (the basics)
      </button>
      {openHow && (
        <div className="about-body">
          <h3>Your goal</h3>
          <p>
            You can control <strong>either side</strong> — the <strong>heroes</strong> or
            {' '}<strong>Sauron</strong> — solo against the AI or online with friends. The
            {' '}<strong>heroes</strong> win by thwarting Sauron: <strong>breaking his Plots</strong>
            {' '}and advancing their own quests and secret mission. <strong>Sauron wins</strong> if
            his three coloured story markers climb too far — any one marker reaching the
            {' '}<em>Finale</em>, or all three reaching the <em>Shadow Falls</em> (the midpoint).
            Every Plot Sauron plays feeds one of those markers each turn, so the race between
            plots and counters is the whole game.
          </p>

          <h3>Playing the heroes — a turn, step by step</h3>
          <ol>
            <li><strong>Draw</strong> — at the start of your turn you draw cards equal to your
              hero's fortitude. Cards are your fuel for movement and combat.</li>
            <li><strong>Take 2 actions</strong>, choosing from:
              <ul>
                <li><strong>Travel</strong> — reachable locations glow gold. Click one; a window
                  lets you pick which card(s) pay for the path (one matching-terrain card, or a
                  number of any cards).</li>
                <li><strong>Explore</strong> — run the location's Encounter step (draw 3, resolve
                  the one that applies) for rewards like favor, training or items.</li>
                <li><strong>Rest</strong> — only in a <em>Haven</em>: heal and cleanse Corruption
                  (for favor).</li>
                <li><strong>Engage</strong> a monster blocking your way; <strong>Counter a Plot</strong>
                  {' '}by spending favor where a plot sits; <strong>Consult</strong> a character or
                  <strong> retrieve favor</strong>; or <strong>trade favor</strong> with an ally in
                  the same location.</li>
              </ul>
            </li>
            <li><strong>End</strong> — your turn ends with the Encounter step if you didn't Explore.</li>
          </ol>

          <h3>What experienced hero players do</h3>
          <ul>
            <li><strong>Favor is everything</strong> — it breaks plots and cleanses corruption.
              Bank it, and break plots with pooled favor at the last safe moment.</li>
            <li><strong>End your turn in a Haven</strong> when you can, so Sauron can't steal your
              favor and you're safe from Shadow cards and Peril.</li>
            <li><strong>Cleanse Corruption</strong> in Havens — each card you carry is an ongoing
              penalty.</li>
            <li><strong>Cooperate</strong> — split up to cover several plots, then converge to pool
              favor for a break none of you could afford alone.</li>
          </ul>

          <h3>Playing Sauron</h3>
          <p>
            Between the heroes' turns you take the <strong>Sauron</strong> turn: <strong>play a
            Plot</strong> to push one of your three story markers toward victory, <strong>spread
            influence</strong> across locations, <strong>move and place monsters</strong> to block
            the heroes, and pressure them with <strong>Shadow cards and Peril</strong>. You don't
            have to win a fight — you win by advancing your markers faster than the heroes can
            break your plots, so protect the plots they most want to stop and force them into the
            open, away from Havens, where you can steal their favor.
          </p>
          <p className="muted">
            When the AI plays Sauron, the panel on the right <strong>recaps what it did</strong>
            {' '}each turn, including the opening setup.
          </p>

          <h3>Playing online</h3>
          <p>
            Everything runs <strong>peer-to-peer</strong> in the browser — no accounts, no server.
            {' '}<strong>Host online game</strong> creates a session with a 5-letter code; share it
            and friends <strong>Join online game</strong> with that code and a name. Any player can
            claim any open role — a hero, or Sauron — and any <strong>unclaimed or dropped role is
            played by the AI</strong>, so a game never stalls if someone leaves. For a quick solo
            game, use <strong>New game</strong> and pick which side you control.
          </p>

          <h3>The smart button</h3>
          <p>
            Whichever side you play, the glowing <strong>next-step button</strong> tells you the
            obvious thing to do now and warns you before you end a turn with actions still worth
            taking (a favor to grab, a plot to break or protect, a move to make out of the open).
          </p>
        </div>
      )}
      <button className="about-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? '▾' : '▸'} ℹ️ About this project & how to load the art
      </button>
      {open && (
        <div className="about-body">
          <h3>What is this?</h3>
          <p>
            An <strong>unofficial, non-commercial fan port</strong> of the board game
            {' '}<em>Middle-earth Quest</em> (Fantasy Flight Games, 2009). It reproduces the
            board, cards and rules as a browser app so friends can play remotely. All game
            logic runs locally in your browser — like the VASSAL module it is inspired by,
            there is no game server, so it can be hosted as plain static files.
          </p>
          <p className="muted">
            This project ships <strong>no artwork</strong>. To keep it legal, you supply the
            card and board images yourself from the community VASSAL module (which you must
            own/obtain separately). Nothing you load is uploaded anywhere — the images stay in
            your browser.
          </p>

          <h3>Loading the art (bring your own)</h3>
          <p className="muted">
            You do <strong>not</strong> need to install VASSAL — just download the module file.
          </p>
          <ol>
            <li>Download the <em>Middle-earth Quest</em> module (<code>.vmod</code>) directly:{' '}
              <a href={VMOD_URL} target="_blank" rel="noreferrer"><code>Middle_Earth_Quest_1.6.vmod</code></a>{' '}
              (from the <a href="https://vassalengine.org" target="_blank" rel="noreferrer">VASSAL module library</a>).
            </li>
            <li>Click <strong>“Load VASSAL module (.vmod)…”</strong> below and select that file.
              No need to rename or unzip it — the app reads the images inside and matches them to
              the cards automatically. (Loading a folder of extracted images still works too.)</li>
          </ol>
          <p className="muted">
            The VASSAL module has some misspelled/mismatched file names. We keep our own
            corrected filename map, so mislabeled files (e.g. <code>concetrate</code> →
            {' '}<code>concentrate</code>) are matched anyway. Any images we can’t match simply
            fall back to readable text cards.
          </p>

          <h3>Ways to play</h3>
          <ul>
            <li><strong>Solo vs. AI</strong> — “New game”, then pick the heroes and which side
              you control; the AI plays the other side.</li>
            <li><strong>Host online</strong> — “Host online game” creates a session and gives you
              a 5-letter code. Share it with your friends.</li>
            <li><strong>Join online</strong> — “Join online game”, enter the host’s code and your
              name. You connect peer-to-peer directly to the host; no accounts, no server.</li>
            <li>Any player can claim any open role (a hero, or Sauron). Unclaimed or kicked roles
              are played by the AI, so a game never stalls if someone drops.</li>
          </ul>
        </div>
      )}
    </section>
  );
}
