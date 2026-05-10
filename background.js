'use strict';

// ── Initialise side-panel behaviour ─────────────────────────────────────────
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ── Last prompt store (for debug view) ───────────────────────────────────────
let _lastPrompt = '';

// ── Message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'ANALYZE') {
    runAnalysis(msg.tabId, msg.url || '')
      .then(result => sendResponse(result))
      .catch(err  => sendResponse({ error: err.message }));
    return true;
  }
  if (msg.type === 'GET_LAST_PROMPT') {
    sendResponse({ prompt: _lastPrompt });
  }
});

// ── Category + page-type helpers ─────────────────────────────────────────────
function detectCategory(url) {
  const u = (url || '').toLowerCase();
  if (/\b(shoes?|sneakers?|footwear|sandals?|boots?|loafers?|slippers?|heels?|moccasins?|sports-shoes?|casual-shoes?|formal-shoes?)\b/.test(u)) return 'shoes';
  if (/\b(trousers?|pants?|jeans?|chinos?|cargos?|joggers?|shorts?|leggings?|skirts?|denim)\b/.test(u)) return 'trousers';
  // shirts, t-shirts, polos, sweatshirts, hoodies, jackets all share chest/shoulder/length scoring
  return 'shirts';
}

function isProductPage(url) {
  // Myntra product URLs end with /NNNNN/buy or /NNNNN
  return /\/\d{5,}(\/buy)?\/?(\?.*)?$/.test(url || '');
}

// ── Main pipeline ────────────────────────────────────────────────────────────
async function runAnalysis(tabId, tabUrl) {
  const category    = detectCategory(tabUrl);
  const productPage = isProductPage(tabUrl);

  // 1. Ensure content script is injected
  progress('Reading products on page…');
  let products;
  try {
    const msgType = productPage ? 'SCRAPE_PRODUCT_PAGE' : 'SCRAPE_PRODUCTS';
    products = await chrome.tabs.sendMessage(tabId, { type: msgType });
  } catch {
    progress('Injecting extension into page…');
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
      await new Promise(r => setTimeout(r, 300));
      const msgType = productPage ? 'SCRAPE_PRODUCT_PAGE' : 'SCRAPE_PRODUCTS';
      products = await chrome.tabs.sendMessage(tabId, { type: msgType });
    } catch (e) {
      throw new Error('Could not read this page. Make sure you are on a Myntra listing or product page.');
    }
  }

  // Normalise: product page returns a single object, listing returns array
  if (!Array.isArray(products)) products = products ? [products] : [];

  if (!products.length) {
    throw new Error('No products found. Try a Myntra search or category page (e.g. myntra.com/shirts).');
  }

  // 2. Load user settings
  const stored = await chrome.storage.local.get(['measurements', 'llmConfig', 'priorities']);
  if (!stored.measurements) {
    throw new Error('No measurements saved. Open Settings (⚙) and enter your measurements first.');
  }
  const gender = (stored.measurements.gender || 'male').toLowerCase();

  // 3. Gender filter (not needed for product pages — user navigated there deliberately)
  const genderFiltered = productPage
    ? products
    : products.filter(p => !isWrongGender(p, gender));
  const capped = genderFiltered.slice(0, 50);
  progress(`Found ${capped.length} product${capped.length !== 1 ? 's' : ''}. Fetching size charts…`);

  // 4. Fetch size charts in parallel
  const enriched = await parallelMap(capped, async (p, i) => {
    if (!productPage) progress(`Size chart ${i + 1}/${capped.length}…`);
    const sizeData = await fetchSizeChart(p.url);
    return { ...p, ...sizeData };
  }, 8);

  progress(`Scoring ${enriched.length} product${enriched.length !== 1 ? 's' : ''} with AI…`);

  // 5. Score with LLM (batch errors are tolerated — partial results shown)
  let scored;
  try {
    // Shoes: pure JS size matching — no LLM needed, instant and reliable
    if (category === 'shoes') {
      scored = scoreShoes(enriched, stored.measurements);
    } else {
      scored = await callLLM(enriched, stored.measurements, stored.llmConfig || { provider: 'claude' }, category);
    }
  } catch (err) {
    throw new Error(`AI scoring failed: ${err.message}`);
  }

  if (!Array.isArray(scored) || scored.length === 0) {
    throw new Error('No results returned. Try again.');
  }

  // 6. Recompute score using user's dimension priorities (shirts + trousers only)
  if (category !== 'shoes') {
    const priorities = stored.priorities ?? {};
    scored = scored.map(p => ({ ...p, score: applyPriorityWeights(p, priorities) }));
  }
  scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // 7. Inject badges (only on listing pages — product page has no cards)
  if (!productPage) {
    chrome.tabs.sendMessage(tabId, { type: 'INJECT_BADGES', data: scored }).catch(() => {});
  }

  return { success: true, data: scored, category, productPage };
}

