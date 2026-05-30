/**
 * Antigravity Centralized Background Service Worker
 * Orchestrates WebSockets, REST data, indicators calculations, and trade resolutions
 * centrally. Eliminates multi-tab desyncs, double-entry queue shifts, and rate limits.
 */

console.log("🛰️ Antigravity Background SW: Initializing Centralized Architecture...");

// Load compiled TS Engine
try {
  importScripts("dist/AntigravityEngine.bundle.js");
  console.log("⚡ Antigravity SW: TS Engine Bundle successfully loaded!");
} catch (e) {
  console.error("❌ Antigravity SW: Failed to load TS Engine Bundle:", e);
}

/**
 * Returns the singleton AntigravityEngine instance.
 * Creates it if it doesn't exist (e.g. after SW restart).
 * This replaces the scattered `globalThis._swEngine` checks throughout the file.
 */
function getOrCreateEngine() {
  if (typeof AntigravityCore === 'undefined') return null;
  if (!globalThis._swEngine) {
    globalThis._swEngine = new AntigravityCore.AntigravityEngine();
    console.log('⚡ Antigravity SW: Engine instance created.');

    const engine = globalThis._swEngine;
    const logger = AntigravityCore.EventLog.getInstance();

    // Register state getter for checkpoints snapshot
    logger.registerStateGetter(() => {
      return {
        probabilityState: engine.probEngine.serializeState(),
        journalStats: state.journalStats,
        sandboxJournalStats: state.sandboxJournalStats,
        consecutiveLosses: state.consecutiveLosses,
        walletBalance: state.walletBalance,
        sandboxWalletBalance: state.sandboxWalletBalance
      };
    });

    // Register state restorer for checkpoint hydration
    logger.registerStateRestorer((snapshotState) => {
      if (!snapshotState) return;
      if (snapshotState.probabilityState) {
        engine.probEngine.deserializeState(snapshotState.probabilityState);
        console.log('⚡ Event Sourcing: Bayesian probability restored from snapshot.');
      }
      if (snapshotState.journalStats) state.journalStats = snapshotState.journalStats;
      if (snapshotState.sandboxJournalStats) state.sandboxJournalStats = snapshotState.sandboxJournalStats;
      if (snapshotState.consecutiveLosses !== undefined) state.consecutiveLosses = snapshotState.consecutiveLosses;
      if (snapshotState.walletBalance !== undefined) state.walletBalance = snapshotState.walletBalance;
      if (snapshotState.sandboxWalletBalance !== undefined) state.sandboxWalletBalance = snapshotState.sandboxWalletBalance;
      console.log('💾 Event Sourcing: State restored from snapshot checkpoint.');
    });

    // Trigger async hydration from backend SQLite DB
    logger.hydrate()
      .then(() => {
        console.log('⚡ Event Sourcing: Hydration complete from backend SQLite database.');
      })
      .catch(e => {
        console.warn('⚠️ Event Sourcing: Hydration failed:', e);
      });
  }
  return globalThis._swEngine;
}

// Extension Global States (Surviving worker updates via Chrome storage persistence)
let state = {
  settings: {
    timeframe: "5m",
    leverage: 3,
    triggerThreshold: 78,
    customStopLoss: "1.5",
    customTakeProfit: "2.0",
    targetMode: "STRUCTURAL", // STRUCTURAL vs CUSTOM
    customTpSlMode: "position", // position vs ROE
    enableTechnical: true,
    enableSMC: true,
    enableCircuitBreaker: true,
    enableAudio: true,
    enableAutoPilot: false,
    sandboxMode: true,
    alertPhone: ""
  },
  consecutiveLosses: 0,
  journalStats: { wins: 0, losses: 0, timeouts: 0 },
  sandboxJournalStats: { wins: 0, losses: 0, timeouts: 0 },
  walletBalance: 1000,
  sandboxWalletBalance: 1000,
  activeTrades: {} // Dictionary: { [symbol]: activeTrade }
};

// Symbol Specific Runtime Contexts (volatile, managed in memory, persisted partly to storage)
let symbolData = {}; 
let viewedSymbols = new Set();
let activeSockets = {};
let activePollIntervals = {};

// Helper to extract top-level settings keys
function extractSettings(items) {
  const settings = { ...state.settings };
  const keys = [
    "timeframe", "leverage", "triggerThreshold", "customStopLoss", 
    "customTakeProfit", "targetMode", "customTpSlMode", "enableTechnical", 
    "enableSMC", "enableCircuitBreaker", "enableAudio", "enableAutoPilot", 
    "sandboxMode", "alertPhone", "riskAmount", "tradeCapital", 
    "marginMode", "enableTimeout", "timeoutCandles"
  ];
  keys.forEach(k => {
    if (items[k] !== undefined) {
      settings[k] = items[k];
    }
  });
  return settings;
}

// Load states from storage on startup
chrome.storage.local.get(null, (items) => {
  state.settings = extractSettings(items);
  if (items.journalStats) state.journalStats = items.journalStats;
  if (items.sandboxJournalStats) state.sandboxJournalStats = items.sandboxJournalStats;
  if (items.consecutiveLosses !== undefined) state.consecutiveLosses = items.consecutiveLosses;
  if (items.walletBalance !== undefined) state.walletBalance = items.walletBalance;
  if (items.sandboxWalletBalance !== undefined) state.sandboxWalletBalance = items.sandboxWalletBalance;

  // Restore Bayesian probability state so learning survives SW restarts
  if (items.probabilityState && typeof AntigravityCore !== 'undefined') {
    try {
      getOrCreateEngine().probEngine.deserializeState(items.probabilityState);
      console.log('⚡ Antigravity SW: Bayesian probability state restored from storage.');
    } catch (e) {
      console.warn('⚠️ Antigravity SW: Failed to restore probability state:', e);
    }
  }

  // Re-import active trades from storage keys
  for (const key in items) {
    if (key.startsWith('activeTrade_')) {
      const sym = key.replace('activeTrade_', '');
      state.activeTrades[sym] = items[key];
    }
  }

  // Restore viewedSymbols from local storage
  if (items.viewedSymbols && Array.isArray(items.viewedSymbols)) {
    viewedSymbols = new Set(items.viewedSymbols);
    console.log("💾 Antigravity SW: Restored viewedSymbols from local storage:", items.viewedSymbols);
    for (const sym of viewedSymbols) {
      if (!activeSockets[sym]) {
        initializeSymbolContext(sym);
      }
    }
  }

  console.log("💾 Antigravity SW: Restored states from local storage.");
  scanActiveTabs(); // Immediate scan on start
});

// Sync changes across popup / dashboard writes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  
  let timeframeChanged = false;
  let sandboxModeChanged = false;
  let generalSettingsChanged = false;
  
  const keys = [
    "timeframe", "leverage", "triggerThreshold", "customStopLoss", 
    "customTakeProfit", "targetMode", "customTpSlMode", "enableTechnical", 
    "enableSMC", "enableCircuitBreaker", "enableAudio", "enableAutoPilot", 
    "sandboxMode", "alertPhone", "riskAmount", "tradeCapital", 
    "marginMode", "enableTimeout", "timeoutCandles"
  ];
  
  keys.forEach(k => {
    if (changes[k]) {
      state.settings[k] = changes[k].newValue;
      generalSettingsChanged = true;
      if (k === 'timeframe') timeframeChanged = true;
      if (k === 'sandboxMode') sandboxModeChanged = true;
    }
  });
  
  if (timeframeChanged || sandboxModeChanged) {
    restartActiveStreams();
  } else if (generalSettingsChanged) {
    for (const sym of viewedSymbols) {
      runCalculations(sym);
    }
  }
  
  if (changes.journalStats) state.journalStats = changes.journalStats.newValue;
  if (changes.sandboxJournalStats) state.sandboxJournalStats = changes.sandboxJournalStats.newValue;
  if (changes.consecutiveLosses !== undefined) state.consecutiveLosses = changes.consecutiveLosses.newValue;
});

