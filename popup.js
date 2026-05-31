// ── Session logic mirrors content.js 8-zone refined UTC windows exactly ──
function getUTCDecimal() {
  const now = new Date();
  return now.getUTCHours() + now.getUTCMinutes() / 60;
}

function renderSessions() {
  const utc = getUTCDecimal();

  const londonEl = document.getElementById('sessLondon');
  const nyEl     = document.getElementById('sessNY');
  const asiaEl   = document.getElementById('sessAsia');

  // ── London ──
  if (utc >= 13 && utc < 14) {
    londonEl.textContent = 'Peak / NY Overlap';
    londonEl.className   = 'session-status active';
  } else if (utc >= 8 && utc < 10) {
    londonEl.textContent = 'Open — Core';
    londonEl.className   = 'session-status active';
  } else if (utc >= 7 && utc < 8) {
    londonEl.textContent = 'Pre-Open Caution';
    londonEl.className   = 'session-status active'; // mild positive, show as active
  } else if (utc >= 10 && utc < 13) {
    londonEl.textContent = 'Open — Trailing';
    londonEl.className   = 'session-status inactive';
  } else {
    londonEl.textContent = 'Closed';
    londonEl.className   = 'session-status inactive';
  }

  // ── New York ──
  if (utc >= 13 && utc < 14) {
    nyEl.textContent = 'Open — Overlap';
    nyEl.className   = 'session-status active';
  } else if (utc >= 14 && utc < 17) {
    nyEl.textContent = 'Open — Active';
    nyEl.className   = 'session-status active';
  } else if (utc >= 17 && utc < 21) {
    nyEl.textContent = 'Afternoon Drift';
    nyEl.className   = 'session-status inactive';
  } else {
    nyEl.textContent = 'Closed';
    nyEl.className   = 'session-status inactive';
  }

  // ── Asia ── (refined — Tokyo open is NOT dead)
  if (utc >= 2 && utc < 4) {
    asiaEl.textContent = 'Tokyo Open — Neutral';
    asiaEl.className   = 'session-status inactive'; // neutral, not dead
  } else if (utc >= 0 && utc < 2) {
    asiaEl.textContent = 'Midnight — No Liquidity';
    asiaEl.className   = 'session-status dead';
  } else if (utc >= 4 && utc < 7) {
    asiaEl.textContent = 'Dead Zone ⚠️';
    asiaEl.className   = 'session-status dead';
  } else {
    asiaEl.textContent = 'Closed';
    asiaEl.className   = 'session-status inactive';
  }
}

// ── IST Clock (UTC + 5h30m) ──────────────────────────────
function renderISTClock() {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 * 60 * 1000); // add 5h30m
  const ist = new Date(istMs);
  const hh  = String(ist.getUTCHours()).padStart(2, '0');
  const mm  = String(ist.getUTCMinutes()).padStart(2, '0');
  const ss  = String(ist.getUTCSeconds()).padStart(2, '0');
  const el  = document.getElementById('istClock');
  if (el) el.textContent = `IST ${hh}:${mm}:${ss}`;
}


function renderStats(stats) {
  const wins     = stats.wins     || 0;
  const losses   = stats.losses   || 0;
  const timeouts = stats.timeouts || 0;
  const total    = wins + losses;

  const winRate  = total > 0 ? Math.round((wins / total) * 100) : 0;

  document.getElementById('statsWins').textContent     = wins;
  document.getElementById('statsLosses').textContent   = losses;
  document.getElementById('statsTimeouts').textContent = timeouts;
  document.getElementById('statsWinrate').textContent  = `${winRate}%`;
  document.getElementById('statsWinrate').style.color  = winRate >= 50 ? 'var(--green)' : winRate > 0 ? 'var(--red)' : 'var(--text-muted)';
  document.getElementById('totalTradeBadge').textContent = `${wins + losses + timeouts} Trades`;

  // Win rate bar
  document.getElementById('winRateBar').style.width         = `${winRate}%`;
  document.getElementById('winRateBar').style.background    = winRate >= 50 ? 'var(--green)' : 'var(--red)';
  document.getElementById('winRateBarLabel').textContent    = `${winRate}%`;
}

function updateJournalTitle(isSandbox) {
  const titleEl = document.getElementById('journalTitle');
  if (!titleEl) return;
  const badge = document.getElementById('totalTradeBadge');
  const badgeHTML = badge ? badge.outerHTML : '<span class="badge" id="totalTradeBadge">0 Trades</span>';
  const walletSpan = `<span id="journalWalletBalance" style="font-size: 11px; color: var(--accent); margin-left: 10px; font-weight: bold;"></span>`;
  
  if (isSandbox) {
    titleEl.innerHTML = `Performance Journal <span class="badge" style="background: rgba(30,144,255,0.15); color: var(--blue); border-color: rgba(30,144,255,0.3);">Sandbox</span> ${badgeHTML} ${walletSpan}`;
  } else {
    titleEl.innerHTML = `Performance Journal <span class="badge" style="background: rgba(46,189,133,0.15); color: var(--green); border-color: rgba(46,189,133,0.3);">Real</span> ${badgeHTML} ${walletSpan}`;
  }

  updatePopupEquity();
}

