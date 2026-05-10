# FitAgent — User Guide

## What It Does
FitAgent is a Chrome extension that reads every product on a Myntra listing page, fetches each product's size chart, and uses AI to score how well each item fits **your exact body measurements**. Scores appear as badges on the product cards and a ranked list in the side panel tells you which size to buy.

---

## Installation

1. Download or clone the project folder.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer Mode** (top-right toggle).
4. Click **Load unpacked** and select the project folder.
5. The extension icon appears in your toolbar.

---

## First-Time Setup

Click the extension icon to open the side panel, then click the **⚙ gear icon** to open Settings.

### Your Measurements

Measurements are organised into three tabs — fill in only the tabs relevant to what you shop for:

**👕 Shirts tab** — Chest, Length, Shoulder + Fit style
| Used for |
|---|
| Shirts, T-shirts, Polos, Sweatshirts, Hoodies, Jackets |

**👖 Trousers tab** — Waist, Hip, Inseam + Fit style
| Used for |
|---|
| Trousers, Jeans, Chinos, Cargos, Joggers, Shorts |

**👟 Shoes tab** — UK Shoe Size only
| Used for |
|---|
| All footwear (sneakers, boots, sandals, formal shoes) |

**How to measure:**
- **Chest** — tape around the fullest part of your chest (cm)
- **Length** — collar base to shirt hem while wearing a well-fitting shirt (cm)
- **Shoulder** — seam to seam across the back (cm)
- **Waist** — around your natural waist (cm)
- **Hip** — around the fullest part of your hips (cm)
- **Inseam** — crotch to ankle along the inner leg (cm)
- **UK Shoe Size** — your standard UK shoe size, half sizes supported (e.g. 9 or 9.5)

### Fit Style

**For Shirts:**
- **Slim** — follows your body closely, minimal extra room
- **Regular** — comfortable fit with some ease
- **Oversized** — intentionally loose/relaxed fit

**For Trousers:**
- **Skinny** — very close to the leg, minimal ease (works best with stretch fabric)
- **Slim** — tapered, close fit with a little room
- **Regular** — classic comfortable fit
- **Baggy** — intentionally loose and roomy
- **Stretched (Lycra/Flex)** — for stretch-fabric trousers that accommodate negative ease

### What Matters Most to You?
Use the Low / Medium / High toggles to tell the extension which dimensions affect your score the most. For example, if shirt length is critical for you (tall build), set Length → High.

### AI Provider
Choose your preferred AI model:

| Provider | Cost | Setup |
|---|---|---|
| Google Gemini | Free tier (20 req/day) | [aistudio.google.com](https://aistudio.google.com) |
| Claude (Anthropic) | Paid | [console.anthropic.com](https://console.anthropic.com) |
| OpenAI (GPT) | Paid | [platform.openai.com](https://platform.openai.com) |
| Grok (xAI) | Paid | [console.x.ai](https://console.x.ai) |
| Local LLM (Ollama) | Free | Install [Ollama](https://ollama.com), run `ollama pull qwen2.5:3b` |

For **Ollama**, also run this once in a terminal to allow the extension to connect:
```
setx OLLAMA_ORIGINS "*"
```
Then restart Ollama.

Click **Save Settings** when done.

---

## Using the Extension

### On a Listing Page (e.g. myntra.com/shirts)
1. Browse to any Myntra category page.
2. Click the extension icon to open the side panel.
3. Click **Analyze This Page**.
4. Watch the status bar — it shows live progress and a running timer.
5. When done, score badges appear on every product card and the side panel shows a ranked list.

### On a Product Page (e.g. a specific shirt)
Open any individual product page — the extension **auto-analyzes** it immediately without needing a button click.

---

## Understanding the Results

### Score Badge (on card)
- 🟢 **Green (7–10)** — Great or good fit
- 🟡 **Yellow (4–6)** — Okay fit, some compromise
- 🔴 **Red (0–3)** — Poor fit or size unavailable

Hover over the badge to see:
- **We recommend: Size X** — the best available size for you
- **Fit quality · Score/10** — overall fit rating
- **Per-dimension bars** — how well chest, length, shoulder each fit
- **Fit summary** — plain English explanation of the fit

### Side Panel Cards
Each card shows:
- Rank and brand/name/price
- **Recommended: X** pill — the size to buy
- Score ring (colored by fit quality)
- Expandable **Score Breakdown** with per-dimension bars and reasons
- **View on Myntra →** link

### Score of 0
Means one of:
- The best size for you is **out of stock**
- This product **doesn't come in your size**
- **Shoes:** the closest available size is 2.5+ sizes away

---

## Multiple Profiles

You can save different profiles — e.g. one for casual wear (regular fit) and one for gym wear (slim fit):
1. In Settings, type a profile name and click **+ New**
2. Fill in measurements for that profile
3. Switch between profiles by clicking their pill buttons
4. The active profile is used for all analyses

---

## Controls

| Button | What it does |
|---|---|
| **Analyze This Page** | Scrape + score all visible products |
| **↕ Sort** | Re-order the Myntra cards by score |
| **Open Top 5 →** | Open your top-scored products in new tabs |
| **Score ≥ slider** | Dim products below a threshold score |
| **🔍 Debug** | Show the raw data sent to the AI (for troubleshooting) |
| **Re-analyze** | Re-run analysis on a product page |

---

## Supported Categories

| Category | Auto-detected from URL |
|---|---|
| Shirts, T-shirts, Polos, Sweatshirts, Hoodies, Jackets | Default (any top) |
| Trousers, Jeans, Chinos, Cargo, Joggers | URLs containing trouser/pant/jean/denim/chino etc. |
| Shoes, Sneakers, Boots, Sandals | URLs containing shoe/sneaker/boot/sandal/footwear etc. |

---

## Tips

- **More products = slower analysis.** Scroll down to load more Myntra cards before clicking Analyze if you want a bigger batch.
- **Gemini free tier resets daily.** If you hit the quota, wait until the next day or switch to Ollama.
- **Ollama is slower but free.** On slow machines, analysis may take 2–3 minutes for 30 products.
- **Size chart missing?** Some products have no chart data — the AI uses Indian standard size ranges as a fallback (less accurate).
- **Product page analysis** is the most accurate because it analyzes exactly one item with full size chart data.