// Periodic active symbols scanner
function scanActiveTabs() {
  chrome.tabs.query({}, (tabs) => {
    const currentSymbols = new Set();
    
    for (const tab of tabs) {
      if (tab.url && tab.url.includes("binance.com") && tab.url.includes("/futures/")) {
        const match = tab.url.match(/\/futures\/([A-Z0-9_]+)/i);
        if (match && match[1]) {
          const sym = match[1].toUpperCase();
          // Filter out typical UI strings
          if (sym !== "USDS" && sym !== "COIN") {
            currentSymbols.add(sym);
          }
        }
      }
    }
    
    // Add symbols from active trades so their WS feeds survive tab closures
    if (state && state.activeTrades) {
      for (const sym in state.activeTrades) {
        const trade = state.activeTrades[sym];
        if (trade && (trade.status === 'ACTIVE' || trade.status === 'SANDBOX_ACTIVE')) {
          currentSymbols.add(sym);
        }
      }
    }
    
    // Stop sockets/polling for symbols no longer being viewed or traded
    for (const sym of viewedSymbols) {
      if (!currentSymbols.has(sym)) {
        console.log(`🔌 Stopping WebSocket stream for inactive symbol: ${sym}`);
        if (activeSockets[sym]) {
          activeSockets[sym].close();
          delete activeSockets[sym];
        }
        if (activePollIntervals[sym]) {
          clearInterval(activePollIntervals[sym]);
          delete activePollIntervals[sym];
        }
        delete symbolData[sym];
        chrome.storage.local.remove('tabState_' + sym);
      }
    }
    
    // Start sockets/polling for newly viewed/traded symbols
    for (const sym of currentSymbols) {
      if (!viewedSymbols.has(sym) || !activeSockets[sym]) {
        initializeSymbolContext(sym);
      }
    }
    
    const prevViewedArray = Array.from(viewedSymbols).sort();
    const currentSymbolsArray = Array.from(currentSymbols).sort();
    const hasChanged = prevViewedArray.join(',') !== currentSymbolsArray.join(',');
    viewedSymbols = currentSymbols;
    if (hasChanged) {
      chrome.storage.local.set({ viewedSymbols: currentSymbolsArray });
    }
  });
}
setInterval(scanActiveTabs, 3000);

function restartActiveStreams() {
  console.log("🔄 Settings changed. Restarting all active data streams...");
  for (const sym of viewedSymbols) {
    if (activeSockets[sym]) activeSockets[sym].close();
    if (activePollIntervals[sym]) clearInterval(activePollIntervals[sym]);
    initializeSymbolContext(sym);
  }
}

// Core Inbound Communication Ingestion (Popup, Dashboard, Content Script Overlays)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "OPEN_DASHBOARD") {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
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
    const now = Date.now();
    state.journalStats = { wins: 0, losses: 0, timeouts: 0 };
    state.sandboxJournalStats = { wins: 0, losses: 0, timeouts: 0 };
    state.consecutiveLosses = 0;
    
    // Remove active trades
    state.activeTrades = {};
    chrome.storage.local.get(null, (items) => {
      const keysToRemove = [];
      for (const key in items) {
        if (key.startsWith('activeTrade_')) keysToRemove.push(key);
      }
      chrome.storage.local.remove(keysToRemove);
      chrome.storage.local.set({
        journalStats: state.journalStats,
        sandboxJournalStats: state.sandboxJournalStats,
        consecutiveLosses: 0,
        journalLastClearedTime: now
      }, () => {
        sendResponse({ success: true });
        broadcastHUDUpdates();
      });
    });
    return true;
  }

  if (request.type === "MANUAL_CLOSE_TRADE") {
    const sym = request.symbol;
    if (sym && state.activeTrades[sym]) {
      resolveActiveTrade(sym, "INVALIDATED");
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: "No active trade found" });
    }
    return false;
  }

  if (request.type === "ACTION_TAKEN") {
    const sym = request.symbol;
    if (sym && state.activeTrades[sym]) {
      markUserActionTaken(sym);
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: "No active trade to record action" });
    }
    return false;
  }

});

// Initialize Symbol Data Structure and Sync History
function initializeSymbolContext(symbol) {
  symbolData[symbol] = {
    candles: [],
    fundingRate: null,
    oiDelta: 0,
    lastOIValue: null,
    lsRatio: null,
    pdh: null,
    pdl: null,
    ema21_15m: null,
    ema21_1h: null,
    currentTickPrice: 0,
    lastIndicatorStates: { rsi: 50, ema9: 0, ema21: 0, bullishOB: 0, bearishOB: 0 },
    advisorMode: "HUNTING",
    lastWsEventTime: Date.now(),
    useSpotAPI: false,
    symbolPrecisions: { pricePrecision: 2, quantityPrecision: 3 },
    currentSignal: { direction: "WAITING", probability: 50, patternName: "Scanning", reason: "Initializing stream..." }
  };

  fetchExchangePrecision(symbol);
  fetchHistoricalCandles(symbol);
}

// Fetch Price & Volume Precisions
function fetchExchangePrecision(symbol) {
  const url = `https://fapi.binance.com/fapi/v1/exchangeInfo`;
  fetch(url)
    .then(res => res.json())
    .then(data => {
      if (data && Array.isArray(data.symbols)) {
        const info = data.symbols.find(s => s.symbol === symbol);
        if (info) {
          symbolData[symbol].symbolPrecisions = {
            pricePrecision: info.pricePrecision || 2,
            quantityPrecision: info.quantityPrecision || 3
          };
          console.log(`⚖️ Precision parsed for ${symbol}: Price ${info.pricePrecision}, Quantity ${info.quantityPrecision}`);
        }
      }
    })
    .catch(() => {});
}

// Save Candle Cache to Chrome Storage
function saveCandleCache(symbol) {
  const data = symbolData[symbol];
  if (!data || !Array.isArray(data.candles) || data.candles.length === 0) return;
  const interval = state.settings.timeframe;
  const key = `candleCache_${symbol}_${interval}`;
  chrome.storage.local.set({ [key]: data.candles });
}

// Fetch Initial Historical Candles with Cache and Gap-Fill
function fetchHistoricalCandles(symbol) {
  const limit = 150;
  const interval = state.settings.timeframe;
  const cacheKey = `candleCache_${symbol}_${interval}`;

  chrome.storage.local.get([cacheKey], (items) => {
    const cachedCandles = items[cacheKey];

    if (Array.isArray(cachedCandles) && cachedCandles.length > 0) {
      const lastCandle = cachedCandles[cachedCandles.length - 1];
      const gapMs = Date.now() - lastCandle.time;
      const intervalMs = timeframeToMs(interval);
      const gapIntervals = gapMs / intervalMs;

      if (gapIntervals < limit) {
        console.log(`🔌 Candle cache found for ${symbol} (${interval}). Gap is ${Math.round(gapIntervals)} candles. Performing gap-fill...`);
        // We fetch starting from the last candle's open time to overlap and update the last unclosed candle
        const startTime = lastCandle.time;
        const futuresUrl = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}`;
        const spotUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}`;

        fetch(futuresUrl)
          .then(res => {
            if (!res.ok) throw new Error("Futures blocked");
            symbolData[symbol].useSpotAPI = false;
            return res.json();
          })
          .catch(() => {
            symbolData[symbol].useSpotAPI = true;
            return fetch(spotUrl).then(res => res.json());
          })
          .then(data => {
            if (!Array.isArray(data)) {
              fallbackToFullFetch(symbol);
              return;
            }

            const merged = [...cachedCandles];
            data.forEach(c => {
              const time = parseInt(c[0]);
              const parsed = {
                time,
                open: parseFloat(c[1]),
                high: parseFloat(c[2]),
                low: parseFloat(c[3]),
                close: parseFloat(c[4]),
                volume: parseFloat(c[5])
              };
              const existingIdx = merged.findIndex(mc => mc.time === time);
              if (existingIdx !== -1) {
                merged[existingIdx] = parsed;
              } else {
                merged.push(parsed);
              }
            });

            merged.sort((a, b) => a.time - b.time);
            if (merged.length > 200) {
              merged.splice(0, merged.length - 200);
            }

            symbolData[symbol].candles = merged;
            if (merged.length > 0) {
              symbolData[symbol].currentTickPrice = merged[merged.length - 1].close;
            }
            console.log(`📊 History loaded via gap-fill: ${merged.length} candles for ${symbol}`);
            saveCandleCache(symbol);

            // Start socket and polling
            connectWebSocket(symbol);
            fetchRestMarketData(symbol);

            if (activePollIntervals[symbol]) clearInterval(activePollIntervals[symbol]);
            activePollIntervals[symbol] = setInterval(() => fetchRestMarketData(symbol), 5 * 60 * 1000);
          })
          .catch(err => {
            console.warn(`⚠️ Gap-fill failed for ${symbol}, falling back to full fetch:`, err.message);
            fallbackToFullFetch(symbol);
          });
        return;
      }
    }

    // No cache or gap too large -> full fetch
    fallbackToFullFetch(symbol);
  });
}