// ── Shoe scoring (pure JS — no LLM) ──────────────────────────────────────────
function scoreShoes(products, measurements) {
  const userSize = parseFloat(measurements.uk_shoe_size);
  if (!userSize) return products.map((p, i) => ({
    index: p.index ?? i, brand: p.brand, name: p.name, price: p.price, url: p.url,
    score: 0, suggested_size: '?', fit_summary: 'Enter your UK shoe size in Settings.', breakdown: {}, breakdown_reasons: {},
  }));

  // Score: exact=10, 0.5 off=8, 1 off=6, 1.5 off=4, 2 off=2, 2.5+=0
  const sizeScore = diff => diff === 0 ? 10 : diff <= 0.5 ? 8 : diff <= 1 ? 6 : diff <= 1.5 ? 4 : diff <= 2 ? 2 : 0;

  return products.map((p, i) => {
    const available = [...new Set([...(p.available_sizes || []), ...(p.sizes || [])])];
    const oos       = p.out_of_stock_sizes || [];
    const all       = [...available, ...oos].map(s => parseFloat(s)).filter(n => !isNaN(n));

    if (all.length === 0) return {
      index: p.index ?? i, brand: p.brand, name: p.name, price: p.price, url: p.url,
      score: 0, suggested_size: '?', fit_summary: 'No size info available.', breakdown: {}, breakdown_reasons: {},
    };

    // Find closest size overall, then check if it's in stock
    const closest     = all.reduce((a, b) => Math.abs(b - userSize) < Math.abs(a - userSize) ? b : a);
    const diff        = Math.abs(closest - userSize);
    const isInStock   = available.map(s => parseFloat(s)).includes(closest);
    const score       = isInStock ? sizeScore(diff) : 0;
    const sizeLabel   = `UK ${closest % 1 === 0 ? closest : closest.toFixed(1)}`;
    const fit_summary = score === 0 && !isInStock
      ? `${sizeLabel} would be your closest fit but is out of stock.`
      : score === 10 ? `Perfect match — ${sizeLabel} is available.`
      : score >= 6  ? `${sizeLabel} is the closest available (${diff <= 0.5 ? 'half' : diff} size${diff > 1 ? 's' : ''} off).`
      : `Closest size ${sizeLabel} is ${diff} sizes away — may not fit well.`;

    return {
      index: p.index ?? i, brand: p.brand, name: p.name, price: p.price, url: p.url,
      score, suggested_size: String(closest), fit_summary, breakdown: {}, breakdown_reasons: {},
    };
  }).sort((a, b) => b.score - a.score);
}

// ── Priority-weighted score ───────────────────────────────────────────────────
function applyPriorityWeights(product, priorities) {
  // If score is 0 (OOS / no size), keep it 0
  if (!product.score || product.score === 0) return 0;

  const bd = product.breakdown ?? {};
  const dims = Object.keys(bd);
  if (dims.length === 0) return product.score; // no breakdown — keep LLM score

  // Guard: if any value > 10 the LLM put measurements instead of scores — fall back
  if (dims.some(k => (bd[k] ?? 0) > 10)) return product.score;

  const weightMap = { low: 1, medium: 2, high: 3 };
  let totalWeight = 0;
  let weightedSum = 0;

  dims.forEach(dim => {
    const val = bd[dim] ?? 0;
    if (val === 0) return; // 0 means no chart data for this dimension — exclude from average
    const w = weightMap[priorities[dim] ?? 'medium'] ?? 2;
    totalWeight += w;
    weightedSum += val * w;
  });

  if (totalWeight === 0) return product.score;
  return Math.round((weightedSum / totalWeight) * 10) / 10;
}

// ── Gender filter ─────────────────────────────────────────────────────────────
const FEMALE_KEYWORDS = ['women', 'woman', 'ladies', 'lady', 'girl', 'female', 'saree', 'kurti', 'lehenga', 'salwar', 'dupatta', 'blouse', 'bra', 'lingerie'];
const MALE_KEYWORDS   = ['men', 'man', 'boys', 'boy', 'male', 'gents'];

