# FitAgent — Technical Documentation

## Overview
A Chrome Extension (Manifest V3) that scrapes Myntra product listings, extracts size chart data from each product page, sends it to an LLM with the user's body measurements, and displays fit scores as overlay badges and a ranked side panel.

---

## Architecture

```
chrome.sidePanel (sidepanel.html/js/css)
       │  ANALYZE message (tabId, url)
       ▼
background.js  ← Service Worker (orchestrator)
  │  SCRAPE_PRODUCTS / SCRAPE_PRODUCT_PAGE
  │  INJECT_BADGES
  ▼
content.js  ← Injected into myntra.com tabs
       │  Scrapes product cards / product page DOM
       ▼
background.js
  │  parallelMap → fetchSizeChart(url) × N
  │  Stream HTML, extract window.__myx JSON
  │  parseMyxSizes() → { available_sizes, out_of_stock_sizes, size_chart_raw }
  ▼
callLLM() → Claude / Gemini / OpenAI / Grok / Ollama
  │  Returns scored JSON array
  ▼
applyPriorityWeights()  ← User-defined dimension weights
  ▼
INJECT_BADGES → content.js renders overlay badges
sidepanel.js renders ranked result cards
```

---

## File Structure

```
myntra-size-finder/
├── manifest.json        MV3 manifest — permissions, host_permissions, side panel
├── background.js        Service worker — orchestration, fetching, LLM calls
├── content.js           Content script — scraping, badge injection, sorting
├── content.css          Badge + tooltip overlay styles
├── sidepanel.html       Side panel shell
├── sidepanel.js         Side panel UI logic (results + settings)
├── sidepanel.css        Side panel styles
├── USER_GUIDE.md        End-user documentation
└── TECHNICAL.md         This file
```

---

## Data Flow (Detailed)

### Step 1 — Category & Page Detection
```js
detectCategory(url)   // 'shirts' | 'trousers' | 'shoes'
isProductPage(url)    // true if URL matches /\d{5,}(\/buy)?/
```
Category is detected from URL keywords. Product pages skip the listing scraper.

### Step 2 — Scraping

**Listing page** (`SCRAPE_PRODUCTS`):
- Queries `li.product-base, [class*="product-base"]`
- Extracts brand, name, price, href, visible size chips
- Stamps each card with `data-msf-index` for later badge injection
- Gender filter: word-boundary regex (`\bwomen\b`, `\bmen\b`) removes wrong-gender items

**Product page** (`SCRAPE_PRODUCT_PAGE`):
- Reads `window.__myx.pdpData` directly
- Returns single product object `{ brand, name, price, url }`

### Step 3 — Size Chart Extraction

Myntra embeds product data as `window.__myx = {...}` in every page HTML.

```
Streaming fetch with AbortController (10s timeout)
  → Read chunks until 'window.__myx' found in text
  → extractProductSizes(jsonFragment)
       → scan for "sizes" key
       → validate: array with 'label' + ('measurements' or 'available') fields
       → skip image-size arrays that also use "sizes" key
  → Abort stream as soon as valid sizes found (~3–5× faster than full download)
```

**`parseMyxSizes(sizes[])`:**
- Iterates size objects, reads `label`, `available`/`quantity`, `measurements[]`
- Each measurement has `name`, `value`, `unit` ("Inches")
- Converts inches → cm: `value × 2.54`
- Builds `size_chart_raw`: JSON string of `[{ size, chest, "front length", "across shoulder" }]`

### Step 4 — LLM Scoring

**Two types of size data the LLM handles:**

| Type | When | How scored |
|---|---|---|
| TYPE 1 — Garment measurements | Chart has actual cm values | `ease = garment − body`, scored by ease range |
| TYPE 2 — Indian reference ranges | Chart is "none", numeric sizes 38–46 | Body chest vs range (38=94-98cm, 40=102-106cm…) |

**Ease scoring tables (TYPE 1):**

*Chest / Waist (fit-dependent):*
| Fit | Ideal ease → 9-10 | Good → 7-8 | Loose → 5-6 | Tight → 3-5 | Very tight → 1-2 |
|---|---|---|---|---|---|
| Slim | 0–4 cm | 4–7 cm | 7–12 cm | <0 cm | <−4 cm |
| Regular | 2–7 cm | 0–2 or 7–12 cm | 12–16 cm | <0 cm | <−4 cm |
| Oversized | 8–16 cm | 4–8 or 16–22 cm | 22–28 cm | <4 cm | <0 cm |

*Shoulder (fit-independent):*
`0–3cm → 9-10 | 3–5cm → 7-8 | 5–8cm → 5-6 | >8cm → 3-4 | <0cm → 3-5 | <−3cm → 1-2`

*Length (fit-independent):*
`0–4cm → 9-10 | −2–0cm → 7-8 | 4–8cm → 6-7 | >8cm → 4-5 | <−2cm → 2-4`

**Trouser ease (waist same as shirt, plus):**
- Hip: `2–6cm → 9-10 | 0–2cm → 8 | 6–10cm → 7 | <0cm → 3-5 | >10cm → 5-6`
- Inseam: `|diff| 0–2cm → 9-10 | 2–4cm → 7-8 | 4–6cm → 5-6 | >6cm → 3-4`