function fallbackToFullFetch(symbol) {
  const limit = 150;
  const interval = state.settings.timeframe;
  const futuresUrl = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const spotUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

  fetch(futuresUrl)
    .then(res => {
      if (!res.ok) throw new Error("Futures blocked");
      symbolData[symbol].useSpotAPI = false;
      return res.json();
    })
    .catch(() => {
      symbolData[symbol].useSpotAPI = true;
      return fetch(spotUrl).then(res => res.json());
    })
    .then(data => {
      if (!Array.isArray(data)) return;
      symbolData[symbol].candles = data.map(c => ({
        time: parseInt(c[0]),
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        volume: parseFloat(c[5])
      }));

      const len = symbolData[symbol].candles.length;
      if (len > 0) {
        symbolData[symbol].currentTickPrice = symbolData[symbol].candles[len - 1].close;
      }
      console.log(`📊 Full history loaded: ${len} candles for ${symbol}`);
      saveCandleCache(symbol);

      // Start socket and polling
      connectWebSocket(symbol);
      fetchRestMarketData(symbol);

      if (activePollIntervals[symbol]) clearInterval(activePollIntervals[symbol]);
      activePollIntervals[symbol] = setInterval(() => fetchRestMarketData(symbol), 5 * 60 * 1000);
    })
    .catch(err => {
      console.error(`❌ Failed to sync full history for ${symbol}:`, err.message);
      setTimeout(() => initializeSymbolContext(symbol), 5000);
    });
}

// Fetch Premium, Funding, OpenInterest & HTF alignment candles
function fetchRestMarketData(symbol) {
  const sym = symbol.toUpperCase();
  const data = symbolData[symbol];
  if (!data) return;

  // 1. Funding
  fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`)
    .then(r => r.json())
    .then(d => { data.fundingRate = parseFloat(d.lastFundingRate); })
    .catch(() => { data.fundingRate = null; });

  // 2. Open Interest
  fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}`)
    .then(r => r.json())
    .then(d => {
      const oi = parseFloat(d.openInterest);
      if (data.lastOIValue !== null) data.oiDelta = oi - data.lastOIValue;
      data.lastOIValue = oi;
    })
    .catch(() => {});

  // 3. L/S Ratio
  fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=5m&limit=1`)
    .then(r => r.json())
    .then(d => {
      if (Array.isArray(d) && d.length > 0) data.lsRatio = parseFloat(d[0].longShortRatio);
    })
    .catch(() => { data.lsRatio = null; });

  // 4. Daily Candles
  const dailyUrl = data.useSpotAPI
    ? `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1d&limit=2`
    : `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1d&limit=2`;
  fetch(dailyUrl)
    .then(r => r.json())
    .then(d => {
      if (Array.isArray(d) && d.length >= 2) {
        data.pdh = parseFloat(d[0][2]);
        data.pdl = parseFloat(d[0][3]);
      }
    })
    .catch(() => {});

  // 5. 15m HTF
  const url15m = data.useSpotAPI
    ? `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=15m&limit=30`
    : `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=15m&limit=30`;
  fetch(url15m)
    .then(r => r.json())
    .then(d => {
      if (Array.isArray(d) && d.length >= 21) {
        const closes = d.map(c => parseFloat(c[4]));
        const k = 2 / 22;
        let ema = closes[0];
        for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
        data.ema21_15m = ema;
      }
    })
    .catch(() => { data.ema21_15m = null; });

  // 6. 1h HTF
  const url1h = data.useSpotAPI
    ? `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1h&limit=30`
    : `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1h&limit=30`;
  fetch(url1h)
    .then(r => r.json())
    .then(d => {
      if (Array.isArray(d) && d.length >= 21) {
        const closes = d.map(c => parseFloat(c[4]));
        const k = 2 / 22;
        let ema = closes[0];
        for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
        data.ema21_1h = ema;
      }
    })
    .catch(() => { data.ema21_1h = null; });
}

// Connect Symbol Stream Sockets
function connectWebSocket(symbol) {
  const symLower = symbol.toLowerCase();
  const wsHost = (symbolData[symbol].useSpotAPI) ? "stream.binance.com" : "fstream.binance.com";
  const wsPath = (symbolData[symbol].useSpotAPI) ? "/stream" : "/market/stream";
  const tfStream = state.settings.timeframe === '1m'
    ? `${symLower}@kline_1m`
    : `${symLower}@kline_${state.settings.timeframe}/${symLower}@kline_1m`;
  
  const wsUrl = `wss://${wsHost}${wsPath}?streams=${tfStream}`;
  
  if (activeSockets[symbol]) {
    try { activeSockets[symbol].close(); } catch(e) {}
  }

  const ws = new WebSocket(wsUrl);
  activeSockets[symbol] = ws;

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const stream = data.stream;
      const payload = data.data;
      const isTfStream = stream.includes(`kline_${state.settings.timeframe}`);
      const is1mStream = stream.includes('kline_1m');
      const is1mTimeframe = state.settings.timeframe === '1m';
      
      const sData = symbolData[symbol];
      if (!sData) return;

      if (payload && payload.E) {
        sData.lastWsEventTime = parseInt(payload.E);
      }

      if (is1mStream) {
        sData.currentTickPrice = parseFloat(payload.k.c);
        if (sData.candles.length > 0) {
          const lastCandle = sData.candles[sData.candles.length - 1];
          lastCandle.close = sData.currentTickPrice;
          if (sData.currentTickPrice > lastCandle.high) lastCandle.high = sData.currentTickPrice;
          if (sData.currentTickPrice < lastCandle.low) lastCandle.low = sData.currentTickPrice;
        }
        trackActiveTradeLive(symbol);
      }

      if (isTfStream) {
        const k = payload.k;
        const candleTime = parseInt(k.t);
        const latestCandle = {
          time: candleTime,
          open: parseFloat(k.o),
          high: parseFloat(k.h),
          low: parseFloat(k.l),
          close: parseFloat(k.c),
          volume: parseFloat(k.v)
        };

        let candleAdded = false;
        if (sData.candles.length > 0 && sData.candles[sData.candles.length - 1].time === candleTime) {
          sData.candles[sData.candles.length - 1] = latestCandle;
        } else {
          sData.candles.push(latestCandle);
          if (sData.candles.length > 200) sData.candles.shift();
          candleAdded = true;
          
          const activeTrade = state.activeTrades[symbol];
          if (activeTrade && (activeTrade.status === "ACTIVE" || activeTrade.status === "SANDBOX_ACTIVE")) {
            activeTrade.elapsedCandles = Math.round(
              (candleTime - activeTrade.triggerTime) / timeframeToMs(activeTrade.timeframe || state.settings.timeframe)
            );
            const limit = state.settings.timeoutCandles !== undefined ? parseInt(state.settings.timeoutCandles) : 12;
            if (activeTrade.elapsedCandles >= limit) {
              resolveActiveTrade(symbol, "TIMEOUT");
            } else {
              chrome.storage.local.set({ ['activeTrade_' + symbol]: activeTrade });
            }
          }
        }

        if (candleAdded || k.x) {
          saveCandleCache(symbol);
        }
        runCalculations(symbol);
      } else if (!isTfStream && is1mStream && !is1mTimeframe) {
        runCalculations(symbol);
      }
    } catch (err) {
      console.error("SW error parsing WS frame:", err);
    }
  };

  ws.onerror = () => {
    console.warn(`WebSocket error on ${symbol}, restarting...`);
  };

  ws.onclose = () => {
    if (activeSockets[symbol] === ws) {
      setTimeout(() => connectWebSocket(symbol), 4000);
    }
  };
}

