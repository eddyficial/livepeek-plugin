/**
 * Wait for Chromium to finish the visual update triggered by recent input.
 * A bounded wait keeps a busy or navigating page from stalling the pane, while
 * sharing an unfinished evaluate prevents repeated paints from queueing work in
 * a page that is not responding. Page and navigation errors are non-fatal.
 */
export function createFrameSettler(timeoutMs = 150) {
  let pending = null;

  return async function settle(page) {
    if (!pending) {
      const evaluate = Promise.resolve().then(() => page.evaluate(() => new Promise((resolve) => {
        globalThis.requestAnimationFrame(() => resolve());
      })));
      const tracked = evaluate.catch(() => {}).finally(() => {
        if (pending === tracked) pending = null;
      });
      pending = tracked;
    }

    let timer;
    try {
      await Promise.race([
        pending,
        new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } catch { /* settling a frame is never worth failing a paint */ }
    finally { clearTimeout(timer); }
  };
}
