'use strict';

// ── Provider defaults ─────────────────────────────────────────────────────────
const PROVIDER_META = {
  claude: { label: 'Claude (Anthropic)', defaultModel: 'claude-sonnet-4-6', needsKey: true,  needsUrl: false, note: 'Get your key at console.anthropic.com' },
  openai: { label: 'OpenAI',             defaultModel: 'gpt-4o',            needsKey: true,  needsUrl: false, note: 'Get your key at platform.openai.com' },
  gemini: { label: 'Google Gemini',      defaultModel: 'gemini-2.5-flash',  needsKey: true,  needsUrl: false, note: 'Get your key at aistudio.google.com' },
  grok:   { label: 'Grok (xAI)',         defaultModel: 'grok-2',            needsKey: true,  needsUrl: false, note: 'Get your key at console.x.ai' },
  local:  { label: 'Local LLM (Ollama)', defaultModel: 'llama3',            needsKey: false, needsUrl: true,  note: 'Make sure Ollama is running locally' },
};

// ── State ─────────────────────────────────────────────────────────────────────
let allScored       = [];
let filterThreshold = 0;
let profiles        = [];   // [{ id, name, measurements }]
let activeProfileId = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const viewResults   = document.getElementById('viewResults');
const viewSettings  = document.getElementById('viewSettings');
const btnSettings   = document.getElementById('btnSettings');
const btnBack       = document.getElementById('btnBack');
const btnAnalyze    = document.getElementById('btnAnalyze');
const btnSort       = document.getElementById('btnSort');
const btnDebug      = document.getElementById('btnDebug');
const btnOpenTop    = document.getElementById('btnOpenTop');
const topRow        = document.getElementById('topRow');
const debugOverlay  = document.getElementById('debugOverlay');
const debugPre      = document.getElementById('debugPre');
const btnCloseDebug = document.getElementById('btnCloseDebug');
const statusEl      = document.getElementById('status');
const emptyState    = document.getElementById('emptyState');
const resultsList   = document.getElementById('resultsList');
const filterBar     = document.getElementById('filterBar');
const scoreSlider   = document.getElementById('scoreSlider');
const filterValue   = document.getElementById('filterValue');
const profilePills  = document.getElementById('profilePills');
const fProfileName  = document.getElementById('fProfileName');
const btnAddProfile = document.getElementById('btnAddProfile');
const btnDelProfile = document.getElementById('btnDeleteProfile');

// Settings fields
const fProvider  = document.getElementById('fProvider');
const fApiKey    = document.getElementById('fApiKey');
const fModel     = document.getElementById('fModel');
const fBaseUrl   = document.getElementById('fBaseUrl');
const rowApiKey  = document.getElementById('rowApiKey');
const rowBaseUrl = document.getElementById('rowBaseUrl');
const provNote   = document.getElementById('providerNote');
const saveMsg    = document.getElementById('saveMsg');

// ── View toggle ───────────────────────────────────────────────────────────────
btnSettings.addEventListener('click', () => {
  viewResults.classList.add('hidden');
  viewSettings.classList.remove('hidden');
  loadSettings();
});

btnBack.addEventListener('click', () => {
  viewSettings.classList.add('hidden');
  viewResults.classList.remove('hidden');
});

// ── Analyze ───────────────────────────────────────────────────────────────────
// ── Analysis timer ────────────────────────────────────────────────────────────
let _timerInterval  = null;
let _timerStart     = 0;
let _lastStatusMsg  = '';
let _lastStatusType = 'info';

function startTimer() {
  stopTimer();
  _timerStart = Date.now();
  _timerInterval = setInterval(() => {
    const secs = Math.floor((Date.now() - _timerStart) / 1000);
    const label = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
    statusEl.textContent = `${_lastStatusMsg}  [${label}]`;
  }, 1000);
}

function stopTimer() {
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
}