function computeSweepQuality(candles, sweeps) {
  if (!sweeps.bullishSweep && !sweeps.bearishSweep) return 0;
  let quality = 50;
  const cc = candles[candles.length - 1];
  const range = cc.high - cc.low;
  if (range > 0) {
    if (sweeps.bullishSweep && (cc.close - cc.low) / range > 0.65) quality += 25;
    if (sweeps.bearishSweep && (cc.high - cc.close) / range > 0.65) quality += 25;
  }
  const recentVols = candles.slice(-21, -1).map(c => c.volume);
  const avgVol = recentVols.reduce((s, v) => s + v, 0) / Math.max(1, recentVols.length);
  if (cc.volume > avgVol * 1.5) quality += 15;
  return Math.min(100, quality);
}

function computePositionSize(entry, stopLoss) {
  const riskAmount = parseFloat(state.settings.riskAmount) || 20;
  const riskPerUnit = Math.abs(entry - stopLoss);
  if (riskPerUnit <= 0 || !Number.isFinite(entry)) return 0;
  return riskPerUnit > 0 ? riskAmount / riskPerUnit : 0;
}

function persistSignalToApi(payload) {
  return fetch('http://localhost:4000/api/advisor/signals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(async (res) => {
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`[Advisor API] POST signals failed: ${res.status}`, errText);
      return null;
    }
    return res.json();
  }).catch((err) => {
    console.warn('[Advisor API] POST signals unreachable:', err.message);
    return null;
  });
}

// Core Math Calculations Loop
function runCalculations(symbol) {
  const data = symbolData[symbol];
  if (!data || data.candles.length < 50) return;

  const closes = data.candles.map(c => c.close);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const rsi = calculateRSI(closes, 14);
  const macdData = calculateMACD(closes);

  const curClose = closes[closes.length - 1];
  const curEma9 = ema9[ema9.length - 1];
  const curEma21 = ema21[ema21.length - 1];
  const curRsi = rsi[rsi.length - 1];

  const orderBlocks = detectOrderBlocks(data.candles);
  const fvg = detectFVG(data.candles);
  const sweeps = detectLiquiditySweep(data.candles);

  data.lastIndicatorStates = {
    rsi: Math.round(curRsi),
    ema9: curEma9,
    ema21: curEma21,
    bullishOB: orderBlocks.bullish.filter(ob => ob.unmitigated).length,
    bearishOB: orderBlocks.bearish.filter(ob => ob.unmitigated).length
  };

  // Switch advisor mode
  const activeTrade = state.activeTrades[symbol];
  const positionActive = !!(activeTrade && (activeTrade.status === "ACTIVE" || activeTrade.status === "SANDBOX_ACTIVE"));
  if (positionActive) {
    data.advisorMode = "MONITORING";
  } else {
    data.advisorMode = "HUNTING";
  }

  // --- Constraint engine (single evaluation path) ---
  let ctx = null;
  data.dagDecision = null;
  const engine = getOrCreateEngine();
  if (!engine) {
    data.currentSignal = {
      direction: "WAITING",
      probability: 0,
      patternName: "CRITICAL HALT",
      reason: "Antigravity Engine not loaded",
      triggerCatalyst: "System halted to prevent unvalidated execution."
    };
    broadcastHUDUpdate(symbol);
    throw new Error(`Antigravity Engine is not initialized. Halted execution for ${symbol}.`);
  }

  try {
    const { MarketRegime, MarketState } = AntigravityCore;

    const atrValues = calculateATR(data.candles, 14);
    const curAtr = atrValues[atrValues.length - 1] || 0;
    let atrRank = 50;
    let isExpanding = false;
    let isCompressing = false;
    if (atrValues.length > 20) {
      const recentAtrs = atrValues.slice(-100);
      const smaller = recentAtrs.filter(val => val < curAtr).length;
      atrRank = Math.round((smaller / recentAtrs.length) * 100);
      const avgAtr20 = atrValues.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, atrValues.length);
      isExpanding = curAtr > avgAtr20 * 1.15;
      isCompressing = curAtr < avgAtr20 * 0.85;
    }

    const htfDataReady = data.ema21_15m !== null && data.ema21_1h !== null;
    const htfAligned = htfDataReady
      ? ((curClose > data.ema21_15m && curClose > data.ema21_1h && curEma9 > curEma21) ||
         (curClose < data.ema21_15m && curClose < data.ema21_1h && curEma9 < curEma21))
      : false;

    const dateObj = new Date(data.lastWsEventTime);
    const utcDec = dateObj.getUTCHours() + dateObj.getUTCMinutes() / 60;
    let sessionName = 'ASIA';
    let isOverlapSession = false;
    if (utcDec >= 8 && utcDec < 14) sessionName = 'LONDON';
    else if (utcDec >= 14 && utcDec < 21) sessionName = 'NEW_YORK';
    else if (utcDec >= 21 || utcDec < 2) sessionName = 'POST_NY_CHOP';
    if (utcDec >= 13 && utcDec <= 14) isOverlapSession = true;

    const emaDiff = Math.abs(curEma9 - curEma21);
    const emaPct = (emaDiff / curClose) * 100;
    const trendDir = emaPct < 0.05 ? 'SIDEWAYS' : (curEma9 > curEma21 ? 'UP' : 'DOWN');
    const trendStrength = Math.min(100, Math.round(emaPct * 400));

    const hasSweep = sweeps.bullishSweep || sweeps.bearishSweep;
    const marketState = data.advisorMode === "MONITORING"
      ? MarketState.NO_TRADE
      : (hasSweep ? MarketState.EXECUTION_WINDOW : MarketState.NO_TRADE);

    // Note: spread is synthetic (no real order-book data available in the extension).
    // The SPREAD_EXPLOSION circuit breaker is disabled (maxSpreadToAtrRatio = Infinity)
    // until real spread data is available.
    const draftCtx = {
      timestamp: data.lastWsEventTime,
      symbol: symbol,
      // regime is intentionally omitted — the engine classifies it from the other fields
      marketState,
      positionActive,
      volatility: { atr: curAtr, isExpanding, isCompressing, historicalRank: atrRank },
      liquidityState: {
        hasSweep,
        sweepQuality: computeSweepQuality(data.candles, sweeps),
        recentSweepDirection: sweeps.bullishSweep ? 'BULLISH' : sweeps.bearishSweep ? 'BEARISH' : null
      },
      trendState: { direction: trendDir, strength: trendStrength, htfAlignment: htfAligned },
      sessionState: {
        currentSession: sessionName,
        isOverlap: isOverlapSession,
        minutesIntoSession: dateObj.getUTCMinutes()
      },
      displacementQuality: hasSweep ? Math.min(100, computeSweepQuality(data.candles, sweeps)) : 0,
      spread: Math.max(curClose * 0.0001, curAtr * 0.02),
      // confidence is set by the engine from the Bayesian posterior — do not set here
      confidence: 50,
      currentPrice: curClose
    };

    const evaluation = engine.evaluateMarket(draftCtx);
    ctx = evaluation.context;
    data.lastRegime = ctx.regime;

    if (evaluation.halted) {
      data.dagDecision = {
        tradeEligible: false,
        failedConstraints: ['CircuitBreaker'],
        passedConstraints: [],
        failureReasons: [evaluation.haltReason || 'Circuit breaker'],
        finalConfidence: 0,
        individualEvaluations: [],
        totalEvaluationTime: 0,
        deterministicHash: ''
      };
    } else {
      data.dagDecision = evaluation.decision;
    }
  } catch (err) {
    console.error(`SW: Constraint engine evaluation error for ${symbol}:`, err);
    data.currentSignal = {
      direction: "WAITING",
      probability: 0,
      patternName: "CRITICAL HALT",
      reason: `Engine error: ${err.message || err}`,
      triggerCatalyst: "System halted to prevent unvalidated execution."
    };
    broadcastHUDUpdate(symbol);
    throw err;
  }

  // --- RUN LIVE MODEL SCORING ---
  if (data.advisorMode === "MONITORING") {
    runExitCalculations(symbol, curClose, curEma9, curEma21, curRsi, orderBlocks, sweeps);
  } else {
    data.closeSignal = { active: false, confidence: 0, reason: "", triggerCatalyst: "" };
    runAnalyzingCalculations(symbol, curClose, curEma9, curEma21, curRsi, macdData, orderBlocks, fvg, sweeps, ctx);
  }

  // Save tabState to chrome.storage.local so the dashboard receives it
  const tabState = {
    symbol: symbol,
    direction: data.currentSignal ? data.currentSignal.direction : "WAITING",
    probability: data.currentSignal ? data.currentSignal.probability : 50,
    pattern: data.currentSignal ? data.currentSignal.patternName : "Scanning",
    currentTickPrice: data.currentTickPrice || curClose,
    indicators: {
      rsi: data.lastIndicatorStates ? data.lastIndicatorStates.rsi : Math.round(curRsi),
      ema9: curEma9,
      ema21: curEma21,
      bullishOB: data.lastIndicatorStates ? data.lastIndicatorStates.bullishOB : 0,
      bearishOB: data.lastIndicatorStates ? data.lastIndicatorStates.bearishOB : 0
    },
    lastUpdated: Date.now()
  };
  chrome.storage.local.set({ ['tabState_' + symbol]: tabState });

  broadcastHUDUpdate(symbol);
}

