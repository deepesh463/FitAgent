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
  // Collect candidates from both selectors; li.product-base first so the outer
  // list item wins when both a parent li and a child wrapper share the class.
  const allCandidates = [...new Set([
    ...document.querySelectorAll('li.product-base'),
    ...document.querySelectorAll('[class*="product-base"]'),
  ])].filter(card =>
    getComputedStyle(card).display !== 'none' &&
    getComputedStyle(card).visibility !== 'hidden'
  );

  // Deduplicate by product URL — this is the most reliable dedup strategy because
  // Myntra sometimes has both a parent li and a child div matching the selector for
  // the same product.  The li appears first in allCandidates, so it wins.
  const seenUrls = new Set();
  const uniqueCards = [];
  for (const card of allCandidates) {
    const url = card.querySelector('a[href]')?.href || '';
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    uniqueCards.push(card);
  }

  const products = [];

  uniqueCards.forEach((card, index) => {
    const brand  = text(card, '.product-brand, [class*="product-brand"]');
    const name   = text(card, '.product-product, [class*="product-product"]');
    const price  = text(card, '.product-discountedPrice, .product-price, [class*="discountedPrice"], [class*="product-price"]');
    const url    = card.querySelector('a[href]')?.href || '';

    if (!url) return;

    // Scrape size chips shown on the card (e.g. S, M, L, XL or 38, 40, 42)
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

    // fit_summary is primary; fall back to joining br values if it's missing/generic
    const rawSummary = product.fit_summary ?? product.overall_reason ?? '';
    const isGeneric  = !rawSummary || rawSummary.length < 6 || /^(reason|summary|n\/a)$/i.test(rawSummary.trim());
    const reason     = isGeneric
      ? Object.entries(product.breakdown_reasons ?? {}).map(([k, v]) => `${cap(k)}: ${v}`).join(' · ')
      : rawSummary;

    // Build breakdown mini-lines for the tooltip
    const bd = product.breakdown ?? {};
    const br = product.breakdown_reasons ?? {};
    const factorLines = Object.entries(bd)
      .filter(([, v]) => v > 0 && v <= 10) // skip 0 (no data) and >10 (LLM put cm values)
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