function updatePopupEquity() {
  chrome.storage.local.get(null, (items) => {
    const isSandbox = items.sandboxMode || false;
    const walletBalance = isSandbox ? (items.sandboxWalletBalance || 1000) : (items.walletBalance || 1000);
    
    const activeTradesList = [];
    for (const key in items) {
      if (key.startsWith('activeTrade_')) {
        const t = items[key];
        if (t && (t.status === 'ACTIVE' || t.status === 'SANDBOX_ACTIVE')) {
          const tSand = t.status === 'SANDBOX_ACTIVE' || (t.status && t.status.startsWith('SANDBOX_'));
          if (tSand === isSandbox) {
            activeTradesList.push(t);
          }
        }
      }
    }

    if (activeTradesList.length === 0) {
      const balanceEl = document.getElementById('journalWalletBalance');
      if (balanceEl) {
        balanceEl.textContent = `Wallet: $${walletBalance.toFixed(2)} | Equity: $${walletBalance.toFixed(2)}`;
      }
      return;
    }

    const priceUrl = `https://fapi.binance.com/fapi/v1/ticker/price`;
    fetch(priceUrl)
      .then(r => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .catch(() => {
        const spotUrl = `https://api.binance.com/api/v3/ticker/price`;
        return fetch(spotUrl).then(r => r.json());
      })
      .then(data => {
        const priceMap = {};
        data.forEach(item => {
          priceMap[item.symbol] = parseFloat(item.price);
        });

        let totalUnrealizedPnl = 0;
        activeTradesList.forEach(t => {
          const tTick = priceMap[t.symbol] || parseFloat(t.entry) || 0;
          const tEntry = parseFloat(t.entry) || 0;
          const tSize = parseFloat(t.positionSize) || 0;
          const tIsLong = t.direction === 'LONG';

          const uPnL = tIsLong
            ? (tTick - tEntry) * tSize
            : (tEntry - tTick) * tSize;

          totalUnrealizedPnl += uPnL;
        });

        const equity = walletBalance + totalUnrealizedPnl;
        const balanceEl = document.getElementById('journalWalletBalance');
        if (balanceEl) {
          balanceEl.textContent = `Wallet: $${walletBalance.toFixed(2)} | Equity: $${equity.toFixed(2)}`;
        }
      })
      .catch(err => {
        console.error("Popup equity fetch error:", err);
      });
  });
}

let loadedSignals = [];

function populatePopupTickerFilter(signals) {
  const filterSelect = document.getElementById('popupTickerFilter');
  if (!filterSelect) return;
  const currentVal = filterSelect.dataset.userVal || filterSelect.value || 'ALL';
  const normCurrentVal = currentVal.toUpperCase().replace(/[^A-Z0-9]/g, '');
  
  const symbols = new Set();
  signals.forEach(s => {
    if (s.symbol) {
      const norm = s.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (norm) symbols.add(norm);
    }
  });
  
  filterSelect.innerHTML = '<option value="ALL">All Tickers</option>';
  Array.from(symbols).sort().forEach(sym => {
    const opt = document.createElement('option');
    opt.value = sym;
    opt.textContent = sym;
    filterSelect.appendChild(opt);
  });

  getActiveTabSymbol((activeSym) => {
    const normActiveSym = activeSym ? activeSym.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    if (normActiveSym && symbols.has(normActiveSym) && !filterSelect.dataset.userHasSelected) {
      filterSelect.value = normActiveSym;
    } else if (symbols.has(normCurrentVal)) {
      filterSelect.value = normCurrentVal;
    } else {
      filterSelect.value = 'ALL';
    }
    recalculateFilteredStats();
  });
}

function recalculateFilteredStats() {
  const filterSelect = document.getElementById('popupTickerFilter');
  const filterVal = filterSelect ? filterSelect.value : 'ALL';
  const normFilterVal = filterVal.toUpperCase().replace(/[^A-Z0-9]/g, '');
  
  chrome.storage.local.get({ journalLastClearedTime: 0, sandboxMode: false }, (items) => {
    const journalLastClearedTime = items.journalLastClearedTime || 0;
    
    let localWins = 0;
    let localLosses = 0;
    let localTimeouts = 0;

    let sandboxWins = 0;
    let sandboxLosses = 0;
    let sandboxTimeouts = 0;

    for (const sig of loadedSignals) {
      const signalTime = new Date(sig.createdAt).getTime();
      if (journalLastClearedTime && signalTime < journalLastClearedTime) {
        continue;
      }
      const sigSym = sig.symbol ? sig.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
      if (normFilterVal !== 'ALL' && sigSym !== normFilterVal) {
        continue;
      }

      let status = sig.status;
      if (!status || status === "ACTIVE" || status === "SANDBOX_ACTIVE") {
        continue;
      }
      const isSandbox = status.startsWith("SANDBOX_");
      let outcome = isSandbox ? status.replace("SANDBOX_", "") : status;
      
      const pnlPercentage = parseFloat(sig.pnlPercentage) || 0;
      
      const rawOutcome = isSandbox ? status.replace("SANDBOX_", "") : status;
      if (rawOutcome === "TIMEOUT") {
        if (isSandbox) sandboxTimeouts++;
        else localTimeouts++;
      }

      if (outcome === "TIMEOUT" || outcome === "INVALIDATED") {
        outcome = pnlPercentage >= 0 ? "WIN" : "LOSS";
      }

      if (isSandbox) {
        if (outcome === "WIN") {
          sandboxWins++;
        } else if (outcome === "LOSS") {
          sandboxLosses++;
        }
      } else {
        if (outcome === "WIN") {
          localWins++;
        } else if (outcome === "LOSS") {
          localLosses++;
        }
      }
    }

    const journalStats = { wins: localWins, losses: localLosses, timeouts: localTimeouts };
    const sandboxJournalStats = { wins: sandboxWins, losses: sandboxLosses, timeouts: sandboxTimeouts };

    const activeStats = items.sandboxMode ? sandboxJournalStats : journalStats;
    renderStats(activeStats);
    updateJournalTitle(items.sandboxMode);
  });
}

function syncJournalWithDatabase() {
  fetch('http://localhost:4000/api/advisor/signals')
    .then(r => {
      if (!r.ok) throw new Error();
      return r.json();
    })
    .then(signals => {
      if (Array.isArray(signals)) {
        signals.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        loadedSignals = signals;
        populatePopupTickerFilter(signals);
      }
    })
    .catch(err => {
      console.warn("⚠️ Failed to sync journal with PostgreSQL in popup:", err);
    });
}

function renderActiveTrade(trade) {
  const wrap  = document.getElementById('activeTradePanelWrap');
  const panel = document.getElementById('activeTradePanel');

  if (!trade || (trade.status !== 'ACTIVE' && trade.status !== 'SANDBOX_ACTIVE')) {
    wrap.classList.remove('visible');
    return;
  }

  wrap.classList.add('visible');

  const isLong = trade.direction === 'LONG';

  // Panel colour
  panel.className = 'active-trade-panel ' + (isLong ? '' : 'short');

  // Badge / symbol / mode
  const badge = document.getElementById('atpBadge');
  badge.textContent  = trade.direction;
  badge.className    = 'atp-badge ' + (isLong ? 'long' : 'short');

  document.getElementById('atpSymbol').textContent = trade.symbol  || '—';
  document.getElementById('atpMode').textContent   = 'MONITORING';
  const pPrec = trade.pricePrecision !== undefined ? trade.pricePrecision : 2;
  document.getElementById('atpEntry').textContent  = trade.entry   ? `$${parseFloat(trade.entry).toFixed(pPrec)}`  : '—';
  document.getElementById('atpTarget').textContent = trade.target1 ? `$${parseFloat(trade.target1).toFixed(pPrec)}` : '—';
  document.getElementById('atpStop').textContent   = trade.stopLoss? `$${parseFloat(trade.stopLoss).toFixed(pPrec)}`: '—';

  chrome.storage.local.get({ enableTimeout: true, timeoutCandles: 12 }, (tItems) => {
    const limit = tItems.enableTimeout ? tItems.timeoutCandles : 12;
    document.getElementById('atpAge').textContent = trade.elapsedCandles != null ? `${trade.elapsedCandles}/${limit}` : '—';
  });

  document.getElementById('atpMarginRatio').textContent = '—';
  document.getElementById('atpLiqPrice').textContent   = '—';

  chrome.storage.local.get(null, (items) => {
    const isSand = trade.status === 'SANDBOX_ACTIVE' || (trade.status && trade.status.startsWith('SANDBOX_'));
    const marginMode = items.marginMode || 'ISOLATED';
    const activeWalletBalance = isSand ? (items.sandboxWalletBalance || 1000) : (items.walletBalance || 1000);

    const activeTradesList = [];
    for (const key in items) {
      if (key.startsWith('activeTrade_')) {
        const t = items[key];
        if (t && (t.status === 'ACTIVE' || t.status === 'SANDBOX_ACTIVE')) {
          const tSand = t.status === 'SANDBOX_ACTIVE' || (t.status && t.status.startsWith('SANDBOX_'));
          if (tSand === isSand) {
            activeTradesList.push(t);
          }
        }
      }
    }

    const priceUrl = `https://fapi.binance.com/fapi/v1/ticker/price`;
    fetch(priceUrl)
      .then(r => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .catch(() => {
        const spotUrl = `https://api.binance.com/api/v3/ticker/price`;
        return fetch(spotUrl).then(r => r.json());
      })
      .then(data => {
        const priceMap = {};
        data.forEach(item => {
          priceMap[item.symbol] = parseFloat(item.price);
        });

        const tick = priceMap[trade.symbol] || parseFloat(trade.entry) || 0;
        if (tick <= 0 || !trade.entry) {
          document.getElementById('atpPnl').textContent = 'Waiting for tick...';
          document.getElementById('atpPnl').style.color = 'var(--text-muted)';
          return;
        }

        const leverage = parseFloat(trade.leverage) || 3;
        const entry = parseFloat(trade.entry) || 0;
        const posSize = parseFloat(trade.positionSize) || 0;
        const direction = trade.direction;

        if (entry <= 0 || posSize <= 0 || leverage <= 0 || isNaN(entry) || isNaN(posSize) || isNaN(leverage)) {
          document.getElementById('atpPnl').textContent = '—';
          document.getElementById('atpMarginRatio').textContent = '0.00%';
          document.getElementById('atpLiqPrice').textContent = '—';
          return;
        }

        const pPrec = trade.pricePrecision !== undefined ? trade.pricePrecision : 2;
        document.getElementById('atpMarkPrice').textContent = `$${tick.toFixed(pPrec)}`;
        document.getElementById('atpSize').textContent = `${posSize} units`;

        const pnlPct = isLong
          ? ((tick - entry) / entry) * 100 * leverage
          : ((entry - tick) / entry) * 100 * leverage;

        const sizePct = isLong
          ? ((tick - entry) / entry) * 100
          : ((entry - tick) / entry) * 100;

        const pnlDollar = isLong
          ? (tick - entry) * posSize
          : (entry - tick) * posSize;

        const sign  = pnlPct >= 0 ? '+' : '';
        const sizeSign = sizePct >= 0 ? '+' : '';
        const color = pnlPct >= 0 ? 'var(--green)' : 'var(--red)';
        document.getElementById('atpPnl').textContent = `${sign}${pnlPct.toFixed(2)}% (ROE)  |  ${sizeSign}${sizePct.toFixed(2)}% (Size)  |  ${sign}$${pnlDollar.toFixed(2)}`;
        document.getElementById('atpPnl').style.color = color;

        if (marginMode === 'CROSS') {
          let totalUnrealizedPnl = 0;
          let totalMM = 0;
          const uPnLMap = {};
          const mmMap = {};

          activeTradesList.forEach(t => {
            const tTick = priceMap[t.symbol] || parseFloat(t.entry) || 0;
            const tEntry = parseFloat(t.entry) || 0;
            const tSize = parseFloat(t.positionSize) || 0;
            const tIsLong = t.direction === 'LONG';

            const uPnL = tIsLong
              ? (tTick - tEntry) * tSize
              : (tEntry - tTick) * tSize;

            const mm = tSize * tTick * 0.004;

            totalUnrealizedPnl += uPnL;
            totalMM += mm;
            uPnLMap[t.symbol] = uPnL;
            mmMap[t.symbol] = mm;
          });

          const marginBalance = activeWalletBalance + totalUnrealizedPnl;
          const marginRatio = marginBalance <= 0 ? 100 : Math.min((totalMM / marginBalance) * 100, 100);

          const uPnL_i = uPnLMap[trade.symbol] || 0;
          const MM_i = mmMap[trade.symbol] || 0;

          const otherUnrealizedPnl = totalUnrealizedPnl - uPnL_i;
          const otherMaintenanceMargin = totalMM - MM_i;

          let liqPrice = 0;
          if (posSize > 0) {
            if (isLong) {
              liqPrice = (entry - (activeWalletBalance + otherUnrealizedPnl - otherMaintenanceMargin) / posSize) / 0.996;
            } else {
              liqPrice = (entry + (activeWalletBalance + otherUnrealizedPnl - otherMaintenanceMargin) / posSize) / 1.004;
            }
          }

          const pPrec = trade.pricePrecision !== undefined ? trade.pricePrecision : 2;
          document.getElementById('atpMarginRatio').textContent = `${marginRatio.toFixed(2)}%`;
          document.getElementById('atpMarginRatio').style.color = marginRatio > 50 ? 'var(--red)' : marginRatio > 20 ? 'var(--accent)' : 'var(--green)';
          document.getElementById('atpLiqPrice').textContent = liqPrice > 0 ? `$${liqPrice.toFixed(pPrec)}` : '—';
        } else {
          // Isolated margin mode
          const marginRequired = (posSize * entry) / leverage;
          const marginBalance = marginRequired + pnlDollar;
          const maintenanceMargin = posSize * tick * 0.004;
          const marginRatio = marginBalance <= 0 ? 100 : Math.min((maintenanceMargin / marginBalance) * 100, 100);

          const liqPrice = isLong
            ? (entry * (1 - 1 / leverage)) / (1 - 0.004)
            : (entry * (1 + 1 / leverage)) / (1 + 0.004);

          const pPrec = trade.pricePrecision !== undefined ? trade.pricePrecision : 2;
          document.getElementById('atpMarginRatio').textContent = `${marginRatio.toFixed(2)}%`;
          document.getElementById('atpMarginRatio').style.color = marginRatio > 50 ? 'var(--red)' : marginRatio > 20 ? 'var(--accent)' : 'var(--green)';
          document.getElementById('atpLiqPrice').textContent = `$${liqPrice.toFixed(pPrec)}`;
        }
      })
      .catch((err) => {
        console.error("Popup price fetch error:", err);
        document.getElementById('atpPnl').textContent = 'Price error';
        document.getElementById('atpPnl').style.color = 'var(--text-muted)';
      });
  });
}

function markSynced() {
  const dot   = document.getElementById('syncDot');
  const label = document.getElementById('syncLabel');
  dot.className   = 'live-dot synced';
  label.textContent = 'Live';
  // Flash briefly
  setTimeout(() => { dot.className = 'live-dot'; }, 300);
  setTimeout(() => { dot.className = 'live-dot synced'; }, 600);
}

function cleanSymbol(raw) {
  if (!raw) return null;
  let clean = raw.trim().toUpperCase();
  // Remove common suffixes first
  clean = clean.replace(/_?PERP(ETUAL)?$/i, '')
               .replace(/\.P$/i, '')
               .replace(/_?COIN$/i, '')
               .replace(/_?QUARTERLY.*$/i, '');
  // Now remove non-alphanumeric
  clean = clean.replace(/[^A-Z0-9]/g, '');
  
  // Binance symbols usually end with USDT, BUSD, USDC, USD, etc.
  const match = clean.match(/^([A-Z0-9]+(USDT|BUSD|USDC|USD|TUSD|DAI|EUR|TRY|ETH|BTC))/);
  if (match) {
    return match[1];
  }
  
  // Fallback: if it's just alphanumeric and between 3 and 15 chars
  if (/^[A-Z0-9]{3,15}$/.test(clean)) {
    return clean;
  }
  return null;
}

// Parses active tab URL/title to detect the symbol
function getActiveTabSymbol(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url) {
      if (callback) callback(null);
      return;
    }
    try {
      const url = new URL(tab.url);
      const pathSegments = url.pathname.split('/');
      let lastSegment = pathSegments[pathSegments.length - 1] || "";
      lastSegment = lastSegment.split('?')[0].split('#')[0];
      const cleanedUrlSym = cleanSymbol(lastSegment);
      if (cleanedUrlSym) {
        if (callback) callback(cleanedUrlSym);
        return;
      }
      
      const title = tab.title;
      if (title) {
        const words = title.split(/[\s|\|\-\/\_]/);
        for (const word of words) {
          const cleanedWord = cleanSymbol(word);
          if (cleanedWord) {
            if (callback) callback(cleanedWord);
            return;
          }
        }
      }
    } catch (e) {
      console.error(e);
    }
    if (callback) callback(null);
  });
}