function runAnalyzingCalculations(symbol, curClose, curEma9, curEma21, curRsi, macdData, orderBlocks, fvg, sweeps, ctx) {
  const data = symbolData[symbol];
  const macdLine = macdData.macd[macdData.macd.length - 1];
  const signalLine = macdData.signal[macdData.signal.length - 1];

  let trendScore = 0;
  let smcScore = 0;
  let momentumScore = 0;
  let reasons = [];
  let activePattern = "Scanning Range";

  // Trend Score
  if (state.settings.enableTechnical) {
    if (curClose > curEma21) {
      trendScore += 10;
      if (curEma9 > curEma21) trendScore += 15;
    } else {
      trendScore -= 10;
      if (curEma9 < curEma21) trendScore -= 15;
    }
  }

  // Session Filter
  const utcDecimal = new Date(data.lastWsEventTime).getUTCHours() + new Date(data.lastWsEventTime).getUTCMinutes() / 60;
  if (utcDecimal >= 13 && utcDecimal < 14) {
    trendScore += 15; reasons.push("London/NY Overlap — Peak Liquidity");
  } else if (utcDecimal >= 8 && utcDecimal < 10) {
    trendScore += 15; reasons.push("London Core Session");
  } else if (utcDecimal >= 14 && utcDecimal < 17) {
    trendScore += 10; reasons.push("NY Session Active");
  } else if (utcDecimal >= 7 && utcDecimal < 8) {
    trendScore += 5; reasons.push("Pre-London Caution");
  } else if (utcDecimal >= 2 && utcDecimal < 4) {
    reasons.push("Tokyo Open — Neutral");
  } else if (utcDecimal >= 17 && utcDecimal < 21) {
    trendScore -= 5; reasons.push("NY Afternoon Drift — Fading Volume");
  } else if (utcDecimal >= 0 && utcDecimal < 2) {
    trendScore -= 10; reasons.push("Midnight Dead Zone — No Liquidity");
  } else if (utcDecimal >= 4 && utcDecimal < 7) {
    trendScore -= 10; reasons.push("Asia Dead Zone — Low Volume");
  }

  // HTF Trend Coherence
  if (data.ema21_15m !== null && data.ema21_1h !== null) {
    const bullish5m = curClose > curEma21;
    const bullish15m = curClose > data.ema21_15m;
    const bullish1h = curClose > data.ema21_1h;
    if (bullish5m && bullish15m && bullish1h) {
      trendScore += 15; reasons.push('MTF Aligned — All Bullish');
    } else if (!bullish5m && !bullish15m && !bullish1h) {
      trendScore -= 15; reasons.push('MTF Aligned — All Bearish');
    } else {
      const htfBias = bullish15m && bullish1h ? 'Bullish' : (!bullish15m && !bullish1h) ? 'Bearish' : 'Mixed';
      if (htfBias !== 'Mixed') {
        trendScore -= 10; reasons.push(`MTF Divergence — Counter-Trend (HTF ${htfBias})`);
      } else {
        reasons.push('MTF Mixed — No Clear HTF Trend');
      }
    }
  } else {
    reasons.push('MTF Data Pending');
  }

  // SMC Calculations
  if (state.settings.enableSMC) {
    if (sweeps.bullishSweep) {
      smcScore += 35; activePattern = "Liquidity Sweep Reversal"; reasons.push("Bullish Sweep");
      if (fvg.bullishGap) { smcScore += 15; reasons.push("Bullish FVG Displacement"); }
    } else if (sweeps.bearishSweep) {
      smcScore -= 35; activePattern = "Liquidity Sweep Reversal"; reasons.push("Bearish Sweep");
      if (fvg.bearishGap) { smcScore -= 15; reasons.push("Bearish FVG Displacement"); }
    }

    const inBullishOB = orderBlocks.bullish.some(ob => curClose >= ob.low && curClose <= ob.high && ob.unmitigated);
    const inBearishOB = orderBlocks.bearish.some(ob => curClose >= ob.low && curClose <= ob.high && ob.unmitigated);
    if (inBullishOB) { smcScore += 20; reasons.push("OB Support Hold"); if (activePattern === "Scanning Range") activePattern = "Bullish OB Hold"; }
    if (inBearishOB) { smcScore -= 20; reasons.push("OB Resistance Hold"); if (activePattern === "Scanning Range") activePattern = "Bearish OB Hold"; }

    if (fvg.bullishGap && curClose >= fvg.bullishGap.low && curClose <= fvg.bullishGap.high) {
      smcScore += 10; reasons.push("FVG Support Refill");
    }
    if (fvg.bearishGap && curClose >= fvg.bearishGap.low && curClose <= fvg.bearishGap.high) {
      smcScore -= 10; reasons.push("FVG Resistance Refill");
    }

    // Volume Spike
    const recentVols = data.candles.slice(-21, -1).map(c => c.volume);
    const avgVol = recentVols.reduce((s, v) => s + v, 0) / Math.max(1, recentVols.length);
    const curVol = data.candles[data.candles.length - 1].volume;
    if (sweeps.bullishSweep || sweeps.bearishSweep) {
      if (curVol > avgVol * 1.5) { smcScore += 15; reasons.push("Volume Confirmed Sweep"); }
      else if (curVol < avgVol * 0.8) { smcScore -= 10; reasons.push("Low Volume Sweep"); }
    }

    // Candle Wick Ratio
    const cc = data.candles[data.candles.length - 1];
    const candleRange = cc.high - cc.low;
    if (candleRange > 0) {
      if (sweeps.bullishSweep && (cc.close - cc.low) / candleRange > 0.65) { smcScore += 10; reasons.push("Strong Wick Rejection"); }
      if (sweeps.bearishSweep && (cc.high - cc.close) / candleRange > 0.65) { smcScore -= 10; reasons.push("Strong Bearish Wick"); }
    }

    // Zones midpoints
    const rangeHigh = Math.max(...data.candles.slice(-50).map(c => c.high));
    const rangeLow = Math.min(...data.candles.slice(-50).map(c => c.low));
    const midpoint = (rangeHigh + rangeLow) / 2;
    if (sweeps.bullishSweep) {
      if (curClose < midpoint) { smcScore += 12; reasons.push("Buying in Discount Zone"); }
      else { smcScore -= 12; reasons.push("Buying in Premium"); }
    }
    if (sweeps.bearishSweep) {
      if (curClose > midpoint) { smcScore -= 12; reasons.push("Selling in Premium Zone"); }
      else { smcScore += 12; reasons.push("Selling in Discount"); }
    }

    // Equal Highs / Lows
    const lookback30 = data.candles.slice(-31, -1);
    let eqHighs = false, eqLows = false, eqH = 0, eqL = 0;
    for (let i = 0; i < lookback30.length; i++) {
      for (let j = i + 1; j < lookback30.length; j++) {
        if (Math.abs(lookback30[i].high - lookback30[j].high) / lookback30[i].high < 0.0008) { eqHighs = true; eqH = (lookback30[i].high + lookback30[j].high)/2; }
        if (Math.abs(lookback30[i].low - lookback30[j].low) / lookback30[i].low < 0.0008) { eqLows = true; eqL = (lookback30[i].low + lookback30[j].low)/2; }
      }
    }
    if (sweeps.bullishSweep && eqLows && Math.abs(curClose - eqL) / curClose < 0.01) { smcScore += 8; reasons.push("Equal Lows Swept"); }
    if (sweeps.bearishSweep && eqHighs && Math.abs(curClose - eqH) / curClose < 0.01) { smcScore -= 8; reasons.push("Equal Highs Swept"); }
  }

  // Momentum
  if (state.settings.enableTechnical) {
    if (curRsi < 32) { momentumScore += 20; reasons.push("RSI Oversold Pivot"); }
    else if (curRsi > 68) { momentumScore -= 20; reasons.push("RSI Overbought Pivot"); }
    if (macdLine > signalLine) momentumScore += 10;
    else momentumScore -= 10;
  }

  // Circuit Breaker halving
  if (state.settings.enableCircuitBreaker) {
    if (state.consecutiveLosses >= 3) {
      data.currentSignal = {
        direction: "WAITING",
        probability: 50,
        patternName: "Circuit Breaker Active",
        reason: `Bot paused: ${state.consecutiveLosses} consecutive losses. Reset required.`,
        triggerCatalyst: `Circuit Breaker active due to ${state.consecutiveLosses} losses.`
      };
      return;
    }
    if (state.consecutiveLosses === 2) {
      trendScore *= 0.5; smcScore *= 0.5; momentumScore *= 0.5;
      reasons.push("⚠️ Warning: 2 Consecutive Losses — Score Halved");
    }
  }

  // Volatility Gate
  const atrValues = calculateATR(data.candles, 14);
  const atr14 = atrValues[atrValues.length - 1] || 0.1;
  const cc = data.candles[data.candles.length - 1];
  const prevCc = data.candles[data.candles.length - 2];
  let currentRange = cc.high - cc.low;
  if (prevCc) currentRange = Math.max(currentRange, Math.abs(cc.high - prevCc.close), Math.abs(cc.low - prevCc.close));

  if (currentRange < 0.3 * atr14) {
    data.currentSignal = {
      direction: "WAITING",
      probability: 50,
      patternName: "Choppy — No Signal",
      reason: "ATR Gate: Choppy Market — no edge",
      triggerCatalyst: "ATR Gate triggered: range below 30% of ATR14."
    };
    return;
  }

  if (currentRange > 2.0 * atr14) {
    smcScore -= 20; reasons.push("ATR Gate: News Spike Risk");
  }

  const threshold = state.settings.triggerThreshold !== undefined ? state.settings.triggerThreshold : 78;
  const useCustom = state.settings.targetMode === 'CUSTOM';

  // --- Constraint DAG gate ---
  if (!data.dagDecision) {
    throw new Error(`State divergence detected: dagDecision is null for ${symbol}. Fail closed.`);
  }

  const isEligible = data.dagDecision.tradeEligible;
  const failedList = data.dagDecision.failedConstraints || [];
  const failReasons = data.dagDecision.failureReasons || [];

  // Confidence resolution: strictly use the Bayesian point estimate
  const effectiveConfidence = Math.max(0, Math.min(data.dagDecision.finalConfidence, 100));

  data.currentSignal = {
    direction: "WAITING",
    probability: effectiveConfidence,
    patternName: activePattern,
    reason: isEligible
      ? (reasons.slice(0, 2).join(" + ") || "Constraint gate passed")
      : (failReasons[0] || (failedList.length > 0 ? `Blocked: ${failedList.join(', ')}` : "Awaiting setup...")),
    triggerCatalyst: `Conf: ${effectiveConfidence}% (bayesian). Passed: [${(data.dagDecision.passedConstraints || []).join(', ')}]. Failed: [${failedList.join(', ')}]`,
    confidenceBreakdown: { trend: Math.abs(trendScore), smc: Math.abs(smcScore), momentum: Math.abs(momentumScore) }
  };

  const meetsThreshold = effectiveConfidence >= threshold;
  if (isEligible && meetsThreshold && ctx && ctx.trendState) {
    const intendedDirection = ctx.trendState.direction === 'UP' ? 'LONG' : (ctx.trendState.direction === 'DOWN' ? 'SHORT' : 'WAITING');
    if (intendedDirection !== 'WAITING') {
      // Run Execution Safety check
      let entryPrice = curClose;
      if (globalThis._swEngine && globalThis._swEngine.safetyLayer) {
        const safety = globalThis._swEngine.safetyLayer.validateExecution(ctx, intendedDirection, curClose);
        if (!safety.safe) {
          data.currentSignal = {
            direction: "WAITING",
            probability: effectiveConfidence,
            patternName: activePattern,
            reason: safety.reason || "Execution safety limit exceeded",
            triggerCatalyst: `Rejection: ${safety.reason}`,
            confidenceBreakdown: { trend: Math.abs(trendScore), smc: Math.abs(smcScore), momentum: Math.abs(momentumScore) }
          };
          return;
        }
        entryPrice = safety.adjustedEntryPrice;
      }

      data.currentSignal.direction = intendedDirection;
      data.currentSignal.probability = effectiveConfidence;
      data.currentSignal.entry = entryPrice;

      if (useCustom) {
        const lev = parseFloat(state.settings.leverage) || 3;
        const isPos = state.settings.customTpSlMode === 'position';
        const slP = isPos ? parseFloat(state.settings.customStopLoss) : parseFloat(state.settings.customStopLoss) / lev;
        const tpP = isPos ? parseFloat(state.settings.customTakeProfit) : parseFloat(state.settings.customTakeProfit) / lev;

        if (intendedDirection === 'LONG') {
          data.currentSignal.stopLoss = entryPrice * (1 - (slP / 100));
          data.currentSignal.target1 = entryPrice * (1 + (tpP / 100));
        } else {
          data.currentSignal.stopLoss = entryPrice * (1 + (slP / 100));
          data.currentSignal.target1 = entryPrice * (1 - (tpP / 100));
        }
        data.currentSignal.target2 = data.currentSignal.target1;
      } else {
        if (intendedDirection === 'LONG') {
          const closestOB = orderBlocks.bullish.filter(ob => ob.unmitigated).pop();
          const sLow = closestOB ? closestOB.low : Math.min(data.candles[data.candles.length - 2].low, data.candles[data.candles.length - 1].low);
          data.currentSignal.stopLoss = Math.max(sLow, entryPrice * 0.985);
          const risk = data.currentSignal.entry - data.currentSignal.stopLoss;
          data.currentSignal.target1 = data.currentSignal.entry + risk * 1.5;
        } else {
          const closestOB = orderBlocks.bearish.filter(ob => ob.unmitigated).pop();
          const sHigh = closestOB ? closestOB.high : Math.max(data.candles[data.candles.length - 2].high, data.candles[data.candles.length - 1].high);
          data.currentSignal.stopLoss = Math.min(sHigh, entryPrice * 1.015);
          const risk = data.currentSignal.stopLoss - data.currentSignal.entry;
          data.currentSignal.target1 = data.currentSignal.entry - risk * 1.5;
        }
      }
      applyTarget2(data.currentSignal, intendedDirection);
      autoRegisterActiveTrade(symbol);
    }
  }
}

