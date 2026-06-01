/**
 * Antigravity Centralized Background Service Worker (Dumb Client)
 * Connects to the headless Node.js execution backend daemon over WebSockets.
 * Relays UI states, active trades, and triggers TTS voice notifications.
 */

console.log("🛰️ Antigravity Background SW Client: Initializing dumb client...");

let socket = null;
let isConnected = false;
let activeSymbols = new Set();

function isBinanceUrl(url) {
  if (!url) return false;
  return url.includes("binance.com") || 
         url.includes("binance.me") || 
         url.includes("binance.info") || 
         url.includes("binancefuture.com") || 
         url.includes("binance.us");
}

let state = {
  settings: {
    timeframe: "5m",
    leverage: 3,
    triggerThreshold: 78,
    customStopLoss: "1.5",
    customTakeProfit: "2.0",
    targetMode: "STRUCTURAL",
    customTpSlMode: "position",
    enableTechnical: true,
    enableSMC: true,
    enableCircuitBreaker: true,
    enableAudio: true,
    enableAutoPilot: false,
    sandboxMode: true,
    alertPhone: "",
    riskAmount: 20,
    timeoutCandles: 12,
    sweepLookback: 30,
    sweepWickRatio: 0.5,
    maxSpreadPct: 0.05,
    kellyFactor: 0.25,
    maxPortfolioHeat: 0.15,
    maxPortfolioMargin: 0.30
  },
  consecutiveLosses: 0,
  journalStats: { wins: 0, losses: 0, timeouts: 0 },
  sandboxJournalStats: { wins: 0, losses: 0, timeouts: 0 },
  walletBalance: 1000,
  sandboxWalletBalance: 1000,
  activeTrades: {}
};

// Volatile local symbol contexts for HUD updates
let symbolData = {}; 

function extractSettings(items) {
  const settings = { ...state.settings };
  if (!items) return settings;
  const keys = [
    "timeframe", "leverage", "triggerThreshold", "customStopLoss", 
    "customTakeProfit", "targetMode", "customTpSlMode", "enableTechnical", 
    "enableSMC", "enableCircuitBreaker", "enableAudio", "enableAutoPilot", 
    "sandboxMode", "alertPhone", "riskAmount", "timeoutCandles",
    "sweepLookback", "sweepWickRatio", "maxSpreadPct", "kellyFactor",
    "maxPortfolioHeat", "maxPortfolioMargin"
  ];
  keys.forEach(k => {
    if (items[k] !== undefined) settings[k] = items[k];
  });
  return settings;
}

// 1. Initial State Hydration from local storage
chrome.storage.local.get(null, (items) => {
  const safeItems = items || {};
  state.settings = extractSettings(safeItems);
  if (safeItems.journalStats) state.journalStats = safeItems.journalStats;
  if (safeItems.sandboxJournalStats) state.sandboxJournalStats = safeItems.sandboxJournalStats;
  if (safeItems.consecutiveLosses !== undefined) state.consecutiveLosses = safeItems.consecutiveLosses;
  if (safeItems.walletBalance !== undefined) state.walletBalance = safeItems.walletBalance;
  if (safeItems.sandboxWalletBalance !== undefined) state.sandboxWalletBalance = safeItems.sandboxWalletBalance;

  // Restore active trades
  for (const key in safeItems) {
    if (key.startsWith('activeTrade_')) {
      const sym = key.replace('activeTrade_', '');
      state.activeTrades[sym] = safeItems[key];
    }
  }

  console.log("💾 Antigravity SW Client: Local settings & trades loaded. Connecting to backend...");
  connectBackendWebSocket();
});

