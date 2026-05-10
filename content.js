'use strict';

// ── Message handler ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SCRAPE_PRODUCTS')     { sendResponse(scrapeProducts()); }
  if (msg.type === 'SCRAPE_PRODUCT_PAGE') { sendResponse(scrapeProductPage()); }
  if (msg.type === 'INJECT_BADGES')       { injectBadges(msg.data); }
  if (msg.type === 'SORT_BY_SCORE')       { sortByScore(msg.data); }
  if (msg.type === 'FILTER_BADGES')       { filterBadges(msg.threshold); }
});

// ── Scraper ──────────────────────────────────────────────────────────────────
function scrapeProducts() {
  // Try the most specific selector first; fall back to class-contains only if it
  // returns nothing. This avoids double-counting cards that match both selectors.
  let rawCards = [...document.querySelectorAll('li.product-base')];
  if (rawCards.length === 0) {
    // Broader fallback — exclude elements that are descendants of another matched
    // element to prevent injecting badges into inner wrappers.
    const all = [...document.querySelectorAll('[class*="product-base"]')];
    rawCards = all.filter(el => !el.parentElement?.closest('[class*="product-base"]'));
  }

  // Keep cards that are actually in the visible DOM (not display:none)
  const unique = [...new Set(rawCards)].filter(card =>
    getComputedStyle(card).display !== 'none' &&
    getComputedStyle(card).visibility !== 'hidden'
  );
  const products = [];

  unique.forEach((card, index) => {
    const brand = text(card, '.product-brand, [class*="product-brand"]');
    const name  = text(card, '.product-product, [class*="product-product"]');
    const price = text(card, '.product-discountedPrice, .product-price, [class*="discountedPrice"], [class*="product-price"]');
    const anchor = card.querySelector('a[href]');
    const url = anchor ? anchor.href : '';

    if (!url) return;

    // Scrape size chips shown on the card (e.g. S, M, L, XL)
    const sizeEls = card.querySelectorAll(
      '.product-sizes span, [class*="sizes"] span, [class*="size"] li, [class*="sizeChip"], [class*="size-chip"]'
    );
    const sizes = [...sizeEls].map(el => el.innerText.trim()).filter(s => s && s.length <= 5);

    card.setAttribute('data-msf-index', String(index));
    products.push({ index, brand, name, price, url, sizes });
  });

  return products;
}

function text(root, selector) {
  const el = root.querySelector(selector);
  return el ? el.innerText.trim() : '?';
}

// ── Badge injector ────────────────────────────────────────────────────────────
function injectBadges(scoredProducts) {
  // Remove any previously injected badges
  document.querySelectorAll('.msf-badge-container').forEach(el => el.remove());

  scoredProducts.forEach(product => {
    const card = document.querySelector(`[data-msf-index="${product.index}"]`);
    if (!card) return;

    // Ensure the card can host absolutely-positioned children
    if (getComputedStyle(card).position === 'static') {
      card.style.position = 'relative';
    }

    const score    = parseFloat(product.score ?? 0);
    const cls      = score >= 7 ? 'green' : score >= 4 ? 'yellow' : 'red';
    const sizeText = product.suggested_size ?? '?';
    const reason   = product.fit_summary ?? product.overall_reason ?? '';

    // Build breakdown mini-lines for the tooltip
    const bd = product.breakdown ?? {};
    const br = product.breakdown_reasons ?? {};
    const factorLines = Object.entries(bd)
      .filter(([, v]) => v > 0) // skip 0 = no chart data
      .map(([k, v]) => {
        const pct   = Math.round(v * 10);
        const color = v >= 7 ? '#22c55e' : v >= 4 ? '#f59e0b' : '#ef4444';
        return `<div class="msf-tip-row">
          <span>${cap(k)}</span>
          <span style="display:flex;align-items:center;gap:5px">
            <span style="display:inline-block;width:60px;height:5px;background:#f3f4f6;border-radius:99px;overflow:hidden">
              <span style="display:block;width:${pct}%;height:100%;background:${color};border-radius:99px"></span>
            </span>
            <span>${Number(v).toFixed(1)}</span>
          </span>
        </div>`;
      })
      .join('');

    const recLabel = score === 0
      ? (sizeText && sizeText !== '?' && sizeText !== 'N/A' ? `Size ${sizeText} — out of stock` : 'No size available for you')
      : `We recommend: Size ${sizeText}`;

    const fitQuality = score >= 8 ? 'Great fit' : score >= 6 ? 'Good fit' : score >= 4 ? 'Okay fit' : 'Poor fit';
    const scoreNote  = score === 0 ? '' : `Score shows how well Size ${sizeText} matches your measurements.`;

    const container = document.createElement('div');
    container.className = 'msf-badge-container';
    container.innerHTML = `
      <div class="msf-badge ${cls}" title="${recLabel} · ${score.toFixed(1)}/10">
        <span class="msf-score">${score.toFixed(1)}</span>
      </div>
      <div class="msf-tooltip">
        <div class="msf-tip-header">
          <strong>${recLabel}</strong>
          <span class="msf-tip-score ${cls}">${fitQuality} · ${score.toFixed(1)}/10</span>
        </div>
        ${scoreNote ? `<div class="msf-tip-note">${scoreNote}</div>` : ''}
        ${factorLines}
        <div class="msf-tip-reason">${reason}</div>
      </div>`;

    card.appendChild(container);
  });
}

// ── Sort product cards on Myntra by score ─────────────────────────────────────
function sortByScore(scoredProducts) {
  const firstCard = document.querySelector('[data-msf-index]');
  if (!firstCard) return;
  const container = firstCard.parentElement;
  if (!container) return;

  // insertBefore a fixed reference node so scored items land at the top in order
  const refNode = container.firstChild;

  scoredProducts.forEach(product => {
    const card = document.querySelector(`[data-msf-index="${product.index}"]`);
    if (card) container.insertBefore(card, refNode);
  });
}

// ── Filter badges by score threshold ─────────────────────────────────────────
function filterBadges(threshold) {
  document.querySelectorAll('.msf-badge-container').forEach(container => {
    const card  = container.closest('[data-msf-index]');
    if (!card) return;
    const score = parseFloat(container.querySelector('.msf-score')?.textContent ?? 0);
    card.style.opacity = score < threshold ? '0.35' : '1';
  });
}

// ── Product page scraper ──────────────────────────────────────────────────────
function scrapeProductPage() {
  try {
    const pdp   = window.__myx?.pdpData ?? {};
    const brand = pdp.brand?.name
      || text(document, '[class*="pdp-name"] [class*="brand"], h1[class*="brand"]')
      || '?';
    const name  = pdp.name
      || text(document, '[class*="pdp-name"], [class*="pdp-title"]')
      || document.title.split('|')[0].trim()
      || '?';
    const rawPrice = pdp.price?.discounted || pdp.price?.marked || 0;
    const price = rawPrice ? `₹${rawPrice}` : (text(document, '[class*="pdp-price"] strong, [class*="pdp-price"]') || '?');
    return { brand, name, price, url: location.href, sizes: [], index: 0 };
  } catch {
    return { brand: '?', name: document.title.split('|')[0].trim() || '?', price: '?', url: location.href, sizes: [], index: 0 };
  }
}

function cap(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

