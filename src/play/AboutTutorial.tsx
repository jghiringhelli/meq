import { useState } from 'react';

/**
 * Start-screen "About / How to play" panel: explains what this project is,
 * how to bring your own art from the VASSAL module (the app ships no
 * copyrighted art), and the available game/online options. Collapsible so it
 * stays out of the way once you know the ropes.
 */
export default function AboutTutorial() {
  const [open, setOpen] = useState(false);
  return (
    <section className="about">
      <button className="about-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? '▾' : '▸'} About this project & how to load the art
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
            <li>Download the <em>Middle-earth Quest</em> module (<code>.vmod</code>) from the{' '}
              <a href="https://vassalengine.org" target="_blank" rel="noreferrer">VASSAL module library</a>.
            </li>
            <li>A <code>.vmod</code> file is just a ZIP — rename it to <code>.zip</code> and
              extract it. The card/board images live in the <code>images/</code> folder inside.</li>
            <li>Click <strong>“Load your art”</strong> below and select that <code>images</code>
              folder (or all the image files). The app matches them to the cards automatically.</li>
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