// 2. Connect to headless daemon WebSocket
function connectBackendWebSocket() {
  const wsUrl = "ws://localhost:4000/ws";
  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    console.log("🔌 Connected to Antigravity Backend Execution Daemon.");
    isConnected = true;
    
    // Sync current settings to backend
    sendToBackend({
      type: "UPDATE_SETTINGS",
      settings: state.settings
    });

    // Send initial active tabs symbols subscription
    scanActiveTabs();
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case "INIT_STATE":
          // Backend authoritative stats and active trades sync (do NOT overwrite client settings from backend)
          state.journalStats = msg.state.journalStats;
          state.sandboxJournalStats = msg.state.sandboxJournalStats;
          state.consecutiveLosses = msg.state.consecutiveLosses;
          state.walletBalance = msg.state.walletBalance;
          state.sandboxWalletBalance = msg.state.sandboxWalletBalance;
          state.activeTrades = msg.state.activeTrades;
          
          chrome.storage.local.set({
            journalStats: state.journalStats,
            sandboxJournalStats: state.sandboxJournalStats,
            consecutiveLosses: state.consecutiveLosses,
            walletBalance: state.walletBalance,
            sandboxWalletBalance: state.sandboxWalletBalance
          });
          
          // Clear active trades and replace them
          chrome.storage.local.get(null, (items) => {
            const keysToRemove = Object.keys(items || {}).filter(k => k.startsWith('activeTrade_'));
            chrome.storage.local.remove(keysToRemove, () => {
              for (const sym in state.activeTrades) {
                chrome.storage.local.set({ ['activeTrade_' + sym]: state.activeTrades[sym] });
              }
            });
          });
          break;

        case "TAB_STATE_UPDATE":
          const sym = msg.symbol;
          if (msg.tabState) {
            msg.tabState.lastUpdated = Date.now(); // override with local host clock time to fix VM clock drift issues
          }
          symbolData[sym] = msg.tabState;
          chrome.storage.local.set({ ['tabState_' + sym]: msg.tabState });
          broadcastHUDUpdate(sym);
          break;

        case "SETTINGS_UPDATED":
          state.settings = msg.settings;
          // Do NOT call chrome.storage.local.set here to prevent loop. Client's local storage is already source of truth.
          break;

        case "ACTIVE_TRADES_UPDATED":
          state.activeTrades = msg.activeTrades;
          // Clear and rewrite storage active trades
          chrome.storage.local.get(null, (items) => {
            const keysToRemove = Object.keys(items || {}).filter(k => k.startsWith('activeTrade_'));
            chrome.storage.local.remove(keysToRemove, () => {
              for (const sym in state.activeTrades) {
                chrome.storage.local.set({ ['activeTrade_' + sym]: state.activeTrades[sym] });
              }
            });
          });
          break;

        case "TRADE_TRIGGERED":
          if (state.settings.enableAudio) {
            const trade = msg.trade;
            const side = trade.direction === "LONG" ? "Long entry setup" : "Short entry setup";
            const pairText = msg.symbol.replace("USDT", " U.S. Dollar. Tether.");
            const text = `Alert: ${pairText} triggering ${side} via ${trade.patternName}. Confidence is ${trade.probability} percent. Stop loss set at ${trade.stopLoss.toFixed(2)}`;
            dispatchAudioEvent(msg.symbol, { type: 'ENTRY', text });
          }
          break;

        case "TRADE_RESOLVED":
          state.journalStats = msg.journalStats;
          state.sandboxJournalStats = msg.sandboxJournalStats;
          state.consecutiveLosses = msg.consecutiveLosses;
          state.walletBalance = msg.walletBalance;
          state.sandboxWalletBalance = msg.sandboxWalletBalance;
          state.activeTrades = msg.activeTrades;

          chrome.storage.local.set({
            journalStats: state.journalStats,
            sandboxJournalStats: state.sandboxJournalStats,
            consecutiveLosses: state.consecutiveLosses,
            walletBalance: state.walletBalance,
            sandboxWalletBalance: state.sandboxWalletBalance
          });
          chrome.storage.local.remove('activeTrade_' + msg.symbol);

          // Audio triggers
          if (state.settings.enableAudio) {
            if (msg.outcome === 'WIN') {
              // Direct spoken profit booking alert
              dispatchAudioEvent(msg.symbol, { 
                type: 'SPEECH', 
                text: `Profit booked for ${msg.symbol.replace("USDT", "")}` 
              });
            } else {
              // Regular sound chime
              dispatchAudioEvent(msg.symbol, { 
                type: 'SOUND', 
                sound: msg.outcome === 'LOSS' ? 'SL_HIT' : 'EXIT_WARN' 
              });
            }
          }

          // Clean HUD overlay trade display
          broadcastHUDUpdate(msg.symbol);
          break;
      }
    } catch (e) {
      console.error("Error parsing backend message:", e);
    }
  };

  socket.onerror = (err) => {
    console.warn("Backend WebSocket error:", err);
  };

  socket.onclose = () => {
    console.warn("Backend WebSocket closed. Reconnecting in 4 seconds...");
    isConnected = false;
    setTimeout(connectBackendWebSocket, 4000);
  };
}