function runExitCalculations(symbol, curClose, curEma9, curEma21, curRsi, orderBlocks, sweeps) {
  const activeTrade = state.activeTrades[symbol];
  if (!activeTrade) return;

  let exitScore = 0;
  let reasons = [];
  const isLong = activeTrade.direction === "LONG";

  if (isLong) {
    if (curEma9 < curEma21) { exitScore += 40; reasons.push("EMA Cross"); }
    if (sweeps.bearishSweep) { exitScore += 40; reasons.push("Opposing Sweep"); }
    const inBearishOB = orderBlocks.bearish.some(ob => curClose >= ob.low && curClose <= ob.high && ob.unmitigated);
    if (inBearishOB) { exitScore += 20; reasons.push("OB Resistance"); }
  } else {
    if (curEma9 > curEma21) { exitScore += 40; reasons.push("EMA Cross"); }
    if (sweeps.bullishSweep) { exitScore += 40; reasons.push("Opposing Sweep"); }
    const inBullishOB = orderBlocks.bullish.some(ob => curClose >= ob.low && curClose <= ob.high && ob.unmitigated);
    if (inBullishOB) { exitScore += 20; reasons.push("OB Support"); }
  }

  symbolData[symbol].closeSignal = {
    active: exitScore >= 40,
    confidence: exitScore,
    reason: reasons.join(" + "),
    triggerCatalyst: `Reversal indicators hit exit confidence: ${exitScore}%. Opposing factors: ${reasons.join(', ')}`
  };
}