function elapsedLabel() {
  const secs = Math.floor((Date.now() - _timerStart) / 1000);
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

btnAnalyze.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('myntra.com')) {
    setStatus('⚠ Open a Myntra page first (e.g. myntra.com/shirts)', 'warn');
    return;
  }

  btnAnalyze.disabled = true;
  btnSort.classList.add('hidden');
  btnDebug.classList.add('hidden');
  topRow.classList.add('hidden');
  btnOpenTop.classList.add('hidden');
  setStatus('Starting…', 'info');
  startTimer();
  emptyState.classList.add('hidden');
  resultsList.classList.add('hidden');

  chrome.runtime.sendMessage({ type: 'ANALYZE', tabId: tab.id, url: tab.url }, response => {
    stopTimer();
    btnAnalyze.disabled = false;

    if (chrome.runtime.lastError || !response) {
      setStatus('❌ ' + (chrome.runtime.lastError?.message || 'No response from background'), 'error');
      return;
    }
    if (response.error) {
      setStatus('❌ ' + response.error, 'error');
      return;
    }

    allScored = response.data;
    renderResults(allScored);
    btnSort.classList.remove('hidden');
    btnDebug.classList.remove('hidden');
    filterBar.classList.remove('hidden');

    // Show "Open Top 5" only if there are scored results
    const topScored = allScored.filter(p => p.score > 0);
    if (topScored.length > 0) {
      topRow.classList.remove('hidden');
      btnOpenTop.classList.remove('hidden');
      btnOpenTop.textContent = `Open Top ${Math.min(5, topScored.length)} →`;
    }
  });
});

// ── Open Top 5 in new tabs ────────────────────────────────────────────────────
btnOpenTop.addEventListener('click', async () => {
  const top = allScored.filter(p => p.score > 0).slice(0, 5);
  for (const p of top) {
    if (p.url) await chrome.tabs.create({ url: p.url, active: false });
  }
  btnOpenTop.textContent = '✓ Opened!';
  setTimeout(() => {
    const topScored = allScored.filter(p => p.score > 0);
    btnOpenTop.textContent = `Open Top ${Math.min(5, topScored.length)} →`;
  }, 2000);
});

// ── Progress messages from background ────────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.type === 'PROGRESS') setStatus(msg.message, 'info');
});

// ── Debug — show last prompt ──────────────────────────────────────────────────
btnDebug.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'GET_LAST_PROMPT' }, res => {
    debugPre.textContent = res?.prompt || 'No prompt yet — run Analyze first.';
    debugOverlay.classList.remove('hidden');
  });
});
btnCloseDebug.addEventListener('click', () => debugOverlay.classList.add('hidden'));
debugOverlay.addEventListener('click', e => { if (e.target === debugOverlay) debugOverlay.classList.add('hidden'); });

// ── Sort on Myntra ────────────────────────────────────────────────────────────
btnSort.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: 'SORT_BY_SCORE', data: allScored });
  btnSort.textContent = '✓ Sorted';
  setTimeout(() => { btnSort.textContent = '↕ Sort'; }, 2000);
});

// ── Score filter slider ───────────────────────────────────────────────────────
scoreSlider.addEventListener('input', async () => {
  filterThreshold = parseFloat(scoreSlider.value);
  filterValue.textContent = filterThreshold.toFixed(1);
  applyFilter();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'FILTER_BADGES', threshold: filterThreshold });
});

function applyFilter() {
  const cards = resultsList.querySelectorAll('.sp-card');
  cards.forEach(card => {
    const score = parseFloat(card.dataset.score ?? 0);
    card.classList.toggle('sp-card--hidden', score < filterThreshold);
  });
  const visible = [...cards].filter(c => !c.classList.contains('sp-card--hidden')).length;
  setStatus(
    filterThreshold > 0
      ? `Showing ${visible} of ${allScored.length} products (score ≥ ${filterThreshold.toFixed(1)})`
      : `✓ ${allScored.length} products scored — best fit at top.`,
    'ok'
  );
}

