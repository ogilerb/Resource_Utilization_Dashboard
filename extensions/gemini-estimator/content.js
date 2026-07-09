// Content script: observe the Gemini web app and estimate token usage.
//
// The consumer Gemini web app has no official usage API, so this is a best-effort
// ESTIMATE (Option B in the plan): it measures the character length of prompts
// you send and responses you receive, converts to an approximate token count
// (~4 chars/token), and hands increments to the background worker, which pushes
// them to /api/ingest/api with increment=true (idempotent daily accumulation).
//
// Because the DOM of gemini.google.com changes over time, the selectors below
// are intentionally defensive and easy to update; if estimates stop flowing,
// re-check these against the current DOM.

const APPROX_CHARS_PER_TOKEN = 4;

function estTokens(text) {
  return Math.max(0, Math.ceil((text || '').trim().length / APPROX_CHARS_PER_TOKEN));
}

function report(tokensIn, tokensOut) {
  if (tokensIn === 0 && tokensOut === 0) return;
  chrome.runtime.sendMessage({
    type: 'gemini-usage',
    tokens_in: tokensIn,
    tokens_out: tokensOut,
  });
}

// --- Capture outgoing prompts ---
// Gemini sends on Enter (without Shift) or via a send button. Grab the editable
// input's text just before it clears.
function attachPromptCapture() {
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      const editor = e.target.closest?.('[contenteditable="true"], textarea');
      if (!editor) return;
      const text = editor.innerText ?? editor.value ?? '';
      if (text.trim()) report(estTokens(text), 0);
    },
    true
  );

  // Also catch clicks on the send button.
  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target.closest?.('button[aria-label*="Send" i], button[aria-label*="Submit" i]');
      if (!btn) return;
      const editor = document.querySelector('[contenteditable="true"], textarea');
      const text = editor?.innerText ?? editor?.value ?? '';
      if (text.trim()) report(estTokens(text), 0);
    },
    true
  );
}

// --- Capture incoming responses ---
// Watch for assistant response containers being added / finishing, and count the
// text length once they appear stable. We debounce per-node so streaming updates
// only count the final text.
const counted = new WeakSet();
const pending = new Map();

function considerResponseNode(node) {
  if (!(node instanceof HTMLElement)) return;
  // Gemini response blocks; adjust selector if the DOM changes.
  const blocks = node.matches?.('message-content, .model-response-text, [data-response-index]')
    ? [node]
    : node.querySelectorAll?.('message-content, .model-response-text, [data-response-index]') ?? [];
  for (const block of blocks) {
    if (counted.has(block)) continue;
    clearTimeout(pending.get(block));
    // Debounce: wait for streaming to settle, then count once.
    pending.set(
      block,
      setTimeout(() => {
        if (counted.has(block)) return;
        counted.add(block);
        pending.delete(block);
        report(0, estTokens(block.innerText || ''));
      }, 1500)
    );
  }
}

function start() {
  attachPromptCapture();
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach(considerResponseNode);
      if (m.type === 'characterData' && m.target.parentElement) {
        considerResponseNode(m.target.parentElement.closest('message-content') || m.target.parentElement);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  console.log('[gemini-estimator] active');
}

if (document.body) start();
else window.addEventListener('DOMContentLoaded', start);