// Track active trade matches live
function trackActiveTradeLive(symbol) {
  const activeTrade = state.activeTrades[symbol];
  const sData = symbolData[symbol];
  if (!activeTrade || !sData) return;

  const price = sData.currentTickPrice;
  if (activeTrade.direction === "LONG") {
    if (price >= activeTrade.target1) resolveActiveTrade(symbol, "WIN");
    else if (price <= activeTrade.stopLoss) resolveActiveTrade(symbol, "LOSS");
  } else {
    if (price <= activeTrade.target1) resolveActiveTrade(symbol, "WIN");
    else if (price >= activeTrade.stopLoss) resolveActiveTrade(symbol, "LOSS");
  }
}

// Settle Trades Centrally
function resolveActiveTrade(symbol, outcome) {
  const activeTrade = state.activeTrades[symbol];
  const sData = symbolData[symbol];
  if (!activeTrade || !sData) return;

  const isSandbox = activeTrade.status === "SANDBOX_ACTIVE";
  const finalOutcome = isSandbox ? `SANDBOX_${outcome}` : outcome;
  activeTrade.status = finalOutcome;

  const leverage = parseFloat(activeTrade.leverage) || 3;
  const currentPnlPercent = activeTrade.direction === "LONG"
    ? ((sData.currentTickPrice - activeTrade.entry) / activeTrade.entry) * 100 * leverage
    : ((activeTrade.entry - sData.currentTickPrice) / activeTrade.entry) * 100 * leverage;

  const marginRequired = ((parseFloat(activeTrade.positionSize) || 0) * (parseFloat(activeTrade.entry) || 0)) / leverage;
  const dollarPnL = marginRequired * (currentPnlPercent / 100);

  if (isSandbox) {
    state.sandboxWalletBalance += dollarPnL;
    if (outcome === "WIN") state.sandboxJournalStats.wins++;
    else if (outcome === "LOSS") state.sandboxJournalStats.losses++;
    else if (outcome === "TIMEOUT") state.sandboxJournalStats.timeouts++;
  } else {
    state.walletBalance += dollarPnL;
    if (outcome === "WIN") { state.journalStats.wins++; state.consecutiveLosses = 0; }
    else if (outcome === "LOSS") { state.journalStats.losses++; state.consecutiveLosses++; }
    else if (outcome === "TIMEOUT") { state.journalStats.timeouts++; state.consecutiveLosses++; }
  }

  const engine = getOrCreateEngine();
  if (engine && sData.lastRegime) {
    engine.probEngine.recordTradeResult(sData.lastRegime, outcome === "WIN", currentPnlPercent);
    // Persist Bayesian state so it survives service worker restarts
    try {
      const probabilityState = engine.probEngine.serializeState();
      chrome.storage.local.set({ probabilityState });
    } catch (e) {
      console.warn('SW: Failed to persist probability state:', e);
    }
  }

  if (activeTrade.dbId) {
    const payload = { status: finalOutcome, pnlPercentage: parseFloat(currentPnlPercent.toFixed(4)), elapsedCandles: activeTrade.elapsedCandles };
    fetch(`http://localhost:4000/api/advisor/signals/${activeTrade.dbId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((res) => {
      if (!res.ok) console.warn(`[Advisor API] PUT signal ${activeTrade.dbId} failed:`, res.status);
    }).catch((err) => console.warn('[Advisor API] PUT signal unreachable:', err.message));
  }

  // Trigger audio resolution event on HUD tabs
  if (state.settings.enableAudio) {
    dispatchAudioEvent(symbol, { type: 'SOUND', sound: outcome === 'WIN' ? 'TP_HIT' : outcome === 'LOSS' ? 'SL_HIT' : 'EXIT_WARN' });
  }

  // Clean local trade states
  delete state.activeTrades[symbol];
  chrome.storage.local.remove('activeTrade_' + symbol);

  // Save resolved stats
  const updates = {
    journalStats: state.journalStats,
    sandboxJournalStats: state.sandboxJournalStats,
    consecutiveLosses: state.consecutiveLosses,
    walletBalance: state.walletBalance,
    sandboxWalletBalance: state.sandboxWalletBalance
  };
  chrome.storage.local.set(updates, () => {
    runCalculations(symbol);
    broadcastHUDUpdate(symbol);
  });
}

function applyTarget2(signal, direction) {
  if (!signal || signal.target1 == null || signal.entry == null) return;
  const risk = Math.abs(signal.entry - (signal.stopLoss || signal.entry));
  if (direction === 'LONG') {
    signal.target2 = signal.target1 + risk;
  } else if (direction === 'SHORT') {
    signal.target2 = signal.target1 - risk;
  } else {
    signal.target2 = signal.target1;
  }
}

function autoRegisterActiveTrade(symbol) {
  const sData = symbolData[symbol];
  if (!sData || state.activeTrades[symbol]) return;

  const isSandbox = !!state.settings.sandboxMode;
  const pPrec = sData.symbolPrecisions.pricePrecision;
  const qPrec = sData.symbolPrecisions.quantityPrecision;

  const activeTrade = {
    id: "T-" + Date.now(),
    dbId: null,
    symbol: symbol,
    direction: sData.currentSignal.direction,
    entry: sData.currentSignal.entry,
    stopLoss: sData.currentSignal.stopLoss,
    target1: sData.currentSignal.target1,
    target2: sData.currentSignal.target2 ?? sData.currentSignal.target1,
    pricePrecision: pPrec,
    quantityPrecision: qPrec,
    triggerTime: sData.candles[sData.candles.length - 1].time,
    elapsedCandles: 0,
    status: isSandbox ? "SANDBOX_ACTIVE" : "ACTIVE",
    actionTaken: false,
    pattern: sData.currentSignal.patternName,
    confidence: sData.currentSignal.probability,
    triggerCatalyst: sData.currentSignal.triggerCatalyst,
    leverage: state.settings.leverage,
    timeframe: state.settings.timeframe,
    positionSize: computePositionSize(sData.currentSignal.entry, sData.currentSignal.stopLoss)
  };

  state.activeTrades[symbol] = activeTrade;
  chrome.storage.local.set({ ['activeTrade_' + symbol]: activeTrade });

  // Trigger audio alert event on HUD tabs
  if (state.settings.enableAudio) {
    const side = activeTrade.direction === "LONG" ? "Long entry setup" : "Short entry setup";
    const pairText = symbol.replace("USDT", " U.S. Dollar. Tether.");
    const text = `Alert: ${pairText} triggering ${side} via ${activeTrade.pattern}. Confidence is ${activeTrade.confidence} percent. Stop loss set at ${activeTrade.stopLoss.toFixed(2)}`;
    dispatchAudioEvent(symbol, { type: 'ENTRY', text });
  }

  // Post setup to Postgres
  const payload = {
    symbol: symbol,
    direction: activeTrade.direction,
    entryPrice: activeTrade.entry,
    stopLoss: activeTrade.stopLoss,
    target1: activeTrade.target1,
    target2: activeTrade.target2 ?? activeTrade.target1,
    positionSize: activeTrade.positionSize,
    marginRequired: (activeTrade.positionSize * activeTrade.entry) / state.settings.leverage,
    leverage: state.settings.leverage,
    riskAmount: state.settings.riskAmount || 10,
    probability: activeTrade.confidence,
    patternName: activeTrade.pattern,
    rsiValue: sData.lastIndicatorStates.rsi,
    ema9: sData.lastIndicatorStates.ema9,
    ema21: sData.lastIndicatorStates.ema21,
    bullishObCount: sData.lastIndicatorStates.bullishOB,
    bearishObCount: sData.lastIndicatorStates.bearishOB,
    confidenceTrend: sData.currentSignal.confidenceBreakdown?.trend || 10,
    confidenceSmc: sData.currentSignal.confidenceBreakdown?.smc || 10,
    confidenceMomentum: sData.currentSignal.confidenceBreakdown?.momentum || 10,
    triggerCatalyst: activeTrade.triggerCatalyst,
    timeframe: state.settings.timeframe,
    status: activeTrade.status,
    hypotheticalOutcome: activeTrade.status,
    actualOutcome: isSandbox ? 'SANDBOX' : null
  };

  persistSignalToApi(payload).then((data) => {
    if (data && data.id) {
      activeTrade.dbId = data.id;
      state.activeTrades[symbol] = activeTrade;
      chrome.storage.local.set({ ['activeTrade_' + symbol]: activeTrade });
      broadcastHUDUpdate(symbol);
    }
  });
}

function markUserActionTaken(symbol) {
  const activeTrade = state.activeTrades[symbol];
  if (!activeTrade || !activeTrade.dbId) return;

  activeTrade.actionTaken = true;
  chrome.storage.local.set({ ['activeTrade_' + symbol]: activeTrade });
  runCalculations(symbol);

  fetch(`http://localhost:4000/api/advisor/signals/${activeTrade.dbId}/action`, {
    method: 'POST'
  }).catch(() => {});
}