// ── Render results ────────────────────────────────────────────────────────────
function renderResults(products) {
  resultsList.innerHTML = '';

  products.forEach((p, rank) => {
    const score = parseFloat(p.score ?? 0);
    const cls   = score >= 7 ? 'green' : score >= 4 ? 'yellow' : 'red';
    const bd    = p.breakdown ?? {};
    const br    = p.breakdown_reasons ?? {};

    const isOos         = score === 0 && p.suggested_size !== 'Not your size' && p.suggested_size !== 'N/A';
    const reasonCls     = score === 0 ? (isOos ? 'sp-reason--oos' : 'sp-reason--unavailable') : '';
    const sizeDisplay   = !p.suggested_size || p.suggested_size === '?' ? '?' :
                          p.suggested_size === 'N/A' || p.suggested_size === 'Not your size' ? 'No size for you' :
                          isOos ? `Size ${p.suggested_size} (OOS)` :
                          `Recommended: ${p.suggested_size}`;

    // Only render dimensions where the LLM returned a valid 0-10 score
    // (values >10 mean the LLM confused cm measurements with fit scores)
    const validBd    = Object.entries(bd).filter(([, val]) => val > 0 && val <= 10);
    const factorRows = validBd.length
      ? validBd.map(([factor, val]) => {
          const pct   = Math.min(100, Math.max(0, Number(val) * 10));
          const fCls  = val >= 7 ? 'green' : val >= 4 ? 'yellow' : 'red';
          const COLOR = { green: '#22c55e', yellow: '#f59e0b', red: '#ef4444' };
          return `
          <div class="sp-factor">
            <div class="sp-factor-top">
              <span class="sp-factor-name">${cap(factor)}</span>
              <span class="sp-factor-score ${fCls}">${Number(val).toFixed(1)}</span>
            </div>
            <svg width="100%" height="6" style="border-radius:99px;overflow:hidden;display:block">
              <rect width="100%" height="6" fill="#f3f4f6"/>
              <rect width="${pct}%" height="6" fill="${COLOR[fCls]}"/>
            </svg>
            <div class="sp-factor-reason">${esc(br[factor] ?? '')}</div>
          </div>`;
        }).join('')
      : '<div class="sp-factor-reason" style="padding:4px 0">No breakdown data from AI.</div>';

    const card = document.createElement('div');
    card.className = 'sp-card';
    card.dataset.score = score;

    card.innerHTML = `
      <div class="sp-card-top">
        <div class="sp-rank">#${rank + 1}</div>
        <div class="sp-card-info">
          <div class="sp-brand">${esc(p.brand)}</div>
          <div class="sp-name">${esc(p.name)}</div>
          <div class="sp-meta">
            <span class="sp-price">${esc(p.price)}</span>
            <span class="sp-size-pill ${isOos ? 'sp-size-pill--oos' : ''}">${esc(sizeDisplay)}</span>
          </div>
        </div>
        <div class="sp-score-ring ${cls}">
          <svg viewBox="0 0 36 36" class="sp-ring-svg">
            <path class="sp-ring-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
            <path class="sp-ring-fill" stroke-dasharray="${score * 10}, 100" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"/>
          </svg>
          <span class="sp-ring-label">${score.toFixed(1)}</span>
        </div>
      </div>
      <div class="sp-reason ${reasonCls}">${esc(buildReason(p))}</div>
      <button class="sp-expand-btn" data-idx="${rank}">Score breakdown ▾</button>
      <div class="sp-breakdown hidden" id="bd-${rank}">${factorRows}</div>
      <a class="sp-link" href="${esc(p.url)}" target="_blank" rel="noopener">View on Myntra →</a>
    `;

    resultsList.appendChild(card);
  });

  resultsList.querySelectorAll('.sp-expand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const bd   = document.getElementById(`bd-${btn.dataset.idx}`);
      const open = !bd.classList.contains('hidden');
      bd.classList.toggle('hidden', open);
      btn.textContent = open ? 'Score breakdown ▾' : 'Score breakdown ▴';
    });
  });

  applyFilter();
  setStatus(`✓ ${products.length} products scored in ${elapsedLabel()} — best fit at top.`, 'ok');
  resultsList.classList.remove('hidden');
  emptyState.classList.add('hidden');
}

// ══════════════════════════════════════════════════════════════
//  PROFILES
// ══════════════════════════════════════════════════════════════

function newProfile(name = 'New Profile') {
  return {
    id: Date.now().toString(),
    name,
    measurements: {
      chest_cm: '', length_cm: '', shoulder_cm: '',
      waist_cm: '', gender: 'male', fit_preference: 'regular',
    },
    priorities: { chest: 'medium', shoulder: 'medium', length: 'medium' },
  };
}

// ── Priority toggles ──────────────────────────────────────────────────────────
const PRIORITY_IDS = { chest: 'priChest', shoulder: 'priShoulder', length: 'priLength', waist: 'priWaist', hip: 'priHip', inseam: 'priInseam' };

// ── Measurement category tabs ─────────────────────────────────────────────────
let activeMeasureTab = 'shirts';

function switchMeasureTab(tab) {
  activeMeasureTab = tab;
  document.querySelectorAll('.sp-mtab').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.tab === tab));
  document.querySelectorAll('.sp-mtab-panel').forEach(panel =>
    panel.classList.toggle('hidden', panel.id !== `tab${cap(tab)}`));
  // Sync priority groups
  ['Shirts', 'Trousers', 'Shoes'].forEach(t =>
    document.getElementById(`priGroup${t}`)?.classList.toggle('hidden', t.toLowerCase() !== tab));
}