const FEMALE_RE = new RegExp(`\\b(${FEMALE_KEYWORDS.join('|')})\\b`);
const MALE_RE   = new RegExp(`\\b(${MALE_KEYWORDS.join('|')})\\b`);

function isWrongGender(product, gender) {
  if (gender === 'unisex') return false;
  const haystack = `${product.name} ${product.brand} ${product.url}`.toLowerCase();

  if (gender === 'male') {
    return FEMALE_RE.test(haystack) && !MALE_RE.test(haystack);
  }
  if (gender === 'female') {
    return MALE_RE.test(haystack) && !FEMALE_RE.test(haystack);
  }
  return false;
}

function progress(message) {
  chrome.runtime.sendMessage({ type: 'PROGRESS', message }).catch(() => {});
}

// Run async tasks with a concurrency limit
async function parallelMap(items, fn, concurrency = 5) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ── Size-chart fetcher — Myntra stores data in window.__myx, not __NEXT_DATA__ ──
async function fetchSizeChart(url) {
  if (!url) return { available_sizes: [], out_of_stock_sizes: [], size_chart_raw: '' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html',
      },
    });

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   chunk   = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunk += decoder.decode(value, { stream: true });

      // Myntra embeds product data as: window.__myx = {...};
      const myxIdx = chunk.indexOf('window.__myx');
      if (myxIdx !== -1) {
        const jsonStart = chunk.indexOf('{', myxIdx);
        if (jsonStart !== -1) {
          const jsonSoFar = chunk.slice(jsonStart);
          // Product sizes contain "measurements" inside each entry — find that specific array
          const sizes = extractProductSizes(jsonSoFar);
          if (sizes !== null) {
            controller.abort();
            clearTimeout(timer);
            return parseMyxSizes(sizes);
          }
          // Safety: give up after 350KB if no product sizes found
          if (jsonSoFar.length > 350_000) break;
        }
      }

      if (chunk.length > 400_000) break;
    }

    clearTimeout(timer);
    return { available_sizes: [], out_of_stock_sizes: [], size_chart_raw: '' };
  } catch (e) {
    clearTimeout(timer);
    return { available_sizes: [], out_of_stock_sizes: [], size_chart_raw: '' };
  }
}

// ── Extract a JSON field value from raw text using bracket counting ───────────
function extractJsonField(text, key, fromIdx = 0) {
  const idx = text.indexOf(`"${key}"`, fromIdx);
  if (idx === -1) return null;
  const colon = text.indexOf(':', idx + key.length + 2);
  if (colon === -1) return null;

  let start = colon + 1;
  while (start < text.length && text[start] === ' ') start++;

  const opener = text[start];
  if (opener !== '[' && opener !== '{') return null;

  const closer = opener === '[' ? ']' : '}';
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === opener) depth++;
    else if (text[i] === closer) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// ── Find the "sizes" array that contains product size objects with measurements ─
function extractProductSizes(text) {
  let from = 0;
  while (true) {
    const idx = text.indexOf('"sizes"', from);
    if (idx === -1) return null;
    const arr = extractJsonField(text, 'sizes', idx);
    if (
      Array.isArray(arr) && arr.length > 0 &&
      arr[0] && typeof arr[0] === 'object' &&
      ('measurements' in arr[0] || 'available' in arr[0]) &&
      'label' in arr[0]
    ) return arr;
    from = idx + 7;
  }
}

// ── Parse product sizes array — measurements[] are in Inches, convert to cm ───
function parseMyxSizes(sizes) {
  const available_sizes    = [];
  const out_of_stock_sizes = [];
  const chartRows          = [];

  (Array.isArray(sizes) ? sizes : []).forEach(s => {
    const label     = typeof s === 'string' ? s : (s.label ?? s.size ?? s.value ?? '');
    const quantity  = s.quantity ?? s.qty ?? null;
    const inStock   = typeof s === 'string' ? true : (s.available ?? s.inStock ?? true);
    const stockBool = quantity !== null ? quantity > 0 : Boolean(inStock);
    if (!label) return;
    if (stockBool) available_sizes.push(String(label));
    else           out_of_stock_sizes.push(String(label));

    // Extract garment measurements embedded in each size entry
    if (Array.isArray(s.measurements)) {
      const row = { size: label };
      s.measurements.forEach(m => {
        const raw = parseFloat(m.value ?? m.minValue);
        if (isNaN(raw) || !m.name) return;
        const isInches = /inch/i.test(m.unit || '');
        row[m.name.toLowerCase()] = isInches ? Math.round(raw * 2.54 * 10) / 10 : raw;
      });
      chartRows.push(row);
    }
  });

  const size_chart_raw = chartRows.length > 0
    ? JSON.stringify(chartRows).slice(0, 1500)
    : '';

  return { available_sizes, out_of_stock_sizes, size_chart_raw };
}

