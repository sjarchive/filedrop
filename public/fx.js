/* FileDrop visual effects: spotlight, aurora parallax.
   Everything is rAF-throttled, passive, and disabled for
   reduced-motion users and coarse (touch) pointers. */

(() => {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (reduced) return; // CSS also freezes animations; skip JS effects entirely

  /* Spotlight: glass cards light up under the cursor via --mx/--my */
  if (finePointer) {
    for (const card of document.querySelectorAll('.card')) {
      let raf = 0;
      let x = 0;
      let y = 0;
      const apply = () => {
        raf = 0;
        card.style.setProperty('--mx', `${x}px`);
        card.style.setProperty('--my', `${y}px`);
      };
      card.addEventListener(
        'pointermove',
        (e) => {
          const r = card.getBoundingClientRect();
          x = e.clientX - r.left;
          y = e.clientY - r.top;
          if (!raf) raf = requestAnimationFrame(apply);
        },
        { passive: true }
      );
    }
  }

  /* Parallax: the aurora layer drifts with scroll + a hint of pointer */
  const aurora = document.querySelector('.aurora');
  if (aurora) {
    let sy = window.scrollY;
    let mx = 0;
    let my = 0;
    let raf = 0;
    const update = () => {
      raf = 0;
      const root = document.documentElement.style;
      root.setProperty('--par-y', `${sy * 0.08 + my * 10}px`);
      root.setProperty('--par-x', `${mx * 16}px`);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    addEventListener('scroll', () => { sy = window.scrollY; schedule(); }, { passive: true });
    if (finePointer) {
      addEventListener(
        'pointermove',
        (e) => {
          mx = e.clientX / innerWidth - 0.5;
          my = e.clientY / innerHeight - 0.5;
          schedule();
        },
        { passive: true }
      );
    }
    schedule();
  }
})();