function sendToBackend(payload) {
  if (isConnected && socket) {
    socket.send(JSON.stringify(payload));
  }
}

// 3. Tab Scanning & Subscription Logic
function scanActiveTabs() {
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
    const currentSymbols = new Set();
    
    for (const tab of tabs) {
      if (isBinanceUrl(tab.url) && tab.url.includes("/futures/")) {
        const match = tab.url.match(/\/futures\/([A-Z0-9_]+)/i);
        if (match && match[1]) {
          const sym = match[1].toUpperCase();
          if (sym !== "USDS" && sym !== "COIN") {
            currentSymbols.add(sym);
          }
        }
      }
    }
    
    // Maintain symbols with active trades
    for (const sym in state.activeTrades) {
      currentSymbols.add(sym);
    }

    const changed = Array.from(currentSymbols).sort().join(',') !== Array.from(activeSymbols).sort().join(',');
    activeSymbols = currentSymbols;

    if (changed) {
      chrome.storage.local.set({ viewedSymbols: Array.from(activeSymbols) });
      if (isConnected) {
        console.log(`🔌 Syncing symbols subscription with backend:`, Array.from(activeSymbols));
        sendToBackend({
          type: "SUBSCRIBE_SYMBOLS",
          symbols: Array.from(activeSymbols)
        });
      }
    }
  });
}
setInterval(scanActiveTabs, 3000);

// 4. Settings Storage Listener
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  
  let settingsChanged = false;
  const keys = [
    "timeframe", "leverage", "triggerThreshold", "customStopLoss", 
    "customTakeProfit", "targetMode", "customTpSlMode", "enableTechnical", 
    "enableSMC", "enableCircuitBreaker", "enableAudio", "enableAutoPilot", 
    "sandboxMode", "alertPhone", "riskAmount", "timeoutCandles",
    "sweepLookback", "sweepWickRatio", "maxSpreadPct", "kellyFactor",
    "maxPortfolioHeat", "maxPortfolioMargin"
  ];
  
  keys.forEach(k => {
    if (changes[k]) {
      state.settings[k] = changes[k].newValue;
      settingsChanged = true;
    }
  });
  
  if (settingsChanged && isConnected) {
    sendToBackend({
      type: "UPDATE_SETTINGS",
      settings: state.settings
    });
  }

  if (changes.journalStats) state.journalStats = changes.journalStats.newValue;
  if (changes.sandboxJournalStats) state.sandboxJournalStats = changes.sandboxJournalStats.newValue;
  if (changes.consecutiveLosses !== undefined) state.consecutiveLosses = changes.consecutiveLosses.newValue;
});

