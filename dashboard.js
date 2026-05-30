// Antigravity Master Control Dashboard Logic

let activeTrades = {};
let tabStates = {};
let journalStats = { wins: 0, losses: 0, timeouts: 0 };
let sandboxJournalStats = { wins: 0, losses: 0, timeouts: 0 };
let consecutiveLosses = 0;
let settings = {};

// Cache for live prices to compute PnL
let priceCache = {};

function timeframeToMs(tf) {
  if (!tf) return 5 * 60 * 1000;
  const num = parseInt(tf);
  const unit = tf.replace(num, "");
  if (unit === "m") return num * 60 * 1000;
  if (unit === "h") return num * 60 * 60 * 1000;
  if (unit === "d") return num * 24 * 60 * 60 * 1000;
  return 5 * 60 * 1000; // default 5m
}

document.addEventListener('DOMContentLoaded', () => {
  const versionLabel = document.getElementById('dashboard-version-label');
  if (versionLabel) {
    versionLabel.textContent = 'v' + chrome.runtime.getManifest().version;
  }

  // Elements
  const riskAmountInput = document.getElementById('risk-amount');
  const riskVal = document.getElementById('risk-val');
  const leverageInput = document.getElementById('leverage');
  const levVal = document.getElementById('lev-val');
  const entryThresholdInput = document.getElementById('entry-threshold');
  const thresholdVal = document.getElementById('threshold-val');
  const enableAutoPilotCheck = document.getElementById('enable-autopilot');
  const enableCircuitBreakerCheck = document.getElementById('enable-circuitbreaker');
  const enableSMCCheck = document.getElementById('enable-smc');
  const enableTechnicalCheck = document.getElementById('enable-technical');
  const enableAudioCheck = document.getElementById('enable-audio');
  const enableSandboxCheck = document.getElementById('enable-sandbox');

  // New sizing/target elements
  const sizeModeSelect = document.getElementById('size-mode');
  const tradeCapitalInput = document.getElementById('trade-capital');
  const capitalVal = document.getElementById('capital-val');
  const targetModeSelect = document.getElementById('target-mode');
  const customTpInput = document.getElementById('custom-tp');
  const customSlInput = document.getElementById('custom-sl');
  const timeframeSelect = document.getElementById('timeframe');
  const customTpSlModeSelect = document.getElementById('custom-tpsl-mode');
  
  const groupRiskAmount = document.getElementById('group-risk-amount');
  const groupTradeCapital = document.getElementById('group-trade-capital');
  const customTargetsGroup = document.getElementById('custom-targets-group');

  const btnApply = document.getElementById('btn-apply-configs');
  const btnReset = document.getElementById('btn-reset-journal');
  const btnPurgeSandbox = document.getElementById('btn-purge-sandbox');
  const btnCloseAll = document.getElementById('btn-close-all');

  const marginModeSelect = document.getElementById('margin-mode');
  const walletBalanceInput = document.getElementById('wallet-balance');
  const walletBalanceVal = document.getElementById('wallet-balance-val');
  const enableTimeoutCheck = document.getElementById('enable-timeout');
  const timeoutCandlesInput = document.getElementById('timeout-candles');
  const groupWalletBalance = document.getElementById('group-wallet-balance');
  const groupTimeoutCandles = document.getElementById('group-timeout-candles');

  let loadedWalletBalance = 1000;
  let loadedSandboxWalletBalance = 1000;

  const winsEl = document.getElementById('stats-wins');
  const lossesEl = document.getElementById('stats-losses');
  const timeoutsEl = document.getElementById('stats-timeouts');
  const consecEl = document.getElementById('stats-consec-losses');
  const winrateEl = document.getElementById('stats-winrate');
  const realProfitEl = document.getElementById('stats-profit');
  const realDurationEl = document.getElementById('stats-duration');
  const realFactorEl = document.getElementById('stats-factor');
  const realTotalEl = document.getElementById('stats-total');

  // Sandbox Stats elements
  const sandboxWinsEl = document.getElementById('sandbox-wins');
  const sandboxLossesEl = document.getElementById('sandbox-losses');
  const sandboxConsecEl = document.getElementById('sandbox-consec-losses');
  const sandboxWinrateEl = document.getElementById('sandbox-winrate');
  const sandboxProfitEl = document.getElementById('sandbox-profit');
  const sandboxDurationEl = document.getElementById('sandbox-duration');
  const sandboxFactorEl = document.getElementById('sandbox-factor');
  const sandboxTotalEl = document.getElementById('sandbox-total');

  // Ledger Elements
  const ledgerTbody = document.getElementById('ledger-tbody');
  const ledgerFilterAll = document.getElementById('ledger-filter-all');
  const ledgerFilterReal = document.getElementById('ledger-filter-real');
  const ledgerFilterSandbox = document.getElementById('ledger-filter-sandbox');

  const circuitBanner = document.getElementById('circuit-breaker-banner');
  const circuitDesc = document.getElementById('circuit-breaker-desc');

  // Input listeners
  riskAmountInput.addEventListener('input', () => { riskVal.textContent = `$${riskAmountInput.value}`; });
  leverageInput.addEventListener('input', () => { levVal.textContent = `${leverageInput.value}x`; });
  entryThresholdInput.addEventListener('input', () => { thresholdVal.textContent = `${entryThresholdInput.value}%`; });

  if (walletBalanceInput) {
    walletBalanceInput.addEventListener('input', () => {
      if (walletBalanceVal) walletBalanceVal.textContent = `$${walletBalanceInput.value}`;
    });
  }

  function updateMarginModeVisibility() {
    if (marginModeSelect && marginModeSelect.value === 'CROSS') {
      if (groupWalletBalance) groupWalletBalance.style.display = 'block';
    } else {
      if (groupWalletBalance) groupWalletBalance.style.display = 'none';
    }
  }
  if (marginModeSelect) marginModeSelect.addEventListener('change', updateMarginModeVisibility);

  function updateTimeoutVisibility() {
    if (enableTimeoutCheck && enableTimeoutCheck.checked) {
      if (groupTimeoutCandles) groupTimeoutCandles.style.display = 'block';
    } else {
      if (groupTimeoutCandles) groupTimeoutCandles.style.display = 'none';
    }
  }
  if (enableTimeoutCheck) enableTimeoutCheck.addEventListener('change', updateTimeoutVisibility);

  if (enableSandboxCheck) {
    enableSandboxCheck.addEventListener('change', () => {
      if (walletBalanceInput) {
        walletBalanceInput.value = enableSandboxCheck.checked ? loadedSandboxWalletBalance : loadedWalletBalance;
        if (walletBalanceVal) walletBalanceVal.textContent = `$${walletBalanceInput.value}`;
      }
    });
  }

  sizeModeSelect.addEventListener('change', () => {
    if (sizeModeSelect.value === 'RISK') {
      groupRiskAmount.style.display = 'block';
      groupTradeCapital.style.display = 'none';
    } else {
      groupRiskAmount.style.display = 'none';
      groupTradeCapital.style.display = 'block';
    }
  });

  tradeCapitalInput.addEventListener('input', () => {
    capitalVal.textContent = `$${tradeCapitalInput.value}`;
  });

  targetModeSelect.addEventListener('change', () => {
    if (targetModeSelect.value === 'CUSTOM') {
      customTargetsGroup.style.display = 'block';
    } else {
      customTargetsGroup.style.display = 'none';
    }
  });

  let dbSignals = [];
  let ledgerFilter = 'ALL';
  let activeTickerFilter = 'ALL';
  let ledgerSortColumn = 'date';
  let ledgerSortDirection = 'desc';
  let ledgerSearchQuery = '';
  let ledgerOutcomeFilter = 'ALL';
  let ledgerPageSize = 25;
  let ledgerCurrentPage = 1;

  ledgerFilterAll.addEventListener('click', () => {
    ledgerFilter = 'ALL';
    updateFilterButtons();
    renderLedgerTable();
  });

  ledgerFilterReal.addEventListener('click', () => {
    ledgerFilter = 'REAL';
    updateFilterButtons();
    renderLedgerTable();
  });

  ledgerFilterSandbox.addEventListener('click', () => {
    ledgerFilter = 'SANDBOX';
    updateFilterButtons();
    renderLedgerTable();
  });

  function updateFilterButtons() {
    const btns = [
      { el: ledgerFilterAll, filter: 'ALL', color: 'var(--blue)' },
      { el: ledgerFilterReal, filter: 'REAL', color: 'var(--green)' },
      { el: ledgerFilterSandbox, filter: 'SANDBOX', color: '#1e90ff' }
    ];
    btns.forEach(b => {
      if (ledgerFilter === b.filter) {
        b.el.style.background = b.color;
        b.el.style.borderColor = b.color;
        b.el.style.color = '#fff';
      } else {
        b.el.style.background = 'transparent';
        b.el.style.borderColor = 'var(--border)';
        b.el.style.color = 'var(--text-muted)';
      }
    });
  }

  // --- Global Ticker Filter ---
  const globalTickerFilter = document.getElementById('global-ticker-filter');
  if (globalTickerFilter) {
    globalTickerFilter.addEventListener('change', (e) => {
      activeTickerFilter = e.target.value;
      compileStatsFromSignals(dbSignals);
      ledgerCurrentPage = 1;
      renderLedgerTable();
    });
  }

  function populateTickerFilter(signals) {
    const filterSelect = document.getElementById('global-ticker-filter');
    if (!filterSelect) return;
    const currentVal = filterSelect.value || 'ALL';
    const normCurrentVal = currentVal.toUpperCase().replace(/[^A-Z0-9]/g, '');
    
    const symbols = new Set();
    signals.forEach(s => {
      if (s.symbol) {
        const norm = s.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (norm) symbols.add(norm);
      }
    });
    
    Object.keys(activeTrades).forEach(sym => {
      const norm = sym.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (norm) symbols.add(norm);
    });
    
    filterSelect.innerHTML = '<option value="ALL">All Tickers</option>';
    Array.from(symbols).sort().forEach(sym => {
      const opt = document.createElement('option');
      opt.value = sym;
      opt.textContent = sym;
      filterSelect.appendChild(opt);
    });
    
    if (symbols.has(normCurrentVal)) {
      filterSelect.value = normCurrentVal;
      activeTickerFilter = normCurrentVal;
    } else {
      filterSelect.value = 'ALL';
      activeTickerFilter = 'ALL';
    }
  }

  // --- Collapsible Dashboard Sections ---
  document.querySelectorAll('.widget-collapse-btn').forEach(btn => {
    const targetId = btn.getAttribute('data-target');
    const isCollapsed = localStorage.getItem('collapse_' + targetId) === 'true';
    const target = document.getElementById(targetId);
    if (target) {
      if (isCollapsed) {
        target.classList.add('collapsed');
        btn.textContent = '▲';
      } else {
        target.classList.remove('collapsed');
        btn.textContent = '▼';
      }
    }
    btn.addEventListener('click', () => {
      const currentlyCollapsed = target.classList.toggle('collapsed');
      btn.textContent = currentlyCollapsed ? '▲' : '▼';
      localStorage.setItem('collapse_' + targetId, currentlyCollapsed ? 'true' : 'false');
    });
  });

  // --- Historical Ledger Advanced Sorting, Filtering, and Pagination ---
  const sortHeaders = [
    { id: 'sort-symbol', col: 'symbol' },
    { id: 'sort-prob', col: 'prob' },
    { id: 'sort-cap', col: 'cap' },
    { id: 'sort-duration', col: 'duration' },
    { id: 'sort-pnl', col: 'pnl' },
    { id: 'sort-date', col: 'date' }
  ];

  sortHeaders.forEach(sh => {
    const el = document.getElementById(sh.id);
    if (el) {
      el.addEventListener('click', () => {
        if (ledgerSortColumn === sh.col) {
          ledgerSortDirection = ledgerSortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          ledgerSortColumn = sh.col;
          ledgerSortDirection = 'desc';
        }
        updateSortIcons();
        renderLedgerTable();
      });
    }
  });

  function updateSortIcons() {
    sortHeaders.forEach(sh => {
      const el = document.getElementById(sh.id);
      if (el) {
        const iconEl = el.querySelector('.sort-icon');
        if (iconEl) {
          if (ledgerSortColumn === sh.col) {
            iconEl.textContent = ledgerSortDirection === 'asc' ? '▲' : '▼';
            iconEl.style.color = 'var(--accent)';
          } else {
            iconEl.textContent = '↕';
            iconEl.style.color = 'var(--text-muted)';
          }
        }
      }
    });
  }

  const btnPrev = document.getElementById('ledger-btn-prev');
  const btnNext = document.getElementById('ledger-btn-next');

  if (btnPrev) {
    btnPrev.addEventListener('click', () => {
      if (ledgerCurrentPage > 1) {
        ledgerCurrentPage--;
        renderLedgerTable();
      }
    });
  }
  if (btnNext) {
    btnNext.addEventListener('click', () => {
      ledgerCurrentPage++;
      renderLedgerTable();
    });
  }

  const ledgerPageSizeSelect = document.getElementById('ledger-page-size');
  if (ledgerPageSizeSelect) {
    ledgerPageSizeSelect.addEventListener('change', (e) => {
      ledgerPageSize = parseInt(e.target.value) || 25;
      ledgerCurrentPage = 1;
      renderLedgerTable();
    });
  }

  const ledgerOutcomeSelect = document.getElementById('ledger-filter-outcome');
  if (ledgerOutcomeSelect) {
    ledgerOutcomeSelect.addEventListener('change', (e) => {
      ledgerOutcomeFilter = e.target.value;
      ledgerCurrentPage = 1;
      renderLedgerTable();
    });
  }

  const ledgerSearchInput = document.getElementById('ledger-search');
  if (ledgerSearchInput) {
    ledgerSearchInput.addEventListener('input', (e) => {
      ledgerSearchQuery = e.target.value.trim().toUpperCase();
      ledgerCurrentPage = 1;
      renderLedgerTable();
    });
  }

  // 1. Initial Load from Storage (Aggregating partitioned keys)
  chrome.storage.local.get(null, (items) => {
    // Set settings values
    riskAmountInput.value = items.riskAmount !== undefined ? items.riskAmount : 20;
    riskVal.textContent = `$${riskAmountInput.value}`;
    leverageInput.value = items.leverage !== undefined ? items.leverage : 3;
    levVal.textContent = `${leverageInput.value}x`;
    entryThresholdInput.value = items.triggerThreshold !== undefined ? items.triggerThreshold : 78;
    thresholdVal.textContent = `${entryThresholdInput.value}%`;

    enableAutoPilotCheck.checked = items.enableAutoPilot !== undefined ? items.enableAutoPilot : false;
    enableCircuitBreakerCheck.checked = items.enableCircuitBreaker !== undefined ? items.enableCircuitBreaker : true;
    enableSMCCheck.checked = items.enableSMC !== undefined ? items.enableSMC : true;
    enableTechnicalCheck.checked = items.enableTechnical !== undefined ? items.enableTechnical : true;
    enableAudioCheck.checked = items.enableAudio !== undefined ? items.enableAudio : true;
    enableSandboxCheck.checked = items.sandboxMode !== undefined ? items.sandboxMode : false;

    // Load new settings
    sizeModeSelect.value = items.sizeMode || 'RISK';
    tradeCapitalInput.value = items.tradeCapital !== undefined ? items.tradeCapital : 100;
    capitalVal.textContent = `$${tradeCapitalInput.value}`;
    targetModeSelect.value = items.targetMode || 'INDICATOR';
    customTpInput.value = items.customTakeProfit !== undefined ? items.customTakeProfit : 1.5;
    customSlInput.value = items.customStopLoss !== undefined ? items.customStopLoss : 1.0;
    if (timeframeSelect) timeframeSelect.value = items.timeframe || '5m';
    if (customTpSlModeSelect) customTpSlModeSelect.value = items.customTpSlMode || 'margin';

    loadedWalletBalance = items.walletBalance !== undefined ? items.walletBalance : 1000;
    loadedSandboxWalletBalance = items.sandboxWalletBalance !== undefined ? items.sandboxWalletBalance : 1000;
    
    if (marginModeSelect) marginModeSelect.value = items.marginMode || 'ISOLATED';
    if (walletBalanceInput) {
      walletBalanceInput.value = items.sandboxMode ? loadedSandboxWalletBalance : loadedWalletBalance;
      if (walletBalanceVal) walletBalanceVal.textContent = `$${walletBalanceInput.value}`;
    }
    if (enableTimeoutCheck) enableTimeoutCheck.checked = items.enableTimeout !== false;
    if (timeoutCandlesInput) timeoutCandlesInput.value = items.timeoutCandles !== undefined ? items.timeoutCandles : 12;

    updateMarginModeVisibility();
    updateTimeoutVisibility();

    // Show/hide based on loaded values
    if (sizeModeSelect.value === 'RISK') {
      groupRiskAmount.style.display = 'block';
      groupTradeCapital.style.display = 'none';
    } else {
      groupRiskAmount.style.display = 'none';
      groupTradeCapital.style.display = 'block';
    }

    if (targetModeSelect.value === 'CUSTOM') {
      customTargetsGroup.style.display = 'block';
    } else {
      customTargetsGroup.style.display = 'none';
    }

    journalStats = items.journalStats || { wins: 0, losses: 0, timeouts: 0 };
    sandboxJournalStats = items.sandboxJournalStats || { wins: 0, losses: 0, timeouts: 0 };
    consecutiveLosses = items.consecutiveLosses || 0;
    
    activeTrades = {};
    tabStates = {};
    
    for (const key in items) {
      if (key.startsWith('activeTrade_')) {
        const sym = key.replace('activeTrade_', '');
        activeTrades[sym] = items[key];
      } else if (key.startsWith('tabState_')) {
        const sym = key.replace('tabState_', '');
        tabStates[sym] = items[key];
      }
    }

    // Load phone config
    const phoneInputInit = document.getElementById('alert-phone');
    const phoneDisplayInit = document.getElementById('phone-display');
    if (items.alertPhone) {
      if (phoneInputInit) phoneInputInit.value = items.alertPhone;
      if (phoneDisplayInit) phoneDisplayInit.textContent = items.alertPhone || 'None';
    }

    renderStats();
    renderActiveTrades();
    renderScanners();
    
    // Fetch initial prices for active trades
    fetchPrices();

    // Load historical signals
    loadDatabaseHistory();
    setInterval(loadDatabaseHistory, 5000);
  });

  // 2. Storage Changed Listener (Sync partitioned keys)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    if (changes.journalStats) {
      journalStats = changes.journalStats.newValue || { wins: 0, losses: 0, timeouts: 0 };
      renderStats();
    }
    if (changes.sandboxJournalStats) {
      sandboxJournalStats = changes.sandboxJournalStats.newValue || { wins: 0, losses: 0, timeouts: 0 };
      renderStats();
    }
    if (changes.consecutiveLosses) {
      consecutiveLosses = changes.consecutiveLosses.newValue || 0;
      renderStats();
    }
    if (changes.marginMode) {
      if (marginModeSelect) {
        marginModeSelect.value = changes.marginMode.newValue;
        updateMarginModeVisibility();
      }
    }
    if (changes.walletBalance) {
      loadedWalletBalance = changes.walletBalance.newValue;
      if (walletBalanceInput && enableSandboxCheck && !enableSandboxCheck.checked) {
        walletBalanceInput.value = loadedWalletBalance;
        if (walletBalanceVal) walletBalanceVal.textContent = `$${loadedWalletBalance}`;
      }
    }
    if (changes.sandboxWalletBalance) {
      loadedSandboxWalletBalance = changes.sandboxWalletBalance.newValue;
      if (walletBalanceInput && enableSandboxCheck && enableSandboxCheck.checked) {
        walletBalanceInput.value = loadedSandboxWalletBalance;
        if (walletBalanceVal) walletBalanceVal.textContent = `$${loadedSandboxWalletBalance}`;
      }
    }
    if (changes.enableTimeout) {
      if (enableTimeoutCheck) {
        enableTimeoutCheck.checked = changes.enableTimeout.newValue;
        updateTimeoutVisibility();
      }
    }
    if (changes.timeoutCandles) {
      if (timeoutCandlesInput) {
        timeoutCandlesInput.value = changes.timeoutCandles.newValue;
      }
    }
    if (changes.timeframe) {
      if (timeframeSelect) {
        timeframeSelect.value = changes.timeframe.newValue;
      }
    }
    if (changes.customTpSlMode) {
      if (customTpSlModeSelect) {
        customTpSlModeSelect.value = changes.customTpSlMode.newValue;
      }
    }
    
    let activeTradesChanged = false;
    let tabStatesChanged = false;
    
    for (const key in changes) {
      if (key.startsWith('activeTrade_')) {
        const sym = key.replace('activeTrade_', '');
        const change = changes[key];
        if (change.newValue) {
          activeTrades[sym] = change.newValue;
        } else {
          delete activeTrades[sym];
        }
        activeTradesChanged = true;
      } else if (key.startsWith('tabState_')) {
        const sym = key.replace('tabState_', '');
        const change = changes[key];
        if (change.newValue) {
          tabStates[sym] = change.newValue;
        } else {
          delete tabStates[sym];
        }
        tabStatesChanged = true;
      }
    }
    
    if (activeTradesChanged) {
      renderActiveTrades();
      fetchPrices();
      loadDatabaseHistory();
    }
    if (tabStatesChanged) {
      renderScanners();
    }
    if (changes.journalLastClearedTime) {
      loadDatabaseHistory();
    }

    // Update visual controls if settings changed externally
    if (changes.enableAutoPilot) enableAutoPilotCheck.checked = changes.enableAutoPilot.newValue;
    if (changes.enableCircuitBreaker) enableCircuitBreakerCheck.checked = changes.enableCircuitBreaker.newValue;
    if (changes.enableSMC) enableSMCCheck.checked = changes.enableSMC.newValue;
    if (changes.enableTechnical) enableTechnicalCheck.checked = changes.enableTechnical.newValue;
    if (changes.enableAudio) enableAudioCheck.checked = changes.enableAudio.newValue;
    if (changes.sandboxMode) enableSandboxCheck.checked = changes.sandboxMode.newValue;
    if (changes.riskAmount) {
      riskAmountInput.value = changes.riskAmount.newValue;
      riskVal.textContent = `$${changes.riskAmount.newValue}`;
    }
    if (changes.leverage) {
      leverageInput.value = changes.leverage.newValue;
      levVal.textContent = `${changes.leverage.newValue}x`;
    }
    if (changes.triggerThreshold) {
      entryThresholdInput.value = changes.triggerThreshold.newValue;
      thresholdVal.textContent = `${changes.triggerThreshold.newValue}%`;
    }
    if (changes.sizeMode) sizeModeSelect.value = changes.sizeMode.newValue;
    if (changes.tradeCapital) {
      tradeCapitalInput.value = changes.tradeCapital.newValue;
      capitalVal.textContent = `$${changes.tradeCapital.newValue}`;
    }
    if (changes.targetMode) targetModeSelect.value = changes.targetMode.newValue;
    if (changes.customTakeProfit) customTpInput.value = changes.customTakeProfit.newValue;
    if (changes.customStopLoss) customSlInput.value = changes.customStopLoss.newValue;
  });

  // 3. Apply configurations button
  btnApply.addEventListener('click', () => {
    const phoneInput = document.getElementById('alert-phone');
    const phoneDisplay = document.getElementById('phone-display');

    const isSandbox = enableSandboxCheck.checked;
    const newSettings = {
      riskAmount: parseInt(riskAmountInput.value),
      leverage: parseInt(leverageInput.value),
      triggerThreshold: parseInt(entryThresholdInput.value),
      sandboxMode: isSandbox,
      enableSMC: enableSMCCheck.checked,
      enableTechnical: enableTechnicalCheck.checked,
      enableAudio: enableAudioCheck.checked,
      enableAutoPilot: enableAutoPilotCheck.checked,
      enableCircuitBreaker: enableCircuitBreakerCheck.checked,
      alertPhone: phoneInput ? phoneInput.value.trim() : '',
      sizeMode: sizeModeSelect.value,
      tradeCapital: parseInt(tradeCapitalInput.value),
      targetMode: targetModeSelect.value,
      customTakeProfit: parseFloat(customTpInput.value) || 1.5,
      customStopLoss: parseFloat(customSlInput.value) || 1.0,
      marginMode: marginModeSelect ? marginModeSelect.value : 'ISOLATED',
      enableTimeout: enableTimeoutCheck ? enableTimeoutCheck.checked : true,
      timeoutCandles: timeoutCandlesInput ? parseInt(timeoutCandlesInput.value) : 12,
      timeframe: timeframeSelect ? timeframeSelect.value : '5m',
      customTpSlMode: customTpSlModeSelect ? customTpSlModeSelect.value : 'margin'
    };

    if (walletBalanceInput) {
      if (isSandbox) {
        newSettings.sandboxWalletBalance = parseFloat(walletBalanceInput.value);
        newSettings.walletBalance = loadedWalletBalance;
        loadedSandboxWalletBalance = newSettings.sandboxWalletBalance;
      } else {
        newSettings.walletBalance = parseFloat(walletBalanceInput.value);
        newSettings.sandboxWalletBalance = loadedSandboxWalletBalance;
        loadedWalletBalance = newSettings.walletBalance;
      }
    }

    chrome.storage.local.set(newSettings, () => {
      // Update phone display
      if (phoneDisplay) phoneDisplay.textContent = phoneInput.value.trim() || 'None';

      // Notify all open tabs to update settings
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          if (tab.url && tab.url.includes('binance.com')) {
            chrome.tabs.sendMessage(tab.id, { type: 'UPDATE_SETTINGS', settings: newSettings }).catch(() => {});
          }
        });
      });
      alert('✅ Global Configuration parameters successfully saved and applied to all tabs!');
      loadDatabaseHistory();
    });
  });

  // Bind Purge Sandbox button
  btnPurgeSandbox.addEventListener('click', () => {
    if (!confirm('🧪 Purge all sandbox/mock trade logs from the PostgreSQL ledger? This will not affect your real live trade metrics.')) return;
    
    fetch('http://localhost:4000/api/advisor/signals/sandbox', {
      method: 'DELETE'
    })
    .then(r => {
      if (!r.ok) throw new Error("HTTP error " + r.status);
      return r.json();
    })
    .then(d => {
      if (d.success) {
        alert(`🧹 Purged ${d.count} sandbox signals from PostgreSQL!`);
        // Notify tabs to refresh metrics
        chrome.storage.local.get(null, (items) => {
          chrome.storage.local.set({ journalStats: items.journalStats || { wins: 0, losses: 0, timeouts: 0 } }, () => {
            loadDatabaseHistory();
          });
        });
      } else {
        alert("❌ Failed to purge sandbox logs: " + (d.error || "unknown error"));
      }
    })
    .catch(err => {
      alert("❌ Error connecting to backend: " + err.message);
    });
  });

  // 4. Reset trade journal button
  btnReset.addEventListener('click', () => {
    if (!confirm('🚨 Are you sure you want to reset all trade history metrics? This will clear the Postgres ledger local stats and reset consecutive loss streaks.')) return;
    
    chrome.runtime.sendMessage({ type: 'CLEAR_JOURNAL' }, (response) => {
      if (response && response.success) {
        activeTrades = {};
        tabStates = {};
        renderStats();
        renderActiveTrades();
        renderScanners();
        loadDatabaseHistory();
      }
    });
  });

  // Close all active positions button
  if (btnCloseAll) {
    btnCloseAll.addEventListener('click', () => {
      const keys = Object.keys(activeTrades);
      if (keys.length === 0) return;
      if (!confirm(`🚨 Are you sure you want to force close all ${keys.length} active positions?`)) return;
      keys.forEach(sym => {
        closePosition(sym);
      });
    });
  }

  // 5. Render stats header row
  function renderStats() {
    chrome.storage.local.get({ walletBalance: 1000, sandboxWalletBalance: 1000 }, (items) => {
      const realWalletEl = document.getElementById('real-wallet-balance');
      const sandWalletEl = document.getElementById('sandbox-wallet-balance');
      if (realWalletEl) realWalletEl.textContent = (items.walletBalance || 1000).toFixed(2);
      if (sandWalletEl) sandWalletEl.textContent = (items.sandboxWalletBalance || 1000).toFixed(2);
    });

    winsEl.textContent = journalStats.wins;
    lossesEl.textContent = journalStats.losses;
    if (timeoutsEl) timeoutsEl.textContent = journalStats.timeouts;
    consecEl.textContent = consecutiveLosses;

    const total = journalStats.wins + journalStats.losses;
    const wr = total > 0 ? Math.round((journalStats.wins / total) * 100) : 0;
    winrateEl.textContent = `${wr}%`;

    if (sandboxWinsEl) sandboxWinsEl.textContent = sandboxJournalStats.wins;
    if (sandboxLossesEl) sandboxLossesEl.textContent = sandboxJournalStats.losses;
    
    const sandTotal = sandboxJournalStats.wins + sandboxJournalStats.losses;
    const sandWr = sandTotal > 0 ? Math.round((sandboxJournalStats.wins / sandTotal) * 100) : 0;
    if (sandboxWinrateEl) sandboxWinrateEl.textContent = `${sandWr}%`;

    // Circuit breaker check
    if (enableCircuitBreakerCheck.checked && consecutiveLosses >= 3) {
      circuitBanner.style.display = 'flex';
      circuitDesc.textContent = `Bot execution paused due to ${consecutiveLosses} consecutive losses. Manual reset / overriding streak required.`;
    } else {
      circuitBanner.style.display = 'none';
    }
  }

  function updateTickerFilterPrices() {
    const filterSelect = document.getElementById('global-ticker-filter');
    if (!filterSelect) return;
    Array.from(filterSelect.options).forEach(opt => {
      const sym = opt.value;
      if (sym !== 'ALL') {
        const price = priceCache[sym];
        opt.textContent = price ? `${sym} ($${price.toFixed(2)})` : sym;
      }
    });

    const badgeEl = document.getElementById('filter-ticker-price-badge');
    if (badgeEl) {
      if (activeTickerFilter && activeTickerFilter !== 'ALL') {
        const price = priceCache[activeTickerFilter];
        badgeEl.textContent = price ? `${activeTickerFilter}: $${price.toFixed(2)}` : `${activeTickerFilter}: ---`;
        badgeEl.style.display = 'inline-block';
      } else {
        badgeEl.style.display = 'none';
      }
    }
  }

  // 6. Fetch live ticker prices for PnL
  function fetchPrices() {
    const symbolsSet = new Set(Object.keys(activeTrades));
    const filterSelect = document.getElementById('global-ticker-filter');
    if (filterSelect) {
      Array.from(filterSelect.options).forEach(opt => {
        if (opt.value !== 'ALL') symbolsSet.add(opt.value);
      });
    }
    const symbols = Array.from(symbolsSet);
    if (symbols.length === 0) {
      updateDashboardEquity();
      return;
    }

    symbols.forEach(sym => {
      const endpoints = [
        `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${sym}`,
        `https://www.binance.com/fapi/v1/ticker/price?symbol=${sym}`,
        `https://api.binance.com/api/v3/ticker/price?symbol=${sym}`,
        `https://www.binance.com/api/v3/ticker/price?symbol=${sym}`,
        `https://data-api.binance.vision/api/v3/ticker/price?symbol=${sym}`,
        `https://api.allorigins.win/raw?url=${encodeURIComponent('https://fapi.binance.com/fapi/v1/ticker/price?symbol=' + sym)}`
      ];

      const tryFetchPrice = (idx) => {
        if (idx >= endpoints.length) return;
        fetch(endpoints[idx])
          .then(r => {
            if (!r.ok) throw new Error();
            return r.json();
          })
          .then(d => {
            const price = parseFloat(d.price);
            if (price > 0) {
              priceCache[sym] = price;
              if (activeTrades[sym]) {
                updatePnLDisplay(sym);
              } else {
                updateDashboardEquity();
              }
              updateTickerFilterPrices();
            }
          })
          .catch(() => tryFetchPrice(idx + 1));
      };

      tryFetchPrice(0);
    });
  }

  // PnL updates loop
  setInterval(fetchPrices, 2000);

  // 7. Render Active Positions
  function renderActiveTrades() {
    const container = document.getElementById('positions-list');
    const badge = document.getElementById('positions-count-badge');
    const closeAllBtn = document.getElementById('btn-close-all');
    const isSandbox = enableSandboxCheck ? enableSandboxCheck.checked : false;
    const keys = Object.keys(activeTrades).filter(sym => {
      const t = activeTrades[sym];
      const tIsSandbox = t && (t.status === 'SANDBOX_ACTIVE');
      return tIsSandbox === isSandbox;
    });

    badge.textContent = `${keys.length} Active`;
    if (closeAllBtn) {
      closeAllBtn.style.display = keys.length > 0 ? 'inline-block' : 'none';
    }

    if (keys.length === 0) {
      container.innerHTML = `<div class="no-positions">No active trades are currently running. Waiting for trigger setups...</div>`;
      updateDashboardEquity();
      return;
    }

    const limit = timeoutCandlesInput ? (parseInt(timeoutCandlesInput.value) || 12) : 12;

    let html = '';
    keys.forEach(sym => {
      const pos = activeTrades[sym];
      const isLong = pos.direction === 'LONG';
      const sideClass = isLong ? 'long' : 'short';

      html += `
        <div class="pos-card ${isLong ? '' : 'short'}" id="pos-${sym}">
          <div class="pos-header">
            <div class="pos-symbol-wrap">
              <span class="pos-side-badge ${sideClass}">${pos.direction}</span>
              <span class="pos-symbol">${pos.symbol}</span>
            </div>
            <span class="pos-age">Age: <span id="pos-age-${sym}">${pos.elapsedCandles || 0}</span>/${limit} candles</span>
          </div>

          <div class="pos-grid">
            <div class="pos-cell">
              <div class="pos-lbl">Entry Price</div>
              <div class="pos-val">$${parseFloat(pos.entry).toFixed(pos.pricePrecision !== undefined ? pos.pricePrecision : 2)}</div>
            </div>
            <div class="pos-cell">
              <div class="pos-lbl">Mark Price</div>
              <div class="pos-val" style="color: var(--accent);" id="pos-mark-${sym}">—</div>
            </div>
            <div class="pos-cell">
              <div class="pos-lbl">Take Profit</div>
              <div class="pos-val" style="color: var(--green);">$${parseFloat(pos.target1).toFixed(pos.pricePrecision !== undefined ? pos.pricePrecision : 2)}</div>
            </div>
            <div class="pos-cell">
              <div class="pos-lbl">Stop Loss</div>
              <div class="pos-val" style="color: var(--red);">$${parseFloat(pos.stopLoss).toFixed(pos.pricePrecision !== undefined ? pos.pricePrecision : 2)}</div>
            </div>
            <div class="pos-cell">
              <div class="pos-lbl">Position Size</div>
              <div class="pos-val" id="pos-size-${sym}">${pos.positionSize} units</div>
            </div>
            <div class="pos-cell">
              <div class="pos-lbl">Leverage</div>
              <div class="pos-val">${pos.leverage}x</div>
            </div>
            <div class="pos-cell">
              <div class="pos-lbl">Margin Ratio</div>
              <div class="pos-val" style="color: var(--accent);" id="pos-margin-${sym}">—</div>
            </div>
            <div class="pos-cell">
              <div class="pos-lbl">Liq. Price</div>
              <div class="pos-val" style="color: var(--red);" id="pos-liq-${sym}">—</div>
            </div>
          </div>

          <div class="pos-pnl-strip">
            <span>Unrealized PnL</span>
            <span class="pos-pnl-val" id="pos-pnl-val-${sym}">Calculating...</span>
          </div>

          <div class="pos-actions">
            <button class="pos-btn pos-btn-close" data-symbol="${sym}">🚨 Close Position</button>
            <button class="pos-btn pos-btn-chart" data-symbol="${sym}">📊 View Chart</button>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;

    // Attach button listeners
    container.querySelectorAll('.pos-btn-close').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const sym = e.currentTarget.getAttribute('data-symbol');
        if (confirm(`Confirm force closing position for ${sym}?`)) {
          closePosition(sym);
        }
      });
    });

    container.querySelectorAll('.pos-btn-chart').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const sym = e.currentTarget.getAttribute('data-symbol');
        chrome.tabs.create({ url: `https://www.binance.com/en/futures/${sym}` });
      });
    });
  }

  // Update PnL numbers dynamically
  function updatePnLDisplay(sym) {
    chrome.storage.local.get(null, (items) => {
      // Find all active trades in items
      const activeKeys = Object.keys(items).filter(k => k.startsWith('activeTrade_'));
      const marginMode = items.marginMode || 'ISOLATED';
      const isSandbox = items.sandboxMode === true;
      const walletBalance = isSandbox
        ? (items.sandboxWalletBalance !== undefined ? items.sandboxWalletBalance : 1000)
        : (items.walletBalance !== undefined ? items.walletBalance : 1000);
      const activeList = activeKeys
        .map(k => items[k])
        .filter(t => t && (t.status === 'SANDBOX_ACTIVE') === isSandbox);

      // Now update the target active position stats
      const pnlEl = document.getElementById(`pos-pnl-val-${sym}`);
      const ageEl = document.getElementById(`pos-age-${sym}`);
      const marginEl = document.getElementById(`pos-margin-${sym}`);
      const liqEl = document.getElementById(`pos-liq-${sym}`);
      const pos = activeTrades[sym];
      const tickPrice = priceCache[sym];

      if (!pos || !tickPrice) return;
      const posIsSandbox = pos.status === 'SANDBOX_ACTIVE';
      if (posIsSandbox !== isSandbox) return;

      if (ageEl && pos.triggerTime) {
        const tf = pos.timeframe || items.timeframe || '5m';
        const elapsed = Math.floor((Date.now() - pos.triggerTime) / timeframeToMs(tf));
        ageEl.textContent = Math.max(0, elapsed);
      } else if (ageEl && pos.elapsedCandles != null) {
        ageEl.textContent = pos.elapsedCandles;
      }

      const isLong = pos.direction === 'LONG';
      const leverage = parseFloat(pos.leverage) || 3;
      const entry = parseFloat(pos.entry) || 0;
      const posSize = parseFloat(pos.positionSize) || 0;
      const direction = pos.direction;

      if (entry <= 0 || posSize <= 0 || leverage <= 0 || isNaN(entry) || isNaN(posSize) || isNaN(leverage)) {
        if (pnlEl) pnlEl.textContent = '—';
        if (marginEl) marginEl.textContent = '0.00%';
        if (liqEl) liqEl.textContent = '—';
        return;
      }

      const pPrec = pos.pricePrecision !== undefined ? pos.pricePrecision : 2;
      const markEl = document.getElementById(`pos-mark-${sym}`);
      if (markEl) markEl.textContent = `$${tickPrice.toFixed(pPrec)}`;

      const pnlPct = isLong
        ? ((tickPrice - entry) / entry) * 100 * leverage
        : ((entry - tickPrice) / entry) * 100 * leverage;

      const sizePct = isLong
        ? ((tickPrice - entry) / entry) * 100
        : ((entry - tickPrice) / entry) * 100;

      const pnlDollar = isLong
        ? (tickPrice - entry) * posSize
        : (entry - tickPrice) * posSize;

      if (pnlEl) {
        const sign = pnlPct >= 0 ? '+' : '';
        const sizeSign = sizePct >= 0 ? '+' : '';
        pnlEl.textContent = `${sign}${pnlPct.toFixed(2)}% (ROE) | ${sizeSign}${sizePct.toFixed(2)}% (Size) | ${sign}$${pnlDollar.toFixed(2)}`;
        pnlEl.style.color = pnlPct >= 0 ? 'var(--green)' : 'var(--red)';
      }

      if (marginMode === 'CROSS') {
        // Calculate Cross Margin metrics
        let totalUnrealizedPnl = 0;
        let totalMaintenanceMargin = 0;

        activeList.forEach(t => {
          const tSym = t.symbol;
          const tTickPrice = priceCache[tSym] || parseFloat(t.entry);
          const tEntry = parseFloat(t.entry) || 0;
          const tSize = parseFloat(t.positionSize) || 0;
          const tIsLong = t.direction === 'LONG';

          const tUpnl = tIsLong
            ? (tTickPrice - tEntry) * tSize
            : (tEntry - tTickPrice) * tSize;

          totalUnrealizedPnl += tUpnl;
          totalMaintenanceMargin += tSize * tTickPrice * 0.004;
        });

        const marginBalance = walletBalance + totalUnrealizedPnl;
        const sharedMarginRatio = marginBalance <= 0 ? 100 : Math.min((totalMaintenanceMargin / marginBalance) * 100, 100);

        // Specific uPnL and MM for the current position
        const currentUpnl = isLong
          ? (tickPrice - entry) * posSize
          : (entry - tickPrice) * posSize;
        const currentMM = posSize * tickPrice * 0.004;

        const otherUnrealizedPnl = totalUnrealizedPnl - currentUpnl;
        const otherMaintenanceMargin = totalMaintenanceMargin - currentMM;

        let liqPrice = 0;
        if (isLong) {
          liqPrice = (entry - (walletBalance + otherUnrealizedPnl - otherMaintenanceMargin) / posSize) / 0.996;
        } else {
          liqPrice = (entry + (walletBalance + otherUnrealizedPnl - otherMaintenanceMargin) / posSize) / 1.004;
        }

        if (liqPrice < 0) liqPrice = 0;

        if (marginEl) {
          marginEl.textContent = `${sharedMarginRatio.toFixed(2)}%`;
          marginEl.style.color = sharedMarginRatio > 50 ? 'var(--red)' : sharedMarginRatio > 20 ? 'var(--accent)' : 'var(--green)';
        }

        if (liqEl) {
          liqEl.textContent = `$${liqPrice.toFixed(pPrec)}`;
        }
      } else {
        // Isolated Margin Mode
        const marginRequired = (posSize * entry) / leverage;
        const unrealizedPnl = direction === 'LONG'
          ? (tickPrice - entry) * posSize
          : (entry - tickPrice) * posSize;
        const marginBalance = marginRequired + unrealizedPnl;
        const maintenanceMargin = posSize * tickPrice * 0.004;
        const marginRatio = marginBalance <= 0 ? 100 : Math.min((maintenanceMargin / marginBalance) * 100, 100);

        const liqPrice = direction === 'LONG'
          ? (entry * (1 - 1 / leverage)) / (1 - 0.004)
          : (entry * (1 + 1 / leverage)) / (1 + 0.004);

        if (marginEl) {
          marginEl.textContent = `${marginRatio.toFixed(2)}%`;
          marginEl.style.color = marginRatio > 50 ? 'var(--red)' : marginRatio > 20 ? 'var(--accent)' : 'var(--green)';
        }

        if (liqEl) {
          liqEl.textContent = `$${liqPrice.toFixed(pPrec)}`;
        }
      }

      updateDashboardEquity();
    });
  }

  function updateDashboardEquity() {
    chrome.storage.local.get(null, (items) => {
      const isSandbox = items.sandboxMode === true;
      const walletBalance = isSandbox
        ? (items.sandboxWalletBalance !== undefined ? items.sandboxWalletBalance : 1000)
        : (items.walletBalance !== undefined ? items.walletBalance : 1000);

      const activeKeys = Object.keys(items).filter(k => k.startsWith('activeTrade_'));
      const activeList = activeKeys
        .map(k => items[k])
        .filter(t => t && (t.status === 'SANDBOX_ACTIVE') === isSandbox);

      let totalUnrealizedPnl = 0;
      let totalPositionMargin = 0;
      let totalMaintenanceMargin = 0;

      activeList.forEach(t => {
        const tSym = t.symbol;
        const tTickPrice = priceCache[tSym] || parseFloat(t.entry) || 0;
        const tEntry = parseFloat(t.entry) || 0;
        const tSize = parseFloat(t.positionSize) || 0;
        const tLeverage = parseFloat(t.leverage) || 3;
        const tIsLong = t.direction === 'LONG';

        if (tEntry > 0 && tSize > 0) {
          totalPositionMargin += (tSize * tEntry) / tLeverage;
          if (tTickPrice > 0) {
            const tUpnl = tIsLong
              ? (tTickPrice - tEntry) * tSize
              : (tEntry - tTickPrice) * tSize;
            totalUnrealizedPnl += tUpnl;
            totalMaintenanceMargin += tSize * tTickPrice * 0.004;
          } else {
            totalMaintenanceMargin += tSize * tEntry * 0.004;
          }
        }
      });

      const equity = walletBalance + totalUnrealizedPnl;
      const marginRatio = equity <= 0 ? 100 : Math.min((totalMaintenanceMargin / equity) * 100, 100);
      const availableCapital = Math.max(0, equity - totalPositionMargin);

      // Update Portfolio Wallet DOM elements
      const wEquityEl = document.getElementById('wallet-equity-display');
      const wWalletEl = document.getElementById('wallet-balance-display');
      const wUpnlEl = document.getElementById('wallet-upnl-display');
      const wMarginEl = document.getElementById('wallet-margin-display');
      const wRatioEl = document.getElementById('wallet-ratio-display');
      const wAvailableEl = document.getElementById('wallet-available-display');

      if (wEquityEl) wEquityEl.textContent = `$${equity.toFixed(2)}`;
      if (wWalletEl) wWalletEl.textContent = `$${walletBalance.toFixed(2)}`;
      if (wUpnlEl) {
        const pnlSign = totalUnrealizedPnl >= 0 ? '+' : '';
        wUpnlEl.textContent = `${pnlSign}$${totalUnrealizedPnl.toFixed(2)}`;
        wUpnlEl.style.color = totalUnrealizedPnl >= 0 ? 'var(--green)' : 'var(--red)';
      }
      if (wMarginEl) wMarginEl.textContent = `$${totalPositionMargin.toFixed(2)}`;
      if (wRatioEl) {
        wRatioEl.textContent = `${marginRatio.toFixed(2)}%`;
        wRatioEl.style.color = marginRatio > 50 ? 'var(--red)' : marginRatio > 20 ? 'var(--accent)' : 'var(--green)';
      }
      if (wAvailableEl) wAvailableEl.textContent = `$${availableCapital.toFixed(2)}`;

      // Legacy support for title bar performance journals
      if (isSandbox) {
        const sandEquityEl = document.getElementById('sandbox-equity');
        if (sandEquityEl) sandEquityEl.textContent = equity.toFixed(2);
        const sandWalletEl = document.getElementById('sandbox-wallet-balance');
        if (sandWalletEl) sandWalletEl.textContent = walletBalance.toFixed(2);
      } else {
        const realEquityEl = document.getElementById('real-equity');
        if (realEquityEl) realEquityEl.textContent = equity.toFixed(2);
        const realWalletEl = document.getElementById('real-wallet-balance');
        if (realWalletEl) realWalletEl.textContent = walletBalance.toFixed(2);
      }
    });
  }

  // Force close active position centrally via background SW
  function closePosition(sym) {
    chrome.runtime.sendMessage({ type: 'MANUAL_CLOSE_TRADE', symbol: sym }, (response) => {
      if (response && response.success) {
        console.log(`✅ Successfully closed active position for ${sym}`);
      } else {
        console.error(`❌ Failed to manually close trade:`, response ? response.error : 'Unknown error');
      }
    });
  }

  // 8. Render Scanners Grid
  function renderScanners() {
    const container = document.getElementById('scanners-grid');
    const badge = document.getElementById('scanners-count-badge');
    const keys = Object.keys(tabStates);

    // Filter out stale scanner heartbeats (older than 20 seconds) and purge from storage in batch
    const staleKeys = [];
    const activeKeys = keys.filter(sym => {
      const isStale = Date.now() - tabStates[sym].lastUpdated > 20000;
      if (isStale) {
        staleKeys.push('tabState_' + sym);
        delete tabStates[sym];
        return false;
      }
      return true;
    });

    if (staleKeys.length > 0) {
      chrome.storage.local.remove(staleKeys);
    }
    badge.textContent = `${activeKeys.length} Active Charts`;

    if (activeKeys.length === 0) {
      container.innerHTML = `<div class="no-scanners">No active tabs detected scanning tickers. Open Binance Futures charts in other tabs.</div>`;
      return;
    }

    let html = '';
    activeKeys.forEach(sym => {
      const state = tabStates[sym];
      const biasClass = state.direction === 'LONG' ? 'bullish' : state.direction === 'SHORT' ? 'bearish' : 'neutral';
      const biasText = state.direction === 'LONG' ? 'BULLISH SETUP' : state.direction === 'SHORT' ? 'BEARISH SETUP' : 'SCANNING RANGE';
      
      // Indicators object
      const ind = state.indicators || { rsi: '--', ema9: 0, ema21: 0, bullishOB: 0, bearishOB: 0 };
      const emaLabel = state.currentTickPrice > ind.ema21 ? 'BULL' : 'BEAR';

      html += `
        <div class="scan-card">
          <div class="scan-header">
            <div class="scan-symbol-wrap">
              <span class="scan-symbol">${state.symbol}</span>
              <span class="scan-bias-badge ${biasClass}">${biasText}</span>
            </div>
            <span class="scan-prob">${state.probability}%</span>
          </div>
          
          <div class="scan-pattern" style="display: flex; justify-content: space-between; align-items: center;">
            <span>${state.pattern || 'Scanning'}</span>
            <span style="font-family: monospace; font-weight: 700; color: #fff;">$${state.currentTickPrice ? parseFloat(state.currentTickPrice).toFixed(2) : '--'}</span>
          </div>

          <div class="scan-indicators">
            <div>
              <span class="scan-ind-lbl">RSI (14)</span>
            </div>
            <div class="scan-ind-val" style="color: ${ind.rsi < 32 ? 'var(--green)' : ind.rsi > 68 ? 'var(--red)' : 'var(--accent)'}">${ind.rsi}</div>

            <div>
              <span class="scan-ind-lbl">EMA Trend</span>
            </div>
            <div class="scan-ind-val" style="color: ${emaLabel === 'BULL' ? 'var(--green)' : 'var(--red)'}">${emaLabel}</div>

            <div>
              <span class="scan-ind-lbl">Bullish OBs</span>
            </div>
            <div class="scan-ind-val" style="color: var(--green);">${ind.bullishOB || 0}</div>

            <div>
              <span class="scan-ind-lbl">Bearish OBs</span>
            </div>
            <div class="scan-ind-val" style="color: var(--red);">${ind.bearishOB || 0}</div>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  // Periodic cleaner of stale scanners
  setInterval(renderScanners, 5000);

  // ── World Clocks & Timeline ──
  function renderTimelineClock() {
    const now = new Date();

    const fmt = (tz) => now.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false });

    const estEl = document.getElementById('clock-est');
    const gmtEl = document.getElementById('clock-gmt');
    const jstEl = document.getElementById('clock-jst');
    const aestEl = document.getElementById('clock-aest');
    const utcEl = document.getElementById('clock-utc');
    const istEl = document.getElementById('dashboard-ist-clock');

    if (estEl) estEl.textContent = fmt('America/New_York');
    if (gmtEl) gmtEl.textContent = fmt('Europe/London');
    if (jstEl) jstEl.textContent = fmt('Asia/Tokyo');
    if (aestEl) aestEl.textContent = fmt('Australia/Sydney');
    if (utcEl) utcEl.textContent = fmt('UTC');
    if (istEl) istEl.textContent = 'IST ' + fmt('Asia/Kolkata');

    // Move timeline needle based on current UTC hour + fraction
    const utcHours = now.getUTCHours();
    const utcMinutes = now.getUTCMinutes();
    const pct = ((utcHours * 60 + utcMinutes) / 1440) * 100;
    const needle = document.getElementById('timeline-needle');
    if (needle) needle.style.left = `${pct}%`;
  }

  function loadDatabaseHistory() {
    fetch('http://localhost:4000/api/advisor/signals')
      .then(r => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then(signals => {
        if (Array.isArray(signals)) {
          signals.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          dbSignals = signals;
          populateTickerFilter(signals);
          compileStatsFromSignals(signals);
          renderLedgerTable();
        }
      })
      .catch(err => {
        console.warn("⚠️ Failed to load signals history:", err.message);
      });
  }

  function compileStatsFromSignals(signals) {
    chrome.storage.local.get(['journalLastClearedTime', 'walletBalance', 'sandboxWalletBalance'], (items) => {
      const lastCleared = items.journalLastClearedTime || 0;
      const walletBalance = items.walletBalance !== undefined ? items.walletBalance : 1000;
      const sandboxWalletBalance = items.sandboxWalletBalance !== undefined ? items.sandboxWalletBalance : 1000;

      const realWalletEl = document.getElementById('real-wallet-balance');
      const sandWalletEl = document.getElementById('sandbox-wallet-balance');
      if (realWalletEl) realWalletEl.textContent = walletBalance.toFixed(2);
      if (sandWalletEl) sandWalletEl.textContent = sandboxWalletBalance.toFixed(2);

      let realWins = 0, realLosses = 0, realTimeouts = 0, realConsec = 0;
      let sandWins = 0, sandLosses = 0, sandTimeouts = 0, sandConsec = 0;

      let realGrossWins = 0, realGrossLosses = 0, realNetProfit = 0;
      let sandGrossWins = 0, sandGrossLosses = 0, sandNetProfit = 0;

      let realTotalDuration = 0, realResolvedCount = 0;
      let sandTotalDuration = 0, sandResolvedCount = 0;

      let realTotalTrades = 0;
      let sandTotalTrades = 0;

      const chronoSignals = [...signals]
        .filter(s => new Date(s.createdAt).getTime() >= lastCleared)
        .filter(s => activeTickerFilter === 'ALL' || (s.symbol && s.symbol.toUpperCase() === activeTickerFilter))
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      for (const sig of chronoSignals) {
        const isSand = sig.actualOutcome === 'SANDBOX' || sig.status.startsWith('SANDBOX_');
        let status = sig.status;

        // PnL Calculation
        const pnlVal = parseFloat(sig.pnlPercentage || '0.0000');
        const risk = parseFloat(sig.riskAmount || '20');
        const cap = parseFloat(sig.positionSize) * parseFloat(sig.entryPrice) / (parseFloat(sig.leverage) || 3);
        const tradeCap = isNaN(cap) || cap <= 0 || !isFinite(cap) ? risk : cap;
        const dollarPnL = (pnlVal / 100) * tradeCap;

        // Trade duration
        let durationMins = 0;
        let hasDuration = false;
        if (sig.resolvedAt && sig.createdAt) {
          const diffMs = new Date(sig.resolvedAt).getTime() - new Date(sig.createdAt).getTime();
          durationMins = diffMs / 60000;
          hasDuration = true;
        }

        // Standardize status for outcome calculation
        let outcome = isSand ? status.replace('SANDBOX_', '') : status;
        if (outcome === 'TIMEOUT' || outcome === 'INVALIDATED') {
          outcome = pnlVal >= 0 ? 'WIN' : 'LOSS';
        }

        if (isSand) {
          if (outcome === 'WIN') {
            sandWins++;
            sandConsec = 0;
            sandNetProfit += dollarPnL;
            if (dollarPnL > 0) sandGrossWins += dollarPnL;
            if (hasDuration) { sandTotalDuration += durationMins; sandResolvedCount++; }
            sandTotalTrades++;
          } else if (outcome === 'LOSS') {
            sandLosses++;
            sandConsec++;
            sandNetProfit += dollarPnL;
            if (dollarPnL < 0) sandGrossLosses += Math.abs(dollarPnL);
            if (hasDuration) { sandTotalDuration += durationMins; sandResolvedCount++; }
            sandTotalTrades++;
          }
          if (status.replace('SANDBOX_', '') === 'TIMEOUT') {
            sandTimeouts++;
          }
        } else {
          if (outcome === 'WIN') {
            realWins++;
            realConsec = 0;
            realNetProfit += dollarPnL;
            if (dollarPnL > 0) realGrossWins += dollarPnL;
            if (hasDuration) { realTotalDuration += durationMins; realResolvedCount++; }
            realTotalTrades++;
          } else if (outcome === 'LOSS') {
            realLosses++;
            realConsec++;
            realNetProfit += dollarPnL;
            if (dollarPnL < 0) realGrossLosses += Math.abs(dollarPnL);
            if (hasDuration) { realTotalDuration += durationMins; realResolvedCount++; }
            realTotalTrades++;
          }
          if (status === 'TIMEOUT') {
            realTimeouts++;
          }
        }
      }

      winsEl.textContent = realWins;
      lossesEl.textContent = realLosses;
      if (timeoutsEl) timeoutsEl.textContent = realTimeouts;
      consecEl.textContent = realConsec;
      
      const realTotal = realWins + realLosses;
      const realWr = realTotal > 0 ? Math.round((realWins / realTotal) * 100) : 0;
      winrateEl.textContent = `${realWr}%`;

      // Profit Factor for Real
      let realProfitFactor = '0.00';
      if (realGrossLosses > 0) {
        realProfitFactor = (realGrossWins / realGrossLosses).toFixed(2);
      } else if (realGrossWins > 0) {
        realProfitFactor = '99.99';
      }

      const realNetProfitSign = realNetProfit >= 0 ? '+' : '';
      const realProfitColor = realNetProfit >= 0 ? 'var(--green)' : 'var(--red)';
      if (realProfitEl) {
        realProfitEl.textContent = `${realNetProfitSign}$${Math.abs(realNetProfit).toFixed(2)}`;
        realProfitEl.style.color = realProfitColor;
      }
      if (realDurationEl) {
        const avgDur = realResolvedCount > 0 ? Math.round(realTotalDuration / realResolvedCount) : 0;
        realDurationEl.textContent = `${avgDur}m`;
      }
      if (realFactorEl) {
        realFactorEl.textContent = realProfitFactor;
      }
      if (realTotalEl) {
        realTotalEl.textContent = realTotalTrades;
      }

      sandboxWinsEl.textContent = sandWins;
      sandboxLossesEl.textContent = sandLosses;
      sandboxConsecEl.textContent = sandConsec;
      
      const sandTotal = sandWins + sandLosses;
      const sandWr = sandTotal > 0 ? Math.round((sandWins / sandTotal) * 100) : 0;
      sandboxWinrateEl.textContent = `${sandWr}%`;

      // Profit Factor for Sandbox
      let sandProfitFactor = '0.00';
      if (sandGrossLosses > 0) {
        sandProfitFactor = (sandGrossWins / sandGrossLosses).toFixed(2);
      } else if (sandGrossWins > 0) {
        sandProfitFactor = '99.99';
      }

      const sandNetProfitSign = sandNetProfit >= 0 ? '+' : '';
      const sandProfitColor = sandNetProfit >= 0 ? 'var(--green)' : 'var(--red)';
      if (sandboxProfitEl) {
        sandboxProfitEl.textContent = `${sandNetProfitSign}$${Math.abs(sandNetProfit).toFixed(2)}`;
        sandboxProfitEl.style.color = sandProfitColor;
      }
      if (sandboxDurationEl) {
        const avgDur = sandResolvedCount > 0 ? Math.round(sandTotalDuration / sandResolvedCount) : 0;
        sandboxDurationEl.textContent = `${avgDur}m`;
      }
      if (sandboxFactorEl) {
        sandboxFactorEl.textContent = sandProfitFactor;
      }
      if (sandboxTotalEl) {
        sandboxTotalEl.textContent = sandTotalTrades;
      }

    // Only write to storage if the calculated stats actually differ from what is currently stored.
    // This prevents redundant storage writes and onChange events every 5 seconds.
    chrome.storage.local.get(['journalStats', 'sandboxJournalStats', 'consecutiveLosses'], (stored) => {
      const storedStats = stored.journalStats || { wins: 0, losses: 0, timeouts: 0 };
      const storedSandStats = stored.sandboxJournalStats || { wins: 0, losses: 0, timeouts: 0 };
      const storedConsec = stored.consecutiveLosses || 0;
      
      if (storedStats.wins !== realWins || 
          storedStats.losses !== realLosses || 
          storedStats.timeouts !== realTimeouts ||
          storedSandStats.wins !== sandWins ||
          storedSandStats.losses !== sandLosses ||
          storedSandStats.timeouts !== sandTimeouts ||
          storedConsec !== realConsec) {
        chrome.storage.local.set({
          journalStats: { wins: realWins, losses: realLosses, timeouts: realTimeouts },
          sandboxJournalStats: { wins: sandWins, losses: sandLosses, timeouts: sandTimeouts },
          consecutiveLosses: realConsec
        });
      }
    });

      if (enableCircuitBreakerCheck.checked && realConsec >= 3) {
        circuitBanner.style.display = 'flex';
        circuitDesc.textContent = `Bot execution paused due to ${realConsec} consecutive losses. Manual reset / overriding streak required.`;
      } else {
        circuitBanner.style.display = 'none';
      }
    });
  }

  function renderLedgerTable() {
    if (!ledgerTbody) return;

    chrome.storage.local.get('journalLastClearedTime', (items) => {
      const lastCleared = items.journalLastClearedTime || 0;

      // 1. Initial filter by cleared time
      let filtered = dbSignals.filter(s => {
        return new Date(s.createdAt).getTime() >= lastCleared;
      });

      // 2. Filter by global ticker focus
      if (activeTickerFilter !== 'ALL') {
        const normActiveFilter = activeTickerFilter.toUpperCase().replace(/[^A-Z0-9]/g, '');
        filtered = filtered.filter(s => {
          const sigSym = s.symbol ? s.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '') : "";
          return sigSym === normActiveFilter;
        });
      }

      // 3. Filter by type (REAL vs SANDBOX)
      if (ledgerFilter === 'REAL') {
        filtered = filtered.filter(s => s.actualOutcome !== 'SANDBOX' && !s.status.startsWith('SANDBOX_'));
      } else if (ledgerFilter === 'SANDBOX') {
        filtered = filtered.filter(s => s.actualOutcome === 'SANDBOX' || s.status.startsWith('SANDBOX_'));
      }

      // 4. Filter by outcome selector
      if (ledgerOutcomeFilter !== 'ALL') {
        filtered = filtered.filter(s => {
          let status = s.status;
          const isSand = s.actualOutcome === 'SANDBOX' || s.status.startsWith('SANDBOX_');
          let outcome = isSand ? status.replace('SANDBOX_', '') : status;
          const pnlVal = parseFloat(s.pnlPercentage || '0.0000');
          if (outcome === 'TIMEOUT' || outcome === 'INVALIDATED') {
            outcome = pnlVal >= 0 ? 'WIN' : 'LOSS';
          }
          return outcome === ledgerOutcomeFilter;
        });
      }

      // 5. Filter by Search Query (Symbol)
      if (ledgerSearchQuery) {
        filtered = filtered.filter(s => s.symbol && s.symbol.toUpperCase().includes(ledgerSearchQuery));
      }

      // 6. Sort data
      filtered.sort((a, b) => {
        let valA, valB;
        if (ledgerSortColumn === 'symbol') {
          valA = a.symbol || '';
          valB = b.symbol || '';
        } else if (ledgerSortColumn === 'prob') {
          valA = parseFloat(a.probability) || 0;
          valB = parseFloat(b.probability) || 0;
        } else if (ledgerSortColumn === 'cap') {
          const aRisk = parseFloat(a.riskAmount || '20');
          const aCap = parseFloat(a.positionSize) * parseFloat(a.entryPrice) / (parseFloat(a.leverage) || 3);
          valA = isNaN(aCap) || aCap <= 0 || !isFinite(aCap) ? aRisk : aCap;

          const bRisk = parseFloat(b.riskAmount || '20');
          const bCap = parseFloat(b.positionSize) * parseFloat(b.entryPrice) / (parseFloat(b.leverage) || 3);
          valB = isNaN(bCap) || bCap <= 0 || !isFinite(bCap) ? bRisk : bCap;
        } else if (ledgerSortColumn === 'duration') {
          valA = (a.resolvedAt && a.createdAt) ? new Date(a.resolvedAt).getTime() - new Date(a.createdAt).getTime() : 0;
          valB = (b.resolvedAt && b.createdAt) ? new Date(b.resolvedAt).getTime() - new Date(b.createdAt).getTime() : 0;
        } else if (ledgerSortColumn === 'pnl') {
          valA = parseFloat(a.pnlPercentage || '0.0000');
          valB = parseFloat(b.pnlPercentage || '0.0000');
        } else {
          // Default sorting by date
          valA = new Date(a.createdAt).getTime();
          valB = new Date(b.createdAt).getTime();
        }

        if (typeof valA === 'string') {
          return ledgerSortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
        } else {
          return ledgerSortDirection === 'asc' ? valA - valB : valB - valA;
        }
      });

      // 7. Paginate data
      const totalCount = filtered.length;
      const totalPages = Math.ceil(totalCount / ledgerPageSize);

      if (ledgerCurrentPage > totalPages) {
        ledgerCurrentPage = Math.max(1, totalPages);
      }

      const startIdx = (ledgerCurrentPage - 1) * ledgerPageSize;
      const endIdx = Math.min(startIdx + ledgerPageSize, totalCount);

      // Update Pagination DOM labels
      const startCountEl = document.getElementById('ledger-page-start');
      const endCountEl = document.getElementById('ledger-page-end');
      const totalCountEl = document.getElementById('ledger-total-count');
      if (startCountEl) startCountEl.textContent = totalCount === 0 ? 0 : startIdx + 1;
      if (endCountEl) endCountEl.textContent = endIdx;
      if (totalCountEl) totalCountEl.textContent = totalCount;

      if (btnPrev) {
        btnPrev.disabled = ledgerCurrentPage <= 1;
        btnPrev.style.opacity = ledgerCurrentPage <= 1 ? '0.5' : '1';
        btnPrev.style.cursor = ledgerCurrentPage <= 1 ? 'not-allowed' : 'pointer';
      }
      if (btnNext) {
        btnNext.disabled = ledgerCurrentPage >= totalPages;
        btnNext.style.opacity = ledgerCurrentPage >= totalPages ? '0.5' : '1';
        btnNext.style.cursor = ledgerCurrentPage >= totalPages ? 'not-allowed' : 'pointer';
      }

      const pageItems = filtered.slice(startIdx, endIdx);

      if (pageItems.length === 0) {
        ledgerTbody.innerHTML = `
          <tr>
            <td colspan="9" style="text-align: center; padding: 20px; color: var(--text-muted);">No matching trade logs found.</td>
          </tr>
        `;
        return;
      }

      let html = '';
      pageItems.forEach(sig => {
        const isSand = sig.actualOutcome === 'SANDBOX' || sig.status.startsWith('SANDBOX_');
        const sideClass = sig.direction === 'LONG' ? 'color: var(--green);' : 'color: var(--red);';
        const typeLabel = isSand 
          ? '<span style="background: rgba(30, 144, 255, 0.15); color: #1e90ff; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 800;">SANDBOX</span>' 
          : '<span style="background: rgba(46, 189, 133, 0.15); color: var(--green); padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: 800;">REAL</span>';

        let durationStr = '--';
        if (sig.resolvedAt && sig.createdAt) {
          const diffMs = new Date(sig.resolvedAt).getTime() - new Date(sig.createdAt).getTime();
          const diffMins = Math.round(diffMs / 60000);
          durationStr = `${diffMins} min`;
        }

        const pnlVal = parseFloat(sig.pnlPercentage || '0.0000');
        const pnlColor = pnlVal >= 0 ? 'var(--green)' : 'var(--red)';
        const pnlSign = pnlVal >= 0 ? '+' : '';

        const risk = parseFloat(sig.riskAmount || '20');
        const cap = parseFloat(sig.positionSize) * parseFloat(sig.entryPrice) / (parseFloat(sig.leverage) || 3);
        const tradeCap = isNaN(cap) || cap <= 0 || !isFinite(cap) ? risk : cap;
        const dollarPnL = (pnlVal / 100) * tradeCap;

        const dateStr = new Date(sig.createdAt).toLocaleDateString() + ' ' + new Date(sig.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        html += `
          <tr style="border-bottom: 1px solid var(--border); color: var(--text);">
            <td style="padding: 10px 8px; font-weight: 700;"><span style="${sideClass}">${sig.direction}</span> ${sig.symbol}</td>
            <td style="padding: 10px 8px;">${typeLabel}</td>
            <td style="padding: 10px 8px; font-weight: 700; color: var(--accent); font-family: monospace;">${sig.probability}%</td>
            <td style="padding: 10px 8px; font-family: monospace;">$${tradeCap.toFixed(2)}</td>
            <td style="padding: 10px 8px; font-family: monospace;">$${parseFloat(sig.entryPrice).toFixed(2)} ➔ $${sig.resolvedAt ? parseFloat(sig.target1).toFixed(2) : '--'}</td>
            <td style="padding: 10px 8px; color: var(--text-muted);">${durationStr}</td>
            <td style="padding: 10px 8px; font-family: monospace; font-weight: 800; color: ${pnlColor};">${pnlSign}${pnlVal.toFixed(2)}% ($${pnlSign}${dollarPnL.toFixed(2)})</td>
            <td style="padding: 10px 8px; font-weight: 800; text-transform: uppercase;">${sig.status}</td>
            <td style="padding: 10px 8px; color: var(--text-muted); font-size: 11px;">${dateStr}</td>
          </tr>
        `;
      });

      ledgerTbody.innerHTML = html;
    });
  }

  // Start clock immediately and tick every second
  renderTimelineClock();
  setInterval(renderTimelineClock, 1000);
});