// Post audio event to all content script overlays matching symbol
function dispatchAudioEvent(symbol, payload) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.url && tab.url.includes("binance.com") && tab.url.includes(symbol.toLowerCase())) {
        chrome.tabs.sendMessage(tab.id, { type: "PLAY_AUDIO", payload }).catch(() => {});
      }
    }
  });
}

// Post message to all content script overlays matching symbol
function broadcastHUDUpdate(symbol) {
  const payload = getHUDUpdatePayload(symbol);
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      // Check symbol matching or url matching
      if (tab.url && tab.url.includes("binance.com") && tab.url.includes(symbol.toLowerCase())) {
        chrome.tabs.sendMessage(tab.id, { type: "HUD_UPDATE", symbol, payload }).catch(() => {});
      }
    }
  });
}

function broadcastHUDUpdates() {
  for (const sym of viewedSymbols) broadcastHUDUpdate(sym);
}

function getHUDUpdatePayload(symbol) {
  const sData = symbolData[symbol];
  if (!sData) return null;
  return {
    symbol,
    candles: sData.candles.slice(-50), // Send only last 50 candles to optimize network bandwidth
    lastIndicatorStates: sData.lastIndicatorStates,
    currentSignal: sData.currentSignal,
    closeSignal: sData.closeSignal,
    activeTrade: state.activeTrades[symbol] || null,
    advisorMode: sData.advisorMode,
    consecutiveLosses: state.consecutiveLosses,
    journalStats: state.journalStats,
    sandboxJournalStats: state.sandboxJournalStats,
    walletBalance: state.walletBalance,
    sandboxWalletBalance: state.sandboxWalletBalance,
    symbolPrecisions: sData.symbolPrecisions
  };
}

// Timeframe helper
function timeframeToMs(tf) {
  const val = parseInt(tf);
  if (tf.endsWith('m')) return val * 60 * 1000;
  if (tf.endsWith('h')) return val * 60 * 60 * 1000;
  if (tf.endsWith('d')) return val * 24 * 60 * 60 * 1000;
  return 5 * 60 * 1000;
}

// Stats helpers
function calculateEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) {
    ema.push(data[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calculateRSI(closes, period = 14) {
  const rsi = [];
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    let gain = diff > 0 ? diff : 0;
    let loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calculateMACD(closes) {
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const macd = [];
  for (let i = 0; i < closes.length; i++) {
    macd.push(ema12[i] - ema26[i]);
  }
  const signal = calculateEMA(macd.slice(26), 9);
  const paddedSignal = new Array(26).fill(0).concat(signal);
  return { macd, signal: paddedSignal };
}

function calculateATR(candles, period = 14) {
  const len = candles.length;
  const atr = new Array(len).fill(0);
  if (len === 0) return atr;
  const tr = new Array(len).fill(0);
  tr[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < len; i++) {
    const h = candles[i].high;
    const l = candles[i].low;
    const pc = candles[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let sum = 0;
  const limit = Math.min(len, period);
  for (let i = 0; i < limit; i++) sum += tr[i];
  const initialAtr = sum / limit;
  for (let i = 0; i < limit; i++) atr[i] = initialAtr;
  for (let i = period; i < len; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

function detectLiquiditySweep(candles) {
  const len = candles.length;
  if (len < 30) return { bullishSweep: false, bearishSweep: false, level: 0 };
  const current = candles[len - 1];
  const lookback = candles.slice(len - 31, len - 1);
  const highestHigh = Math.max(...lookback.map(c => c.high));
  const lowestLow = Math.min(...lookback.map(c => c.low));
  const isBullishSweep = current.low < lowestLow && current.close > lowestLow && (current.close - current.low) / (current.high - current.low) >= 0.5;
  const isBearishSweep = current.high > highestHigh && current.close < highestHigh && (current.high - current.close) / (current.high - current.low) >= 0.5;
  if (isBullishSweep) return { bullishSweep: true, bearishSweep: false, level: lowestLow };
  if (isBearishSweep) return { bullishSweep: false, bearishSweep: true, level: highestHigh };
  return { bullishSweep: false, bearishSweep: false, level: 0 };
}

function detectOrderBlocks(candles) {
  const bullish = [];
  const bearish = [];
  const len = candles.length;
  for (let i = 5; i < len - 2; i++) {
    const c = candles[i];
    const cNext = candles[i + 1];
    const cNext2 = candles[i + 2];
    const isDown = c.close < c.open;
    const isStrongUp = cNext.close > cNext.open && cNext2.close > cNext2.open && cNext2.close > candles[i - 1].high;
    if (isDown && isStrongUp) bullish.push({ index: i, low: c.low, high: c.high, unmitigated: true });
    const isUp = c.close > c.open;
    const isStrongDown = cNext.close < cNext.open && cNext2.close < cNext2.open && cNext2.close < candles[i - 1].low;
    if (isUp && isStrongDown) bearish.push({ index: i, low: c.low, high: c.high, unmitigated: true });
  }
  bullish.forEach(ob => {
    for (let j = ob.index + 2; j < len; j++) {
      if (candles[j].low < ob.low) { ob.unmitigated = false; break; }
    }
  });
  bearish.forEach(ob => {
    for (let j = ob.index + 2; j < len; j++) {
      if (candles[j].high > ob.high) { ob.unmitigated = false; break; }
    }
  });
  return { bullish, bearish };
}

function detectFVG(candles) {
  const len = candles.length;
  if (len < 5) return { bullishGap: null, bearishGap: null };
  const c1 = candles[len - 4];
  const c2 = candles[len - 3];
  const c3 = candles[len - 2];
  let bullishGap = null;
  let bearishGap = null;
  if (c3.low > c1.high && c2.close > c2.open) bullishGap = { low: c1.high, high: c3.low };
  if (c3.high < c1.low && c2.close < c2.open) bearishGap = { low: c3.high, high: c1.low };
  return { bullishGap, bearishGap };
}