function parseNextData(json) {
  try {
    const nd = JSON.parse(json);

    // Standard Next.js layout: props.pageProps contains actual data
    const root = nd?.props?.pageProps ?? nd?.props ?? nd;

    // Search for chart under multiple key names
    const chart =
      findDeep(root, 'sizeChartInfo') ||
      findDeep(root, 'sizeChart')     ||
      findDeep(root, 'sizeRepresentation') ||
      findDeep(root, 'measurementChart')   ||
      findDeep(root, 'sizeChartDetail')    ||
      findDeep(root, 'sizeFit');

    // Find the product sizes array — must have objects with availability fields
    const rawSizes = findDeepWhere(root, 'sizes', v =>
      Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object' &&
      ('label' in v[0] || 'available' in v[0] || 'quantity' in v[0] || 'inStock' in v[0])
    ) || [];

    const available_sizes    = [];
    const out_of_stock_sizes = [];

    rawSizes.forEach(s => {
      const label     = typeof s === 'string' ? s : (s.label ?? s.size ?? s.value ?? s.sizeValue ?? '');
      const quantity  = s.quantity ?? s.qty ?? null;
      const inStock   = typeof s === 'string' ? true : (s.available ?? s.inStock ?? s.stock ?? true);
      const stockBool = quantity !== null ? quantity > 0 : Boolean(inStock);
      if (!label) return;
      if (stockBool) available_sizes.push(String(label));
      else           out_of_stock_sizes.push(String(label));
    });

    // Build chart string — prefer dedicated chart block, fall back to sizes with measurement fields
    let chartRaw = chart ? JSON.stringify(chart).slice(0, 1500) : '';
    if (!chartRaw && rawSizes.length > 0) {
      const withMeasurements = rawSizes.filter(s =>
        s && typeof s === 'object' &&
        Object.keys(s).some(k => /chest|shoulder|waist|hip|length|measure/i.test(k))
      );
      if (withMeasurements.length > 0) {
        chartRaw = JSON.stringify(withMeasurements).slice(0, 1500);
      }
    }

    return { available_sizes, out_of_stock_sizes, size_chart_raw: chartRaw };
  } catch {
    return { available_sizes: [], out_of_stock_sizes: [], size_chart_raw: '' };
  }
}

function findDeepWhere(obj, key, predicate) {
  if (!obj || typeof obj !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(obj, key) && predicate(obj[key])) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findDeepWhere(v, key, predicate);
    if (found !== null) return found;
  }
  return null;
}

function findDeep(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const found = findDeep(v, key);
    if (found !== null) return found;
  }
  return null;
}

function extractSizeLabels(sizes) {
  if (!Array.isArray(sizes)) return [];
  return sizes
    .map(s => (typeof s === 'string' ? s : (s.label ?? s.size ?? s.value ?? '')))
    .filter(Boolean);
}

function extractTableText(html) {
  const lower = html.toLowerCase();
  const idx = lower.indexOf('size chart');
  if (idx === -1) return '';
  const tStart = lower.indexOf('<table', idx);
  if (tStart === -1) return '';
  const tEnd = lower.indexOf('</table>', tStart) + 8;
  return html.slice(tStart, tEnd).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
}

