/**
 * Binance Futures Real-Time Advisor - Stateless HUD Overlay
 * Responsible solely for UI rendering, drag interactions, audio synthesis, and event forwarding.
 * Zero math calculations, zero direct WebSockets, zero local database updates.
 */

(function () {
  console.log("⚡ Antigravity Stateless Content HUD Overlay Loaded!");

  // --- STATE VARIABLES ---
  let activeSymbol = "";
  let settings = {
    riskAmount: 20,
    leverage: 3,
    enableSMC: true,
    enableTechnical: true,
    enableAudio: true,
    enableAutoPilot: false,
    enableCircuitBreaker: true,
    timeframe: "5m",
    alertPhone: ""
  };

  let candles = [];
  let currentTickPrice = 0;
  let activeTrade = null;
  let advisorMode = "HUNTING";
  let closeSignal = { active: false, confidence: 0, reason: "", triggerCatalyst: "" };
  let currentSignal = {
    direction: "WAITING",
    probability: 50,
    entry: 0,
    stopLoss: 0,
    target1: 0,
    target2: 0,
    positionSize: 0,
    marginRequired: 0,
    patternName: "Scanning",
    confidenceBreakdown: { trend: 0, smc: 0, momentum: 0 },
    reason: "Awaiting high-probability conditions...",
    triggerCatalyst: ""
  };

  let lastIndicatorStates = { rsi: 50, ema9: 0, ema21: 0, bullishOB: 0, bearishOB: 0 };
  let symbolPrecisions = {};
  let lastSpokenTime = 0;
  const SPEECH_COOLDOWN_MS = 120000;

  // --- DOM HUD ELEMENTS ---
  let hudRoot = null;
  let isMinimized = false;
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };

  // --- INITIALIZATION ---
  function loadSettings(callback) {
    chrome.storage.local.get(null, (items) => {
      const keys = [
        "timeframe", "leverage", "triggerThreshold", "customStopLoss", 
        "customTakeProfit", "targetMode", "customTpSlMode", "enableTechnical", 
        "enableSMC", "enableCircuitBreaker", "enableAudio", "enableAutoPilot", 
        "sandboxMode", "alertPhone", "riskAmount", "tradeCapital", 
        "marginMode", "walletBalance", "sandboxWalletBalance", "enableTimeout", 
        "timeoutCandles"
      ];
      keys.forEach(k => {
        if (items[k] !== undefined) {
          settings[k] = items[k];
        }
      });
      if (callback) callback();
    });
  }

  // --- COMMUNICATIONS & MESSAGE LISTENERS ---
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!isContextValid()) return;

    if (request.type === "HUD_UPDATE") {
      if (request.symbol === activeSymbol) {
        processHUDUpdate(request.payload);
      }
    } else if (request.type === "PLAY_AUDIO") {
      const payload = request.payload;
      if (settings.enableAudio) {
        if (payload.type === 'SOUND') {
          playSyntheticSound(payload.sound);
        } else if (payload.type === 'ENTRY') {
          const now = Date.now();
          if (now - lastSpokenTime >= SPEECH_COOLDOWN_MS) {
            playSyntheticSound('SETUP_ALERT');
            const speech = new SpeechSynthesisUtterance(payload.text);
            speech.rate = 0.95;
            window.speechSynthesis.speak(speech);
            lastSpokenTime = now;
          }
        }
      }
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let needsUpdate = false;
    const keys = [
      "timeframe", "leverage", "triggerThreshold", "customStopLoss", 
      "customTakeProfit", "targetMode", "customTpSlMode", "enableTechnical", 
      "enableSMC", "enableCircuitBreaker", "enableAudio", "enableAutoPilot", 
      "sandboxMode", "alertPhone", "riskAmount", "tradeCapital", 
      "marginMode", "enableTimeout", "timeoutCandles"
    ];
    keys.forEach(k => {
      if (changes[k]) {
        settings[k] = changes[k].newValue;
        needsUpdate = true;
      }
    });

    if (needsUpdate) {
      updateHUDSettingsDisplay();
      requestInitialHUDData();
    }
  });

  function processHUDUpdate(payload) {
    if (!payload) return;
    candles = payload.candles || [];
    lastIndicatorStates = payload.lastIndicatorStates || lastIndicatorStates;
    currentSignal = payload.currentSignal || currentSignal;
    closeSignal = payload.closeSignal || closeSignal;
    activeTrade = payload.activeTrade || null;
    advisorMode = payload.advisorMode || "HUNTING";
    
    if (payload.journalStats) {
      // Sync from DB stats sent by SW
      window._dbWins = payload.journalStats.wins;
      window._dbLosses = payload.journalStats.losses;
      window._dbTimeouts = payload.journalStats.timeouts;
    }
    if (payload.sandboxJournalStats) {
      window._sbWins = payload.sandboxJournalStats.wins;
      window._sbLosses = payload.sandboxJournalStats.losses;
      window._sbTimeouts = payload.sandboxJournalStats.timeouts;
    }

    if (candles.length > 0) {
      currentTickPrice = candles[candles.length - 1].close;
    }
    if (payload.symbolPrecisions) {
      symbolPrecisions[activeSymbol] = payload.symbolPrecisions;
    }

    updateHUDContent(lastIndicatorStates);
    updateHUDStatus(false, "Live ✅");
  }

  function requestInitialHUDData() {
    if (!activeSymbol) return;
    updateHUDStatus(true, "Connecting...");
    chrome.runtime.sendMessage({ type: "GET_HUD_DATA", symbol: activeSymbol }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response && response.success && response.data) {
        processHUDUpdate(response.data);
      } else {
        updateHUDStatus(true, "Waiting for ticks...");
      }
    });
  }

  // --- ACTIONS FORWARDERS ---
  function markUserActionTaken() {
    chrome.runtime.sendMessage({ type: "ACTION_TAKEN", symbol: activeSymbol });
  }

  function manuallyCloseActiveTrade() {
    chrome.runtime.sendMessage({ type: "MANUAL_CLOSE_TRADE", symbol: activeSymbol });
  }

  function toggleAutoPilotMode() {
    settings.enableAutoPilot = !settings.enableAutoPilot;
    chrome.storage.local.set({ enableAutoPilot: settings.enableAutoPilot }, () => {
      updateAutoPilotHUDDisplay();
    });
  }

  // --- SYMBOL DETECTION ---
  function cleanSymbol(raw) {
    if (!raw) return null;
    let clean = raw.trim().toUpperCase();
    clean = clean.replace(/_?PERP(ETUAL)?$/i, '')
                 .replace(/\.P$/i, '')
                 .replace(/_?COIN$/i, '')
                 .replace(/_?QUARTERLY.*$/i, '');
    clean = clean.replace(/[^A-Z0-9]/g, '');
    
    const match = clean.match(/^([A-Z0-9]+(USDT|BUSD|USDC|USD|TUSD|DAI|EUR|TRY|ETH|BTC))/);
    if (match) return match[1];
    if (/^[A-Z0-9]{3,15}$/.test(clean)) return clean;
    return null;
  }

  function detectSymbolFromPage() {
    const pathSegments = window.location.pathname.split('/');
    let lastSegment = pathSegments[pathSegments.length - 1] || "";
    lastSegment = lastSegment.split('?')[0].split('#')[0];
    const cleanedUrlSym = cleanSymbol(lastSegment);
    if (cleanedUrlSym) return cleanedUrlSym;

    const title = document.title;
    if (title) {
      const words = title.split(/[\s|\|\-\/\_]/);
      for (const word of words) {
        const cleanedWord = cleanSymbol(word);
        if (cleanedWord) return cleanedWord;
      }
    }

    const tickerEl = document.querySelector('.symbol-name');
    if (tickerEl) {
      const cleanedDOMSym = cleanSymbol(tickerEl.textContent);
      if (cleanedDOMSym) return cleanedDOMSym;
    }
    return null;
  }

  function startSymbolDetectionLoop() {
    setInterval(() => {
      if (!isContextValid()) return;
      const detected = detectSymbolFromPage();
      if (detected && detected !== activeSymbol) {
        console.log(`🎯 Active symbol changed to: ${detected}`);
        activeSymbol = detected;
        candles = [];
        currentTickPrice = 0;
        activeTrade = null;
        requestInitialHUDData();
      }
    }, 1500);
  }

  // --- UI RENDER HELPERS ---
  function formatPrice(val) {
    const num = parseFloat(val);
    if (isNaN(num)) return "0.00";
    const prec = symbolPrecisions[activeSymbol];
    const pPrec = prec !== undefined ? prec.pricePrecision : 2;
    return num.toFixed(pPrec);
  }

  function isContextValid() {
    return typeof chrome !== 'undefined' && chrome.runtime && !!chrome.runtime.id;
  }

  // --- DOM INJECTION & HUD UI MANAGEMENT ---
  function injectHUD() {
    if (document.getElementById("antigravity-hud-root")) return;

    hudRoot = document.createElement("div");
    hudRoot.id = "antigravity-hud-root";
    hudRoot.innerHTML = `
      <div id="agy-hud-maximized">
        <div class="agy-header" id="agy-drag-handle">
          <div class="agy-title-container">
            <span class="agy-logo">⚡</span>
            <span class="agy-text-title">ANTIGRAVITY TICKER HUD OVERLAY</span>
            <span class="agy-active-pair" id="agy-pair-label">USDT</span>
            <span class="agy-mode-badge hunting" id="agy-mode-indicator">HUNTING</span>
            <span class="agy-auto-badge auto-off" id="agy-auto-indicator" style="cursor: pointer; font-size: 8px !important; font-weight: 800 !important; padding: 2px 5px !important; border-radius: 4px !important; text-transform: uppercase !important; display: inline-block !important; letter-spacing: 0.5px !important;" title="Click to Toggle Auto-Pilot">🤖 AUTO: OFF</span>
          </div>
          <div class="agy-controls">
            <button class="agy-btn" id="agy-btn-dashboard" title="Open Control Room" style="margin-right: 6px; font-size: 11px;">🎛️</button>
            <button class="agy-btn" id="agy-btn-minimize" title="Minimize">➖</button>
          </div>
        </div>

        <div class="agy-body">
          <!-- Large Flashing Warning Banner -->
          <div id="agy-flash-warning" class="agy-flash-alert" style="display: none;"></div>

          <!-- Dial -->
          <div class="agy-gauge-section">
            <div class="agy-gauge-wrapper">
              <div class="agy-gauge-bg"></div>
              <div class="agy-gauge-fill" id="agy-probability-fill"></div>
              <div class="agy-gauge-value" id="agy-probability-val">50%</div>
            </div>
            <div class="agy-gauge-label" id="agy-bias-label">Neutral Bias</div>
            <div id="agy-pattern-text" style="font-size: 11px; font-weight: 700; color: #fff; margin-top: 5px;">Scanning Markets</div>
          </div>

          <!-- Live Trade Monitor Overlay -->
          <div id="agy-live-monitor-box" style="display:none; background: rgba(24, 26, 32, 0.7); border: 1px solid rgba(240, 185, 11, 0.4); border-radius: 8px; padding: 10px; margin-bottom: 12px; transition: opacity 0.3s ease;">
            <div style="display:flex; justify-content:space-between; font-size: 10px; font-weight: 800; color: #f0b90b; margin-bottom: 6px; text-transform: uppercase;">
              <span>📈 Live Tracker Active</span>
              <span id="agy-track-time">Age: 0 candles</span>
            </div>
            <div class="agy-trade-levels" id="agy-track-levels"></div>
            <div id="agy-btn-action-container"></div>
          </div>

          <!-- Indicators grid -->
          <div class="agy-indicator-grid">
            <div class="agy-ind-card">
              <span class="agy-ind-name">Timeframe</span>
              <span class="agy-ind-val" id="agy-ind-tf">5m</span>
            </div>
            <div class="agy-ind-card">
              <span class="agy-ind-name">RSI (14)</span>
              <span class="agy-ind-val">
                <span class="agy-dot" id="agy-dot-rsi" style="color: #848e9c;"></span>
                <span id="agy-val-rsi">--</span>
              </span>
            </div>
            <div class="agy-ind-card">
              <span class="agy-ind-name">EMA Conf</span>
              <span class="agy-ind-val">
                <span class="agy-dot" id="agy-dot-ema" style="color: #848e9c;"></span>
                <span id="agy-val-ema">--</span>
              </span>
            </div>
            <div class="agy-ind-card">
              <span class="agy-ind-name" id="agy-ledger-title">Postgres Ledger</span>
              <span class="agy-ind-val" style="color: #fff; font-family: monospace;">
                <span id="agy-val-wins" style="color: #2ebd85;">0</span>/
                <span id="agy-val-losses" style="color: #f6465d;">0</span>/
                <span id="agy-val-timeouts" style="color: #848e9c;">0</span>
              </span>
            </div>
          </div>

          <!-- Trade recommendation box -->
          <div class="agy-trade-box" id="agy-trade-recommendation-box" style="transition: opacity 0.3s ease;">
            <div class="agy-trade-badge" id="agy-trade-badge">No Setup</div>
            <div class="agy-trade-title">Futures Recommendation</div>
            <div class="agy-trade-levels" id="agy-trade-levels">
              <div class="agy-lvl-item">
                <span class="agy-lvl-name">Status</span>
                <span class="agy-lvl-val" style="color: #848e9c;" id="agy-rec-status">Scanning...</span>
              </div>
            </div>
          </div>
        </div>

        <div class="agy-footer">
          <div class="agy-status">
            <span class="agy-status-dot" id="agy-status-indicator"></span>
            <span id="agy-status-text">Connecting...</span>
          </div>
          <div>SMC DB Synced HUD v${chrome.runtime.getManifest().version}</div>
        </div>
      </div>

      <!-- Minimized -->
      <div id="agy-hud-minimized" style="display: none;">
        <div class="agy-minimized-icon">⚡</div>
      </div>
    `;

    document.body.appendChild(hudRoot);

    const header = document.getElementById("agy-drag-handle");
    header.addEventListener("mousedown", onDragStart);
    document.addEventListener("mousemove", onDragging);
    document.addEventListener("mouseup", onDragEnd);

    document.getElementById("agy-btn-minimize").addEventListener("click", toggleMinimize);
    document.getElementById("agy-hud-minimized").addEventListener("click", toggleMinimize);
    document.getElementById("agy-btn-dashboard").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "OPEN_DASHBOARD" });
    });

    hudRoot.addEventListener("click", (e) => {
      if (e.target && e.target.id === "agy-btn-action-taken") {
        markUserActionTaken();
      } else if (e.target && e.target.id === "agy-btn-close-position") {
        manuallyCloseActiveTrade();
      } else if (e.target && e.target.id === "agy-auto-indicator") {
        toggleAutoPilotMode();
      }
    });

    chrome.storage.local.get({ hudPos: { top: 70, right: 20 } }, (items) => {
      hudRoot.style.top = `${items.hudPos.top}px`;
      hudRoot.style.right = `${items.hudPos.right}px`;
      hudRoot.style.left = "auto";
      updateAutoPilotHUDDisplay();
    });
  }

  // --- DRAGGING INTERACTION ---
  function onDragStart(e) {
    if (e.target.closest(".agy-btn")) return;
    isDragging = true;
    hudRoot.classList.add("agy-dragging");
    const rect = hudRoot.getBoundingClientRect();
    dragOffset.x = e.clientX - rect.left;
    dragOffset.y = e.clientY - rect.top;
  }

  function onDragging(e) {
    if (!isDragging) return;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let newLeft = e.clientX - dragOffset.x;
    let newTop = e.clientY - dragOffset.y;

    newLeft = Math.max(10, Math.min(newLeft, viewportWidth - hudRoot.offsetWidth - 10));
    newTop = Math.max(10, Math.min(newTop, viewportHeight - hudRoot.offsetHeight - 10));

    hudRoot.style.left = `${newLeft}px`;
    hudRoot.style.top = `${newTop}px`;
    hudRoot.style.right = "auto";
  }

  function onDragEnd() {
    if (!isDragging) return;
    isDragging = false;
    hudRoot.classList.remove("agy-dragging");
    const rect = hudRoot.getBoundingClientRect();
    chrome.storage.local.set({
      hudPos: { top: rect.top, right: window.innerWidth - rect.right }
    });
  }

  function toggleMinimize() {
    isMinimized = !isMinimized;
    const maxView = document.getElementById("agy-hud-maximized");
    const minView = document.getElementById("agy-hud-minimized");

    if (isMinimized) {
      hudRoot.classList.add("minimized");
      maxView.style.display = "none";
      minView.style.display = "flex";
      hudRoot.style.height = "48px";
      hudRoot.style.width = "48px";
    } else {
      hudRoot.classList.remove("minimized");
      maxView.style.display = "block";
      minView.style.display = "none";
      hudRoot.style.height = "auto";
      hudRoot.style.width = "320px";
    }
  }

  function updateAutoPilotHUDDisplay() {
    const autoEl = document.getElementById("agy-auto-indicator");
    if (!autoEl) return;
    if (settings.enableAutoPilot) {
      autoEl.textContent = "🤖 AUTO: ON";
      autoEl.className = "agy-auto-badge auto-on";
    } else {
      autoEl.textContent = "🤖 AUTO: OFF";
      autoEl.className = "agy-auto-badge auto-off";
    }
  }

  function updateHUDSettingsDisplay() {
    const tfEl = document.getElementById("agy-ind-tf");
    if (tfEl) tfEl.textContent = settings.timeframe;
    updateAutoPilotHUDDisplay();
  }

  function updateHUDStatus(isLoading, labelText = "Streaming Live") {
    const dotEl = document.getElementById("agy-status-indicator");
    const textEl = document.getElementById("agy-status-text");
    if (!dotEl || !textEl) return;
    dotEl.className = isLoading ? "agy-status-dot loading" : "agy-status-dot live";
    textEl.textContent = labelText;
  }

  function updateHUDLivePrice() {
    const pairEl = document.getElementById("agy-pair-label");
    if (pairEl && activeSymbol) {
      pairEl.textContent = `${activeSymbol} $${currentTickPrice > 0 ? currentTickPrice.toFixed(2) : "---"}`;
    }
  }

  // --- REAL-TIME UPDATES ROUTINE ---
  function updateHUDContent(indicators) {
    updateHUDLivePrice();

    const fillEl = document.getElementById("agy-probability-fill");
    const valEl = document.getElementById("agy-probability-val");
    const biasEl = document.getElementById("agy-bias-label");
    const patternEl = document.getElementById("agy-pattern-text");
    const modeBadgeEl = document.getElementById("agy-mode-indicator");

    if (modeBadgeEl) {
      modeBadgeEl.textContent = advisorMode;
      modeBadgeEl.className = advisorMode === "MONITORING" ? "agy-mode-badge monitoring" : "agy-mode-badge hunting";
    }

    let calculatedOpacity = 1.0;

    if (activeTrade && (activeTrade.status === "ACTIVE" || activeTrade.status === "SANDBOX_ACTIVE")) {
      const limit = settings.enableTimeout !== false ? (settings.timeoutCandles !== undefined ? settings.timeoutCandles : 12) : 12;
      const timeOpacity = Math.max(0.0, 1 - (activeTrade.elapsedCandles / limit));
      const initialDistance = Math.abs(activeTrade.entry - activeTrade.stopLoss);
      const currentDistance = Math.abs(currentTickPrice - activeTrade.stopLoss);

      let priceOpacity = 1.0;
      if (activeTrade.direction === "LONG" && currentTickPrice < activeTrade.entry) {
        priceOpacity = initialDistance > 0 ? currentDistance / initialDistance : 1;
      } else if (activeTrade.direction === "SHORT" && currentTickPrice > activeTrade.entry) {
        priceOpacity = initialDistance > 0 ? currentDistance / initialDistance : 1;
      }
      calculatedOpacity = Math.max(0.15, Math.min(timeOpacity, priceOpacity));
    }

    if (fillEl && valEl && biasEl && patternEl) {
      let probabilityVal = currentSignal.probability;
      if (currentSignal.direction === "SHORT") {
        probabilityVal = 100 - probabilityVal;
      } else if (currentSignal.direction === "WAITING") {
        probabilityVal = 50;
      }

      const rotation = -45 + (probabilityVal / 100) * 180;
      fillEl.style.transform = `rotate(${rotation}deg)`;
      valEl.textContent = `${currentSignal.probability}%`;
      patternEl.textContent = currentSignal.patternName;

      if (currentSignal.direction === "LONG") {
        biasEl.textContent = "Strong Bullish Setup";
        biasEl.style.color = "#2ebd85";
        fillEl.style.borderLeftColor = "#2ebd85";
        fillEl.style.borderBottomColor = "#2ebd85";
      } else if (currentSignal.direction === "SHORT") {
        biasEl.textContent = "Strong Bearish Setup";
        biasEl.style.color = "#f6465d";
        fillEl.style.borderLeftColor = "#f6465d";
        fillEl.style.borderBottomColor = "#f6465d";
      } else {
        biasEl.textContent = "Neutral Market Bias";
        biasEl.style.color = "#848e9c";
      }
    }

    const recommendationBox = document.getElementById("agy-trade-recommendation-box");
    const activeMonitorBox = document.getElementById("agy-live-monitor-box");

    if (recommendationBox) {
      recommendationBox.style.opacity = calculatedOpacity;
      recommendationBox.style.display = advisorMode === "MONITORING" ? "none" : "block";
    }
    if (activeMonitorBox) {
      activeMonitorBox.style.opacity = calculatedOpacity;
      activeMonitorBox.style.display = advisorMode === "MONITORING" ? "block" : "none";
    }

    // Flashing Warning Banner
    const flashEl = document.getElementById("agy-flash-warning");
    if (flashEl) {
      if (advisorMode === "MONITORING" && closeSignal.active && closeSignal.confidence === 100) {
        flashEl.style.display = "block";
        flashEl.className = "agy-flash-alert bearish";
        flashEl.innerHTML = `⚠️ CLOSE POSITION NOW! (100% Conf)`;
      } else if (advisorMode === "HUNTING" && currentSignal.direction === "LONG" && currentSignal.probability === 100) {
        flashEl.style.display = "block";
        flashEl.className = "agy-flash-alert bullish";
        flashEl.innerHTML = `🚀 BUY NOW! (100% Conf)`;
      } else if (advisorMode === "HUNTING" && currentSignal.direction === "SHORT" && currentSignal.probability === 100) {
        flashEl.style.display = "block";
        flashEl.className = "agy-flash-alert bearish";
        flashEl.innerHTML = `💥 SELL NOW! (100% Conf)`;
      } else {
        flashEl.style.display = "none";
      }
    }

    // Update Indicators text values
    const rsiValEl = document.getElementById("agy-val-rsi");
    const rsiDotEl = document.getElementById("agy-dot-rsi");
    const emaValEl = document.getElementById("agy-val-ema");
    const emaDotEl = document.getElementById("agy-dot-ema");

    if (rsiValEl && rsiDotEl) {
      rsiValEl.textContent = indicators.rsi;
      rsiDotEl.style.color = indicators.rsi < 32 ? "#2ebd85" : indicators.rsi > 68 ? "#f6465d" : "#f0b90b";
    }

    if (emaValEl && emaDotEl) {
      const isBull = currentTickPrice > indicators.ema21;
      emaValEl.textContent = isBull ? "BULL" : "BEAR";
      emaDotEl.style.color = isBull ? "#2ebd85" : "#f6465d";
    }

    // Update Journal Ledger
    const winsEl = document.getElementById("agy-val-wins");
    const lossesEl = document.getElementById("agy-val-losses");
    const timeoutsEl = document.getElementById("agy-val-timeouts");
    const ledgerTitleEl = document.getElementById("agy-ledger-title");

    if (winsEl && lossesEl && timeoutsEl) {
      const wins = settings.sandboxMode ? (window._sbWins || 0) : (window._dbWins || 0);
      const losses = settings.sandboxMode ? (window._sbLosses || 0) : (window._dbLosses || 0);
      const timeouts = settings.sandboxMode ? (window._sbTimeouts || 0) : (window._dbTimeouts || 0);
      winsEl.textContent = wins;
      lossesEl.textContent = losses;
      timeoutsEl.textContent = timeouts;
    }
    if (ledgerTitleEl) {
      ledgerTitleEl.textContent = settings.sandboxMode ? "Sandbox Ledger" : "Postgres Ledger";
    }

    // Active Monitor layout
    const monitorTime = document.getElementById("agy-track-time");
    const monitorLevels = document.getElementById("agy-track-levels");
    const actionBtnContainer = document.getElementById("agy-btn-action-container");

    if (activeMonitorBox && monitorTime && monitorLevels && actionBtnContainer) {
      if (activeTrade && (activeTrade.status === "ACTIVE" || activeTrade.status === "SANDBOX_ACTIVE")) {
        const limit = settings.enableTimeout !== false ? (settings.timeoutCandles !== undefined ? settings.timeoutCandles : 12) : 12;
        monitorTime.textContent = `Age: ${activeTrade.elapsedCandles || 0}/${limit} candles`;

        const sideColor = activeTrade.direction === "LONG" ? "#2ebd85" : "#f6465d";
        const leverage = parseFloat(activeTrade.leverage) || parseFloat(settings.leverage) || 3;
        const currentPnlPercent = activeTrade.direction === "LONG"
          ? ((currentTickPrice - activeTrade.entry) / activeTrade.entry) * 100 * leverage
          : ((activeTrade.entry - currentTickPrice) / activeTrade.entry) * 100 * leverage;
        const sizePercent = activeTrade.direction === "LONG"
          ? ((currentTickPrice - activeTrade.entry) / activeTrade.entry) * 100
          : ((activeTrade.entry - currentTickPrice) / activeTrade.entry) * 100;
        const pnlDollar = activeTrade.direction === "LONG"
          ? (currentTickPrice - activeTrade.entry) * (activeTrade.positionSize || 0)
          : (activeTrade.entry - currentTickPrice) * (activeTrade.positionSize || 0);

        const decayWarning = calculatedOpacity < 0.4 ? "color: #f6465d; font-weight: 900;" : "";

        let adverseWarningHtml = "";
        if (closeSignal.active) {
          const warningConfColor = closeSignal.confidence >= 80 ? "#f6465d" : "#f0b90b";
          adverseWarningHtml = `
            <div style="margin-top: 8px; padding: 6px; background: rgba(246, 70, 93, 0.12); border: 1px solid rgba(246, 70, 93, 0.4); border-radius: 4px; font-size: 9px; color: ${warningConfColor}; font-weight: 800; text-align: center; text-transform: uppercase;">
              ⚠️ Exit Warning: ${closeSignal.reason} (${closeSignal.confidence}% Conf)
            </div>
          `;
        }

        monitorLevels.innerHTML = `
          <div class="agy-lvl-item">
            <span class="agy-lvl-name">Position</span>
            <span class="agy-lvl-val" style="color: ${sideColor};">${activeTrade.direction} (${activeTrade.pattern})</span>
          </div>
          <div class="agy-lvl-item">
            <span class="agy-lvl-name">Unrealized PnL</span>
            <span class="agy-lvl-val" style="color: ${currentPnlPercent >= 0 ? "#2ebd85" : "#f6465d"}; font-family: monospace; font-weight: 900;">
              ${currentPnlPercent >= 0 ? "+" : ""}${currentPnlPercent.toFixed(2)}% (ROE) &nbsp;|&nbsp; ${sizePercent >= 0 ? "+" : ""}${sizePercent.toFixed(2)}% (Size) &nbsp;|&nbsp; ${pnlDollar >= 0 ? "+" : ""}$${pnlDollar.toFixed(2)}
            </span>
          </div>
          <div class="agy-lvl-item">
            <span class="agy-lvl-name">Target Level</span>
            <span class="agy-lvl-val" style="color: #2ebd85; font-family: monospace;">${formatPrice(activeTrade.target1)}</span>
          </div>
          <div class="agy-lvl-item">
            <span class="agy-lvl-name">Liquidation Stop</span>
            <span class="agy-lvl-val" style="color: #f6465d; font-family: monospace;">${formatPrice(activeTrade.stopLoss)}</span>
          </div>
          <div class="agy-lvl-item" style="border-top: 1px dashed rgba(240, 185, 11, 0.2); padding-top: 4px; margin-top: 4px;">
            <span class="agy-lvl-name" style="${decayWarning}">Signal Strength</span>
            <span class="agy-lvl-val" style="font-family: monospace; ${decayWarning}">${(calculatedOpacity * 100).toFixed(0)}% (Valid)</span>
          </div>
          ${adverseWarningHtml}
        `;

        if (!activeTrade.actionTaken) {
          actionBtnContainer.innerHTML = `
            <button id="agy-btn-action-taken" style="margin-top: 8px; width: 100%; padding: 6px 10px; background: #f0b90b; border: none; border-radius: 4px; color: #0b0e11; font-weight: 800; font-size: 10px; cursor: pointer; text-transform: uppercase; transition: background-color 0.2s;">
              ✅ I Entered This Trade
            </button>
            <button id="agy-btn-close-position" style="margin-top: 6px; width: 100%; padding: 6px 10px; background: rgba(246, 70, 93, 0.15); border: 1px solid #f6465d; border-radius: 4px; color: #f6465d; font-weight: 800; font-size: 10px; cursor: pointer; text-transform: uppercase; transition: background-color 0.2s;">
              🚨 Dismiss Setup / Close
            </button>
          `;
        } else {
          actionBtnContainer.innerHTML = `
            <div style="width: 100%; padding: 6px 10px; background: rgba(46, 189, 133, 0.15); border: 1px solid #2ebd85; border-radius: 4px; color: #2ebd85; font-weight: 800; font-size: 10px; text-align: center; text-transform: uppercase; box-sizing: border-box;">
              Entered (Postgres Synced)
            </div>
            <button id="agy-btn-close-position" style="margin-top: 6px; width: 100%; padding: 6px 10px; background: #f6465d; border: none; border-radius: 4px; color: #fff; font-weight: 800; font-size: 10px; cursor: pointer; text-transform: uppercase; transition: background-color 0.2s;">
              🚨 CLOSE POSITION NOW
            </button>
          `;
        }
      }
    }

    // Recommendation card
    const cardEl = document.getElementById("agy-trade-recommendation-box");
    const badgeEl = document.getElementById("agy-trade-badge");
    const levelsEl = document.getElementById("agy-trade-levels");

    if (!cardEl || !badgeEl || !levelsEl) return;

    cardEl.className = "agy-trade-box";
    badgeEl.className = "agy-trade-badge";

    if (currentSignal.direction === "LONG") {
      cardEl.classList.add("bullish");
      badgeEl.classList.add("bullish");
      badgeEl.textContent = "LONG TRIGGER";

      const isCustomTarget = settings.targetMode === 'CUSTOM';
      const sizeLabel = settings.sizeMode === 'CAPITAL'
        ? `Ideal Size (Capital $${settings.tradeCapital})`
        : `Ideal Size (USDT Risk $${settings.riskAmount})`;
      const slLabel = isCustomTarget ? `Stop Loss (${settings.customStopLoss}%)` : `Invalidation (Stop Loss)`;
      const tpLabel = isCustomTarget ? `Take Profit (${settings.customTakeProfit}%)` : `Take Profit (1.5x)`;

      levelsEl.innerHTML = `
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">Trigger Price</span>
          <span class="agy-lvl-val" style="color: #2ebd85;">${formatPrice(currentSignal.entry)}</span>
        </div>
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">${slLabel}</span>
          <span class="agy-lvl-val" style="color: #f6465d;">${formatPrice(currentSignal.stopLoss)}</span>
        </div>
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">${tpLabel}</span>
          <span class="agy-lvl-val" style="color: #2ebd85;">${formatPrice(currentSignal.target1)}</span>
        </div>
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">Target Price (3.0x)</span>
          <span class="agy-lvl-val" style="color: #f0b90b;">${formatPrice(currentSignal.target2)}</span>
        </div>
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">${sizeLabel}</span>
          <span class="agy-lvl-val">${currentSignal.positionSize} units</span>
        </div>
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">Required Margin (${settings.leverage}x)</span>
          <span class="agy-lvl-val" style="color: #f0b90b;">$${currentSignal.marginRequired}</span>
        </div>
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">Confidence Ratios</span>
          <span class="agy-lvl-val" style="font-size: 9px; color: #848e9c;">
            Trend:${currentSignal.confidenceBreakdown?.trend || 0} SMC:${currentSignal.confidenceBreakdown?.smc || 0} Mom:${currentSignal.confidenceBreakdown?.momentum || 0}
          </span>
        </div>
      `;
    } else if (currentSignal.direction === "SHORT") {
      cardEl.classList.add("bearish");
      badgeEl.classList.add("bearish");
      badgeEl.textContent = "SHORT TRIGGER";

      const isCustomTarget = settings.targetMode === 'CUSTOM';
      const sizeLabel = settings.sizeMode === 'CAPITAL'
        ? `Ideal Size (Capital $${settings.tradeCapital})`
        : `Ideal Size (USDT Risk $${settings.riskAmount})`;
      const slLabel = isCustomTarget ? `Stop Loss (${settings.customStopLoss}%)` : `Invalidation (Stop Loss)`;
      const tpLabel = isCustomTarget ? `Take Profit (${settings.customTakeProfit}%)` : `Take Profit (1.5x)`;

      levelsEl.innerHTML = `
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">Trigger Price</span>
          <span class="agy-lvl-val" style="color: #f6465d;">${formatPrice(currentSignal.entry)}</span>
        </div>
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">${slLabel}</span>
          <span class="agy-lvl-val" style="color: #2ebd85;">${formatPrice(currentSignal.stopLoss)}</span>
        </div>
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">${tpLabel}</span>
          <span class="agy-lvl-val" style="color: #2ebd85;">${formatPrice(currentSignal.target1)}</span>
        </div>
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">Target Price (3.0x)</span>
          <span class="agy-lvl-val" style="color: #f0b90b;">${formatPrice(currentSignal.target2)}</span>
        </div>
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">${sizeLabel}</span>
          <span class="agy-lvl-val">${currentSignal.positionSize} units</span>
        </div>
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">Required Margin (${settings.leverage}x)</span>
          <span class="agy-lvl-val" style="color: #f0b90b;">$${currentSignal.marginRequired}</span>
        </div>
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">Confidence Ratios</span>
          <span class="agy-lvl-val" style="font-size: 9px; color: #848e9c;">
            Trend:${currentSignal.confidenceBreakdown?.trend || 0} SMC:${currentSignal.confidenceBreakdown?.smc || 0} Mom:${currentSignal.confidenceBreakdown?.momentum || 0}
          </span>
        </div>
      `;
    } else {
      badgeEl.textContent = "WAITING";
      levelsEl.innerHTML = `
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">Status</span>
          <span class="agy-lvl-val" style="color: #848e9c;" id="agy-rec-status">${currentSignal.reason}</span>
        </div>
      `;
    }
  }

  // Dedicated PnL ticker — runs locally every 1s using cached ticker price
  function startPnLTicker() {
    if (window._agPnLInterval) clearInterval(window._agPnLInterval);
    window._agPnLInterval = setInterval(() => {
      if (!isContextValid()) return;
      if (!activeTrade || (activeTrade.status !== "ACTIVE" && activeTrade.status !== "SANDBOX_ACTIVE") || currentTickPrice <= 0) return;
      if (activeTrade.symbol && activeSymbol && activeTrade.symbol !== activeSymbol) return;

      const monitorLevels = document.getElementById("agy-track-levels");
      const monitorBox = document.getElementById("agy-live-monitor-box");
      if (!monitorLevels || !monitorBox) return;

      const sideColor = activeTrade.direction === "LONG" ? "#2ebd85" : "#f6465d";
      const leverage = parseFloat(activeTrade.leverage) || parseFloat(settings.leverage) || 3;
      const pnlPercent = activeTrade.direction === "LONG"
        ? ((currentTickPrice - activeTrade.entry) / activeTrade.entry) * 100 * leverage
        : ((activeTrade.entry - currentTickPrice) / activeTrade.entry) * 100 * leverage;
      const sizePercent = activeTrade.direction === "LONG"
        ? ((currentTickPrice - activeTrade.entry) / activeTrade.entry) * 100
        : ((activeTrade.entry - currentTickPrice) / activeTrade.entry) * 100;
      const pnlDollar = activeTrade.direction === "LONG"
        ? (currentTickPrice - activeTrade.entry) * (activeTrade.positionSize || 0)
        : (activeTrade.entry - currentTickPrice) * (activeTrade.positionSize || 0);

      const pnlColor = pnlPercent >= 0 ? "#2ebd85" : "#f6465d";
      const pnlSign = pnlPercent >= 0 ? "+" : "";
      const sizeSign = sizePercent >= 0 ? "+" : "";

      const timeoutCandles = settings.enableTimeout !== false ? (settings.timeoutCandles !== undefined ? settings.timeoutCandles : 12) : 12;
      const timeOpacity = Math.max(0.0, 1 - ((activeTrade.elapsedCandles || 0) / timeoutCandles));
      const initDist = Math.abs(activeTrade.entry - activeTrade.stopLoss);
      const currDist = Math.abs(currentTickPrice - activeTrade.stopLoss);
      let priceOpacity = 1.0;
      if (activeTrade.direction === "LONG" && currentTickPrice < activeTrade.entry) {
        priceOpacity = initDist > 0 ? currDist / initDist : 1;
      } else if (activeTrade.direction === "SHORT" && currentTickPrice > activeTrade.entry) {
        priceOpacity = initDist > 0 ? currDist / initDist : 1;
      }
      const opacity = Math.max(0.15, Math.min(timeOpacity, priceOpacity));
      const decayWarning = opacity < 0.4 ? "color: #f6465d; font-weight: 900;" : "";

      let adverseWarningHtml = "";
      if (closeSignal.active) {
        const warningConfColor = closeSignal.confidence >= 80 ? "#f6465d" : "#f0b90b";
        adverseWarningHtml = `
          <div style="margin-top: 8px; padding: 6px; background: rgba(246, 70, 93, 0.12); border: 1px solid rgba(246, 70, 93, 0.4); border-radius: 4px; font-size: 9px; color: ${warningConfColor}; font-weight: 800; text-align: center; text-transform: uppercase;">
            ⚠️ Exit Warning: ${closeSignal.reason} (${closeSignal.confidence}% Conf)
          </div>
        `;
      }

      monitorLevels.innerHTML = `
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">Position</span>
          <span class="agy-lvl-val" style="color: ${sideColor};">${activeTrade.direction} (${activeTrade.pattern || 'SMC'})</span>
        </div>
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">Unrealized PnL</span>
          <span class="agy-lvl-val" style="color: ${pnlColor}; font-family: monospace; font-weight: 900;">
            ${pnlSign}${pnlPercent.toFixed(2)}% (ROE) &nbsp;|&nbsp; ${sizeSign}${sizePercent.toFixed(2)}% (Size) &nbsp;|&nbsp; ${pnlSign}$${pnlDollar.toFixed(2)}
          </span>
        </div>
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">Entry Price</span>
          <span class="agy-lvl-val" style="font-family: monospace;">${formatPrice(activeTrade.entry)}</span>
        </div>
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">Live Price</span>
          <span class="agy-lvl-val" style="font-family: monospace; color: #f0b90b;">${formatPrice(currentTickPrice)}</span>
        </div>
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">Target Level</span>
          <span class="agy-lvl-val" style="color: #2ebd85; font-family: monospace;">${formatPrice(activeTrade.target1)}</span>
        </div>
        <div class="agy-lvl-item">
          <span class="agy-lvl-name">Liquidation Stop</span>
          <span class="agy-lvl-val" style="color: #f6465d; font-family: monospace;">${formatPrice(activeTrade.stopLoss)}</span>
        </div>
        <div class="agy-lvl-item" style="border-top: 1px dashed rgba(240, 185, 11, 0.2); padding-top: 4px; margin-top: 4px;">
          <span class="agy-lvl-name" style="${decayWarning}">Signal Strength</span>
          <span class="agy-lvl-val" style="font-family: monospace; ${decayWarning}">${(opacity * 100).toFixed(0)}% (Valid)</span>
        </div>
        ${adverseWarningHtml}
      `;
    }, 1000);
  }

  // --- AUDIO SYNTHESIZER ---
  let _audioCtx = null;
  function getAudioContext() {
    if (!_audioCtx) {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (_audioCtx.state === 'suspended') {
      _audioCtx.resume().catch(() => {});
    }
    return _audioCtx;
  }

  function playSyntheticSound(type) {
    if (!settings.enableAudio) return;
    const ctx = getAudioContext();

    function playTone(freq, startOffset, duration, waveType, decayTime) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = waveType;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.35, ctx.currentTime + startOffset);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startOffset + decayTime);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + startOffset);
      osc.stop(ctx.currentTime + startOffset + duration);
    }

    try {
      if (type === 'SETUP_ALERT') {
        playTone(880, 0, 0.12, 'sine', 0.12);
        playTone(1100, 0.18, 0.12, 'sine', 0.12);
      } else if (type === 'TP_HIT') {
        playTone(523, 0, 0.08, 'sine', 0.08);
        playTone(659, 0.08, 0.08, 'sine', 0.08);
        playTone(784, 0.16, 0.08, 'sine', 0.08);
        playTone(1047, 0.24, 0.12, 'sine', 0.12);
      } else if (type === 'SL_HIT') {
        playTone(330, 0, 0.15, 'triangle', 0.2);
        playTone(220, 0.15, 0.15, 'triangle', 0.2);
        playTone(165, 0.30, 0.2, 'triangle', 0.25);
      } else if (type === 'EXIT_WARN') {
        playTone(600, 0, 0.10, 'square', 0.10);
        playTone(400, 0.18, 0.10, 'square', 0.10);
        playTone(600, 0.36, 0.10, 'square', 0.10);
      }
    } catch (e) {
      console.warn("Audio Context playback warning:", e);
    }
  }

  function unlockAudioContext() {
    try {
      const ctx = getAudioContext();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().then(() => {
          window.removeEventListener('click', unlockAudioContext);
          window.removeEventListener('mousedown', unlockAudioContext);
        });
      }
    } catch (e) {
      console.warn("Unable to unlock AudioContext:", e);
    }
  }
  window.addEventListener('click', unlockAudioContext);
  window.addEventListener('mousedown', unlockAudioContext);

  // --- BOOTSTRAP ---
  loadSettings(() => {
    injectHUD();
    startPnLTicker();
    startSymbolDetectionLoop();
  });
})();
