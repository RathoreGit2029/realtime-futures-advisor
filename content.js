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
        } else if (payload.type === 'SPEECH') {
          const speech = new SpeechSynthesisUtterance(payload.text);
          speech.rate = 0.95;
          window.speechSynthesis.speak(speech);
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
    const intervalId = setInterval(() => {
      if (!isContextValid()) {
        clearInterval(intervalId);
        return;
      }
      
      const isFuturesPage = window.location.pathname.includes('/futures/');
      if (isFuturesPage) {
        const detected = detectSymbolFromPage();
        if (detected) {
          if (detected !== activeSymbol) {
            console.log(`🎯 Active symbol changed to: ${detected}`);
            activeSymbol = detected;
            candles = [];
            currentTickPrice = 0;
            activeTrade = null;
            injectHUD();
            if (hudRoot) hudRoot.style.display = 'block';
            requestInitialHUDData();
          } else {
            if (hudRoot) hudRoot.style.display = 'block';
          }
        } else {
          if (hudRoot) hudRoot.style.display = 'none';
        }
      } else {
        if (hudRoot) hudRoot.style.display = 'none';
      }
    }, 1500);
  }

  // --- UI RENDER HELPERS ---
  function renderMiniSVGChart(svgEl, candles, currentSignal) {
    if (!svgEl) return;
    svgEl.innerHTML = ""; // Clear existing drawings

    if (!candles || candles.length < 5) {
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", "50%");
      text.setAttribute("y", "50%");
      text.setAttribute("dominant-baseline", "middle");
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("fill", "#848e9c");
      text.setAttribute("font-size", "10px");
      text.textContent = "Loading Chart Snapshot...";
      svgEl.appendChild(text);
      return;
    }

    // Select the last 35 candles
    const subset = candles.slice(-35);
    const width = svgEl.clientWidth || 388; // Default width matching HUD padding
    const height = svgEl.clientHeight || 120;

    // Pad container bounds so candles don't touch edges
    const highs = subset.map(c => c.high);
    const lows = subset.map(c => c.low);
    let maxP = Math.max(...highs);
    let minP = Math.min(...lows);
    
    // Add active indicators / signal levels to the min/max calculation so they are visible on chart
    const levelsToInclude = [];
    if (currentSignal.sweptPoolPrice) levelsToInclude.push(currentSignal.sweptPoolPrice);
    if (currentSignal.mssPrice) levelsToInclude.push(currentSignal.mssPrice);
    if (currentSignal.pendingMssPrice) levelsToInclude.push(currentSignal.pendingMssPrice);
    if (currentSignal.fvgTop) levelsToInclude.push(currentSignal.fvgTop);
    if (currentSignal.fvgBottom) levelsToInclude.push(currentSignal.fvgBottom);
    if (currentSignal.nearestSupport) levelsToInclude.push(currentSignal.nearestSupport.price);
    if (currentSignal.nearestResistance) levelsToInclude.push(currentSignal.nearestResistance.price);
    if (currentSignal.equilibrium) levelsToInclude.push(currentSignal.equilibrium);

    levelsToInclude.forEach(lvl => {
      if (lvl > 0) {
        if (lvl > maxP) maxP = lvl;
        if (lvl < minP) minP = lvl;
      }
    });

    const priceRange = maxP - minP;
    const padding = priceRange * 0.08 || 1;
    const chartMax = maxP + padding;
    const chartMin = minP - padding;
    const chartHeightRange = chartMax - chartMin;

    // Helper functions for scaling coordinates
    function getX(index) {
      return (index / (subset.length - 1)) * (width - 16) + 8;
    }

    function getY(price) {
      return height - ((price - chartMin) / chartHeightRange) * (height - 16) - 8;
    }

    // 1. Draw FVG Zone (if present)
    if (currentSignal.fvgTop && currentSignal.fvgBottom) {
      const fvgYTop = getY(currentSignal.fvgTop);
      const fvgYBottom = getY(currentSignal.fvgBottom);
      
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", "0");
      rect.setAttribute("y", Math.min(fvgYTop, fvgYBottom));
      rect.setAttribute("width", width);
      rect.setAttribute("height", Math.abs(fvgYTop - fvgYBottom));
      rect.setAttribute("fill", "rgba(240, 185, 11, 0.06)");
      rect.setAttribute("stroke", "rgba(240, 185, 11, 0.15)");
      rect.setAttribute("stroke-width", "1");
      rect.setAttribute("stroke-dasharray", "2,2");
      svgEl.appendChild(rect);
    }

    // 2. Draw Candlesticks
    const candleWidth = Math.max(2, (width / subset.length) * 0.6);
    
    subset.forEach((c, i) => {
      const x = getX(i);
      const yHigh = getY(c.high);
      const yLow = getY(c.low);
      const yOpen = getY(c.open);
      const yClose = getY(c.close);
      
      const isBullish = c.close >= c.open;
      const color = isBullish ? "#2ebd85" : "#f6465d";

      // Wick line
      const wick = document.createElementNS("http://www.w3.org/2000/svg", "line");
      wick.setAttribute("x1", x);
      wick.setAttribute("y1", yHigh);
      wick.setAttribute("x2", x);
      wick.setAttribute("y2", yLow);
      wick.setAttribute("stroke", color);
      wick.setAttribute("stroke-width", "1.2");
      svgEl.appendChild(wick);

      // Body rect
      const body = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      body.setAttribute("x", x - candleWidth / 2);
      body.setAttribute("y", Math.min(yOpen, yClose));
      body.setAttribute("width", candleWidth);
      body.setAttribute("height", Math.max(1, Math.abs(yOpen - yClose)));
      body.setAttribute("fill", isBullish ? "rgba(46, 189, 133, 0.85)" : "rgba(246, 70, 93, 0.85)");
      body.setAttribute("stroke", color);
      body.setAttribute("stroke-width", "0.5");
      svgEl.appendChild(body);
    });

    // 3. Draw Support (SSL) Level (if present)
    if (currentSignal.nearestSupport) {
      const ySupp = getY(currentSignal.nearestSupport.price);
      
      // Line
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", "0");
      line.setAttribute("y1", ySupp);
      line.setAttribute("x2", width);
      line.setAttribute("y2", ySupp);
      line.setAttribute("stroke", "#2ebd85");
      line.setAttribute("stroke-width", "1");
      line.setAttribute("stroke-dasharray", "3,3");
      line.setAttribute("opacity", "0.6");
      svgEl.appendChild(line);

      // Text label
      const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
      txt.setAttribute("x", "4");
      txt.setAttribute("y", ySupp - 3);
      txt.setAttribute("fill", "#2ebd85");
      txt.setAttribute("font-size", "7px");
      txt.setAttribute("font-weight", "bold");
      txt.textContent = `SUP (${currentSignal.nearestSupport.type}): $${formatPrice(currentSignal.nearestSupport.price)}`;
      svgEl.appendChild(txt);
    }

    // 4. Draw Resistance (BSL) Level (if present)
    if (currentSignal.nearestResistance) {
      const yRes = getY(currentSignal.nearestResistance.price);
      
      // Line
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", "0");
      line.setAttribute("y1", yRes);
      line.setAttribute("x2", width);
      line.setAttribute("y2", yRes);
      line.setAttribute("stroke", "#f6465d");
      line.setAttribute("stroke-width", "1");
      line.setAttribute("stroke-dasharray", "3,3");
      line.setAttribute("opacity", "0.6");
      svgEl.appendChild(line);

      // Text label
      const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
      txt.setAttribute("x", "4");
      txt.setAttribute("y", yRes - 3);
      txt.setAttribute("fill", "#f6465d");
      txt.setAttribute("font-size", "7px");
      txt.setAttribute("font-weight", "bold");
      txt.textContent = `RES (${currentSignal.nearestResistance.type}): $${formatPrice(currentSignal.nearestResistance.price)}`;
      svgEl.appendChild(txt);
    }

    // 5. Draw MSS / Pending MSS Level (if present)
    if (currentSignal.mssPrice || currentSignal.pendingMssPrice) {
      const mssVal = currentSignal.mssPrice || currentSignal.pendingMssPrice;
      const isConfirmed = !!currentSignal.mssPrice;
      const yMss = getY(mssVal);
      
      // Line
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", "0");
      line.setAttribute("y1", yMss);
      line.setAttribute("x2", width);
      line.setAttribute("y2", yMss);
      line.setAttribute("stroke", "#f0b90b");
      line.setAttribute("stroke-width", "1.2");
      line.setAttribute("stroke-dasharray", isConfirmed ? "none" : "5,4");
      line.setAttribute("opacity", "0.85");
      svgEl.appendChild(line);

      // Text label
      const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
      txt.setAttribute("x", width - 4);
      txt.setAttribute("y", yMss - 3);
      txt.setAttribute("fill", "#f0b90b");
      txt.setAttribute("font-size", "7px");
      txt.setAttribute("font-weight", "bold");
      txt.setAttribute("text-anchor", "end");
      txt.textContent = isConfirmed ? `MSS: $${formatPrice(mssVal)}` : `PENDING MSS: $${formatPrice(mssVal)}`;
      svgEl.appendChild(txt);
    }

    // 6. Draw Equilibrium Line (if present)
    if (currentSignal.equilibrium) {
      const yEq = getY(currentSignal.equilibrium);
      
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", "0");
      line.setAttribute("y1", yEq);
      line.setAttribute("x2", width);
      line.setAttribute("y2", yEq);
      line.setAttribute("stroke", "#848e9c");
      line.setAttribute("stroke-width", "0.8");
      line.setAttribute("stroke-dasharray", "4,4");
      line.setAttribute("opacity", "0.4");
      svgEl.appendChild(line);

      const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
      txt.setAttribute("x", width / 2);
      txt.setAttribute("y", yEq - 3);
      txt.setAttribute("fill", "#848e9c");
      txt.setAttribute("font-size", "6px");
      txt.setAttribute("text-anchor", "middle");
      txt.textContent = `EQ: $${formatPrice(currentSignal.equilibrium)}`;
      svgEl.appendChild(txt);
    }

    // 7. Draw Current Price Level (pulsing line)
    const yCurrent = getY(currentTickPrice);
    if (yCurrent >= 0 && yCurrent <= height) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", "0");
      line.setAttribute("y1", yCurrent);
      line.setAttribute("x2", width);
      line.setAttribute("y2", yCurrent);
      line.setAttribute("stroke", "#fff");
      line.setAttribute("stroke-width", "1");
      line.setAttribute("opacity", "0.55");
      svgEl.appendChild(line);

      const labelGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
      
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", width - 50);
      rect.setAttribute("y", yCurrent - 6);
      rect.setAttribute("width", "48");
      rect.setAttribute("height", "12");
      rect.setAttribute("rx", "2");
      rect.setAttribute("fill", "#2b3139");
      rect.setAttribute("stroke", "#f0b90b");
      rect.setAttribute("stroke-width", "0.5");
      labelGroup.appendChild(rect);

      const txt = document.createElementNS("http://www.w3.org/2000/svg", "text");
      txt.setAttribute("x", width - 26);
      txt.setAttribute("y", yCurrent + 3);
      txt.setAttribute("fill", "#fff");
      txt.setAttribute("font-size", "7px");
      txt.setAttribute("font-weight", "bold");
      txt.setAttribute("text-anchor", "middle");
      txt.textContent = `$${formatPrice(currentTickPrice)}`;
      labelGroup.appendChild(txt);
      
      svgEl.appendChild(labelGroup);
    }

    // 8. Draw Linear Regression Trend Line
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    const n = subset.length;
    subset.forEach((c, idx) => {
      sumX += idx;
      sumY += c.close;
      sumXY += idx * c.close;
      sumXX += idx * idx;
    });
    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;
    const yStartVal = intercept;
    const yEndVal = slope * (n - 1) + intercept;

    const trendLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
    trendLine.setAttribute("x1", getX(0));
    trendLine.setAttribute("y1", getY(yStartVal));
    trendLine.setAttribute("x2", getX(n - 1));
    trendLine.setAttribute("y2", getY(yEndVal));
    trendLine.setAttribute("stroke", slope >= 0 ? "rgba(46, 189, 133, 0.6)" : "rgba(246, 70, 93, 0.6)");
    trendLine.setAttribute("stroke-width", "1.5");
    trendLine.setAttribute("stroke-dasharray", "4,3");
    svgEl.appendChild(trendLine);

    // 9. Draw Highest High / Lowest Low Labels
    let highestIdx = 0;
    let lowestIdx = 0;
    subset.forEach((c, idx) => {
      if (c.high > subset[highestIdx].high) highestIdx = idx;
      if (c.low < subset[lowestIdx].low) lowestIdx = idx;
    });

    // Highest High label
    const hDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    hDot.setAttribute("cx", getX(highestIdx));
    hDot.setAttribute("cy", getY(subset[highestIdx].high));
    hDot.setAttribute("r", "2");
    hDot.setAttribute("fill", "#f6465d");
    svgEl.appendChild(hDot);

    const hText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    hText.setAttribute("x", getX(highestIdx));
    hText.setAttribute("y", getY(subset[highestIdx].high) - 5);
    hText.setAttribute("fill", "#f6465d");
    hText.setAttribute("font-size", "7px");
    hText.setAttribute("font-weight", "bold");
    hText.setAttribute("text-anchor", "middle");
    hText.textContent = "H";
    svgEl.appendChild(hText);

    // Lowest Low label
    const lDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    lDot.setAttribute("cx", getX(lowestIdx));
    lDot.setAttribute("cy", getY(subset[lowestIdx].low));
    lDot.setAttribute("r", "2");
    lDot.setAttribute("fill", "#2ebd85");
    svgEl.appendChild(lDot);

    const lText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    lText.setAttribute("x", getX(lowestIdx));
    lText.setAttribute("y", getY(subset[lowestIdx].low) + 9);
    lText.setAttribute("fill", "#2ebd85");
    lText.setAttribute("font-size", "7px");
    lText.setAttribute("font-weight", "bold");
    lText.setAttribute("text-anchor", "middle");
    lText.textContent = "L";
    svgEl.appendChild(lText);
  }

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
  let activeTab = "setup";

  function switchTab(tabName) {
    activeTab = tabName;
    chrome.storage.local.set({ activeTab: tabName });

    const btns = hudRoot.querySelectorAll(".agy-tab-btn");
    const nav = hudRoot.querySelector(".agy-tabs-nav");
    btns.forEach((btn, index) => {
      if (btn.dataset.tab === tabName) {
        btn.classList.add("active");
        if (nav) {
          nav.style.setProperty("--agy-tab-left", `${index * 33.333}%`);
        }
      } else {
        btn.classList.remove("active");
      }
    });

    const panels = ["setup", "chart", "metrics"];
    panels.forEach(p => {
      const el = document.getElementById(`agy-tab-content-${p}`);
      if (el) {
        if (p === tabName) {
          el.style.display = "block";
          // Trigger reflow
          el.offsetHeight;
          el.classList.add("active");
          if (p === "chart") {
            const svgEl = document.getElementById("agy-svg-chart");
            if (svgEl && candles && candles.length >= 5) {
              renderMiniSVGChart(svgEl, candles, currentSignal);
            }
          }
        } else {
          el.style.display = "none";
          el.classList.remove("active");
        }
      }
    });
  }

  function injectHUD() {
    if (document.getElementById("antigravity-hud-root")) return;

    hudRoot = document.createElement("div");
    hudRoot.id = "antigravity-hud-root";
    hudRoot.innerHTML = `
      <div id="agy-hud-maximized">
        <div class="agy-header" id="agy-drag-handle">
          <div class="agy-title-container">
            <span class="agy-logo" style="width: 18px !important; height: 18px !important; font-size: 11px !important;">⚡</span>
            <span class="agy-text-title" style="font-size: 10px !important;">AGY HUD</span>
            <span class="agy-active-pair" id="agy-pair-label" style="font-size: 8px !important; padding: 1px 3px !important;">USDT</span>
            <span class="agy-mode-badge hunting" id="agy-mode-indicator" style="font-size: 7px !important; padding: 1px 4px !important;">HUNTING</span>
            <span class="agy-auto-badge auto-off" id="agy-auto-indicator" style="cursor: pointer; font-size: 7px !important; font-weight: 800 !important; padding: 1px 4px !important; border-radius: 3px !important; text-transform: uppercase !important; display: inline-block !important; letter-spacing: 0.5px !important;" title="Click to Toggle Auto-Pilot">🤖 OFF</span>
          </div>
          <div class="agy-controls">
            <button class="agy-btn" id="agy-btn-dashboard" title="Open Control Room" style="margin-right: 6px; font-size: 11px;">🎛️</button>
            <button class="agy-btn" id="agy-btn-minimize" title="Minimize">➖</button>
          </div>
        </div>

        <div class="agy-tabs-nav">
          <button class="agy-tab-btn" data-tab="setup">🎯 SETUP</button>
          <button class="agy-tab-btn" data-tab="chart">📈 CHART</button>
          <button class="agy-tab-btn" data-tab="metrics">📊 METRICS</button>
        </div>

        <div class="agy-body">
          <!-- Large Flashing Warning Banner -->
          <div id="agy-flash-warning" class="agy-flash-alert" style="display: none;"></div>

          <!-- TAB 1: SETUP -->
          <div id="agy-tab-content-setup" class="agy-tab-content">
            <!-- Dial -->
            <div class="agy-gauge-section" style="margin-bottom: 8px !important;">
              <div class="agy-gauge-wrapper">
                <div class="agy-gauge-bg"></div>
                <div class="agy-gauge-fill" id="agy-probability-fill"></div>
                <div class="agy-gauge-value" id="agy-probability-val">50%</div>
              </div>
              <div class="agy-gauge-label" id="agy-bias-label">Neutral Bias</div>
              <div id="agy-pattern-text" style="font-size: 11px; font-weight: 700; color: #fff; margin-top: 5px;">Scanning Markets</div>
            </div>

            <!-- Bias Bar -->
            <div class="agy-bias-section" style="margin-bottom: 14px; padding: 0 5px;">
              <div style="display: flex; justify-content: space-between; font-size: 10px; font-weight: 800; margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px;">
                <span style="color: #2ebd85;">Long Bias: <span id="agy-long-bias-val">50%</span></span>
                <span style="color: #f6465d;">Short Bias: <span id="agy-short-bias-val">50%</span></span>
              </div>
              <div class="agy-bias-bar-wrapper" style="height: 6px; background: #2b3139; border-radius: 3px; overflow: hidden; display: flex; box-shadow: inset 0 1px 3px rgba(0,0,0,0.5);">
                <div id="agy-long-bias-bar" style="width: 50%; background: #2ebd85; transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);"></div>
                <div id="agy-short-bias-bar" style="width: 50%; background: #f6465d; transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);"></div>
              </div>
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

          <!-- TAB 2: CHART -->
          <div id="agy-tab-content-chart" class="agy-tab-content" style="display: none;">
            <!-- SVG Candlestick Chart -->
            <div style="font-size: 10px; font-weight: 800; color: #848e9c; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; padding: 0 5px;">📈 Live SMC Chart Snapshot</div>
            <div id="agy-chart-container" style="background: rgba(16, 18, 23, 0.65) !important; border: 1px solid rgba(43, 49, 57, 0.6) !important; border-radius: 8px !important; padding: 8px 6px !important; margin-bottom: 14px !important; overflow: visible !important;">
              <svg id="agy-svg-chart" style="width: 100% !important; height: 120px !important; display: block !important; overflow: visible !important;"></svg>
            </div>

            <!-- Key Levels Section -->
            <div style="font-size: 10px; font-weight: 800; color: #848e9c; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">🎯 Key Levels</div>
            <div class="agy-indicator-grid" style="margin-bottom: 4px;">
              <div class="agy-ind-card">
                <span class="agy-ind-name">Nearest Support (SSL)</span>
                <span class="agy-ind-val" id="agy-val-support" style="color: #2ebd85;">--</span>
              </div>
              <div class="agy-ind-card">
                <span class="agy-ind-name">Nearest Resistance (BSL)</span>
                <span class="agy-ind-val" id="agy-val-resistance" style="color: #f6465d;">--</span>
              </div>
            </div>
          </div>

          <!-- TAB 3: METRICS -->
          <div id="agy-tab-content-metrics" class="agy-tab-content" style="display: none;">
            <!-- Scalper Metrics Section -->
            <div style="font-size: 10px; font-weight: 800; color: #848e9c; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">📊 Scalper Metrics</div>
            <div class="agy-indicator-grid" style="margin-bottom: 12px;">
              <div class="agy-ind-card">
                <span class="agy-ind-name">Market Regime</span>
                <span class="agy-ind-val" id="agy-val-regime">--</span>
              </div>
              <div class="agy-ind-card">
                <span class="agy-ind-name">Bid/Ask Spread</span>
                <span class="agy-ind-val" id="agy-val-spread">--</span>
              </div>
              <div class="agy-ind-card">
                <span class="agy-ind-name">HTF Trend</span>
                <span class="agy-ind-val" id="agy-val-htf">--</span>
              </div>
              <div class="agy-ind-card">
                <span class="agy-ind-name">Order Imbalance</span>
                <span class="agy-ind-val" id="agy-val-imbalance">--</span>
              </div>
            </div>

            <!-- Indicators grid -->
            <div style="font-size: 10px; font-weight: 800; color: #848e9c; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px;">⚡ SMC Indicators</div>
            <div class="agy-indicator-grid">
              <div class="agy-ind-card">
                <span class="agy-ind-name">Timeframe</span>
                <span class="agy-ind-val" id="agy-ind-tf">5m</span>
              </div>
              <div class="agy-ind-card">
                <span class="agy-ind-name">Displacement</span>
                <span class="agy-ind-val">
                  <span class="agy-dot" id="agy-dot-disp" style="color: #848e9c;"></span>
                  <span id="agy-val-disp">--</span>
                </span>
              </div>
              <div class="agy-ind-card">
                <span class="agy-ind-name">FVG Mitigation</span>
                <span class="agy-ind-val">
                  <span class="agy-dot" id="agy-dot-fvg" style="color: #848e9c;"></span>
                  <span id="agy-val-fvg">--</span>
                </span>
              </div>
              <div class="agy-ind-card">
                <span class="agy-ind-name">Dealing Range</span>
                <span class="agy-ind-val">
                  <span class="agy-dot" id="agy-dot-range" style="color: #848e9c;"></span>
                  <span id="agy-val-range">--</span>
                </span>
              </div>
              <div class="agy-ind-card" style="grid-column: span 2;">
                <span class="agy-ind-name">Swept Pool</span>
                <span class="agy-ind-val" id="agy-val-sweep" style="color: #fff; font-size: 10px !important;">--</span>
              </div>
              <div class="agy-ind-card" style="grid-column: span 2;">
                <span class="agy-ind-name" id="agy-ledger-title">Postgres Ledger</span>
                <span class="agy-ind-val" style="color: #fff; font-family: monospace;">
                  <span id="agy-val-wins" style="color: #2ebd85;">0</span>/
                  <span id="agy-val-losses" style="color: #f6465d;">0</span>/
                  <span id="agy-val-timeouts" style="color: #848e9c;">0</span>
                </span>
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

    const chartContainer = document.getElementById("agy-chart-container");
    const svgEl = document.getElementById("agy-svg-chart");
    if (chartContainer && svgEl) {
      chartContainer.style.cursor = "pointer";
      chartContainer.title = "Click to Expand/Collapse Chart";
      chartContainer.addEventListener("click", () => {
        const isExpanded = svgEl.style.height === "240px" || svgEl.style.height === "240px !important";
        svgEl.style.setProperty("height", isExpanded ? "120px" : "240px", "important");
        if (candles && candles.length >= 5) {
          renderMiniSVGChart(svgEl, candles, currentSignal);
        }
      });
    }

    hudRoot.addEventListener("click", (e) => {
      if (e.target && e.target.id === "agy-btn-action-taken") {
        markUserActionTaken();
      } else if (e.target && e.target.id === "agy-btn-close-position") {
        manuallyCloseActiveTrade();
      } else if (e.target && e.target.id === "agy-auto-indicator") {
        toggleAutoPilotMode();
      }
    });

    chrome.storage.local.get({ hudPos: { top: 70, right: 20 }, activeTab: "setup" }, (items) => {
      hudRoot.style.top = `${items.hudPos.top}px`;
      hudRoot.style.right = `${items.hudPos.right}px`;
      hudRoot.style.left = "auto";
      updateAutoPilotHUDDisplay();
      
      const tabBtns = hudRoot.querySelectorAll(".agy-tab-btn");
      tabBtns.forEach(btn => {
        btn.addEventListener("click", () => {
          switchTab(btn.dataset.tab);
        });
      });
      switchTab(items.activeTab || "setup");
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
      autoEl.textContent = "🤖 ON";
      autoEl.className = "agy-auto-badge auto-on";
    } else {
      autoEl.textContent = "🤖 OFF";
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
      const initialDistance = Math.abs(activeTrade.entry - activeTrade.stopLoss);
      const currentDistance = Math.abs(currentTickPrice - activeTrade.stopLoss);

      let priceOpacity = 1.0;
      if (activeTrade.direction === "LONG" && currentTickPrice < activeTrade.entry) {
        priceOpacity = initialDistance > 0 ? currentDistance / initialDistance : 1;
      } else if (activeTrade.direction === "SHORT" && currentTickPrice > activeTrade.entry) {
        priceOpacity = initialDistance > 0 ? currentDistance / initialDistance : 1;
      }
      calculatedOpacity = Math.max(0.15, priceOpacity);
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

    // Update Bias Bar
    const longBiasValEl = document.getElementById("agy-long-bias-val");
    const shortBiasValEl = document.getElementById("agy-short-bias-val");
    const longBiasBarEl = document.getElementById("agy-long-bias-bar");
    const shortBiasBarEl = document.getElementById("agy-short-bias-bar");

    if (longBiasValEl && shortBiasValEl && longBiasBarEl && shortBiasBarEl) {
      const longBias = currentSignal.longBias != null ? currentSignal.longBias : 50;
      const shortBias = currentSignal.shortBias != null ? currentSignal.shortBias : 50;
      longBiasValEl.textContent = `${longBias}%`;
      shortBiasValEl.textContent = `${shortBias}%`;
      longBiasBarEl.style.width = `${longBias}%`;
      shortBiasBarEl.style.width = `${shortBias}%`;
    }

    // Update Scalper Metrics
    const regimeValEl = document.getElementById("agy-val-regime");
    const spreadValEl = document.getElementById("agy-val-spread");
    const htfValEl = document.getElementById("agy-val-htf");
    const imbalanceValEl = document.getElementById("agy-val-imbalance");

    if (regimeValEl) {
      const regime = currentSignal.regime || "CHOPPY";
      regimeValEl.textContent = regime;
      if (regime === "TRENDING" || regime === "EXPANSION") {
        regimeValEl.style.color = "#2ebd85";
      } else if (regime === "CHOPPY" || regime === "HIGH_VOLATILITY" || regime === "LIQUIDATION_CASCADE") {
        regimeValEl.style.color = "#f6465d";
      } else if (regime === "COMPRESSION") {
        regimeValEl.style.color = "#f0b90b";
      } else {
        regimeValEl.style.color = "#848e9c";
      }
    }

    if (spreadValEl && currentTickPrice > 0) {
      const spread = currentSignal.spread || 0;
      const spreadPct = (spread / currentTickPrice) * 100;
      spreadValEl.textContent = `$${formatPrice(spread)} (${spreadPct.toFixed(3)}%)`;
      spreadValEl.style.color = spreadPct > 0.05 ? "#f6465d" : "#2ebd85";
    } else if (spreadValEl) {
      spreadValEl.textContent = "--";
    }

    if (htfValEl) {
      const htfTrend = currentSignal.htfTrend || "WAITING";
      htfValEl.textContent = htfTrend;
      if (htfTrend === "BULLISH") htfValEl.style.color = "#2ebd85";
      else if (htfTrend === "BEARISH") htfValEl.style.color = "#f6465d";
      else htfValEl.style.color = "#848e9c";
    }

    if (imbalanceValEl) {
      const imb = currentSignal.orderbookImbalance != null ? currentSignal.orderbookImbalance : 0.5;
      imbalanceValEl.textContent = `Bids ${(imb * 100).toFixed(0)}% | Asks ${((1 - imb) * 100).toFixed(0)}%`;
      imbalanceValEl.style.color = imb > 0.6 ? "#2ebd85" : imb < 0.4 ? "#f6465d" : "#848e9c";
    }

    // Update SMC Indicators text values
    const dispValEl = document.getElementById("agy-val-disp");
    const dispDotEl = document.getElementById("agy-dot-disp");
    const fvgValEl = document.getElementById("agy-val-fvg");
    const fvgDotEl = document.getElementById("agy-dot-fvg");
    const rangeValEl = document.getElementById("agy-val-range");
    const rangeDotEl = document.getElementById("agy-dot-range");
    const sweepValEl = document.getElementById("agy-val-sweep");

    if (dispValEl && dispDotEl) {
      const dispScore = currentSignal.displacementScore;
      if (dispScore != null) {
        dispValEl.textContent = `${dispScore}`;
        dispDotEl.style.color = dispScore >= 60 ? "#2ebd85" : dispScore >= 40 ? "#f0b90b" : "#f6465d";
      } else {
        dispValEl.textContent = "--";
        dispDotEl.style.color = "#848e9c";
      }
    }

    if (fvgValEl && fvgDotEl) {
      const top = currentSignal.fvgTop;
      const bottom = currentSignal.fvgBottom;
      if (top != null && bottom != null) {
        fvgValEl.textContent = `${formatPrice(bottom)}-${formatPrice(top)}`;
        fvgDotEl.style.color = "#2ebd85";
      } else {
        fvgValEl.textContent = "No active FVG";
        fvgDotEl.style.color = "#848e9c";
      }
    }

    if (rangeValEl && rangeDotEl) {
      const drHigh = currentSignal.dealingRangeHigh;
      const drLow = currentSignal.dealingRangeLow;
      const eq = currentSignal.equilibrium;
      if (drHigh != null && drLow != null && eq != null) {
        const isPremium = currentTickPrice > eq;
        rangeValEl.textContent = isPremium ? "Premium Zone" : "Discount Zone";
        rangeDotEl.style.color = isPremium ? "#f6465d" : "#2ebd85";
      } else {
        rangeValEl.textContent = "No Dealing Range";
        rangeDotEl.style.color = "#848e9c";
      }
    }

    if (sweepValEl) {
      const poolType = currentSignal.sweptPoolType;
      const poolPrice = currentSignal.sweptPoolPrice;
      if (poolType && poolPrice) {
        sweepValEl.textContent = `${poolType} swept at $${formatPrice(poolPrice)}`;
      } else {
        sweepValEl.textContent = "Scanning Liquidity Pools...";
      }
    }

    // Update Support and Resistance Key Levels
    const supportValEl = document.getElementById("agy-val-support");
    const resistanceValEl = document.getElementById("agy-val-resistance");

    if (supportValEl) {
      const supp = currentSignal.nearestSupport;
      if (supp) {
        supportValEl.textContent = `${supp.type}: $${formatPrice(supp.price)}`;
      } else {
        supportValEl.textContent = "None Active";
      }
    }

    if (resistanceValEl) {
      const res = currentSignal.nearestResistance;
      if (res) {
        resistanceValEl.textContent = `${res.type}: $${formatPrice(res.price)}`;
      } else {
        resistanceValEl.textContent = "None Active";
      }
    }

    // Trigger Mini SVG Chart Render
    const svgEl = document.getElementById("agy-svg-chart");
    if (svgEl) {
      renderMiniSVGChart(svgEl, candles, currentSignal);
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
        if (settings.enableTimeout !== false) {
          const limit = settings.timeoutCandles !== undefined ? settings.timeoutCandles : 12;
          monitorTime.textContent = `Age: ${activeTrade.elapsedCandles || 0}/${limit} candles`;
        } else {
          monitorTime.textContent = `Age: ${activeTrade.elapsedCandles || 0} candles`;
        }

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
      
      if (settings.enableSMC) {
        // SMC Checklist Calculations
        
        // 1. Sweep check
        let sweepCheck = `<span style="color: #f6465d;">🔴 Awaiting Sweep</span>`;
        if (currentSignal.sweptPoolType) {
          sweepCheck = `<span style="color: #2ebd85;">🟢 Swept ${currentSignal.sweptPoolType} ($${formatPrice(currentSignal.sweptPoolPrice)})</span>`;
        }
        
        // 2. MSS check
        let mssCheck = `<span style="color: #848e9c;">🔴 Awaiting Sweep</span>`;
        if (currentSignal.mssPrice) {
          mssCheck = `<span style="color: #2ebd85;">🟢 MSS Confirmed ($${formatPrice(currentSignal.mssPrice)})</span>`;
        } else if (currentSignal.pendingMssPrice) {
          const poolType = currentSignal.sweptPoolType || "";
          const isLows = poolType.includes("LOW") || poolType.includes("SSL") || poolType.includes("PDL") || poolType.includes("WL") || poolType.includes("EQL") || poolType.includes("SWING_LOW");
          const mssDir = isLows ? "Break Above" : "Break Below";
          mssCheck = `<span style="color: #f0b90b;">🔴 Awaiting ${mssDir} $${formatPrice(currentSignal.pendingMssPrice)}</span>`;
        } else if (currentSignal.sweptPoolType) {
          mssCheck = `<span style="color: #f6465d;">🔴 Awaiting MSS Break</span>`;
        }
        
        // 3. Displacement
        let dispCheck = `<span style="color: #848e9c;">🔴 Awaiting MSS</span>`;
        if (currentSignal.displacementScore != null) {
          const dScore = currentSignal.displacementScore;
          if (dScore >= 60) {
            dispCheck = `<span style="color: #2ebd85;">🟢 Score ${dScore}/100</span>`;
          } else {
            dispCheck = `<span style="color: #f6465d;">🔴 Low Score ${dScore}/100</span>`;
          }
        }
        
        // 4. FVG Mitigation
        let fvgCheck = `<span style="color: #848e9c;">🔴 Awaiting displacement</span>`;
        if (currentSignal.fvgTop != null && currentSignal.fvgBottom != null) {
          const isTouch = currentTickPrice <= currentSignal.fvgTop && currentTickPrice >= currentSignal.fvgBottom;
          if (isTouch) {
            fvgCheck = `<span style="color: #2ebd85;">🟢 Inside FVG ($${formatPrice(currentSignal.fvgBottom)}-$${formatPrice(currentSignal.fvgTop)})</span>`;
          } else {
            fvgCheck = `<span style="color: #f0b90b;">🔴 Retracement pending ($${formatPrice(currentSignal.fvgBottom)}-$${formatPrice(currentSignal.fvgTop)})</span>`;
          }
        } else if (currentSignal.displacementScore != null && currentSignal.displacementScore >= 60) {
          fvgCheck = `<span style="color: #f6465d;">🔴 Awaiting FVG Creation</span>`;
        }
        
        // 5. Equilibrium
        let eqCheck = `<span style="color: #848e9c;">🔴 Awaiting range</span>`;
        if (currentSignal.equilibrium != null) {
          const poolType = currentSignal.sweptPoolType || "";
          const isLows = poolType.includes("LOW") || poolType.includes("SSL") || poolType.includes("PDL") || poolType.includes("WL") || poolType.includes("EQL") || poolType.includes("SWING_LOW");
          const isHighs = poolType.includes("HIGH") || poolType.includes("BSL") || poolType.includes("PDH") || poolType.includes("WH") || poolType.includes("EQH") || poolType.includes("SWING_HIGH");
          
          if (isLows) {
            if (currentTickPrice < currentSignal.equilibrium) {
              eqCheck = `<span style="color: #2ebd85;">🟢 Discount ($${formatPrice(currentTickPrice)} < $${formatPrice(currentSignal.equilibrium)})</span>`;
            } else {
              eqCheck = `<span style="color: #f6465d;">🔴 Premium (Wait for < $${formatPrice(currentSignal.equilibrium)})</span>`;
            }
          } else if (isHighs) {
            if (currentTickPrice > currentSignal.equilibrium) {
              eqCheck = `<span style="color: #2ebd85;">🟢 Premium ($${formatPrice(currentTickPrice)} > $${formatPrice(currentSignal.equilibrium)})</span>`;
            } else {
              eqCheck = `<span style="color: #f6465d;">🔴 Discount (Wait for > $${formatPrice(currentSignal.equilibrium)})</span>`;
            }
          } else {
            eqCheck = `<span style="color: #848e9c;">🔴 Out of Zone</span>`;
          }
        }
        
        levelsEl.innerHTML = `
          <div class="agy-lvl-item" style="border-bottom: 1px solid rgba(240, 185, 11, 0.2) !important; padding-bottom: 6px !important; margin-bottom: 6px !important;">
            <span class="agy-lvl-name" style="color: #f0b90b; font-weight: 800;">PENDING SMC SETUP</span>
            <span class="agy-lvl-val" style="color: #f0b90b; font-size: 9px;">${currentSignal.reason}</span>
          </div>
          <div class="agy-lvl-item">
            <span class="agy-lvl-name">1. Liquidity Sweep</span>
            <span class="agy-lvl-val">${sweepCheck}</span>
          </div>
          <div class="agy-lvl-item">
            <span class="agy-lvl-name">2. Market Structure Shift</span>
            <span class="agy-lvl-val">${mssCheck}</span>
          </div>
          <div class="agy-lvl-item">
            <span class="agy-lvl-name">3. Displacement Quality</span>
            <span class="agy-lvl-val">${dispCheck}</span>
          </div>
          <div class="agy-lvl-item">
            <span class="agy-lvl-name">4. FVG Mitigation</span>
            <span class="agy-lvl-val">${fvgCheck}</span>
          </div>
          <div class="agy-lvl-item">
            <span class="agy-lvl-name">5. Equilibrium Zone</span>
            <span class="agy-lvl-val">${eqCheck}</span>
          </div>
        `;
      } else {
        // Legacy Indicators Checklist
        levelsEl.innerHTML = `
          <div class="agy-lvl-item" style="border-bottom: 1px solid rgba(240, 185, 11, 0.2) !important; padding-bottom: 6px !important; margin-bottom: 6px !important;">
            <span class="agy-lvl-name" style="color: #f0b90b; font-weight: 800;">PENDING CONFLUENCE</span>
            <span class="agy-lvl-val" style="color: #f0b90b; font-size: 9px;">${currentSignal.reason}</span>
          </div>
          <div class="agy-lvl-item">
            <span class="agy-lvl-name">Trend Direction</span>
            <span class="agy-lvl-val" style="color: ${indicators.ema9 > indicators.ema21 ? '#2ebd85' : '#f6465d'};">${indicators.ema9 > indicators.ema21 ? '🟢 Bullish (EMA9 > EMA21)' : '🔴 Bearish (EMA9 < EMA21)'}</span>
          </div>
          <div class="agy-lvl-item">
            <span class="agy-lvl-name">RSI Momentum</span>
            <span class="agy-lvl-val" style="color: ${indicators.rsi > 70 || indicators.rsi < 30 ? '#f0b90b' : '#848e9c'};">${indicators.rsi > 70 ? '⚠️ Overbought' : indicators.rsi < 30 ? '⚠️ Oversold' : '🟢 Neutral'} (${indicators.rsi})</span>
          </div>
          <div class="agy-lvl-item">
            <span class="agy-lvl-name">Liquidity Sweep</span>
            <span class="agy-lvl-val">${currentSignal.sweptPoolType ? `🟢 Swept ${currentSignal.sweptPoolType}` : '🔴 Awaiting Sweep'}</span>
          </div>
        `;
      }
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

      const initDist = Math.abs(activeTrade.entry - activeTrade.stopLoss);
      const currDist = Math.abs(currentTickPrice - activeTrade.stopLoss);
      let priceOpacity = 1.0;
      if (activeTrade.direction === "LONG" && currentTickPrice < activeTrade.entry) {
        priceOpacity = initDist > 0 ? currDist / initDist : 1;
      } else if (activeTrade.direction === "SHORT" && currentTickPrice > activeTrade.entry) {
        priceOpacity = initDist > 0 ? currDist / initDist : 1;
      }
      const opacity = Math.max(0.15, priceOpacity);
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
    startPnLTicker();
    startSymbolDetectionLoop();
  });
})();
