# Changelog

All notable changes to FitAgent will be documented here.
Format: `[version] - YYYY-MM-DD` → Added / Changed / Fixed / Removed

---

## [1.0.0] - 2026-05-11

### Added
- Initial release of FitAgent (formerly Myntra Size Finder)
- AI-powered fit scoring (0–10 badge) on every Myntra listing card
- Side panel with ranked results, score breakdown, and fit summary
- Support for 5 AI providers: Claude (Anthropic), Gemini, OpenAI, Grok, Ollama
- Measurement profiles — save multiple profiles (e.g. Casual, Gym, Formal)
- Category detection: Shirts, Trousers, Shoes scored with separate logic
- Dimension priority toggles (Low / Medium / High) per measurement
- Score filter slider to dim products below a threshold
- Sort button to reorder Myntra cards by fit score
- "Open Top 5" button to open best-fit products in new tabs
- Debug modal showing raw data sent to the LLM
- Shoe scoring in pure JS (no LLM needed) using UK size matching
- Streaming HTML fetch with AbortController for 3–5× faster size chart extraction
- Batch error recovery — partial results shown if some LLM calls fail
- Local LLM support (Ollama) with compact prompts for small context windows

### Changed
- Extension renamed from "Myntra Size Finder" to "FitAgent"

---

## How to use this file

When you make a change, add an entry at the top under a new version block:

```
## [1.1.0] - YYYY-MM-DD

### Added
- ...

### Changed
- ...

### Fixed
- ...

### Removed
- ...
```

Bump the version in `manifest.json` to match.