document.querySelectorAll('.sp-mtab').forEach(btn =>
  btn.addEventListener('click', () => switchMeasureTab(btn.dataset.tab)));

function setPriority(dim, val) {
  const group = document.getElementById(PRIORITY_IDS[dim]);
  if (!group) return;
  group.querySelectorAll('button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === val);
  });
}

function getPriority(dim) {
  const group = document.getElementById(PRIORITY_IDS[dim]);
  if (!group) return 'medium';
  return group.querySelector('button.active')?.dataset.val ?? 'medium';
}

// Wire up click handlers for all priority toggles
Object.entries(PRIORITY_IDS).forEach(([dim, id]) => {
  document.getElementById(id)?.addEventListener('click', e => {
    const btn = e.target.closest('button[data-val]');
    if (!btn) return;
    setPriority(dim, btn.dataset.val);
  });
});

async function loadSettings() {
  const stored = await chrome.storage.local.get(['profiles', 'activeProfileId', 'llmConfig']);

  // Bootstrap: create a default profile if none exist
  profiles = stored.profiles?.length ? stored.profiles : [newProfile('Default')];
  activeProfileId = stored.activeProfileId ?? profiles[0].id;
  if (!profiles.find(p => p.id === activeProfileId)) activeProfileId = profiles[0].id;

  const l = stored.llmConfig ?? { provider: 'claude' };
  fProvider.value = l.provider ?? 'claude';
  fApiKey.value   = l.apiKey   ?? '';
  fModel.value    = l.model    ?? '';
  fBaseUrl.value  = l.baseUrl  ?? '';

  renderProfilePills();
  loadActiveProfileIntoForm();
  updateProviderUI();
}

function renderProfilePills() {
  profilePills.innerHTML = '';
  profiles.forEach(profile => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'sp-profile-pill' + (profile.id === activeProfileId ? ' active' : '');
    pill.textContent = profile.name;
    pill.addEventListener('click', () => {
      // Save current form into current profile before switching
      saveFormIntoActiveProfile();
      activeProfileId = profile.id;
      renderProfilePills();
      loadActiveProfileIntoForm();
    });
    profilePills.appendChild(pill);
  });
}

function loadActiveProfileIntoForm() {
  const profile = profiles.find(p => p.id === activeProfileId);
  if (!profile) return;
  const m = profile.measurements ?? {};
  document.getElementById('fChest').value    = m.chest_cm       ?? '';
  document.getElementById('fLength').value   = m.length_cm      ?? '';
  document.getElementById('fShoulder').value = m.shoulder_cm    ?? '';
  document.getElementById('fWaist').value    = m.waist_cm       ?? '';
  document.getElementById('fGender').value   = m.gender         ?? 'male';
  document.getElementById('fFit').value         = m.fit_preference  ?? 'regular';
  document.getElementById('fTrouserFit').value  = m.trouser_fit     ?? 'regular';
  fProfileName.value = profile.name;
  const pri = profile.priorities ?? {};
  setPriority('chest',    pri.chest    ?? 'medium');
  setPriority('shoulder', pri.shoulder ?? 'medium');
  setPriority('length',   pri.length   ?? 'medium');
  setPriority('waist',    pri.waist    ?? 'medium');
  setPriority('hip',      pri.hip      ?? 'medium');
  setPriority('inseam',   pri.inseam   ?? 'medium');
  document.getElementById('fHip').value    = m.hip_cm       ?? '';
  document.getElementById('fInseam').value = m.inseam_cm    ?? '';
  document.getElementById('fUkShoe').value = m.uk_shoe_size ?? '';
}

function saveFormIntoActiveProfile() {
  const profile = profiles.find(p => p.id === activeProfileId);
  if (!profile) return;
  profile.name = fProfileName.value.trim() || profile.name;
  profile.measurements = {
    chest_cm:       Number(document.getElementById('fChest').value)    || undefined,
    length_cm:      Number(document.getElementById('fLength').value)   || undefined,
    shoulder_cm:    Number(document.getElementById('fShoulder').value) || undefined,
    waist_cm:       Number(document.getElementById('fWaist').value)    || undefined,
    gender:         document.getElementById('fGender').value,
    fit_preference: document.getElementById('fFit').value,
    trouser_fit:    document.getElementById('fTrouserFit').value,
  };
  Object.keys(profile.measurements).forEach(k => profile.measurements[k] === undefined && delete profile.measurements[k]);
  profile.measurements.hip_cm       = Number(document.getElementById('fHip').value)    || undefined;
  profile.measurements.inseam_cm    = Number(document.getElementById('fInseam').value) || undefined;
  profile.measurements.uk_shoe_size = Number(document.getElementById('fUkShoe').value) || undefined;
  Object.keys(profile.measurements).forEach(k => profile.measurements[k] === undefined && delete profile.measurements[k]);
  profile.priorities = {
    chest:    getPriority('chest'),
    shoulder: getPriority('shoulder'),
    length:   getPriority('length'),
    waist:    getPriority('waist'),
    hip:      getPriority('hip'),
    inseam:   getPriority('inseam'),
  };
}