// ── LLM orchestrator ─────────────────────────────────────────────────────────
async function callLLM(products, measurements, config, category = 'shirts') {
  const { provider = 'claude', apiKey, baseUrl, model } = config;
  const isLocal = provider === 'local';

  // For local models use compact prompts to stay within ~4096 token context window
  const builder = isLocal
    ? (category === 'trousers' ? buildLocalTrouserPrompt : buildLocalPrompt)
    : (category === 'trousers' ? buildTrouserPrompt : buildPrompt);

  const batchSize = isLocal ? 3 : products.length;

  const runBatch = (batch) => {
    const prompt = builder(batch, measurements);
    if (provider === 'claude')  return callClaude(prompt, apiKey, model, batch);
    if (provider === 'gemini')  return callGemini(prompt, apiKey, model, batch);
    return callOpenAICompat(prompt, apiKey, baseUrl, model, provider, batch);
  };

  if (products.length <= batchSize) {
    _lastPrompt = builder(products, measurements);
    return runBatch(products);
  }

  // Multiple batches — tolerate individual failures, show partial results
  const batches = [];
  for (let i = 0; i < products.length; i += batchSize) batches.push(products.slice(i, i + batchSize));

  const allResults  = [];
  const batchErrors = [];
  for (let bi = 0; bi < batches.length; bi++) {
    if (bi === 0) _lastPrompt = builder(batches[0], measurements);
    progress(`Scoring batch ${bi + 1} of ${batches.length}…`);
    try {
      allResults.push(...await runBatch(batches[bi]));
    } catch (err) {
      console.warn(`Batch ${bi + 1} failed:`, err.message);
      batchErrors.push(`Batch ${bi + 1}: ${err.message}`);
    }
  }

  if (allResults.length === 0) throw new Error(batchErrors[0] || 'All batches failed');
  if (batchErrors.length > 0)  progress(`⚠ ${batchErrors.length} batch(es) had errors — showing partial results`);

  return allResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

// ── Prompt builder ────────────────────────────────────────────────────────────
function buildPrompt(products, measurements) {
  const m = measurements;
  const list = products.map((p, i) => {
    const inStock  = [...new Set([...(p.available_sizes || []), ...(p.sizes || [])])].join(',') || 'unknown';
    const oos      = (p.out_of_stock_sizes || []).join(',') || 'none';
    const chart    = (p.size_chart_raw || '').slice(0, 1500);
    return `${i}|${p.brand}|${p.name}|in_stock:${inStock}|out_of_stock:${oos}|chart:${chart || 'none'}`;
  }).join('\n---\n');

  return `You are a clothing size matcher for tops (shirts, t-shirts, polos, sweatshirts, hoodies, jackets).

Customer measurements: chest=${m.chest_cm}cm, length=${m.length_cm}cm, shoulder=${m.shoulder_cm}cm, gender=${m.gender}, fit=${m.fit_preference}
NOTE: "shoulder" in measurements = "across shoulder" in size chart. Match them by name.

Products (index|brand|name|in_stock|out_of_stock|size_chart):
${list}

IMPORTANT — TWO TYPES OF SIZE DATA:

TYPE 1 — GARMENT MEASUREMENTS (when size_chart has actual cm values per size):
  The chart values = how big the physical garment is (e.g. chest:116.8cm means the shirt measures 116.8cm around).
  ease = garment_chest − customer_chest
  A shirt FITS if garment_chest ≥ customer_chest (positive ease = room to wear).
  A shirt is TOO SMALL if garment_chest < customer_chest (negative ease = can't wear).
  Scoring by ease for customer's fit preference (${m.fit_preference}):
    slim fit:     ease 0–4cm → 9-10 | 4–7cm → 7-8 | 7–12cm → 5-6 | >12cm → 3-4 | <0cm → 3-5 | <−4cm → 1-2
    regular fit:  ease 2–7cm → 9-10 | 0–2cm or 7–12cm → 7-8 | 12–16cm → 5-6 | >16cm → 3-4 | <0cm → 3-5 | <−4cm → 1-2
    oversized:    ease 8–16cm → 9-10 | 4–8cm or 16–22cm → 7-8 | 22–28cm → 5-6 | <4cm → 4-6 | <0cm → 1-3
  Apply the same ease logic to shoulder and length using these ranges:
    shoulder (all fits): ease 0–3cm → 9-10 | 3–5cm → 7-8 | 5–8cm → 5-6 | >8cm → 3-4 | <0cm → 3-5 | <−3cm → 1-2
    length   (all fits): ease 0–4cm → 9-10 | −2–0cm → 7-8 | 4–8cm → 6-7 | >8cm → 4-5 | <−2cm → 2-4
  The further the ease is from the ideal range, the lower the score.
  fit_summary example: "Garment chest 116.8cm vs your 115.1cm — 1.7cm ease, snug regular fit."

TYPE 2 — INDIAN REFERENCE RANGES (when chart is "none" and sizes are numeric 38–46):
  These are body measurement ranges, not garment measurements.
  38→body chest 94–98cm | 39→98–102cm | 40→102–106cm | 42→106–112cm | 44→112–118cm | 46→118–124cm
  Score 9-10: body chest inside range | 7-8: within 2cm of boundary | 5-6: within 4cm | 3-4: within 6cm | 1-2: >6cm off
  For S/M/L/XL with no chart: score 0 — unknown measurements.

TASK for each product:
1. Check size_chart — if it has cm values use TYPE 1 (garment measurements). If "none" and numeric sizes use TYPE 2.
2. Find which in-stock size gives the best ease/fit for the customer.
3. Score and fit_summary based on the cases below:

   CASE A — best size is IN STOCK:
   - Use scoring rules above for TYPE 1 or TYPE 2
   - fit_summary must state ease or distance from range and whether it fits well or is tight/loose

   CASE B — best size is OUT OF STOCK:
   - Score = 0
   - size = that out-of-stock size label
   - fit_summary: "Size L would fit you (98–102cm) but is currently out of stock."

   CASE C — no size is close enough (in stock or not):
   - Score = 0
   - size = "Not your size"
   - fit_summary: "This shirt doesn't come in your size. Largest available is Size M (94–98cm), you need 100cm+."

   CASE D — wrong gender:
   - Score = 0, size = "N/A", fit_summary = "Wrong gender — skip this."

4. "br" reasons: ≤8 words each, mention actual cm values.
5. Only include a dimension in "bd"/"br" if the chart has data for it.
6. Overall "score" = weighted average of bd scores (0–10). Never put cm values in "score" or "bd".

⚠ OUTPUT FORMAT — every number in "score" and "bd" must be between 0 and 10. They are FIT SCORES, not centimetres.
Worked example (slim fit user chest=107cm, size L garment chest=114cm → ease=7cm → score 5-6):
[{"i":0,"score":5.5,"size":"L","fit_summary":"114cm garment vs 107cm body — 7cm ease, too loose for slim fit.","bd":{"chest":5.5},"br":{"chest":"7cm ease, loose for slim"}}]

Reply ONLY as a JSON array, no markdown, no explanation. All ${products.length} items, sorted score desc.`;
}

// ── Compact prompt for small local models (qwen, llama 3B etc.) ───────────────
function buildLocalPrompt(products, measurements) {
  const m = measurements;
  const fit = m.fit_preference;
  // ease rules in one line
  const easeRule = fit === 'slim'
    ? 'ease 0-4cm→10, 4-7cm→8, <0cm→4, <-4cm→1'
    : fit === 'oversized'
    ? 'ease 8-16cm→10, 4-8cm→8, <4cm→5, <0cm→2'
    : 'ease 2-7cm→10, 0-2cm→8, 7-12cm→7, <0cm→4, <-4cm→1';

  const list = products.map((p, i) => {
    const inStock = [...new Set([...(p.available_sizes || []), ...(p.sizes || [])])].join(',') || '?';
    const oos     = (p.out_of_stock_sizes || []).join(',') || '';
    const chart   = (p.size_chart_raw || '').slice(0, 200) || 'none';
    return `${i}|${p.brand}|in_stock:${inStock}${oos ? '|oos:' + oos : ''}|chart:${chart}`;
  }).join('\n');

  return `You score fit for tops (shirts, t-shirts, polos, sweatshirts). Output ONLY a JSON object with a "results" array.

Body: chest=${m.chest_cm}cm fit=${fit}

Rules:
- chart has cm values = garment size. ${easeRule}. Pick best in-stock size.
- chart "none" + numeric sizes: 38=94-98cm,40=102-106cm,42=106-112cm,44=112-118cm,46=118-124cm body chest.
- OOS size → score=0. No match → score=0,size="N/A".

Output: {"results":[{"i":0,"score":8.5,"size":"L","fit_summary":"reason","bd":{"chest":9},"br":{"chest":"fits"}}]}

Products:
${list}`;
}

// ── Compact trouser prompt for local models (qwen, llama 3B etc.) ────────────
function buildLocalTrouserPrompt(products, measurements) {
  const m   = measurements;
  const fit = m.trouser_fit || m.fit_preference || 'regular';
  const waistRule =
      fit === 'skinny'    ? 'ease 0-1cm→10, 1-2cm→8, 2-4cm→6, >4cm→4, <0cm→5(stretch), <-2cm→1'
    : fit === 'slim'      ? 'ease 1-3cm→10, 0-1cm→8, 3-5cm→6, <0cm→4, <-3cm→1'
    : fit === 'baggy'     ? 'ease 8-15cm→10, 5-8cm→8, 15-20cm→6, <5cm→4, <0cm→2'
    : fit === 'stretched' ? 'ease -2to2cm→10, 2-4cm→8, >4cm→6, <-2cm→4, <-4cm→1'
    :                       'ease 2-5cm→10, 0-2cm→8, 5-8cm→7, >8cm→5, <0cm→4, <-3cm→1';

  const list = products.map((p, i) => {
    const inStock = [...new Set([...(p.available_sizes||[]), ...(p.sizes||[])])].join(',') || '?';
    const oos     = (p.out_of_stock_sizes||[]).join(',') || '';
    const chart   = (p.size_chart_raw||'').slice(0, 200) || 'none';
    return `${i}|${p.brand}|in_stock:${inStock}${oos ? '|oos:'+oos : ''}|chart:${chart}`;
  }).join('\n');

  return `You score fit for TROUSERS/JEANS/PANTS. Output ONLY a JSON object with a "results" array.

Body: waist=${m.waist_cm||'?'}cm hip=${m.hip_cm||'?'}cm inseam=${m.inseam_cm||'?'}cm fit=${fit}

Rules:
- chart cm values = garment. waist: ${waistRule}
- hip: ease 2-6cm→10, 0-2cm→8, 6-10cm→7, <0cm→4, >10cm→5
- inseam: |diff| 0-2cm→10, 2-4cm→8, 4-6cm→5, >6cm→3
- 32/34 sizes: first=waist inches, second=inseam inches (×2.54 for cm)
- single 28-40: waist inches (28=71,30=76,32=81,34=86,36=91,38=97cm)
- OOS → score=0. No match → score=0,size="N/A"

Output: {"results":[{"i":0,"score":8.5,"size":"32","fit_summary":"reason","bd":{"waist":9,"hip":8,"inseam":8},"br":{"waist":"2cm ease","hip":"4cm ease","inseam":"ok"}}]}

Products:
${list}`;
}

// ── Trouser prompt (same ease logic as shirts, different measurements) ────────
function buildTrouserPrompt(products, measurements) {
  const m   = measurements;
  const fit = m.trouser_fit || m.fit_preference || 'regular';
  const waistRule =
      fit === 'skinny'    ? 'ease 0-1cm→9-10, 1-2cm→7-8, 2-4cm→5-6, >4cm→3-4, <0cm(stretch ok)→6-8 if fabric stretches else 3-5, <-2cm→1-2'
    : fit === 'slim'      ? 'ease 1-3cm→9-10, 0-1cm→8, 3-5cm→7, <0cm→3-6, <-3cm→1-2'
    : fit === 'baggy'     ? 'ease 8-15cm→9-10, 5-8cm→7-8, 15-20cm→5-6, <5cm→4-6, <0cm→2-3'
    : fit === 'stretched' ? 'ease -2 to 2cm→9-10, 2-4cm→7-8, >4cm→5-6, <-2cm→4-6, <-4cm→1-3 (stretch fabric accommodates negative ease)'
    :                       'ease 2-5cm→9-10, 0-2cm or 5-8cm→7-8, >8cm→5-6, <0cm→3-6, <-3cm→1-2';

  const list = products.map((p, i) => {
    const inStock = [...new Set([...(p.available_sizes||[]), ...(p.sizes||[])])].join(',') || 'unknown';
    const oos     = (p.out_of_stock_sizes||[]).join(',') || 'none';
    const chart   = (p.size_chart_raw||'').slice(0, 1500);
    return `${i}|${p.brand}|${p.name}|in_stock:${inStock}|out_of_stock:${oos}|chart:${chart||'none'}`;
  }).join('\n---\n');

  return `You are a clothing size matcher for TROUSERS/JEANS/PANTS.
Same logic as shirts: size chart has GARMENT measurements in cm, ease = garment − customer.

Customer: waist=${m.waist_cm||'?'}cm, hip=${m.hip_cm||'?'}cm, inseam=${m.inseam_cm||'?'}cm, gender=${m.gender||'male'}, desired fit style=${fit}
NOTE: chart key "hip" or "seat" = customer hip. "inseam" or "inner leg" = customer inseam.

Products (index|brand|name|in_stock|out_of_stock|size_chart):
${list}

Scoring:
  waist: ${waistRule}
  hip: ease 2-6cm→9-10, 0-2cm→8, 6-10cm→7, <0cm→3-5, >10cm→5-6
  inseam: |diff| 0-2cm→9-10, 2-4cm→7-8, 4-6cm→5-6, >6cm→3-4

For "32/34" style sizes: first=waist inches, second=inseam inches (×2.54 for cm).
For single numeric 28-40: waist inches (28=71,30=76,32=81,34=86,36=91,38=97,40=102cm).
CASE B (OOS): score=0. CASE C (no match): score=0,size="N/A".

⚠ "score"/"bd" values = 0-10 fit scores, NOT cm.
Example: [{"i":0,"score":8.5,"size":"32","fit_summary":"waist 83cm vs your 81cm — 2cm ease.","bd":{"waist":9.0,"hip":8.5,"inseam":8.0},"br":{"waist":"2cm ease","hip":"4cm ease","inseam":"1cm short"}}]

All ${products.length} items sorted score desc. JSON array only, no markdown.`;
}

// ── Claude ────────────────────────────────────────────────────────────────────
async function callClaude(prompt, apiKey, model = 'claude-sonnet-4-6', products) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Claude ${res.status}`);
  return parseJSON(data.content[0].text, products);
}

// ── Gemini ────────────────────────────────────────────────────────────────────
async function callGemini(prompt, apiKey, model = 'gemini-2.5-flash', products) {
  const key = (apiKey || '').trim();
  if (!key) throw new Error('Gemini API key is empty. Open Settings and paste your key.');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 65536 },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Gemini ${res.status}`);
  return parseJSON(data.candidates[0].content.parts[0].text, products);
}