// 5. Inbound communication from popup / dashboard UI pages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "OPEN_DASHBOARD") {
    const dashboardUrl = chrome.runtime.getURL("dashboard.html");
    chrome.tabs.query({ url: dashboardUrl }, (tabs) => {
      if (tabs && tabs.length > 0) {
        chrome.tabs.update(tabs[0].id, { active: true });
        chrome.windows.update(tabs[0].windowId, { focused: true });
      } else {
        chrome.tabs.create({ url: dashboardUrl });
      }
    });
    sendResponse({ success: true });
    return false;
  }

  if (request.type === "GET_HUD_DATA") {
    const sym = request.symbol;
    if (sym && symbolData[sym]) {
      sendResponse({ success: true, data: getHUDUpdatePayload(sym) });
    } else {
      sendResponse({ success: false, error: "Symbol data pending sync" });
    }
    return false;
  }

  if (request.type === "CLEAR_JOURNAL") {
    sendToBackend({ type: "CLEAR_JOURNAL" });
    sendResponse({ success: true });
    return false;
  }

  if (request.type === "FETCH_PROXY") {
    fetch(request.url, request.options || {})
      .then(r => {
        const contentType = r.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
          return r.json().then(data => ({ status: r.status, data }));
        } else {
          return r.text().then(text => ({ status: r.status, text }));
        }
      })
      .then(result => {
        sendResponse({ success: true, ...result });
      })
      .catch(err => {
        sendResponse({ success: false, error: err.message });
      });
    return true; // async
  }

  if (request.type === "MANUAL_CLOSE_TRADE") {
    sendToBackend({ type: "MANUAL_CLOSE_TRADE", symbol: request.symbol });
    sendResponse({ success: true });
    return false;
  }

  if (request.type === "ACTION_TAKEN") {
    sendToBackend({ type: "ACTION_TAKEN", symbol: request.symbol });
    sendResponse({ success: true });
    return false;
  }
});

// HUD overlays helper dispatch methods
function dispatchAudioEvent(symbol, payload) {
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
    for (const tab of tabs) {
      if (tab.url && isBinanceUrl(tab.url) && tab.url.toLowerCase().includes(symbol.toLowerCase())) {
        chrome.tabs.sendMessage(tab.id, { type: "PLAY_AUDIO", payload }).catch(() => {});
      }
    }
  });
}

function broadcastHUDUpdate(symbol) {
  const payload = getHUDUpdatePayload(symbol);
  if (!payload) return;
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
    for (const tab of tabs) {
      if (tab.url && isBinanceUrl(tab.url) && tab.url.toLowerCase().includes(symbol.toLowerCase())) {
        chrome.tabs.sendMessage(tab.id, { type: "HUD_UPDATE", symbol, payload }).catch(() => {});
      }
    }
  });
}

function getHUDUpdatePayload(symbol) {
  const sData = symbolData[symbol];
  if (!sData) return null;
  return {
    symbol,
    candles: sData.candles || [],
    lastIndicatorStates: sData.indicators || null,
    currentSignal: {
      direction: sData.direction,
      probability: sData.probability,
      patternName: sData.pattern,
      displacementScore: sData.displacementScore,
      sweptPoolType: sData.sweptPoolType,
      sweptPoolPrice: sData.sweptPoolPrice,
      mssPrice: sData.mssPrice,
      fvgTop: sData.fvgTop,
      fvgBottom: sData.fvgBottom,
      dealingRangeHigh: sData.dealingRangeHigh,
      dealingRangeLow: sData.dealingRangeLow,
      equilibrium: sData.equilibrium,
      primaryTarget: sData.primaryTarget,
      secondaryTarget: sData.secondaryTarget,
      longBias: sData.longBias,
      shortBias: sData.shortBias,
      regime: sData.regime,
      spread: sData.spread,
      orderbookImbalance: sData.orderbookImbalance,
      htfTrend: sData.htfTrend,
      pendingMssPrice: sData.pendingMssPrice,
      nearestSupport: sData.nearestSupport,
      nearestResistance: sData.nearestResistance
    },
    activeTrade: state.activeTrades[symbol] || null,
    advisorMode: state.activeTrades[symbol] ? "MONITORING" : "HUNTING",
    consecutiveLosses: state.consecutiveLosses,
    journalStats: state.journalStats,
    sandboxJournalStats: state.sandboxJournalStats
  };
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("🚀 Antigravity SW Client: Extension installed or reloaded. Refreshing active Binance tabs...");
  chrome.tabs.query({}, (tabs) => {
    if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
    for (const tab of tabs) {
      if (tab.url && isBinanceUrl(tab.url)) {
        console.log(`🔄 Auto-reloading Binance tab: ${tab.id} to refresh content script`);
        chrome.tabs.reload(tab.id);
      }
    }
  });
});