// Add new profile
btnAddProfile.addEventListener('click', () => {
  saveFormIntoActiveProfile();
  const p = newProfile('New Profile');
  profiles.push(p);
  activeProfileId = p.id;
  renderProfilePills();
  loadActiveProfileIntoForm();
  fProfileName.select();
});

// Delete active profile
btnDelProfile.addEventListener('click', async () => {
  if (profiles.length === 1) {
    alert('You must have at least one profile.');
    return;
  }
  profiles = profiles.filter(p => p.id !== activeProfileId);
  activeProfileId = profiles[0].id;
  await chrome.storage.local.set({ profiles, activeProfileId });
  renderProfilePills();
  loadActiveProfileIntoForm();
});

// Save settings
document.getElementById('settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  saveFormIntoActiveProfile();
  renderProfilePills(); // refresh pill names

  const llmConfig = {
    provider: fProvider.value,
    apiKey:   fApiKey.value.trim(),
    model:    fModel.value.trim()   || undefined,
    baseUrl:  fBaseUrl.value.trim() || undefined,
  };

  // Also update measurements in background storage so ANALYZE picks up active profile
  const activeProfile = profiles.find(p => p.id === activeProfileId);
  await chrome.storage.local.set({
    profiles,
    activeProfileId,
    llmConfig,
    measurements: activeProfile?.measurements ?? {},
    priorities:   activeProfile?.priorities   ?? { chest: 'medium', shoulder: 'medium', length: 'medium' },
  });

  saveMsg.classList.remove('hidden');
  setTimeout(() => saveMsg.classList.add('hidden'), 2000);
});

// ── Provider UI ───────────────────────────────────────────────────────────────
fProvider.addEventListener('change', updateProviderUI);

function updateProviderUI() {
  const meta = PROVIDER_META[fProvider.value] ?? PROVIDER_META.claude;
  rowApiKey.classList.toggle('hidden',  !meta.needsKey);
  rowBaseUrl.classList.toggle('hidden', !meta.needsUrl);
  provNote.textContent = meta.note;
  if (!fModel.value) fModel.placeholder = `Default: ${meta.defaultModel}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(msg, type = 'info') {
  _lastStatusMsg  = msg;
  _lastStatusType = type;
  statusEl.textContent = msg;
  statusEl.className   = 'sp-status sp-status--' + type;
}

function cap(str) { return str.charAt(0).toUpperCase() + str.slice(1); }

// Return the best available fit summary, falling back to joined br values
// when the LLM returned a generic placeholder like "reason" or left it empty.
function buildReason(p) {
  const raw = p.fit_summary ?? p.overall_reason ?? '';
  const isGeneric = !raw || raw.length < 6 || /^(reason|summary|n\/a|none)$/i.test(raw.trim());
  if (!isGeneric) return raw;
  const br    = p.breakdown_reasons ?? {};
  const parts = Object.entries(br).map(([k, v]) => `${cap(k)}: ${v}`);
  return parts.join(' · ') || '';
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  await loadSettings().catch(() => {});
  updateProviderUI();

  // Auto-analyze when the panel opens on a Myntra product page
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.includes('myntra.com') && /\/\d{5,}/.test(tab.url)) {
    btnAnalyze.textContent = 'Re-analyze';
    setStatus('Product page detected — analyzing…', 'info');
    emptyState.classList.add('hidden');
    startTimer();
    btnAnalyze.disabled = true;
    chrome.runtime.sendMessage({ type: 'ANALYZE', tabId: tab.id, url: tab.url }, response => {
      stopTimer();
      btnAnalyze.disabled = false;
      if (!response || response.error) {
        setStatus('❌ ' + (response?.error || 'Analysis failed'), 'error');
        return;
      }
      allScored = response.data;
      renderResults(allScored);
      setStatus(`✓ Analyzed in ${elapsedLabel()} — best size shown above.`, 'ok');
    });
  }
})();