// Refreshes the rendering of active trade based on active tab symbol
function refreshPopupActiveTrade() {
  getActiveTabSymbol((symbol) => {
    if (!symbol) {
      renderActiveTrade(null);
      updatePopupEquity();
      return;
    }
    chrome.storage.local.get('activeTrade_' + symbol, (res) => {
      const trade = res['activeTrade_' + symbol] || null;
      renderActiveTrade(trade);
      updatePopupEquity();
    });
  });
}

// ── Boot ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const versionLabel = document.getElementById('popup-version-label');
  if (versionLabel) {
    versionLabel.textContent = 'v' + chrome.runtime.getManifest().version;
  }

  const riskAmountInput         = document.getElementById('riskAmount');
  const riskVal                 = document.getElementById('riskVal');
  const leverageInput           = document.getElementById('leverage');
  const levVal                  = document.getElementById('levVal');
  const enableSMCCheckbox       = document.getElementById('enableSMC');
  const enableTechnicalCheckbox = document.getElementById('enableTechnical');
  const enableAudioCheckbox     = document.getElementById('enableAudio');
  const enableAutoPilotCheckbox      = document.getElementById('enableAutoPilot');
  const enableCircuitBreakerCheckbox = document.getElementById('enableCircuitBreaker');
  const timeframeSelect         = document.getElementById('timeframe');
  const saveBtn                 = document.getElementById('saveBtn');
  const clearBtn                = document.getElementById('clearBtn');
  const statusMsg               = document.getElementById('statusMsg');

  // New config elements
  const sandboxCheckbox         = document.getElementById('enableSandbox');
  const sizeModeSelect          = document.getElementById('sizeMode');
  const tradeCapitalInput       = document.getElementById('tradeCapital');
  const capitalVal              = document.getElementById('capitalVal');
  const targetModeSelect        = document.getElementById('targetMode');
  const customTpInput           = document.getElementById('customTp');
  const customSlInput           = document.getElementById('customSl');
  const customTpSlModeSelect    = document.getElementById('customTpSlMode');

  const marginModeSelect        = document.getElementById('marginMode');
  const walletBalanceRange      = document.getElementById('walletBalanceRange');
  const walletBalanceVal        = document.getElementById('walletBalanceVal');
  const enableTimeoutCheckbox   = document.getElementById('enableTimeout');
  const timeoutCandlesInput     = document.getElementById('timeoutCandles');

  let loadedWalletBalance = 1000;
  let loadedSandboxWalletBalance = 1000;

  function updateSettingVisibility() {
    const sizeMode = sizeModeSelect.value;
    const targetMode = targetModeSelect.value;
    const marginMode = marginModeSelect.value;
    const enableTimeout = enableTimeoutCheckbox.checked;

    const riskGroup = document.getElementById('group-risk-amount');
    const capitalGroup = document.getElementById('group-trade-capital');
    const customTargetsGroup = document.getElementById('group-custom-targets');
    const walletBalanceGroup = document.getElementById('group-wallet-balance');
    const timeoutCandlesGroup = document.getElementById('group-timeout-candles');

    if (sizeMode === 'RISK') {
      if (riskGroup) riskGroup.style.display = 'block';
      if (capitalGroup) capitalGroup.style.display = 'none';
    } else {
      if (riskGroup) riskGroup.style.display = 'none';
      if (capitalGroup) capitalGroup.style.display = 'block';
    }

    if (targetMode === 'CUSTOM') {
      if (customTargetsGroup) customTargetsGroup.style.display = 'block';
    } else {
      if (customTargetsGroup) customTargetsGroup.style.display = 'none';
    }

    if (marginMode === 'CROSS') {
      if (walletBalanceGroup) walletBalanceGroup.style.display = 'block';
    } else {
      if (walletBalanceGroup) walletBalanceGroup.style.display = 'none';
    }

    if (enableTimeout) {
      if (timeoutCandlesGroup) timeoutCandlesGroup.style.display = 'block';
    } else {
      if (timeoutCandlesGroup) timeoutCandlesGroup.style.display = 'none';
    }
  }

  // Slider live displays
  riskAmountInput.addEventListener('input', () => { riskVal.textContent = `$${riskAmountInput.value}`; });
  leverageInput.addEventListener('input',   () => { levVal.textContent  = `${leverageInput.value}x`;  });
  tradeCapitalInput.addEventListener('input', () => { capitalVal.textContent = `$${tradeCapitalInput.value}`; });
  walletBalanceRange.addEventListener('input', () => { walletBalanceVal.textContent = `$${walletBalanceRange.value}`; });
  sizeModeSelect.addEventListener('change', updateSettingVisibility);
  targetModeSelect.addEventListener('change', updateSettingVisibility);
  marginModeSelect.addEventListener('change', () => {
    updateSettingVisibility();
    const isSandbox = sandboxCheckbox.checked;
    walletBalanceRange.value = isSandbox ? loadedSandboxWalletBalance : loadedWalletBalance;
    walletBalanceVal.textContent = `$${walletBalanceRange.value}`;
  });
  enableTimeoutCheckbox.addEventListener('change', updateSettingVisibility);
  sandboxCheckbox.addEventListener('change', () => {
    const isSandbox = sandboxCheckbox.checked;
    walletBalanceRange.value = isSandbox ? loadedSandboxWalletBalance : loadedWalletBalance;
    walletBalanceVal.textContent = `$${walletBalanceRange.value}`;
    updateJournalTitle(isSandbox);
  });

  // ── Load everything from storage ──
  chrome.storage.local.get({
    riskAmount:      20,
    leverage:        3,
    enableSMC:       true,
    enableTechnical: true,
    enableAudio:     true,
    enableAutoPilot:      false,
    enableCircuitBreaker: true,
    timeframe:       '5m',
    journalStats:    { wins: 0, losses: 0, timeouts: 0 },
    sandboxJournalStats: { wins: 0, losses: 0, timeouts: 0 },
    activeTrades:    {},
    sandboxMode:     false,
    sizeMode:        'RISK',
    tradeCapital:    100,
    targetMode:      'INDICATOR',
    customTakeProfit: 2.0,
    customStopLoss:  1.0,
    customTpSlMode:  'margin',
    marginMode:      'ISOLATED',
    walletBalance:   1000,
    sandboxWalletBalance: 1000,
    enableTimeout:   true,
    timeoutCandles:  12
  }, (items) => {
    riskAmountInput.value = items.riskAmount;
    riskVal.textContent   = `$${items.riskAmount}`;
    leverageInput.value   = items.leverage;
    levVal.textContent    = `${items.leverage}x`;
    enableSMCCheckbox.checked       = items.enableSMC;
    enableTechnicalCheckbox.checked = items.enableTechnical;
    enableAudioCheckbox.checked     = items.enableAudio;
    enableAutoPilotCheckbox.checked       = items.enableAutoPilot;
    enableCircuitBreakerCheckbox.checked  = items.enableCircuitBreaker !== false;
    timeframeSelect.value           = items.timeframe;

    sandboxCheckbox.checked = items.sandboxMode;
    sizeModeSelect.value = items.sizeMode;
    tradeCapitalInput.value = items.tradeCapital;
    capitalVal.textContent = `$${items.tradeCapital}`;
    targetModeSelect.value = items.targetMode;
    customTpInput.value = items.customTakeProfit;
    customSlInput.value = items.customStopLoss;
    if (customTpSlModeSelect) customTpSlModeSelect.value = items.customTpSlMode || 'margin';

    marginModeSelect.value = items.marginMode;
    loadedWalletBalance = items.walletBalance !== undefined ? items.walletBalance : 1000;
    loadedSandboxWalletBalance = items.sandboxWalletBalance !== undefined ? items.sandboxWalletBalance : 1000;
    walletBalanceRange.value = items.sandboxMode ? loadedSandboxWalletBalance : loadedWalletBalance;
    walletBalanceVal.textContent = `$${walletBalanceRange.value}`;
    enableTimeoutCheckbox.checked = items.enableTimeout;
    timeoutCandlesInput.value = items.timeoutCandles;

    updateSettingVisibility();

    const stats = items.sandboxMode 
      ? (items.sandboxJournalStats || { wins: 0, losses: 0, timeouts: 0 }) 
      : (items.journalStats || { wins: 0, losses: 0, timeouts: 0 });
    renderStats(stats);
    updateJournalTitle(items.sandboxMode);
    refreshPopupActiveTrade();

    syncJournalWithDatabase();
  });

  // ── Sessions (clock-driven, refresh every 30s) ──
  // Sessions refresh every 30s; IST clock ticks every second
  renderSessions();
  renderISTClock();
  setInterval(renderSessions, 30000);
  setInterval(renderISTClock, 1000);

  // ── Live sync via storage.onChanged ──────────────────
  // This fires the INSTANT content.js writes new data — no stale window ever.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;

    markSynced();

    chrome.storage.local.get(['sandboxMode', 'journalStats', 'sandboxJournalStats', 'walletBalance', 'sandboxWalletBalance'], (res) => {
      const isSandbox = res.sandboxMode || false;
      if (changes.journalStats || changes.sandboxJournalStats || changes.sandboxMode || changes.walletBalance || changes.sandboxWalletBalance) {
        const stats = isSandbox 
          ? (res.sandboxJournalStats || { wins: 0, losses: 0, timeouts: 0 }) 
          : (res.journalStats || { wins: 0, losses: 0, timeouts: 0 });
        renderStats(stats);
        updateJournalTitle(isSandbox);
      }
    });

    // Check if any activeTrade_<symbol> was updated
    let activeTradeChanged = false;
    for (const key in changes) {
      if (key.startsWith('activeTrade_')) {
        activeTradeChanged = true;
        break;
      }
    }

    if (activeTradeChanged) {
      refreshPopupActiveTrade();
    }

    // Settings updated from another source
    if (changes.riskAmount)    { riskAmountInput.value = changes.riskAmount.newValue;    riskVal.textContent = `$${changes.riskAmount.newValue}`; }
    if (changes.leverage)      { leverageInput.value   = changes.leverage.newValue;      levVal.textContent  = `${changes.leverage.newValue}x`;    }
    if (changes.enableSMC)       enableSMCCheckbox.checked       = changes.enableSMC.newValue;
    if (changes.enableTechnical) enableTechnicalCheckbox.checked = changes.enableTechnical.newValue;
    if (changes.enableAudio)     enableAudioCheckbox.checked     = changes.enableAudio.newValue;
    if (changes.enableAutoPilot)      enableAutoPilotCheckbox.checked      = changes.enableAutoPilot.newValue;
    if (changes.enableCircuitBreaker) enableCircuitBreakerCheckbox.checked = changes.enableCircuitBreaker.newValue;
    if (changes.timeframe)       timeframeSelect.value           = changes.timeframe.newValue;
    if (changes.customTpSlMode)  { if (customTpSlModeSelect) customTpSlModeSelect.value = changes.customTpSlMode.newValue; }

    if (changes.walletBalance) {
      loadedWalletBalance = changes.walletBalance.newValue;
      if (!sandboxCheckbox.checked) {
        walletBalanceRange.value = loadedWalletBalance;
        walletBalanceVal.textContent = `$${loadedWalletBalance}`;
      }
    }
    if (changes.sandboxWalletBalance) {
      loadedSandboxWalletBalance = changes.sandboxWalletBalance.newValue;
      if (sandboxCheckbox.checked) {
        walletBalanceRange.value = loadedSandboxWalletBalance;
        walletBalanceVal.textContent = `$${loadedSandboxWalletBalance}`;
      }
    }
    if (changes.marginMode) {
      marginModeSelect.value = changes.marginMode.newValue;
      updateSettingVisibility();
    }
    if (changes.enableTimeout) {
      enableTimeoutCheckbox.checked = changes.enableTimeout.newValue;
      updateSettingVisibility();
    }
    if (changes.timeoutCandles) {
      timeoutCandlesInput.value = changes.timeoutCandles.newValue;
    }

    if (changes.sandboxMode) {
      sandboxCheckbox.checked = changes.sandboxMode.newValue;
      updateJournalTitle(changes.sandboxMode.newValue);
      walletBalanceRange.value = changes.sandboxMode.newValue ? loadedSandboxWalletBalance : loadedWalletBalance;
      walletBalanceVal.textContent = `$${walletBalanceRange.value}`;
    }
    if (changes.sizeMode) {
      sizeModeSelect.value = changes.sizeMode.newValue;
      updateSettingVisibility();
    }
    if (changes.tradeCapital) {
      tradeCapitalInput.value = changes.tradeCapital.newValue;
      capitalVal.textContent = `$${changes.tradeCapital.newValue}`;
    }
    if (changes.targetMode) {
      targetModeSelect.value = changes.targetMode.newValue;
      updateSettingVisibility();
    }
    if (changes.customTakeProfit) {
      customTpInput.value = changes.customTakeProfit.newValue;
    }
    if (changes.customStopLoss) {
      customSlInput.value = changes.customStopLoss.newValue;
    }
  });

  // Refresh PnL every 2s while popup is open (tick price updates)
  setInterval(() => {
    refreshPopupActiveTrade();
  }, 2000);

  // ── Save settings ──
  saveBtn.addEventListener('click', () => {
    const isSandbox = sandboxCheckbox.checked;
    const newSettings = {
      riskAmount:      parseInt(riskAmountInput.value),
      leverage:        parseInt(leverageInput.value),
      enableSMC:       enableSMCCheckbox.checked,
      enableTechnical: enableTechnicalCheckbox.checked,
      enableAudio:     enableAudioCheckbox.checked,
      enableAutoPilot:      enableAutoPilotCheckbox.checked,
      enableCircuitBreaker: enableCircuitBreakerCheckbox.checked,
      timeframe:       timeframeSelect.value,
      sandboxMode:     isSandbox,
      sizeMode:        sizeModeSelect.value,
      tradeCapital:    parseInt(tradeCapitalInput.value),
      targetMode:      targetModeSelect.value,
      customTakeProfit: parseFloat(customTpInput.value),
      customStopLoss:  parseFloat(customSlInput.value),
      customTpSlMode:  customTpSlModeSelect ? customTpSlModeSelect.value : 'margin',
      marginMode:      marginModeSelect.value,
      enableTimeout:   enableTimeoutCheckbox.checked,
      timeoutCandles:  parseInt(timeoutCandlesInput.value)
    };

    if (isSandbox) {
      newSettings.sandboxWalletBalance = parseFloat(walletBalanceRange.value);
      newSettings.walletBalance = loadedWalletBalance;
      loadedSandboxWalletBalance = newSettings.sandboxWalletBalance;
    } else {
      newSettings.walletBalance = parseFloat(walletBalanceRange.value);
      newSettings.sandboxWalletBalance = loadedSandboxWalletBalance;
      loadedWalletBalance = newSettings.walletBalance;
    }

    chrome.storage.local.set(newSettings, () => {
      statusMsg.textContent = '✅ Configurations Applied!';
      setTimeout(() => { statusMsg.textContent = ''; }, 2000);

      updateJournalTitle(newSettings.sandboxMode);
      chrome.storage.local.get(['journalStats', 'sandboxJournalStats'], (res) => {
        const stats = newSettings.sandboxMode 
          ? (res.sandboxJournalStats || { wins: 0, losses: 0, timeouts: 0 }) 
          : (res.journalStats || { wins: 0, losses: 0, timeouts: 0 });
        renderStats(stats);
      });

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'UPDATE_SETTINGS', settings: newSettings }).catch(() => {});
        }
      });
    });
  });

  // ── Clear journal ──
  clearBtn.addEventListener('click', () => {
    if (!confirm('Reset all trade history metrics?')) return;
    chrome.runtime.sendMessage({ type: 'CLEAR_JOURNAL' }, (response) => {
      if (response && response.success) {
        statusMsg.textContent = '🗑️ Trade Journal Reset!';
        setTimeout(() => { statusMsg.textContent = ''; }, 2000);
        syncJournalWithDatabase();
      }
    });
  });

  // ── Open Dashboard ──
  const openDashboardBtn = document.getElementById('openDashboardBtn');
  if (openDashboardBtn) {
    openDashboardBtn.addEventListener('click', () => {
      const dashboardUrl = chrome.runtime.getURL('dashboard.html');
      chrome.tabs.query({ url: dashboardUrl }, (tabs) => {
        if (tabs && tabs.length > 0) {
          chrome.tabs.update(tabs[0].id, { active: true });
          chrome.windows.update(tabs[0].windowId, { focused: true });
        } else {
          chrome.tabs.create({ url: dashboardUrl });
        }
      });
    });
  }

  // ── Ticker Filter Change listener ──
  const popupTickerFilter = document.getElementById('popupTickerFilter');
  if (popupTickerFilter) {
    popupTickerFilter.addEventListener('change', (e) => {
      popupTickerFilter.dataset.userHasSelected = "true";
      popupTickerFilter.dataset.userVal = e.target.value;
      recalculateFilteredStats();
    });
  }
});