**LLM Output Format (compact keys to save tokens):**
```json
{"i": 0, "score": 8.5, "size": "L", "fit_summary": "...",
 "bd": {"chest": 9.0, "shoulder": 7.5, "front length": 8.0},
 "br": {"chest": "2cm ease, great fit", ...}}
```
- `i` → product index (mapped back to original product)
- `bd` → breakdown scores per dimension (0–10, NOT cm values)
- `br` → short text reasons per dimension

### Step 5 — Priority Weighting (Post-LLM, JS)

After LLM returns per-dimension scores, the final overall score is recomputed in JS using user-defined weights. This makes the scoring deterministic and avoids LLM drift on weight instructions.

```js
weights = { low: 1, medium: 2, high: 3 }
score = Σ(bd[dim] × weight[dim]) / Σ(weight[dim])
```
- Dimensions with `bd[dim] === 0` are excluded (means no chart data, not a zero score)
- Dimensions with `bd[dim] > 10` trigger fallback to LLM's overall score (guards against LLM putting cm values in bd)

### Step 6 — Shoe Scoring (Pure JS, No LLM)

Shoes use UK size matching with no ease calculation needed:
```
diff = |available_size − user_uk_size|
0 → 10 | 0.5 → 8 | 1 → 6 | 1.5 → 4 | 2 → 2 | 2.5+ → 0
```
If closest size is out of stock → score = 0.

---

## Multi-LLM Abstraction

All providers share a common interface. Routing:

```
provider == 'claude'  → callClaude()    POST api.anthropic.com/v1/messages
provider == 'gemini'  → callGemini()    POST generativelanguage.googleapis.com/...
else                  → callOpenAICompat()  POST {baseUrl}/chat/completions
```

OpenAI-compatible path handles OpenAI, Grok, and Ollama (same API schema, different URLs).

**Ollama-specific settings:**
```js
body.options = { num_ctx: 4096, num_predict: 2048 }
body.response_format = { type: 'json_object' }  // forces valid JSON output
```

**Batch processing for local models:**
- Small models (qwen2.5:3b) have ~4096 token context limits
- Products are split into batches of 3 for local, full list for cloud
- Compact prompt used for local: trimmed chart (200 chars), shorter instructions

**Batch error recovery:**
- Each batch runs in a try/catch independently
- If batch N fails, batches N+1…end still complete
- Only fails entirely if ALL batches fail
- Partial results shown with warning

---

## Badge Injection

After scoring, `content.js` injects a `.msf-badge-container` div into each product card:

```
card (li.product-base, position:relative)
└── .msf-badge-container
    ├── .msf-badge.{green|yellow|red}   ← score circle, top-right corner
    └── .msf-tooltip                     ← shown on hover
        ├── .msf-tip-header             "We recommend: Size L"
        ├── .msf-tip-score              "Great fit · 8.5/10"
        ├── .msf-tip-note               "Score shows how well Size L matches..."
        ├── [.msf-tip-row × N]          per-dimension bars
        └── .msf-tip-reason             plain English summary
```

Cards are identified by `data-msf-index` attribute set during scraping — survives React re-renders.

---

## Settings & Storage

Everything stored in `chrome.storage.local`:

```js
{
  profiles: [
    {
      id: "timestamp",
      name: "Casual",
      measurements: {
        chest_cm, length_cm, shoulder_cm, waist_cm,
        hip_cm, inseam_cm, uk_shoe_size,
        gender, fit_preference
      },
      priorities: {
        chest, shoulder, length,    // 'low' | 'medium' | 'high'
        waist, hip, inseam
      }
    }
  ],
  activeProfileId: "timestamp",
  llmConfig: { provider, apiKey, model, baseUrl },
  measurements: { ...activeProfile.measurements },  // denormalized for quick access
  priorities: { ...activeProfile.priorities }
}
```

---

## Key Design Decisions

| Decision | Reason |
|---|---|
| Stream HTML with AbortController | Myntra pages are large; aborting after finding `window.__myx.sizes` is 3–5× faster than downloading the full page |
| Parse `window.__myx` not DOM | Myntra is Next.js; the embedded JSON is more reliable than scraping rendered elements which change with React re-renders |
| Inches → cm in JS, not LLM | Myntra stores all measurements in inches internally; converting in JS is deterministic and removes ambiguity from the prompt |
| Priority weighting in JS post-LLM | LLMs inconsistently follow weight instructions; JS arithmetic is always correct |
| Shoe scoring in pure JS | UK size matching requires no language reasoning — pure arithmetic is faster, cheaper, and more reliable |
| `data-msf-index` for badge anchoring | Survives Myntra's React virtual DOM re-renders; more stable than class or position selectors |
| Batch error recovery | Cloud APIs occasionally timeout or rate-limit; partial results are better than a full failure for the user |
| Compact JSON output keys (`i`, `bd`, `br`) | Reduces output token count by ~30%, important for small local models with strict limits |