// ── OpenAI-compatible (OpenAI / Grok / Local Ollama) ─────────────────────────
async function callOpenAICompat(prompt, apiKey, baseUrl, model, provider, products) {
  const DEFAULTS = {
    openai: { url: 'https://api.openai.com/v1',      model: 'gpt-4o'      },
    grok:   { url: 'https://api.x.ai/v1',            model: 'grok-2'      },
    local:  { url: 'http://localhost:11434/v1',       model: 'qwen2.5:3b'  },
  };
  const d = DEFAULTS[provider] || DEFAULTS.local;
  const endpoint = (baseUrl || d.url) + '/chat/completions';
  const mdl = model || d.model;

  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;

  const body = {
    model: mdl,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 2048,
    stream: false,
  };
  if (provider === 'local') {
    body.options = { num_ctx: 4096, num_predict: 2048 };
    body.response_format = { type: 'json_object' }; // forces valid JSON output
  }

  const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
  const rawText = await res.text();
  if (!rawText.trim()) {
    throw new Error(`Ollama returned empty response using model "${mdl}". Make sure the model is pulled: run "ollama pull ${mdl}" in a terminal.`);
  }
  let data;
  try { data = JSON.parse(rawText); } catch (e) {
    throw new Error(`${provider} (model: ${mdl}) bad JSON. Status ${res.status}. Body: ${rawText.slice(0, 400)}`);
  }
  if (!res.ok) throw new Error(data.error?.message || `${provider} ${res.status} — model "${mdl}"`);
  return parseJSON(data.choices[0].message.content, products);
}

// ── JSON parser (strips markdown fences if model adds them) ───────────────────
function parseJSON(text, products) {
  let s = text.trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  const parsed = JSON.parse(s);
  // Support {"results":[...]} wrapper (used by local JSON mode) and plain arrays
  const raw = Array.isArray(parsed) ? parsed : (parsed.results ?? Object.values(parsed)[0] ?? []);

  // Map compact keys → full keys and re-attach brand/name/price/url from original products
  return raw.map(r => {
    const orig = products?.[r.i] ?? {};
    return {
      // Use the original DOM index (set by content.js during scraping) so badge
      // injection finds the right card even after gender filtering removes items.
      index:             orig.index ?? r.i,
      brand:             orig.brand ?? r.brand ?? '?',
      name:              orig.name  ?? r.name  ?? '?',
      price:             orig.price ?? r.price ?? '?',
      url:               orig.url   ?? r.url   ?? '',
      score:             r.score,
      suggested_size:    r.size,
      fit_summary:       r.fit_summary ?? r.why ?? '',
      breakdown:         r.bd ?? {},
      breakdown_reasons: r.br ?? {},
    };
  });
}
