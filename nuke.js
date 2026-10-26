(async () => {
  const MAX_DELETE_COUNT = Infinity;
  const DRY_RUN = false;
  const BLOCK_IMAGES = true;
  const STEP_TIMEOUT_MS = 5000;
  const POLL_MS = 25;
  const SETTLE_MS = 150;
  const STALL_LIMIT = 5;
  const EMPTY_RETRIES = 3;
  const RANGE_CHECK_MS = 1000;
  const RANGE_MISS_LIMIT = 2;
  const BATCH_SIZE = 100;
  const CLICK_GAP_MS = 25;
  const CLEAR_TIMEOUT_MS = 30000;

  const DELETE_BTN_SELECTOR = 'div[data-delete-origin] button';

  if (BLOCK_IMAGES) {
    const BLANK =
      'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const shouldBlock = (v) =>
      typeof v === 'string' && v.includes('googleusercontent.com');

    const patchProp = (proto, name, blockValue) => {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (!desc) return;
      Object.defineProperty(proto, name, {
        configurable: true,
        get() {
          return desc.get.call(this);
        },
        set(v) {
          desc.set.call(this, shouldBlock(v) ? blockValue : v);
        },
      });
    };

    patchProp(HTMLImageElement.prototype, 'src', BLANK);
    patchProp(HTMLImageElement.prototype, 'srcset', '');
    patchProp(HTMLSourceElement.prototype, 'srcset', '');

    const origSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (
        (this instanceof HTMLImageElement || this instanceof HTMLSourceElement) &&
        (name === 'src' || name === 'srcset') &&
        shouldBlock(value)
      ) {
        return origSetAttribute.call(this, name, name === 'src' ? BLANK : '');
      }
      return origSetAttribute.call(this, name, value);
    };

    for (const img of document.querySelectorAll('img')) {
      if (shouldBlock(img.src)) img.src = BLANK;
      if (shouldBlock(img.srcset)) img.srcset = '';
    }

    console.log('[gphotos-nuke] image blocking enabled (googleusercontent.com)');
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // setTimeout instead of rAF: rAF is paused in background tabs, which stalls the loop
  const waitFor = (predicate, timeout = STEP_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      const started = performance.now();
      const tick = () => {
        let result;
        try {
          result = predicate();
        } catch (e) {
          result = null;
        }
        if (result) return resolve(result);
        if (performance.now() - started > timeout) return reject(new Error('waitFor timeout'));
        setTimeout(tick, POLL_MS);
      };
      tick();
    });

  // The virtualised grid leaves stale 0x0 checkbox nodes behind; skip them
  const isLive = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const queryTiles = () => {
    const mains = document.querySelectorAll('[role="main"]');
    for (const m of mains) {
      const cbs = Array.from(m.querySelectorAll('[role="checkbox"]')).filter(
        (el) => !el.closest('[role="dialog"]') && isLive(el),
      );
      if (cbs.length) return cbs;
    }
    return [];
  };

  const countSelected = () =>
    queryTiles().filter((el) => el.getAttribute('aria-checked') === 'true').length;

  const findConfirmButton = () => {
    const dialogs = document.querySelectorAll('[role="dialog"]');
    const dialog = dialogs[dialogs.length - 1];
    if (!dialog) return null;
    const textButtons = Array.from(dialog.querySelectorAll('button')).filter(
      (b) => b.textContent.trim().length > 0,
    );
    return textButtons[textButtons.length - 1] || null;
  };

  const rangeSelect = (first, last) => {
    first.click();
    last.dispatchEvent(
      new MouseEvent('click', {
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        view: window,
      }),
    );
  };

  // Fallback for browsers where the synthetic shift-click is ignored (seen in Firefox)
  const selectTiles = async (tiles) => {
    for (const el of tiles) {
      if (!el.isConnected || el.getAttribute('aria-checked') === 'true') continue;
      el.click();
      await sleep(CLICK_GAP_MS);
    }
  };

  // Range selects can land over a few frames; read the count once it stops changing
  const settledCount = async () => {
    let prev;
    let n = countSelected();
    do {
      prev = n;
      await sleep(POLL_MS);
      n = countSelected();
    } while (n !== prev);
    return n;
  };

  const waitForTiles = async () => {
    for (let attempt = 1; attempt <= EMPTY_RETRIES; attempt++) {
      try {
        return await waitFor(() => {
          const t = queryTiles();
          return t.length ? t : null;
        });
      } catch (e) {
        if (window.__stopDelete) return null;
        if (attempt < EMPTY_RETRIES) {
          console.log(
            `[gphotos-nuke] no tiles yet (attempt ${attempt}/${EMPTY_RETRIES}) - waiting for grid to load`,
          );
        }
      }
    }
    return null;
  };

  const started = performance.now();
  let cycle = 0;
  let total = 0;
  let stallCount = 0;
  let lastFirstLabel = null;
  let rangeSelectWorks = null;
  let rangeMisses = 0;

  console.log('[gphotos-nuke] starting. Set window.__stopDelete = true to abort.');

  while (true) {
    if (window.__stopDelete) {
      console.log('[gphotos-nuke] aborted via __stopDelete');
      break;
    }
    if (total >= MAX_DELETE_COUNT) {
      console.log('[gphotos-nuke] reached MAX_DELETE_COUNT');
      break;
    }

    const tiles = await waitForTiles();
    if (!tiles) {
      if (!window.__stopDelete) {
        console.log('[gphotos-nuke] no more tiles visible - library appears empty');
      }
      break;
    }

    const remaining = MAX_DELETE_COUNT - total;
    const limit = rangeSelectWorks === false ? BATCH_SIZE : Infinity;
    const batch = tiles.slice(0, Math.min(tiles.length, remaining, limit));
    const cycleStart = performance.now();
    cycle++;

    // Stall detection - adapted from JuliusBairaktaris/Google-Photos-Deletion-Script
    const firstLabel = batch[0].getAttribute('aria-label') || '';
    if (firstLabel && firstLabel === lastFirstLabel) {
      stallCount++;
      if (stallCount >= STALL_LIMIT) {
        console.warn(
          `[gphotos-nuke] stalled ${STALL_LIMIT} cycles - first tile unchanged ("${firstLabel}"). Likely rate-limited by Google. Reload the page and rerun to continue.`,
        );
        break;
      }
    } else {
      stallCount = 0;
    }
    lastFirstLabel = firstLabel;

    try {
      let rangeLanded = false;
      if (rangeSelectWorks !== false && batch.length >= 5) {
        rangeSelect(batch[0], batch[batch.length - 1]);
        rangeLanded = await waitFor(
          () => countSelected() >= batch.length / 2,
          RANGE_CHECK_MS,
        ).then(
          () => true,
          () => false,
        );
        // Only give up on range select after repeated misses, so one slow cycle doesn't decide the run
        if (rangeSelectWorks === null) {
          if (rangeLanded) {
            rangeSelectWorks = true;
          } else if (++rangeMisses >= RANGE_MISS_LIMIT) {
            rangeSelectWorks = false;
            console.log('[gphotos-nuke] range select ignored by this browser - clicking tiles one by one');
          }
        }
      }
      if (!rangeLanded) await selectTiles(batch);

      // The delete button stays in the DOM after a move, so also require a live selection
      const deleteBtn = await waitFor(
        () => countSelected() > 0 && document.querySelector(DELETE_BTN_SELECTOR),
      );
      const selected = rangeLanded ? await settledCount() : countSelected();
      if (selected < batch.length) {
        console.warn(`[cycle #${cycle}] only ${selected}/${batch.length} tiles selected`);
      }

      if (DRY_RUN) {
        console.log(`[cycle #${cycle}] DRY_RUN: would delete ${selected} tiles`);
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
        total += selected;
        break;
      }

      deleteBtn.click();

      const confirmBtn = await waitFor(() => findConfirmButton());
      confirmBtn.click();

      await waitFor(() => !document.querySelector('[role="dialog"]'));

      // The move to Trash is async; wait for the selection to clear so the next cycle doesn't re-submit it
      try {
        await waitFor(() => countSelected() === 0, CLEAR_TIMEOUT_MS);
      } catch {
        console.warn(
          `[gphotos-nuke] selection still present ${CLEAR_TIMEOUT_MS / 1000}s after confirming - stopping rather than re-submitting. Reload the page and rerun.`,
        );
        break;
      }
      await sleep(SETTLE_MS);

      total += selected;
      const ms = Math.round(performance.now() - cycleStart);
      const rate = ((selected * 1000) / ms).toFixed(1);
      console.log(
        `[cycle #${cycle}] selected ${selected} tiles (total ${total}) in ${ms}ms, ${rate} tiles/s`,
      );
    } catch (err) {
      console.warn(`[cycle #${cycle}] error: ${err.message} - continuing`);
      await sleep(SETTLE_MS);
    }
  }

  const elapsedSec = (performance.now() - started) / 1000;
  const avgRate = total > 0 ? (total / elapsedSec).toFixed(1) : '0.0';
  const perMin = total > 0 ? Math.round((total * 60) / elapsedSec) : 0;
  console.log(
    `[gphotos-nuke] done. deleted=${total} cycles=${cycle} elapsed=${elapsedSec.toFixed(1)}s avg=${avgRate} tiles/s (${perMin}/min)`,
  );
  delete window.__stopDelete;
})();
