/**
 * Binance Futures Real-Time Advisor - Upgraded Content Script
 * Tracks catalyst narrative, logs whether user entered the trade, and separates hypothetical vs actual outcomes in PostgreSQL.
 */

(function () {
  console.log("⚡ Upgraded Antigravity Real-Time Binance Futures Advisor with Action Logger Loaded!");

  // --- STATE VARIABLES ---
  window._antigravityEngine = window.AntigravityCore ? new window.AntigravityCore.AntigravityEngine() : null;
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

  let ws = null;
  let useSpotAPI = false; // Fallback for geoblocked regions
  let forceSpotWS = false; // Force Spot WebSocket due to consecutive drops
  let wsFailures = 0;      // Count consecutive WebSocket failures
  let candles = []; // Array of { time, open, high, low, close, volume }
  let lastWsEventTime = Date.now();
  let currentTickPrice = 0;
  let symbolPrecisions = {}; // Cached quantity and price precisions

  // ── Binance market data (fetched async, read sync in scoring) ──
  let fundingRate    = null;  // last funding rate as decimal
  let oiDelta        = 0;     // open interest delta (positive = rising)
  let lastOIValue    = null;
  let lsRatio        = null;  // long/short account ratio
  let consecutiveLosses = 0; // circuit breaker counter
  let pdh            = null;  // yesterday's high from 1d daily candles
  let pdl            = null;  // yesterday's low from 1d daily candles
  let ema21_15m      = null;  // 15m EMA21 level
  let ema21_1h       = null;  // 1h EMA21 level
  
  // Active trade monitoring
  let activeTrade = null; // current ticker's active trade from activeTrades dictionary
  let activeTrades = {};  // dictionary of active trades: { [symbol]: activeTrade }
  let journalStats = { wins: 0, losses: 0, timeouts: 0 };
  let sandboxJournalStats = { wins: 0, losses: 0, timeouts: 0 };
  let dbSignals = [];
  let advisorMode = "HUNTING"; // "HUNTING" or "MONITORING"
  let closeSignal = {
    active: false,
    confidence: 0,
    reason: "",
    triggerCatalyst: ""
  };

  let currentSignal = {
    direction: "WAITING", // LONG, SHORT, WAITING
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

  // Keep track of indicators for database logging
  let lastIndicatorStates = { rsi: 50, ema9: 0, ema21: 0, bullishOB: 0, bearishOB: 0 };

  // Cooldown tracker for speech synthesis
  let lastSpokenTime = 0;
  const SPEECH_COOLDOWN_MS = 120000; // 2 minutes

  // --- DOM HUD ELEMENTS ---
  let hudRoot = null;
  let isMinimized = false;
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };

  // --- INIT & SETTINGS LISTENERS ---
  function loadSettingsAndJournal(callback) {
    chrome.storage.local.get(null, (items) => {
      settings = {
        riskAmount: items.riskAmount !== undefined ? items.riskAmount : 20,
        leverage: items.leverage !== undefined ? items.leverage : 3,
        triggerThreshold: items.triggerThreshold !== undefined ? items.triggerThreshold : 78,
        sandboxMode: items.sandboxMode !== undefined ? items.sandboxMode : false,
        enableSMC: items.enableSMC !== undefined ? items.enableSMC : true,
        enableTechnical: items.enableTechnical !== undefined ? items.enableTechnical : true,
        enableAudio: items.enableAudio !== undefined ? items.enableAudio : true,
        enableAutoPilot: items.enableAutoPilot !== undefined ? items.enableAutoPilot : false,
        enableCircuitBreaker: items.enableCircuitBreaker !== false, // default on
        timeframe: items.timeframe || "5m",
        alertPhone: items.alertPhone || "",
        sizeMode: items.sizeMode || "RISK",
        tradeCapital: items.tradeCapital !== undefined ? items.tradeCapital : 100,
        targetMode: items.targetMode || "INDICATOR",
        customTakeProfit: items.customTakeProfit !== undefined ? items.customTakeProfit : 1.5,
        customStopLoss: items.customStopLoss !== undefined ? items.customStopLoss : 1.0,
        customTpSlMode: items.customTpSlMode || "margin",
        marginMode: items.marginMode || "ISOLATED",
        walletBalance: items.walletBalance !== undefined ? items.walletBalance : 1000,
        sandboxWalletBalance: items.sandboxWalletBalance !== undefined ? items.sandboxWalletBalance : 1000,
        enableTimeout: items.enableTimeout !== false,
        timeoutCandles: items.timeoutCandles !== undefined ? items.timeoutCandles : 12
      };
      journalStats = items.journalStats || { wins: 0, losses: 0, timeouts: 0 };
      sandboxJournalStats = items.sandboxJournalStats || { wins: 0, losses: 0, timeouts: 0 };
      consecutiveLosses = items.consecutiveLosses || 0;
      const journalLastClearedTime = items.journalLastClearedTime || 0;

      activeTrades = {};
      for (const key in items) {
        if (key.startsWith('activeTrade_')) {
          const sym = key.replace('activeTrade_', '');
          activeTrades[sym] = items[key];
        }
      }

      // ── Validate loaded activeTrades and clean up stale ones ──
      const MAX_TRADE_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours
      let staleSymbols = [];

      for (const sym in activeTrades) {
        const loaded = activeTrades[sym];
        const tradeAgeOk = loaded && loaded.triggerTime && (Date.now() - loaded.triggerTime) < MAX_TRADE_AGE_MS;
        if (!loaded || (loaded.status !== 'ACTIVE' && loaded.status !== 'SANDBOX_ACTIVE') || !tradeAgeOk) {
          console.warn(`🗑️ Discarding stale activeTrade for ${sym} from storage.`);
          staleSymbols.push('activeTrade_' + sym);
          delete activeTrades[sym];
        }
      }

      if (staleSymbols.length > 0) {
        chrome.storage.local.remove(staleSymbols);
      }

      activeTrade = activeSymbol ? (activeTrades[activeSymbol] || null) : null;

      syncJournalWithDatabase(journalLastClearedTime, () => {
        if (callback) callback();
      });
    });
  }

  let isSyncingQueue = false;

  function processPendingSyncQueue() {
    if (!checkContextSafety()) return;
    
    chrome.storage.local.get(['pendingSyncQueue', 'syncQueueLock'], (res) => {
      const queue = res.pendingSyncQueue || [];
      if (queue.length === 0) return;
      
      const now = Date.now();
      // Lock timeout: 10 seconds
      if (res.syncQueueLock && (now - res.syncQueueLock < 10000)) {
        return;
      }
      
      chrome.storage.local.set({ syncQueueLock: now }, () => {
        chrome.storage.local.get(['pendingSyncQueue'], (res2) => {
          const freshQueue = res2.pendingSyncQueue || [];
          if (freshQueue.length === 0) {
            chrome.storage.local.remove('syncQueueLock');
            return;
          }
          
          const item = freshQueue[0];
          console.log(`✈️ Syncing queued trade ${item.dbId} via tab lock...`);
          
          fetchApi(`http://localhost:4000/api/advisor/signals/${item.dbId}`, 'PUT', item.payload)
            .then(() => {
              console.log(`✅ Successfully synced queued trade ${item.dbId}`);
              
              chrome.storage.local.get(['pendingSyncQueue'], (res3) => {
                const q = res3.pendingSyncQueue || [];
                q.shift();
                chrome.storage.local.set({ pendingSyncQueue: q }, () => {
                  chrome.storage.local.remove('syncQueueLock', () => {
                    processPendingSyncQueue();
                  });
                });
              });
            })
            .catch(err => {
              console.warn(`⚠️ Failed to sync queued trade ${item.dbId}, will retry:`, err.message);
              chrome.storage.local.remove('syncQueueLock');
            });
        });
      });
    });
  }

  function fetchExchangePrecision(symbol, callback) {
    if (!symbol) {
      if (callback) callback();
      return;
    }
    if (symbolPrecisions[symbol] !== undefined) {
      if (callback) callback();
      return;
    }
    
    const isSpot = useSpotAPI;
    const url = isSpot 
      ? `https://api.binance.com/api/v3/exchangeInfo?symbol=${symbol}`
      : `https://fapi.binance.com/fapi/v1/exchangeInfo?symbol=${symbol}`;
      
    fetchApi(url)
      .then(info => {
        if (info && info.symbols) {
          const symInfo = info.symbols.find(s => s.symbol === symbol);
          if (symInfo) {
            symbolPrecisions[symbol] = {
              quantityPrecision: parseInt(symInfo.quantityPrecision !== undefined ? symInfo.quantityPrecision : symInfo.baseAssetPrecision),
              pricePrecision: parseInt(symInfo.pricePrecision !== undefined ? symInfo.pricePrecision : symInfo.quoteAssetPrecision)
            };
            console.log(`🎯 Cached precision for ${symbol}: Q=${symbolPrecisions[symbol].quantityPrecision}, P=${symbolPrecisions[symbol].pricePrecision}`);
            if (callback) callback();
            return;
          }
        }
        fetchAllExchangePrecision(isSpot, callback);
      })
      .catch(err => {
        console.warn(`⚠️ Filtered exchangeInfo query failed for ${symbol}, fetching all...`, err.message);
        fetchAllExchangePrecision(isSpot, callback);
      });
  }

  function fetchAllExchangePrecision(isSpot, callback) {
    const url = isSpot
      ? `https://api.binance.com/api/v3/exchangeInfo`
      : `https://fapi.binance.com/fapi/v1/exchangeInfo`;
      
    fetchApi(url)
      .then(info => {
        if (info && info.symbols) {
          info.symbols.forEach(s => {
            symbolPrecisions[s.symbol] = {
              quantityPrecision: parseInt(s.quantityPrecision !== undefined ? s.quantityPrecision : s.baseAssetPrecision),
              pricePrecision: parseInt(s.pricePrecision !== undefined ? s.pricePrecision : s.quoteAssetPrecision)
            };
          });
          console.log(`🎯 Cached precisions for ${info.symbols.length} symbols.`);
        }
        if (callback) callback();
      })
      .catch(err => {
        console.error("❌ Failed to fetch exchangeInfo:", err.message);
        if (callback) callback();
      });
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

  function checkContextSafety() {
    if (!isContextValid()) {
      if (ws) {
        try { ws.close(); } catch (e) {}
        ws = null;
      }
      if (window._marketDataInterval) {
        clearInterval(window._marketDataInterval);
      }
      if (window._wsWatchdog) {
        clearInterval(window._wsWatchdog);
      }
      if (window._agPnLInterval) {
        clearInterval(window._agPnLInterval);
      }
      const statusText = document.getElementById("agy-status-text");
      const statusDot = document.getElementById("agy-status-indicator");
      if (statusText) {
        statusText.textContent = "Extension reloaded. Please refresh.";
        statusText.style.color = "#f6465d";
      }
      if (statusDot) {
        statusDot.className = "agy-status-dot dead";
        statusDot.style.background = "#f6465d";
        statusDot.style.boxShadow = "none";
      }
      return false;
    }
    return true;
  }

  // Helper to route ALL API calls through background.js (bypasses page-level CSP connect-src blocks)
  function fetchApi(url, method = 'GET', body = null) {
    if (!isContextValid()) {
      return Promise.reject(new Error("Extension context invalidated"));
    }
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: "FETCH_LOCAL_API",
        url,
        method,
        body
      }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.success) {
          resolve(response.data);
        } else {
          reject(new Error(response ? response.error : "Unknown routing error"));
        }
      });
    });
  }

  // Rebuilds journalStats, sandboxJournalStats and consecutiveLosses from PostgreSQL database (Advisor Signals)
  function syncJournalWithDatabase(journalLastClearedTime, callback) {
    fetchApi('http://localhost:4000/api/advisor/signals', 'GET')
      .then(signals => {
        if (Array.isArray(signals)) {
          dbSignals = signals;
          signals.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
          
          let localWins = 0;
          let localLosses = 0;
          let localTimeouts = 0;
          let localConsecutiveLosses = 0;

          let sandboxWins = 0;
          let sandboxLosses = 0;
          let sandboxTimeouts = 0;

          for (const sig of signals) {
            const signalTime = new Date(sig.createdAt).getTime();
            if (journalLastClearedTime && signalTime < journalLastClearedTime) {
              continue;
            }
            let status = sig.status;
            if (!status || status === "ACTIVE" || status === "SANDBOX_ACTIVE") {
              continue;
            }
            const isSandbox = status.startsWith("SANDBOX_");
            let outcome = isSandbox ? status.replace("SANDBOX_", "") : status;
            
            const pnlPercentage = parseFloat(sig.pnlPercentage) || 0;
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
                localConsecutiveLosses = 0; // reset streak on win
              } else if (outcome === "LOSS") {
                localLosses++;
                localConsecutiveLosses++;
              }
            }
          }

          journalStats = { wins: localWins, losses: localLosses, timeouts: localTimeouts };
          sandboxJournalStats = { wins: sandboxWins, losses: sandboxLosses, timeouts: sandboxTimeouts };
          consecutiveLosses = localConsecutiveLosses;

          // Save the synced stats to chrome.storage.local
          chrome.storage.local.set({ journalStats, sandboxJournalStats, consecutiveLosses });
          console.log("🔄 Rebuilt journalStats and sandboxJournalStats from PostgreSQL (Advisor Signals):", journalStats, sandboxJournalStats, "streak:", consecutiveLosses);
        }
        if (callback) callback();
      })
      .catch(err => {
        console.warn("⚠️ Failed to sync journal with PostgreSQL on load, using storage cache:", err.message);
        if (callback) callback();
      });
  }

  function getTickerJournalStats(symbol, isSandbox) {
    let wins = 0;
    let losses = 0;
    let timeouts = 0;

    const journalLastClearedTime = settings.journalLastClearedTime || 0;
    const cleanSym = symbol ? symbol.toUpperCase().replace(/[^A-Z0-9]/g, '') : "";

    dbSignals.forEach(sig => {
      const sigSym = sig.symbol ? sig.symbol.toUpperCase().replace(/[^A-Z0-9]/g, '') : "";
      if (sigSym !== cleanSym) {
        return;
      }

      const signalTime = new Date(sig.createdAt).getTime();
      if (journalLastClearedTime && signalTime < journalLastClearedTime) {
        return;
      }

      let status = sig.status;
      if (!status || status === "ACTIVE" || status === "SANDBOX_ACTIVE") {
        return;
      }

      const isSigSandbox = status.startsWith("SANDBOX_") || sig.actualOutcome === 'SANDBOX';
      if (isSigSandbox !== isSandbox) {
        return;
      }

      let outcome = isSigSandbox ? status.replace("SANDBOX_", "") : status;
      const pnlPercentage = parseFloat(sig.pnlPercentage) || 0;

      const rawOutcome = isSigSandbox ? status.replace("SANDBOX_", "") : status;
      if (rawOutcome === "TIMEOUT") {
        timeouts++;
      }

      if (outcome === "TIMEOUT" || outcome === "INVALIDATED") {
        outcome = pnlPercentage >= 0 ? "WIN" : "LOSS";
      }

      if (outcome === "WIN") {
        wins++;
      } else if (outcome === "LOSS") {
        losses++;
      }
    });

    return { wins, losses, timeouts };
  }

  // Listen for updates
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "UPDATE_SETTINGS") {
      settings = { ...settings, ...request.settings };
      console.log("🔧 Settings updated:", settings);
      updateHUDSettingsDisplay();
      restartDataSync();
    } else if (request.type === "CLEAR_JOURNAL") {
      const now = Date.now();
      journalStats = { wins: 0, losses: 0, timeouts: 0 };
      sandboxJournalStats = { wins: 0, losses: 0, timeouts: 0 };
      activeTrades = {};
      activeTrade = null;
      consecutiveLosses = 0; // BUG4 FIX: reset circuit breaker on journal clear
      
      chrome.storage.local.get(null, (items) => {
        const keysToRemove = [];
        for (const key in items) {
          if (key.startsWith('activeTrade_') || key.startsWith('tabState_')) {
            keysToRemove.push(key);
          }
        }
        chrome.storage.local.remove(keysToRemove);
        chrome.storage.local.set({ 
          journalStats, 
          sandboxJournalStats,
          consecutiveLosses: 0,
          journalLastClearedTime: now
        }, () => {
          runCalculations();
        });
      });
    } else if (request.type === "WS_OPENED") {
      console.log("✅ Proxied WebSocket connected and streaming live.");
      window._wsFirstMsg = false;
      updateHUDStatus(false, "Live ✅");
      if (window._wsWatchdog) clearInterval(window._wsWatchdog);
      let lastMsgTime = Date.now();
      window._lastWsMsgListener = () => { lastMsgTime = Date.now(); };
      window._wsWatchdog = setInterval(() => {
        if (!checkContextSafety()) return;
        if (Date.now() - lastMsgTime > 30000) {
          console.warn("⚠️ Proxied WS heartbeat timeout — no message in 30s, restarting...");
          clearInterval(window._wsWatchdog);
          if (activeSymbol) restartDataSync();
        }
      }, 15000);
    } else if (request.type === "WS_MESSAGE") {
      if (!checkContextSafety()) return;
      if (window._lastWsMsgListener) window._lastWsMsgListener();
      try {
        wsFailures = 0;
        const data = JSON.parse(request.data);
        const stream = data.stream;
        const payload = data.data;
        if (payload && payload.E) {
          lastWsEventTime = parseInt(payload.E);
        }

        const isTfStream   = stream.includes(`kline_${settings.timeframe}`);
        const is1mStream   = stream.includes('kline_1m');
        const is1mTimeframe = settings.timeframe === '1m';

        // ── Tick price update (always from 1m stream) ──
        if (is1mStream) {
          currentTickPrice = parseFloat(payload.k.c);
          if (candles.length > 0) {
            candles[candles.length - 1].close = currentTickPrice;
            if (currentTickPrice > candles[candles.length - 1].high)
              candles[candles.length - 1].high = currentTickPrice;
            if (currentTickPrice < candles[candles.length - 1].low)
              candles[candles.length - 1].low = currentTickPrice;
          }
          trackActiveTradeLive();
          // Sync tick price to storage (throttled ~2s) so popup PnL stays live
          const now = Date.now();
          if (!window._lastTickSync || now - window._lastTickSync > 2000) {
            window._lastTickSync = now;
            chrome.storage.local.set({ currentTickPrice });
          }
        }

        // ── Candle update (analysis timeframe stream) ──
        if (isTfStream) {
          const k = payload.k;
          const candleTime = parseInt(k.t);

          const latestCandle = {
            time:   candleTime,
            open:   parseFloat(k.o),
            high:   parseFloat(k.h),
            low:    parseFloat(k.l),
            close:  parseFloat(k.c),
            volume: parseFloat(k.v)
          };

          if (candles.length > 0 && candles[candles.length - 1].time === candleTime) {
            candles[candles.length - 1] = latestCandle;
          } else {
            candles.push(latestCandle);
            if (candles.length > 200) candles.shift();
            if (activeTrade && (activeTrade.status === "ACTIVE" || activeTrade.status === "SANDBOX_ACTIVE")) {
              activeTrade.elapsedCandles = Math.round(
                (candleTime - activeTrade.triggerTime) / timeframeToMs(activeTrade.timeframe || settings.timeframe)
              );
              const isTimeoutEnabled = settings.enableTimeout !== false;
              const limit = settings.timeoutCandles !== undefined ? parseInt(settings.timeoutCandles) : 12;
              if (isTimeoutEnabled && activeTrade.elapsedCandles >= limit) {
                resolveActiveTrade("TIMEOUT");
              } else {
                activeTrades[activeSymbol] = activeTrade;
                chrome.storage.local.set({ ['activeTrade_' + activeSymbol]: activeTrade });
              }
            }
          }
          runCalculations();
        } else if (!isTfStream && is1mStream && !is1mTimeframe) {
          runCalculations();
        }

        if (!window._wsFirstMsg) {
          window._wsFirstMsg = true;
          updateHUDStatus(false, "Live ✅");
        }
      } catch (err) {
        console.error("WS error parsing:", err);
      }
    } else if (request.type === "WS_ERROR") {
      console.error("❌ Proxied WebSocket error received");
      updateHUDStatus(true, "WS Error");
    } else if (request.type === "WS_CLOSED") {
      console.warn(`🔌 Proxied WebSocket closed: code=${request.code}, reason=${request.reason}`);
      updateHUDStatus(true, "Disconnected – Reconnecting...");
      
      wsFailures++;
      if (wsFailures >= 2 && !forceSpotWS) {
        console.warn("⚠️ Proxied WebSocket failed consecutively. Forcing Spot WebSocket fallback.");
        forceSpotWS = true;
      }

      setTimeout(() => {
        if (!checkContextSafety()) return;
        if (activeSymbol) restartDataSync();
      }, 4000);
    }
  });

  // Sync state changes across multiple open tabs in real-time
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    
    let needsUpdate = false;
    
    // Check if any activeTrade_<symbol> changed
    for (const key in changes) {
      if (key.startsWith('activeTrade_')) {
        const sym = key.replace('activeTrade_', '');
        const change = changes[key];
        if (change.newValue) {
          activeTrades[sym] = change.newValue;
        } else {
          delete activeTrades[sym];
        }
        activeTrade = activeSymbol ? (activeTrades[activeSymbol] || null) : null;
        console.log(`🔄 Real-time tab sync: activeTrade for ${sym} updated.`);
        needsUpdate = true;
      }
    }
    
    if (changes.journalStats) {
      journalStats = changes.journalStats.newValue || { wins: 0, losses: 0, timeouts: 0 };
      console.log("🔄 Real-time tab sync: journalStats updated from storage.");
      needsUpdate = true;
    }
    if (changes.sandboxJournalStats) {
      sandboxJournalStats = changes.sandboxJournalStats.newValue || { wins: 0, losses: 0, timeouts: 0 };
      console.log("🔄 Real-time tab sync: sandboxJournalStats updated from storage.");
      needsUpdate = true;
    }
    if (changes.sandboxMode) {
      settings.sandboxMode = changes.sandboxMode.newValue;
      console.log("🔄 Real-time tab sync: sandboxMode updated from storage.");
      needsUpdate = true;
    }
    if (changes.consecutiveLosses) {
      consecutiveLosses = changes.consecutiveLosses.newValue || 0;
      console.log("🔄 Real-time tab sync: consecutiveLosses updated from storage.");
      needsUpdate = true;
    }
    if (changes.marginMode) {
      settings.marginMode = changes.marginMode.newValue || "ISOLATED";
      needsUpdate = true;
    }
    if (changes.walletBalance) {
      settings.walletBalance = changes.walletBalance.newValue !== undefined ? changes.walletBalance.newValue : 1000;
      needsUpdate = true;
    }
    if (changes.sandboxWalletBalance) {
      settings.sandboxWalletBalance = changes.sandboxWalletBalance.newValue !== undefined ? changes.sandboxWalletBalance.newValue : 1000;
      needsUpdate = true;
    }
    if (changes.enableTimeout) {
      settings.enableTimeout = changes.enableTimeout.newValue !== false;
      needsUpdate = true;
    }
    if (changes.timeoutCandles) {
      settings.timeoutCandles = changes.timeoutCandles.newValue !== undefined ? changes.timeoutCandles.newValue : 12;
      needsUpdate = true;
    }
    if (changes.journalLastClearedTime) {
      const newTime = changes.journalLastClearedTime.newValue || 0;
      settings.journalLastClearedTime = newTime;
      syncJournalWithDatabase(newTime);
      needsUpdate = true;
    }
    if (changes.leverage) {
      settings.leverage = changes.leverage.newValue !== undefined ? parseFloat(changes.leverage.newValue) : 3;
      needsUpdate = true;
    }
    if (changes.riskAmount) {
      settings.riskAmount = changes.riskAmount.newValue !== undefined ? parseFloat(changes.riskAmount.newValue) : 20;
      needsUpdate = true;
    }
    if (changes.timeframe) {
      const oldTf = settings.timeframe;
      settings.timeframe = changes.timeframe.newValue || "5m";
      if (oldTf !== settings.timeframe) {
        console.log(`🔄 Real-time tab sync: timeframe changed from ${oldTf} to ${settings.timeframe}. Restarting stream.`);
        needsUpdate = true;
        if (activeSymbol) restartDataSync();
      }
    }
    if (changes.enableSMC) {
      settings.enableSMC = changes.enableSMC.newValue !== false;
      needsUpdate = true;
    }
    if (changes.enableTechnical) {
      settings.enableTechnical = changes.enableTechnical.newValue !== false;
      needsUpdate = true;
    }
    if (changes.enableAudio) {
      settings.enableAudio = changes.enableAudio.newValue !== false;
      needsUpdate = true;
    }
    if (changes.enableAutoPilot) {
      settings.enableAutoPilot = changes.enableAutoPilot.newValue === true;
      needsUpdate = true;
    }
    if (changes.enableCircuitBreaker) {
      settings.enableCircuitBreaker = changes.enableCircuitBreaker.newValue !== false;
      needsUpdate = true;
    }
    if (changes.sizeMode) {
      settings.sizeMode = changes.sizeMode.newValue || "RISK";
      needsUpdate = true;
    }
    if (changes.tradeCapital) {
      settings.tradeCapital = changes.tradeCapital.newValue !== undefined ? parseFloat(changes.tradeCapital.newValue) : 100;
      needsUpdate = true;
    }
    if (changes.targetMode) {
      settings.targetMode = changes.targetMode.newValue || "INDICATOR";
      needsUpdate = true;
    }
    if (changes.customTakeProfit) {
      settings.customTakeProfit = changes.customTakeProfit.newValue !== undefined ? parseFloat(changes.customTakeProfit.newValue) : 1.5;
      needsUpdate = true;
    }
    if (changes.customStopLoss) {
      settings.customStopLoss = changes.customStopLoss.newValue !== undefined ? parseFloat(changes.customStopLoss.newValue) : 1.0;
      needsUpdate = true;
    }
    if (changes.triggerThreshold) {
      settings.triggerThreshold = changes.triggerThreshold.newValue !== undefined ? parseInt(changes.triggerThreshold.newValue) : 78;
      needsUpdate = true;
    }
    if (changes.customTpSlMode) {
      settings.customTpSlMode = changes.customTpSlMode.newValue || "margin";
      needsUpdate = true;
    }
    
    if (needsUpdate) {
      runCalculations();
    }
  });

  // Load and inject
  loadSettingsAndJournal(() => {
    injectHUD();
    startPnLTicker();
    startSymbolDetectionLoop();

    // Start pending sync queue check
    processPendingSyncQueue();
    setInterval(processPendingSyncQueue, 15000);
  });

  // --- SYMBOL DETECTION ---
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

  function startSymbolDetectionLoop() {
    setInterval(() => {
      if (!checkContextSafety()) return;
      const detected = detectSymbolFromPage();
      if (detected && detected !== activeSymbol) {
        console.log(`🎯 Active symbol changed to: ${detected}`);
        activeSymbol = detected;
        restartDataSync();
      }
    }, 1500);
  }

  function detectSymbolFromPage() {
    // 1. Try URL last segment
    const pathSegments = window.location.pathname.split('/');
    let lastSegment = pathSegments[pathSegments.length - 1] || "";
    lastSegment = lastSegment.split('?')[0].split('#')[0];
    const cleanedUrlSym = cleanSymbol(lastSegment);
    if (cleanedUrlSym) return cleanedUrlSym;

    // 2. Try document title
    const title = document.title;
    if (title) {
      const words = title.split(/[\s|\|\-\/\_]/);
      for (const word of words) {
        const cleanedWord = cleanSymbol(word);
        if (cleanedWord) return cleanedWord;
      }
    }

    // 3. Try ticker DOM element
    const tickerEl = document.querySelector('.symbol-name');
    if (tickerEl) {
      const cleanedDOMSym = cleanSymbol(tickerEl.textContent);
      if (cleanedDOMSym) return cleanedDOMSym;
    }
    return null;
  }


  // --- DATA ACQUISITION ---
  function restartDataSync() {
    if (!checkContextSafety()) return;
    if (!activeSymbol) return;

    updateHUDStatus(true, "Connecting...");

    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      ws = null;
    }

    candles = [];
    currentTickPrice = 0;

    // Do NOT discard activeTrade on symbol switch to preserve logs/tracking for cross-symbol navigation.
    activeTrade = activeTrades[activeSymbol] || null;
    pdh = null;
    pdl = null;
    ema21_15m = null;
    ema21_1h = null;
    lastOIValue = null;
    oiDelta = 0;
    wsFailures = 0;
    forceSpotWS = false;
    // Clear and restart market data interval synchronously — never inside async .then()
    clearInterval(window._marketDataInterval);
    window._marketDataInterval = setInterval(fetchBinanceMarketData, 5 * 60 * 1000);

    fetchExchangePrecision(activeSymbol, () => {
      if (!checkContextSafety() || !activeSymbol) return;
      const limit = 150; 
      const interval = settings.timeframe;
      const futuresUrl = `https://fapi.binance.com/fapi/v1/klines?symbol=${activeSymbol}&interval=${interval}&limit=${limit}`;
      const spotUrl = `https://api.binance.com/api/v3/klines?symbol=${activeSymbol}&interval=${interval}&limit=${limit}`;

      fetchApi(futuresUrl)
        .then(data => {
          useSpotAPI = false;
          return data;
        })
        .catch(err => {
          console.warn("⚠️ Futures API blocked/failed. Trying Spot fallback...", err.message);
          return fetchApi(spotUrl)
            .then(data => {
              useSpotAPI = true;
              return data;
            })
            .catch(spotErr => {
              console.error("❌ Both Futures and Spot APIs failed:", spotErr.message);
              throw spotErr;
            });
        })
        .then(data => {
          if (!Array.isArray(data)) throw new Error('Invalid candle data received');
          candles = data.map(c => ({
            time: parseInt(c[0]),
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5])
          }));

          console.log(`📊 Synchronized ${candles.length} candles for ${activeSymbol} (Spot Fallback: ${useSpotAPI})`);
          if (candles.length > 0) {
            currentTickPrice = candles[candles.length - 1]?.close || 0;
          }

          // Run calculations in a try-catch so scoring bugs never trigger the API retry loop
          try {
            runCalculations();
          } catch (calcErr) {
            console.error("❌ Calculation error (not an API failure):", calcErr);
          }

          connectWebSocket();
          fetchBinanceMarketData(); // immediate fetch for new symbol
          updateHUDStatus(false, "Synced — Connecting WS...");
        })
        .catch(err => {
          // Only real network/API failures reach here — not calculation errors
          console.error("❌ Error fetching historical candles:", err);
          updateHUDStatus(true, "API Error. Retrying...");
          setTimeout(restartDataSync, 5000);
        });
    });
  }

  // ── Binance Futures market data fetcher (funding, OI, L/S ratio) ──
  function fetchBinanceMarketData() {
    if (!checkContextSafety()) return;
    if (!activeSymbol) return;
    const sym = activeSymbol.toUpperCase();

    // 1. Funding Rate
    fetchApi(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`)
      .then(d => {
        fundingRate = parseFloat(d.lastFundingRate);
        console.log(`💰 Funding Rate: ${(fundingRate * 100).toFixed(4)}%`);
      })
      .catch(() => { fundingRate = null; });

    // 2. Open Interest
    fetchApi(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}`)
      .then(d => {
        const oi = parseFloat(d.openInterest);
        if (lastOIValue !== null) oiDelta = oi - lastOIValue;
        lastOIValue = oi;
        console.log(`📊 OI: ${oi.toFixed(0)}, Delta: ${oiDelta > 0 ? '+' : ''}${oiDelta.toFixed(0)}`);
      })
      .catch(() => {});

    // 3. Long/Short Ratio
    fetchApi(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=5m&limit=1`)
      .then(d => {
        if (Array.isArray(d) && d.length > 0) {
          lsRatio = parseFloat(d[0].longShortRatio);
          console.log(`⚖️ L/S Ratio: ${lsRatio.toFixed(2)}`);
        }
      })
      .catch(() => { lsRatio = null; });

    // 4. Daily Candles for PDH/PDL (Yesterday's High / Low)
    const dailyUrl = useSpotAPI 
      ? `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1d&limit=2`
      : `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1d&limit=2`;
    fetchApi(dailyUrl)
      .then(d => {
        if (Array.isArray(d) && d.length >= 2) {
          pdh = parseFloat(d[0][2]);
          pdl = parseFloat(d[0][3]);
          console.log(`📅 True PDH: ${pdh}, True PDL: ${pdl}`);
        }
      })
      .catch((e) => {
        console.warn("⚠️ Failed to fetch true daily levels:", e);
      });

    // 5. Multi-Timeframe EMA21 (15m)
    const mtf15mUrl = useSpotAPI
      ? `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=15m&limit=30`
      : `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=15m&limit=30`;
    fetchApi(mtf15mUrl)
      .then(d => {
        if (Array.isArray(d) && d.length >= 21) {
          const closes = d.map(c => parseFloat(c[4]));
          const k = 2 / 22;
          let ema = closes[0];
          for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
          ema21_15m = ema;
          console.log(`📐 MTF 15m EMA21: $${ema.toFixed(2)}`);
        }
      })
      .catch(() => { ema21_15m = null; });

    // 6. Multi-Timeframe EMA21 (1h)
    const mtf1hUrl = useSpotAPI
      ? `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1h&limit=30`
      : `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1h&limit=30`;
    fetchApi(mtf1hUrl)
      .then(d => {
        if (Array.isArray(d) && d.length >= 21) {
          const closes = d.map(c => parseFloat(c[4]));
          const k = 2 / 22;
          let ema = closes[0];
          for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
          ema21_1h = ema;
          console.log(`📐 MTF 1h EMA21: $${ema.toFixed(2)}`);
        }
      })
      .catch(() => { ema21_1h = null; });
  }



  function connectWebSocket() {
    if (!activeSymbol) return;

    const symLower = activeSymbol.toLowerCase();
    const wsHost   = (useSpotAPI || forceSpotWS) ? "stream.binance.com" : "fstream.binance.com";
    const wsPath   = (useSpotAPI || forceSpotWS) ? "/stream" : "/market/stream";
    // For 1m timeframe avoid duplicate stream — 1m IS the tick stream
    const tfStream = settings.timeframe === '1m'
      ? `${symLower}@kline_1m`
      : `${symLower}@kline_${settings.timeframe}/${symLower}@kline_1m`;
    const wsUrl = `wss://${wsHost}${wsPath}?streams=${tfStream}`;

    console.log(`🔌 [PROXIED] Connecting WebSocket to: ${wsUrl}`);
    
    // We create a mock WS interface that content.js expects for clean shutdowns
    ws = {
      close: () => {
        chrome.runtime.sendMessage({ type: "DISCONNECT_WS" }).catch(() => {});
      }
    };

    chrome.runtime.sendMessage({ type: "CONNECT_WS", url: wsUrl }, (response) => {
      if (chrome.runtime.lastError || !response || !response.success) {
        console.error("❌ Failed to initiate proxied WebSocket connection:", chrome.runtime.lastError || response?.error);
        updateHUDStatus(true, "WS Proxy Error");
      }
    });
  }

  // --- TRAP BIAS DETECTORS & ALGORITHMS ---
  function detectLiquiditySweep(candles) {
    const len = candles.length;
    if (len < 30) return { bullishSweep: false, bearishSweep: false, level: 0 };

    const current = candles[len - 1];
    const lookback = candles.slice(len - 31, len - 1);
    const highestHigh = Math.max(...lookback.map(c => c.high));
    const lowestLow = Math.min(...lookback.map(c => c.low));

    const isBullishSweep = current.low < lowestLow && 
                          current.close > lowestLow &&
                          (current.close - current.low) / (current.high - current.low) >= 0.5;

    const isBearishSweep = current.high > highestHigh &&
                           current.close < highestHigh &&
                           (current.high - current.close) / (current.high - current.low) >= 0.5;

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
      
      if (isDown && isStrongUp) {
        bullish.push({ index: i, low: c.low, high: c.high, unmitigated: true });
      }

      const isUp = c.close > c.open;
      const isStrongDown = cNext.close < cNext.open && cNext2.close < cNext2.open && cNext2.close < candles[i - 1].low;

      if (isUp && isStrongDown) {
        bearish.push({ index: i, low: c.low, high: c.high, unmitigated: true });
      }
    }

    // Mitigate check
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

    if (c3.low > c1.high && c2.close > c2.open) {
      bullishGap = { low: c1.high, high: c3.low };
    }
    if (c3.high < c1.low && c2.close < c2.open) {
      bearishGap = { low: c3.high, high: c1.low };
    }
    return { bullishGap, bearishGap };
  }

  // --- CALCULATION ENGINE ---
  function runCalculations() {
    if (candles.length < 50) return;

    if (activeTrade && (activeTrade.status === "ACTIVE" || activeTrade.status === "SANDBOX_ACTIVE") && activeTrade.symbol === activeSymbol) {
      advisorMode = "MONITORING";
    } else {
      advisorMode = "HUNTING";
    }

    const closes = candles.map(c => c.close);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const rsi = calculateRSI(closes, 14);
    const macdData = calculateMACD(closes);

    const curClose = closes[closes.length - 1];
    const curEma9 = ema9[ema9.length - 1];
    const curEma21 = ema21[ema21.length - 1];
    const curRsi = rsi[rsi.length - 1];

    const orderBlocks = detectOrderBlocks(candles);
    const fvg = detectFVG(candles);
    const sweeps = detectLiquiditySweep(candles);

    // Save states for DB persistence
    lastIndicatorStates = {
      rsi: Math.round(curRsi),
      ema9: curEma9,
      ema21: curEma21,
      bullishOB: orderBlocks.bullish.filter(ob => ob.unmitigated).length,
      bearishOB: orderBlocks.bearish.filter(ob => ob.unmitigated).length
    };

    // --- PHASE 1 SHADOW MODE INTEGRATION ---
    if (window._antigravityEngine && window.AntigravityCore) {
      try {
        const { MarketRegime, MarketState } = window.AntigravityCore;
        
        // Volatility metrics
        const atrValues = calculateATR(candles, 14);
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

        // HTF alignment
        const htfAligned = (ema21_15m !== null && ema21_1h !== null)
          ? ((curClose > ema21_15m && curClose > ema21_1h && curEma9 > curEma21) ||
             (curClose < ema21_15m && curClose < ema21_1h && curEma9 < curEma21))
          : true;

        // Session metrics
        const dateObj = new Date(lastWsEventTime);
        const utcHour = dateObj.getUTCHours();
        const utcMin = dateObj.getUTCMinutes();
        const utcDec = utcHour + utcMin / 60;
        
        let sessionName = 'ASIA';
        let isOverlapSession = false;
        
        if (utcDec >= 8 && utcDec < 14) {
          sessionName = 'LONDON';
        } else if (utcDec >= 14 && utcDec < 21) {
          sessionName = 'NEW_YORK';
        } else if (utcDec >= 21 || utcDec < 2) {
          sessionName = 'POST_NY_CHOP';
        }
        
        if (utcDec >= 13 && utcDec <= 14) {
          isOverlapSession = true;
        }
        const minIntoSession = utcMin + (utcHour % 8) * 60;

        const ctx = {
          timestamp: lastWsEventTime,
          symbol: activeSymbol,
          regime: MarketRegime.CHOPPY, // Will be classified
          marketState: advisorMode === "HUNTING" ? MarketState.EXECUTION_WINDOW : MarketState.NO_TRADE,
          volatility: {
            atr: curAtr,
            isExpanding,
            isCompressing,
            historicalRank: atrRank
          },
          liquidityState: {
            hasSweep: sweeps.length > 0,
            sweepQuality: sweeps.length > 0 ? 85 : 0,
            recentSweepDirection: sweeps.length > 0 ? sweeps[0].type === 'bullish' ? 'BULLISH' : 'BEARISH' : null
          },
          trendState: {
            direction: curEma9 > curEma21 ? 'UP' : 'DOWN',
            strength: Math.abs(curEma9 - curEma21),
            htfAlignment: htfAligned
          },
          sessionState: { 
            currentSession: sessionName, 
            isOverlap: isOverlapSession, 
            minutesIntoSession: minIntoSession 
          },
          displacementQuality: 80,
          spread: curClose * 0.00015, // Est 1.5 bps spread
          confidence: 50,
          currentPrice: curClose
        };
        
        window._antigravityEngine.evaluateTick(ctx, true); // true = Shadow Mode
      } catch (err) {
        console.error("Shadow Mode Engine Error:", err);
      }
    }
    // ---------------------------------------

    if (advisorMode === "MONITORING") {
      runExitCalculations(curClose, curEma9, curEma21, curRsi, orderBlocks, sweeps);
    } else {
      // Reset close signal state
      closeSignal = { active: false, confidence: 0, reason: "", triggerCatalyst: "" };
      runAnalyzingCalculations(curClose, curEma9, curEma21, curRsi, macdData, orderBlocks, fvg, sweeps);
      
      // Recalculate mode immediately if a trade setup was triggered and registered
      if (activeTrade && (activeTrade.status === "ACTIVE" || activeTrade.status === "SANDBOX_ACTIVE")) {
        advisorMode = "MONITORING";
      }
    }

    updateHUDContent(lastIndicatorStates);
  }

  function runAnalyzingCalculations(curClose, curEma9, curEma21, curRsi, macdData, orderBlocks, fvg, sweeps) {
    const macdLine = macdData.macd[macdData.macd.length - 1];
    const signalLine = macdData.signal[macdData.signal.length - 1];

    let trendScore = 0;      
    let smcScore = 0;        
    let momentumScore = 0;   

    let reasons = [];
    let activePattern = "Scanning Range";

    // 1. Trend Calculations (Max 25)
    if (settings.enableTechnical) {
      if (curClose > curEma21) {
        trendScore += 10;
        if (curEma9 > curEma21) trendScore += 15;
      } else {
        trendScore -= 10;
        if (curEma9 < curEma21) trendScore -= 15;
      }
    }

    // 1b. SESSION FILTER — refined UTC windows (veteran timezone calibration)
    {
      const candleTimeMs = candles[candles.length - 1].time;
      const utcDecimal = new Date(candleTimeMs).getUTCHours() + new Date(candleTimeMs).getUTCMinutes() / 60;

      if (utcDecimal >= 13 && utcDecimal < 14) {
        // London/NY overlap — highest real volume of the day, both desks active
        trendScore += 15;
        reasons.push("London/NY Overlap — Peak Liquidity");
      } else if (utcDecimal >= 8 && utcDecimal < 10) {
        // London core — real institutional flow, tight spreads
        trendScore += 15;
        reasons.push("London Core Session");
      } else if (utcDecimal >= 14 && utcDecimal < 17) {
        // NY session proper — solid volume, trending moves
        trendScore += 10;
        reasons.push("NY Session Active");
      } else if (utcDecimal >= 7 && utcDecimal < 8) {
        // Pre-London — wide spreads, fake breakouts common, caution
        trendScore += 5;
        reasons.push("Pre-London Caution Zone");
      } else if (utcDecimal >= 2 && utcDecimal < 4) {
        // Tokyo open — BTC/crypto gets genuine Asia volume (Binance JP, OKX Asia)
        // Neutral, not penalised — real sweeps happen here
        reasons.push("Tokyo Open — Neutral");
      } else if (utcDecimal >= 17 && utcDecimal < 21) {
        // NY afternoon — volume drops fast after 17:00, choppy drift
        trendScore -= 5;
        reasons.push("NY Afternoon Drift — Fading Volume");
      } else if (utcDecimal >= 0 && utcDecimal < 2) {
        // True dead zone — midnight to Tokyo open, no real players
        trendScore -= 10;
        reasons.push("Midnight Dead Zone — No Liquidity");
      } else if (utcDecimal >= 4 && utcDecimal < 7) {
        // Late Asia / pre-Europe — genuinely thin, avoid
        trendScore -= 10;
        reasons.push("Asia Dead Zone — Low Volume");
      }
      // 21:00–24:00 UTC: late NY / transition — no bias applied (neutral)
    }

    // 1c. MULTI-TIMEFRAME TREND COHERENCE GATE
    if (ema21_15m !== null && ema21_1h !== null) {
      const bullish5m = curClose > curEma21;
      const bullish15m = curClose > ema21_15m;
      const bullish1h = curClose > ema21_1h;

      if (bullish5m && bullish15m && bullish1h) {
        trendScore += 15;
        reasons.push('MTF Aligned — All Bullish');
      } else if (!bullish5m && !bullish15m && !bullish1h) {
        trendScore -= 15;
        reasons.push('MTF Aligned — All Bearish');
      } else if (bullish5m !== bullish15m || bullish5m !== bullish1h) {
        // Counter-trend: 5m opposes higher timeframes
        const htfBias = bullish15m && bullish1h ? 'Bullish' : (!bullish15m && !bullish1h) ? 'Bearish' : 'Mixed';
        if (htfBias !== 'Mixed') {
          trendScore -= 10;
          reasons.push(`MTF Divergence — Counter-Trend (HTF ${htfBias})`);
        } else {
          reasons.push('MTF Mixed — No Clear HTF Trend');
        }
      }
    } else {
      reasons.push('MTF Data Pending');
    }

    // 2. SMC & Traps Calculations (Max 45)
    if (settings.enableSMC) {
      if (sweeps.bullishSweep) {
        smcScore += 35;
        activePattern = "Liquidity Sweep Reversal";
        reasons.push("Bullish Stop Hunt Sweep");
        if (fvg.bullishGap) {
          smcScore += 15; // Extra weight for structural displacement
          reasons.push("Bullish Displacement");
        }
      } else if (sweeps.bearishSweep) {
        smcScore -= 35;
        activePattern = "Liquidity Sweep Reversal";
        reasons.push("Bearish Stop Hunt Sweep");
        if (fvg.bearishGap) {
          smcScore -= 15; // Extra weight for structural displacement
          reasons.push("Bearish Displacement");
        }
      }

      const inBullishOB = orderBlocks.bullish.some(ob => curClose >= ob.low && curClose <= ob.high && ob.unmitigated);
      const inBearishOB = orderBlocks.bearish.some(ob => curClose >= ob.low && curClose <= ob.high && ob.unmitigated);

      if (inBullishOB) {
        smcScore += 20;
        reasons.push("OB Support Rebound");
        if (activePattern === "Scanning Range") activePattern = "Bullish Order Block Hold";
      }
      if (inBearishOB) {
        smcScore -= 20;
        reasons.push("OB Resistance Rebound");
        if (activePattern === "Scanning Range") activePattern = "Bearish Order Block Hold";
      }

      if (fvg.bullishGap && curClose >= fvg.bullishGap.low && curClose <= fvg.bullishGap.high) {
        smcScore += 10;
        reasons.push("FVG Support Refill");
      }
      if (fvg.bearishGap && curClose >= fvg.bearishGap.low && curClose <= fvg.bearishGap.high) {
        smcScore -= 10;
        reasons.push("FVG Resistance Refill");
      }

      // 2b. VOLUME SPIKE CONFIRMATION (±15 pts)
      {
        const len = candles.length;
        const recentVols = candles.slice(len - 21, len - 1).map(c => c.volume);
        const avgVol = recentVols.reduce((s, v) => s + v, 0) / recentVols.length;
        const curVol  = candles[len - 1].volume;

        if (sweeps.bullishSweep || sweeps.bearishSweep) {
          if (curVol > avgVol * 1.5) {
            smcScore += 15;
            reasons.push("Volume Confirmed Sweep");
          } else if (curVol < avgVol * 0.8) {
            smcScore -= 10;
            reasons.push("Low Volume Suspect Sweep");
          }
        }
      }

      // 2c. CANDLE STRUCTURE QUALITY (0 to ±10 pts)
      {
        const cc = candles[candles.length - 1];
        const candleRange = cc.high - cc.low;
        if (candleRange > 0) {
          const rejectionRatio = (cc.close - cc.low) / candleRange;
          const invertedRatio  = (cc.high - cc.close) / candleRange;

          if (sweeps.bullishSweep && rejectionRatio > 0.65) {
            smcScore += 10;
            reasons.push("Strong Rejection Wick");
          }
          if (sweeps.bearishSweep && invertedRatio > 0.65) {
            smcScore -= 10;
            reasons.push("Strong Bearish Rejection Wick");
          }
        }
      }

      // 2d. BOS CONFIRMATION (±10 pts)
      {
        const len = candles.length;
        const lookback = candles.slice(len - 15, len - 1);
        const swingHigh = Math.max(...lookback.map(c => c.high));
        const swingLow  = Math.min(...lookback.map(c => c.low));
        const currentClose = candles[len - 1].close;

        if (sweeps.bullishSweep && currentClose > swingHigh) {
          smcScore += 10;
          reasons.push("BOS Confirmed Long");
        }
        if (sweeps.bearishSweep && currentClose < swingLow) {
          smcScore -= 10;
          reasons.push("BOS Confirmed Short");
        }
      }

      // 2e. PREMIUM / DISCOUNT ZONE FILTER (±12 pts)
      {
        const len = candles.length;
        const last50 = candles.slice(len - 50);
        const rangeHigh = Math.max(...last50.map(c => c.high));
        const rangeLow  = Math.min(...last50.map(c => c.low));
        const midpoint  = (rangeHigh + rangeLow) / 2;

        if (sweeps.bullishSweep) {
          if (curClose < midpoint) {
            smcScore += 12;
            reasons.push("Buying in Discount Zone");
          } else {
            smcScore -= 12;
            reasons.push("Buying in Premium — Risky Entry");
          }
        }
        if (sweeps.bearishSweep) {
          if (curClose > midpoint) {
            smcScore -= 12;
            reasons.push("Selling in Premium Zone");
          } else {
            smcScore += 12;
            reasons.push("Selling in Discount — Risky Short");
          }
        }
      }

      // 2f. PREVIOUS DAY HIGH / LOW (±15 pts)
      if (pdh !== null && pdl !== null) {
        const len = candles.length;
        const cur = candles[len - 1];

        // PDL sweep reversal (swept below PDL then closed above it)
        if (sweeps.bullishSweep && cur.low < pdl && cur.close > pdl) {
          smcScore += 15;
          reasons.push("PDL Sweep Reversal");
        } else if (sweeps.bullishSweep && Math.abs(curClose - pdl) / curClose < 0.0015) {
          smcScore += 10;
          reasons.push("At PDL — Support Confirmed");
        }

        // PDH sweep rejection (swept above PDH then closed below it)
        if (sweeps.bearishSweep && cur.high > pdh && cur.close < pdh) {
          smcScore -= 15;
          reasons.push("PDH Sweep Rejection");
        } else if (sweeps.bearishSweep && Math.abs(curClose - pdh) / curClose < 0.0015) {
          smcScore -= 10;
          reasons.push("At PDH — Resistance");
        }
      }

      // 2g. EQUAL HIGHS / EQUAL LOWS — Liquidity Pool Detection (±8 pts)
      {
        const len = candles.length;
        const lookback30 = candles.slice(len - 31, len - 1);
        const THRESHOLD = 0.0008; // 0.08%

        let equalHighsExist = false;
        let equalLowsExist  = false;
        let eqHighLevel = 0;
        let eqLowLevel  = 0;

        for (let i = 0; i < lookback30.length; i++) {
          for (let j = i + 1; j < lookback30.length; j++) {
            const hiDiff = Math.abs(lookback30[i].high - lookback30[j].high) / lookback30[i].high;
            const loDiff = Math.abs(lookback30[i].low  - lookback30[j].low)  / lookback30[i].low;
            if (hiDiff < THRESHOLD) { equalHighsExist = true; eqHighLevel = (lookback30[i].high + lookback30[j].high) / 2; }
            if (loDiff < THRESHOLD) { equalLowsExist  = true; eqLowLevel  = (lookback30[i].low  + lookback30[j].low)  / 2; }
          }
        }

        if (sweeps.bullishSweep && equalLowsExist && Math.abs(curClose - eqLowLevel) / curClose < 0.01) {
          smcScore += 8;
          reasons.push("Equal Lows Swept — Bullish");
        }
        if (sweeps.bearishSweep && equalHighsExist && Math.abs(curClose - eqHighLevel) / curClose < 0.01) {
          smcScore -= 8;
          reasons.push("Equal Highs Swept — Bearish");
        }
      }

      // 2h. OTE FIBONACCI GOLDEN POCKET (±10 pts)
      {
        const len = candles.length;
        const swing = candles.slice(len - 21, len - 1);
        const swHigh = Math.max(...swing.map(c => c.high));
        const swLow  = Math.min(...swing.map(c => c.low));
        const range  = swHigh - swLow;

        if (range > 0) {
          if (sweeps.bullishSweep) {
            const oteL = swHigh - range * 0.79;
            const oteH = swHigh - range * 0.618;
            if (curClose >= oteL && curClose <= oteH) {
              smcScore += 10;
              reasons.push("OTE Golden Pocket — Long");
            }
          }
          if (sweeps.bearishSweep) {
            const oteL = swLow + range * 0.618;
            const oteH = swLow + range * 0.79;
            if (curClose >= oteL && curClose <= oteH) {
              smcScore -= 10;
              reasons.push("OTE Golden Pocket — Short");
            }
          }
        }
      }

      // 2i. INSIDE BAR COMPRESSION — Pre-Sweep Energy (±8 pts)
      {
        const len = candles.length;
        let compressionCount = 0;
        for (let i = len - 2; i >= Math.max(1, len - 6); i--) {
          if (candles[i].high < candles[i - 1].high && candles[i].low > candles[i - 1].low) {
            compressionCount++;
          } else break;
        }
        if (compressionCount >= 2) {
          if (sweeps.bullishSweep) { smcScore += 8; reasons.push(`Pre-Sweep Compression (${compressionCount} IBs) — Energy Release`); }
          if (sweeps.bearishSweep) { smcScore -= 8; reasons.push(`Pre-Sweep Compression (${compressionCount} IBs) — Energy Release`); }
        }
      }

      // 2j. ROUND NUMBER MAGNETIC LEVELS (±6 pts)
      {
        const roundUnit = curClose > 5000 ? 1000 : curClose > 100 ? 100 : 10;
        const nearestRound = Math.round(curClose / roundUnit) * roundUnit;
        const distPct = Math.abs(curClose - nearestRound) / curClose;
        if (distPct < 0.003) {
          if (sweeps.bullishSweep && curClose > nearestRound) { smcScore += 6; reasons.push(`Round Number Support $${nearestRound}`); }
          if (sweeps.bearishSweep && curClose < nearestRound) { smcScore -= 6; reasons.push(`Round Number Resistance $${nearestRound}`); }
        }
      }

      // 2k. BINANCE FUTURES — Funding Rate, OI Delta, L/S Ratio (async data)
      {
        if (fundingRate !== null) {
          const fPct = fundingRate * 100;
          if (fPct > 0.05)       { smcScore -= 15; reasons.push(`Extreme Long Funding ${fPct.toFixed(3)}% — Squeeze Risk`); }
          else if (fPct < -0.03) { smcScore += 15; reasons.push(`Extreme Short Funding ${fPct.toFixed(3)}% — Squeeze Imminent`); }
          else if (fPct > 0.01)  { smcScore -= 5;  reasons.push(`Positive Funding — Mild Long Overcrowding`); }
        }

        if (oiDelta !== 0) {
          if (sweeps.bullishSweep) {
            if (oiDelta > 0)  { smcScore += 12; reasons.push("OI Rising — Real Buying"); }
            else              { smcScore -= 8;  reasons.push("OI Falling — Short Cover Only"); }
          }
          if (sweeps.bearishSweep) {
            if (oiDelta > 0)  { smcScore -= 12; reasons.push("OI Rising — Real Selling"); }
            else              { smcScore += 8;  reasons.push("OI Falling — Liq Exhausted"); }
          }
        }

        if (lsRatio !== null) {
          if (lsRatio > 1.8)  { smcScore -= 10; reasons.push(`Crowd ${Math.round(lsRatio/(1+lsRatio)*100)}% Long — Contrarian Short`); }
          else if (lsRatio < 0.6) { smcScore += 10; reasons.push(`Crowd ${Math.round(1/(1+lsRatio)*100)}% Short — Contrarian Long`); }
        }
      }
    }

    // 3. Momentum & RSI Calculations (Max 30)
    if (settings.enableTechnical) {
      if (curRsi < 32) {
        momentumScore += 20;
        reasons.push("RSI Oversold Pivot");
      } else if (curRsi > 68) {
        momentumScore -= 20;
        reasons.push("RSI Overbought Pivot");
      }

      if (macdLine > signalLine) {
        momentumScore += 10;
      } else {
        momentumScore -= 10;
      }
    }

    // 4. ADX TREND STRENGTH GATE (±10 pts to trendScore)
    if (settings.enableTechnical) {
      const len = candles.length;
      if (len >= 28) {
        let plusDM = 0, minusDM = 0, trSum = 0;
        for (let i = len - 14; i < len; i++) {
          const upMove   = candles[i].high - candles[i - 1].high;
          const downMove = candles[i - 1].low - candles[i].low;
          plusDM  += (upMove > downMove && upMove > 0) ? upMove : 0;
          minusDM += (downMove > upMove && downMove > 0) ? downMove : 0;
          const tr = Math.max(
            candles[i].high - candles[i].low,
            Math.abs(candles[i].high - candles[i - 1].close),
            Math.abs(candles[i].low  - candles[i - 1].close)
          );
          trSum += tr;
        }
        if (trSum > 0) {
          const diPlus  = (plusDM  / trSum) * 100;
          const diMinus = (minusDM / trSum) * 100;
          const diSum   = diPlus + diMinus;
          const adx     = diSum > 0 ? Math.abs(diPlus - diMinus) / diSum * 100 : 0;

          if (adx < 20)      { trendScore -= 10; reasons.push(`ADX ${adx.toFixed(0)} — Ranging Market`); }
          else if (adx > 40) { smcScore -= 10;   reasons.push(`ADX ${adx.toFixed(0)} — Overextended Trend`); }
        }
      }
    }

    // 4b. RSI DIVERGENCE (±12 pts to momentumScore)
    {
      const closes = candles.map(c => c.close); // derive from module-level candles
      if (settings.enableTechnical && closes.length >= 20) {
        const rsiArr = calculateRSI(closes, 14);
        const lookN  = 6;
        const rsiNow  = rsiArr[rsiArr.length - 1];
        const rsiPrev = rsiArr[rsiArr.length - 1 - lookN];
        const pxNow   = closes[closes.length - 1];
        const pxPrev  = closes[closes.length - 1 - lookN];

        // Bearish divergence: price higher, RSI lower
        if (pxNow > pxPrev && rsiNow < rsiPrev - 3) {
          momentumScore -= 12;
          reasons.push("Bearish RSI Divergence");
        }
        // Bullish divergence: price lower, RSI higher
        else if (pxNow < pxPrev && rsiNow > rsiPrev + 3) {
          momentumScore += 12;
          reasons.push("Bullish RSI Divergence");
        }
      }
    }

    // 4c. CIRCUIT BREAKER — Consecutive Loss Guard (toggleable)
    if (settings.enableCircuitBreaker) {
      if (consecutiveLosses >= 3) {
        currentSignal.direction   = "WAITING";
        currentSignal.probability = 50;
        currentSignal.patternName = "Circuit Breaker Active";
        currentSignal.reason      = `Bot paused: ${consecutiveLosses} consecutive losses. Reset required.`;
        reasons.push(`🚨 Circuit Breaker: ${consecutiveLosses} Consecutive Losses`);
        updateHUDContent(lastIndicatorStates);
        return;
      }
      if (consecutiveLosses === 2) {
        trendScore    *= 0.5;
        smcScore      *= 0.5;
        momentumScore *= 0.5;
        reasons.push("⚠️ Warning: 2 Consecutive Losses — Confidence Halved");
      } else if (consecutiveLosses === 1) {
        reasons.push("Caution: 1 Loss Streak");
      }
    }

    // 5. ATR VOLATILITY GATE — checked BEFORE totalScore
    {
      const len = candles.length;
      // Mathematically correct True Range (TR) ATR calculation
      let trSum = 0;
      for (let i = len - 14; i < len; i++) {
        const c = candles[i];
        const prevC = candles[i - 1];
        let tr = c.high - c.low;
        if (prevC) {
          tr = Math.max(tr, Math.abs(c.high - prevC.close), Math.abs(c.low - prevC.close));
        }
        trSum += tr;
      }
      const atr14 = trSum / 14;

      const lastC = candles[len - 1];
      const prevC = candles[len - 2];
      let currentRange = lastC.high - lastC.low;
      if (prevC) {
        currentRange = Math.max(currentRange, Math.abs(lastC.high - prevC.close), Math.abs(lastC.low - prevC.close));
      }

      if (currentRange < 0.3 * atr14) {
        // Choppy market — abort signal entirely
        currentSignal.direction    = "WAITING";
        currentSignal.probability  = 50;
        currentSignal.patternName  = "Choppy — No Signal";
        currentSignal.reason       = "ATR Gate: Choppy Market — no edge";
        currentSignal.triggerCatalyst = "ATR Gate triggered: range below 30% of ATR14. Market is choppy.";
        reasons.push("ATR Gate: Choppy Market");
        updateHUDContent(lastIndicatorStates);
        return;
      }

      if (currentRange > 2.0 * atr14) {
        smcScore -= 20;
        reasons.push("ATR Gate: News Spike Risk");
      }
    }

    const totalScore = trendScore + smcScore + momentumScore;
    // Max possible ~+215, min ~-215 — normalization window = 430
    const clampedProb = Math.max(0, Math.min(Math.round(((totalScore + 215) / 430) * 100), 100));

    currentSignal.confidenceBreakdown = {
      trend: Math.abs(trendScore),
      smc: Math.abs(smcScore),
      momentum: Math.abs(momentumScore)
    };

    // ── TRADING FLOOR NARRATIVE GENERATOR ──
    {
      const direction = totalScore > 0 ? 'bullish' : totalScore < 0 ? 'bearish' : 'neutral';
      const trendBias = curClose > curEma21 ? 'BULLISH' : 'BEARISH';
      const emaCross = curEma9 > curEma21 ? 'golden cross (EMA9 > EMA21)' : 'death cross (EMA9 < EMA21)';

      // Sentence 1: Market structure context
      let sentence1 = `Price action on ${activeSymbol} is trading at $${curClose.toFixed(2)} with a ${trendBias} trend bias, confirmed by a ${emaCross} alignment.`;

      // Sentence 2: SMC structure narrative
      let sentence2 = '';
      if (sweeps.bullishSweep) {
        sentence2 = `Institutional liquidity was swept below the $${sweeps.level.toFixed(2)} low, triggering a bullish stop hunt reversal — a classic Smart Money accumulation pattern.`;
      } else if (sweeps.bearishSweep) {
        sentence2 = `Price engineered a sweep above the $${sweeps.level.toFixed(2)} high, trapping late longs before reversing — a textbook Smart Money distribution move.`;
      } else {
        sentence2 = `No significant liquidity sweep detected in the current range — price is consolidating within established structure.`;
      }

      // Sentence 3: Multi-timeframe & momentum context
      let mtfStatus = 'unavailable';
      if (ema21_15m !== null && ema21_1h !== null) {
        const aligned = (curClose > ema21_15m && curClose > ema21_1h) || (curClose < ema21_15m && curClose < ema21_1h);
        mtfStatus = aligned ? 'fully aligned across 15m and 1h' : 'divergent — higher timeframe conflict detected';
      }
      let sentence3 = `Multi-timeframe confluence is ${mtfStatus}. RSI reads ${Math.round(curRsi)} (${curRsi < 32 ? 'oversold territory' : curRsi > 68 ? 'overbought territory' : 'neutral zone'}), and the confidence breakdown shows Trend:${Math.abs(trendScore).toFixed(0)} | SMC:${Math.abs(smcScore).toFixed(0)} | Momentum:${Math.abs(momentumScore).toFixed(0)} for a composite score of ${totalScore > 0 ? '+' : ''}${totalScore.toFixed(0)}.`;

      // Sentence 4: Key catalysts summary
      const topReasons = reasons.slice(0, 4).join(', ') || 'No significant catalysts';
      let sentence4 = `Key catalysts: ${topReasons}. Active OBs: ${lastIndicatorStates.bullishOB} bullish, ${lastIndicatorStates.bearishOB} bearish.`;

      currentSignal.triggerCatalyst = `${sentence1} ${sentence2} ${sentence3} ${sentence4}`;
    }

    // Trigger signals
    const threshold = settings.triggerThreshold !== undefined ? settings.triggerThreshold : 78;
    const useCustom = settings.targetMode === 'CUSTOM';

    if (clampedProb >= threshold) {
      currentSignal.direction = "LONG";
      currentSignal.probability = clampedProb;
      currentSignal.entry = curClose;
      currentSignal.patternName = activePattern;
      
      if (useCustom) {
        const leverage = parseFloat(settings.leverage) || 3;
        const isPosMode = settings.customTpSlMode === 'position';
        const stopLossPercent = isPosMode 
          ? (parseFloat(settings.customStopLoss) || 0)
          : (parseFloat(settings.customStopLoss) || 0) / leverage;
        const takeProfitPercent = isPosMode 
          ? (parseFloat(settings.customTakeProfit) || 0)
          : (parseFloat(settings.customTakeProfit) || 0) / leverage;
        currentSignal.stopLoss = curClose * (1 - (stopLossPercent / 100));
        currentSignal.target1 = curClose * (1 + (takeProfitPercent / 100));
        currentSignal.target2 = curClose * (1 + (takeProfitPercent / 100) * 2);
      } else {
        const closestBullishOB = orderBlocks.bullish.filter(ob => ob.unmitigated).pop();
        const structLow = closestBullishOB ? closestBullishOB.low : Math.min(candles[candles.length - 2].low, candles[candles.length - 1].low);
        currentSignal.stopLoss = Math.max(structLow, curClose * 0.985); 

        const riskAmt = currentSignal.entry - currentSignal.stopLoss;
        currentSignal.target1 = currentSignal.entry + riskAmt * 1.5;
        currentSignal.target2 = currentSignal.entry + riskAmt * 3.0;
      }
      currentSignal.reason = reasons.slice(0, 2).join(" + ") || "Bullish Imbalance Detect";

      calculateRiskMetrics();
      triggerAudioAlert();
      autoRegisterActiveTrade(); 
    } else if (clampedProb <= (100 - threshold)) {
      currentSignal.direction = "SHORT";
      currentSignal.probability = 100 - clampedProb;
      currentSignal.entry = curClose;
      currentSignal.patternName = activePattern;

      if (useCustom) {
        const leverage = parseFloat(settings.leverage) || 3;
        const isPosMode = settings.customTpSlMode === 'position';
        const stopLossPercent = isPosMode 
          ? (parseFloat(settings.customStopLoss) || 0)
          : (parseFloat(settings.customStopLoss) || 0) / leverage;
        const takeProfitPercent = isPosMode 
          ? (parseFloat(settings.customTakeProfit) || 0)
          : (parseFloat(settings.customTakeProfit) || 0) / leverage;
        currentSignal.stopLoss = curClose * (1 + (stopLossPercent / 100));
        currentSignal.target1 = curClose * (1 - (takeProfitPercent / 100));
        currentSignal.target2 = curClose * (1 - (takeProfitPercent / 100) * 2);
      } else {
        const closestBearishOB = orderBlocks.bearish.filter(ob => ob.unmitigated).pop();
        const structHigh = closestBearishOB ? closestBearishOB.high : Math.max(candles[candles.length - 2].high, candles[candles.length - 1].high);
        currentSignal.stopLoss = Math.min(structHigh, curClose * 1.015);

        const riskAmt = currentSignal.stopLoss - currentSignal.entry;
        currentSignal.target1 = currentSignal.entry - riskAmt * 1.5;
        currentSignal.target2 = currentSignal.entry - riskAmt * 3.0;
      }
      currentSignal.reason = reasons.slice(0, 2).join(" + ") || "Bearish Imbalance Detect";

      calculateRiskMetrics();
      triggerAudioAlert();
      autoRegisterActiveTrade();
    } else {
      currentSignal.direction = "WAITING";
      currentSignal.probability = 50;
      currentSignal.patternName = "Scanning Markets";
      currentSignal.reason = "Awaiting institutional traps or structure sweeps...";
    }
  }

  function runExitCalculations(curClose, curEma9, curEma21, curRsi, orderBlocks, sweeps) {
    if (!activeTrade) return;

    let exitScore = 0;
    let reasons = [];

    const isLong = activeTrade.direction === "LONG";

    if (isLong) {
      // 1. Trend Reversal: 9 EMA < 21 EMA (Weight: 40)
      if (curEma9 < curEma21) {
        exitScore += 40;
        reasons.push("EMA Bearish Cross");
      }
      // 2. Opposing Sweep: Bearish sweep (Weight: 40)
      if (sweeps.bearishSweep) {
        exitScore += 40;
        reasons.push("Bearish Liquidity Sweep");
      }
      // 3. Opposing Order Block: Price enters Bearish OB (Weight: 20)
      const inBearishOB = orderBlocks.bearish.some(ob => curClose >= ob.low && curClose <= ob.high && ob.unmitigated);
      if (inBearishOB) {
        exitScore += 20;
        reasons.push("Inside Bearish OB");
      }
      // 4. RSI Shift: RSI < 50 (Weight: 10)
      if (curRsi < 50) {
        exitScore += 10;
        reasons.push("RSI < 50 Bearish Pivot");
      }
    } else { // SHORT
      // 1. Trend Reversal: 9 EMA > 21 EMA (Weight: 40)
      if (curEma9 > curEma21) {
        exitScore += 40;
        reasons.push("EMA Bullish Cross");
      }
      // 2. Opposing Sweep: Bullish sweep (Weight: 40)
      if (sweeps.bullishSweep) {
        exitScore += 40;
        reasons.push("Bullish Liquidity Sweep");
      }
      // 3. Opposing Order Block: Price enters Bullish OB (Weight: 20)
      const inBullishOB = orderBlocks.bullish.some(ob => curClose >= ob.low && curClose <= ob.high && ob.unmitigated);
      if (inBullishOB) {
        exitScore += 20;
        reasons.push("Inside Bullish OB");
      }
      // 4. RSI Shift: RSI > 50 (Weight: 10)
      if (curRsi > 50) {
        exitScore += 10;
        reasons.push("RSI > 50 Bullish Pivot");
      }
    }

    // 5. Time decay: elapsedCandles >= 8 (Weight: 15)
    if (activeTrade.elapsedCandles >= 8) {
      exitScore += 15;
      reasons.push("Signal Decay (>8 Candles)");
    }

    const finalConfidence = Math.min(exitScore, 100);

    if (finalConfidence >= 40) {
      closeSignal.active = true;
      closeSignal.confidence = finalConfidence;
      closeSignal.reason = reasons.slice(0, 2).join(" + ") || "Adverse Conditions";
      closeSignal.triggerCatalyst = `Exit Confidence ${finalConfidence}%: ${reasons.join(', ')}`;
      
      if (finalConfidence === 100) {
        triggerCloseAudioAlert();
      }
    } else {
      closeSignal.active = false;
      closeSignal.confidence = 0;
      closeSignal.reason = "";
      closeSignal.triggerCatalyst = "";
    }
  }

  function triggerCloseAudioAlert() {
    if (!settings.enableAudio) return;
    const now = Date.now();
    if (now - lastSpokenTime < SPEECH_COOLDOWN_MS) return;

    const text = `Alert: Adverse trend detected. Recommended early exit for ${activeSymbol} active position now.`;
    const speech = new SpeechSynthesisUtterance(text);
    speech.rate = 0.95;
    window.speechSynthesis.speak(speech);
    lastSpokenTime = now;
  }

  function calculateRiskMetrics() {
    if (currentSignal.direction === "WAITING" || currentSignal.entry === currentSignal.stopLoss) return;
    
    const entry = parseFloat(currentSignal.entry);
    const stopLoss = parseFloat(currentSignal.stopLoss);
    const leverage = parseFloat(settings.leverage) || 3;
    const riskAmount = parseFloat(settings.riskAmount) || 20;
    const tradeCapital = parseFloat(settings.tradeCapital) || 100;

    if (isNaN(entry) || entry <= 0 || isNaN(stopLoss) || stopLoss <= 0 || leverage <= 0 || isNaN(leverage)) {
      return;
    }

    const prec = symbolPrecisions[activeSymbol];
    const qPrec = prec !== undefined ? prec.quantityPrecision : 3;

    if (settings.sizeMode === 'CAPITAL') {
      const nominalPositionSize = tradeCapital * leverage;
      currentSignal.positionSize = (nominalPositionSize / entry).toFixed(qPrec);
      currentSignal.marginRequired = tradeCapital.toFixed(2);
    } else {
      const stopDistance = Math.abs(entry - stopLoss);
      if (stopDistance <= 0) return;
      const riskPercentage = (stopDistance / entry) * 100;
      const nominalPositionSize = riskAmount / (riskPercentage / 100);
      currentSignal.positionSize = (nominalPositionSize / entry).toFixed(qPrec);
      currentSignal.marginRequired = (nominalPositionSize / leverage).toFixed(2);
    }
  }

  // --- PERSISTENCE: TRADE TRACKER ENGINE (POSTGRESQL SYNCED) ---
  function autoRegisterActiveTrade() {
    if (!checkContextSafety()) return;
    if (activeTrades[activeSymbol]) return;

    const isSandbox = !!settings.sandboxMode;
    const prec = symbolPrecisions[activeSymbol];
    const qPrec = prec !== undefined ? prec.quantityPrecision : 3;
    const pPrec = prec !== undefined ? prec.pricePrecision : 2;

    activeTrade = {
      id: "T-" + Date.now(),
      dbId: null, 
      symbol: activeSymbol,
      direction: currentSignal.direction,
      entry: currentSignal.entry,
      stopLoss: currentSignal.stopLoss,
      target1: currentSignal.target1,
      target2: currentSignal.target2,
      pricePrecision: pPrec,
      quantityPrecision: qPrec,
      triggerTime: candles[candles.length - 1].time,
      elapsedCandles: 0,
      status: isSandbox ? "SANDBOX_ACTIVE" : "ACTIVE",
      actionTaken: false,
      pattern: currentSignal.patternName,
      confidence: currentSignal.probability,
      triggerCatalyst: currentSignal.triggerCatalyst,
      leverage: settings.leverage,          // BUG8 FIX: stored so popup PnL uses correct leverage
      timeframe: settings.timeframe,
      positionSize: parseFloat(currentSignal.positionSize) || 0
    };

    activeTrades[activeSymbol] = activeTrade;
    chrome.storage.local.set({ ['activeTrade_' + activeSymbol]: activeTrade });

    const payload = {
      symbol: activeTrade.symbol,
      direction: activeTrade.direction,
      entryPrice: activeTrade.entry,
      stopLoss: activeTrade.stopLoss,
      target1: activeTrade.target1,
      target2: activeTrade.target2,
      positionSize: parseFloat(currentSignal.positionSize),
      marginRequired: parseFloat(currentSignal.marginRequired),
      leverage: settings.leverage,
      riskAmount: settings.riskAmount,
      probability: activeTrade.confidence,
      patternName: activeTrade.pattern,
      rsiValue: lastIndicatorStates.rsi,
      ema9: lastIndicatorStates.ema9,
      ema21: lastIndicatorStates.ema21,
      bullishObCount: lastIndicatorStates.bullishOB,
      bearishObCount: lastIndicatorStates.bearishOB,
      confidenceTrend: currentSignal.confidenceBreakdown.trend,
      confidenceSmc: currentSignal.confidenceBreakdown.smc,
      confidenceMomentum: currentSignal.confidenceBreakdown.momentum,
      triggerCatalyst: activeTrade.triggerCatalyst,
      timeframe: settings.timeframe,
      status: isSandbox ? "SANDBOX_ACTIVE" : "ACTIVE",
      hypotheticalOutcome: isSandbox ? "SANDBOX_ACTIVE" : "ACTIVE",
      actualOutcome: isSandbox ? "SANDBOX" : null
    };

    fetchApi('http://localhost:4000/api/advisor/signals', 'POST', payload)
    .then(data => {
      if (data && data.id) {
        activeTrade.dbId = data.id;
        activeTrades[activeSymbol] = activeTrade;
        chrome.storage.local.set({ ['activeTrade_' + activeSymbol]: activeTrade });
        console.log(`💾 Trade successfully logged to PostgreSQL. DB ID: ${data.id}`);
        
        // Dispatch SMS alert for new setup
        const sandboxPrefix = isSandbox ? "🧪 [SANDBOX] " : "";
        const alertMsg = `${sandboxPrefix}⚠️ [ANTIGRAVITY BOT ALERT] New trade triggered on ${activeSymbol}: ${activeTrade.direction} setup at entry $${activeTrade.entry}. SL: $${activeTrade.stopLoss}, TP: $${activeTrade.target1}.`;
        triggerSMSAlert(alertMsg);

        if (settings.enableAutoPilot && !activeTrade.actionTaken) {
          console.log("🤖 Auto-Pilot: Automatically logging action taken for active trade...");
          markUserActionTaken();
        }
      }
    })
    .catch(err => {
      console.warn("⚠️ Local PostgreSQL backend is unreachable.", err.message);
    });
  }

  // Helper to send alert to server console simulated gateway
  function triggerSMSAlert(message) {
    if (!settings.alertPhone) {
      console.log("📱 SMS alert skipped: No phone number configured.");
      return;
    }
    const payload = {
      phone: settings.alertPhone,
      message: message
    };
    fetchApi('http://localhost:4000/api/advisor/alerts', 'POST', payload)
      .then(() => {
        console.log(`📱 SMS Alert dispatched to backend console for ${settings.alertPhone}`);
      })
      .catch(err => {
        console.error("❌ Failed to send SMS alert:", err.message);
      });
  }

  // Sends action taken trigger to API
  function markUserActionTaken() {
    if (!checkContextSafety()) return;
    if (!activeTrade || !activeTrade.dbId) return;

    activeTrade.actionTaken = true;
    activeTrades[activeSymbol] = activeTrade;
    chrome.storage.local.set({ ['activeTrade_' + activeSymbol]: activeTrade });
    runCalculations(); // Redraw HUD buttons immediately

    fetchApi(`http://localhost:4000/api/advisor/signals/${activeTrade.dbId}/action`, 'POST')
    .then(() => {
      console.log(`💾 PostgreSQL database updated. User entry action recorded for: ${activeTrade.dbId}`);
    })
    .catch(err => {
      console.error("⚠️ Failed to record action taken to PostgreSQL:", err.message);
    });
  }

  function trackActiveTradeLive() {
    if (!activeTrade || (activeTrade.status !== "ACTIVE" && activeTrade.status !== "SANDBOX_ACTIVE")) return;
    if (activeTrade.symbol !== activeSymbol) return;

    const price = currentTickPrice;

    if (activeTrade.direction === "LONG") {
      if (price >= activeTrade.target1) {
        resolveActiveTrade("WIN");
      } else if (price <= activeTrade.stopLoss) {
        resolveActiveTrade("LOSS");
      }
    } else if (activeTrade.direction === "SHORT") {
      if (price <= activeTrade.target1) {
        resolveActiveTrade("WIN");
      } else if (price >= activeTrade.stopLoss) {
        resolveActiveTrade("LOSS");
      }
    }
  }

  function resolveActiveTrade(outcome) {
    if (!checkContextSafety()) return;
    if (!activeTrade) return;

    const isSandbox = activeTrade.status === "SANDBOX_ACTIVE" || (activeTrade.status && activeTrade.status.startsWith("SANDBOX_"));
    const finalOutcome = isSandbox ? `SANDBOX_${outcome}` : outcome;

    activeTrade.status = finalOutcome; // WIN, LOSS, TIMEOUT, INVALIDATED
    
    const leverage = parseFloat(activeTrade.leverage) || parseFloat(settings.leverage) || 3;
    const currentPnlPercent = activeTrade.direction === "LONG" 
      ? ((currentTickPrice - activeTrade.entry) / activeTrade.entry) * 100 * leverage
      : ((activeTrade.entry - currentTickPrice) / activeTrade.entry) * 100 * leverage;

    const marginRequired = ((parseFloat(activeTrade.positionSize) || 0) * (parseFloat(activeTrade.entry) || 0)) / leverage;
    const dollarPnL = marginRequired * (currentPnlPercent / 100);

    chrome.storage.local.get({ walletBalance: 1000, sandboxWalletBalance: 1000 }, (balItems) => {
      let walletBalance = balItems.walletBalance !== undefined ? balItems.walletBalance : 1000;
      let sandboxWalletBalance = balItems.sandboxWalletBalance !== undefined ? balItems.sandboxWalletBalance : 1000;

      if (isSandbox) {
        sandboxWalletBalance += dollarPnL;
      } else {
        walletBalance += dollarPnL;
      }

      if (!isSandbox) {
        if (outcome === "WIN") {
          journalStats.wins++;
          consecutiveLosses = 0; // reset streak on win
        } else if (outcome === "LOSS") {
          journalStats.losses++;
          consecutiveLosses++;
        } else if (outcome === "TIMEOUT") {
          journalStats.timeouts++;
          consecutiveLosses++; // timeouts count toward circuit breaker
        }
        if (consecutiveLosses >= 2) {
          console.warn(`🚨 Circuit Breaker: ${consecutiveLosses} consecutive losses. Auto-pilot risk elevated.`);
        }
      } else {
        if (outcome === "WIN") {
          sandboxJournalStats.wins++;
        } else if (outcome === "LOSS") {
          sandboxJournalStats.losses++;
        } else if (outcome === "TIMEOUT") {
          sandboxJournalStats.timeouts++;
        }
      }

      console.log(`🏆 Trade resolved: ${finalOutcome}! Winrate now:`, isSandbox ? sandboxJournalStats : journalStats);

      const saveLocalStatsAndResolve = (shouldQueue = false) => {
        const updates = { journalStats, sandboxJournalStats, consecutiveLosses, walletBalance, sandboxWalletBalance };
        
        if (shouldQueue && activeTrade && activeTrade.dbId) {
          const syncItem = {
            dbId: activeTrade.dbId,
            payload: {
              status: finalOutcome,
              pnlPercentage: parseFloat(currentPnlPercent.toFixed(4)),
              elapsedCandles: activeTrade.elapsedCandles
            }
          };
          
          // Reset local cache
          if (activeSymbol) {
            delete activeTrades[activeSymbol];
            chrome.storage.local.remove('activeTrade_' + activeSymbol);
          }
          activeTrade = null;

          chrome.storage.local.get({ pendingSyncQueue: [] }, (res2) => {
            const queue = res2.pendingSyncQueue || [];
            queue.push(syncItem);
            updates.pendingSyncQueue = queue;
            chrome.storage.local.set(updates, () => {
              runCalculations();
              processPendingSyncQueue();
            });
          });
        } else {
          // Reset local cache
          if (activeSymbol) {
            delete activeTrades[activeSymbol];
            chrome.storage.local.remove('activeTrade_' + activeSymbol);
          }
          activeTrade = null;

          chrome.storage.local.set(updates, () => {
            runCalculations(); 
          });
        }
      };

      // Sync resolution details to PostgreSQL
      if (activeTrade.dbId) {
        const payload = {
          status: finalOutcome,
          pnlPercentage: parseFloat(currentPnlPercent.toFixed(4)),
          elapsedCandles: activeTrade.elapsedCandles
        };

        fetchApi(`http://localhost:4000/api/advisor/signals/${activeTrade.dbId}`, 'PUT', payload)
        .then(() => {
          console.log(`💾 PostgreSQL row ${activeTrade.dbId} updated with outcomes.`);
          
          // Dispatch SMS alert for trade resolution
          const sandboxPrefix = isSandbox ? "🧪 [SANDBOX] " : "";
          const pnlSign = currentPnlPercent >= 0 ? '+' : '';
          const alertMsg = `${sandboxPrefix}🚨 [ANTIGRAVITY BOT ALERT] Trade resolved on ${activeTrade.symbol}: ${finalOutcome} hit! PnL: ${pnlSign}${currentPnlPercent.toFixed(2)}% (${activeTrade.elapsedCandles} candles).`;
          triggerSMSAlert(alertMsg);

          saveLocalStatsAndResolve(false);
        })
        .catch(err => {
          console.error("⚠️ Failed to sync trade resolution to PostgreSQL, queueing for retry:", err.message);
          saveLocalStatsAndResolve(true);
        });
      } else {
        saveLocalStatsAndResolve(false);
      }

      if (settings.enableAudio) {
        if (outcome === 'WIN') playSyntheticSound('TP_HIT');
        else if (outcome === 'LOSS') playSyntheticSound('SL_HIT');
        else if (outcome === 'TIMEOUT') playSyntheticSound('EXIT_WARN');
      }
    });
  }

  function manuallyCloseActiveTrade() {
    if (!activeTrade) return;
    console.log("🚨 Manually closing active position via HUD...");
    resolveActiveTrade("INVALIDATED");
  }

  // --- STATS UTILS ---
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
    
    let rs = avgLoss === 0 ? (avgGain === 0 ? 1 : Infinity) : avgGain / avgLoss;
    rsi.push(100 - 100 / (1 + rs));

    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      let gain = 0;
      let loss = 0;
      if (diff > 0) gain = diff;
      else loss = -diff;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      
      let rsCurrent = avgLoss === 0 ? (avgGain === 0 ? 1 : Infinity) : avgGain / avgLoss;
      rsi.push(100 - 100 / (1 + rsCurrent));
    }
    while (rsi.length < closes.length) rsi.unshift(50);
    return rsi;
  }

  function calculateMACD(closes) {
    const ema12 = calculateEMA(closes, 12);
    const ema26 = calculateEMA(closes, 26);
    const macd = [];
    for (let i = 0; i < closes.length; i++) macd.push(ema12[i] - ema26[i]);
    const signal = calculateEMA(macd, 9);
    return { macd, signal };
  }

  function timeframeToMs(tf) {
    const unit = tf.slice(-1);
    const val = parseInt(tf);
    if (unit === "m") return val * 60 * 1000;
    if (unit === "h") return val * 60 * 60 * 1000;
    return 5 * 60 * 1000;
  }

  // --- WEB AUDIO SYNTHESIZER ---
  let _audioCtx = null;
  function getAudioContext() {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
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

    if (type === 'SETUP_ALERT') {
      // Double high-pitched chime (880Hz then 1100Hz), each 120ms with 60ms gap
      playTone(880, 0, 0.12, 'sine', 0.12);
      playTone(1100, 0.18, 0.12, 'sine', 0.12);
    } else if (type === 'TP_HIT') {
      // Fast ascending major arpeggio
      playTone(523, 0, 0.08, 'sine', 0.08);
      playTone(659, 0.08, 0.08, 'sine', 0.08);
      playTone(784, 0.16, 0.08, 'sine', 0.08);
      playTone(1047, 0.24, 0.12, 'sine', 0.12);
    } else if (type === 'SL_HIT') {
      // Descending dull tones
      playTone(330, 0, 0.15, 'triangle', 0.2);
      playTone(220, 0.15, 0.15, 'triangle', 0.2);
      playTone(165, 0.30, 0.2, 'triangle', 0.25);
    } else if (type === 'EXIT_WARN') {
      // Alternating pulsing alarm (600Hz ↔ 400Hz), 3 pulses
      playTone(600, 0, 0.10, 'square', 0.10);
      playTone(400, 0.18, 0.10, 'square', 0.10);
      playTone(600, 0.36, 0.10, 'square', 0.10);
    }
  }

  // --- AUDIO ALERTS ---
  function triggerAudioAlert() {
    if (!settings.enableAudio) return;
    const now = Date.now();
    if (now - lastSpokenTime < SPEECH_COOLDOWN_MS) return;

    if (currentSignal.direction === "LONG" || currentSignal.direction === "SHORT") {
      const side = currentSignal.direction === "LONG" ? "Long entry setup" : "Short entry setup";
      const pairText = activeSymbol.replace("USDT", " U.S. Dollar. Tether.");
      const text = `Alert: ${pairText} triggering ${side} via ${currentSignal.patternName}. Confidence is ${currentSignal.probability} percent. Stop loss set at ${currentSignal.stopLoss.toFixed(2)}`;

      playSyntheticSound('SETUP_ALERT');
      const speech = new SpeechSynthesisUtterance(text);
      speech.rate = 0.95;
      window.speechSynthesis.speak(speech);
      lastSpokenTime = now;
    }
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
            
            <!-- Dynamic interactive button to report User Action -->
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

    // Event listener for action taken and manual close (delegated)
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

  // --- DRAG ---
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

  function toggleAutoPilotMode() {
    settings.enableAutoPilot = !settings.enableAutoPilot;
    chrome.storage.local.set({ enableAutoPilot: settings.enableAutoPilot }, () => {
      console.log(`🤖 Auto-Pilot toggled: ${settings.enableAutoPilot}`);
      updateAutoPilotHUDDisplay();
      if (settings.enableAutoPilot && activeTrade && !activeTrade.actionTaken && activeTrade.dbId) {
        console.log("🤖 Auto-Pilot Activated: Automatically entering current active trade...");
        markUserActionTaken();
      }
      runCalculations();
    });
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

  // --- HUD UPDATERS ---
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

  // Dedicated PnL ticker — runs every 1s regardless of candle updates
  function startPnLTicker() {
    if (window._agPnLInterval) clearInterval(window._agPnLInterval);
    window._agPnLInterval = setInterval(() => {
      if (!checkContextSafety()) return;
      // Guard: skip if no active trade, wrong symbol, price not yet received
      if (!activeTrade || (activeTrade.status !== "ACTIVE" && activeTrade.status !== "SANDBOX_ACTIVE") || currentTickPrice <= 0) return;
      if (activeTrade.symbol && activeSymbol && activeTrade.symbol !== activeSymbol) {
        return;
      }

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
      `;
    }, 1000);
  }

  function updateHUDContent(indicators) {
    updateHUDLivePrice();

    const fillEl = document.getElementById("agy-probability-fill");
    const valEl = document.getElementById("agy-probability-val");
    const biasEl = document.getElementById("agy-bias-label");
    const patternEl = document.getElementById("agy-pattern-text");
    const modeBadgeEl = document.getElementById("agy-mode-indicator");

    if (modeBadgeEl) {
      modeBadgeEl.textContent = advisorMode;
      if (advisorMode === "MONITORING") {
        modeBadgeEl.className = "agy-mode-badge monitoring";
      } else {
        modeBadgeEl.className = "agy-mode-badge hunting";
      }
    }

    let calculatedOpacity = 1.0;

    if (activeTrade && activeTrade.status === "ACTIVE" && activeTrade.symbol === activeSymbol) {
      const timeOpacity = Math.max(0.0, 1 - (activeTrade.elapsedCandles / 12));
      const initialDistance = Math.abs(activeTrade.entry - activeTrade.stopLoss);
      const currentDistance = Math.abs(currentTickPrice - activeTrade.stopLoss);

      let priceOpacity = 1.0;
      if (activeTrade.direction === "LONG" && currentTickPrice < activeTrade.entry) {
        priceOpacity = currentDistance / initialDistance;
      } else if (activeTrade.direction === "SHORT" && currentTickPrice > activeTrade.entry) {
        priceOpacity = currentDistance / initialDistance;
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

    // Handle Flashing warning banner (Only flash at 100% confidence)
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

    // Update Indicators
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

    // Update Journal values
    const winsEl = document.getElementById("agy-val-wins");
    const lossesEl = document.getElementById("agy-val-losses");
    const timeoutsEl = document.getElementById("agy-val-timeouts");
    const ledgerTitleEl = document.getElementById("agy-ledger-title");
    if (winsEl && lossesEl && timeoutsEl) {
      const activeStats = getTickerJournalStats(activeSymbol, !!settings.sandboxMode);
      winsEl.textContent = activeStats.wins;
      lossesEl.textContent = activeStats.losses;
      timeoutsEl.textContent = activeStats.timeouts;
    }
    if (ledgerTitleEl) {
      ledgerTitleEl.textContent = settings.sandboxMode ? "Sandbox Ledger" : "Postgres Ledger";
    }

    // Update Live Tracker Box & Action Button
    const monitorBox = document.getElementById("agy-live-monitor-box");
    const monitorTime = document.getElementById("agy-track-time");
    const monitorLevels = document.getElementById("agy-track-levels");
    const actionBtnContainer = document.getElementById("agy-btn-action-container");

    if (monitorBox && monitorTime && monitorLevels && actionBtnContainer) {
      if (activeTrade && (activeTrade.status === "ACTIVE" || activeTrade.status === "SANDBOX_ACTIVE") && activeTrade.symbol === activeSymbol) {
        const limit = settings.enableTimeout !== false ? (settings.timeoutCandles !== undefined ? settings.timeoutCandles : 12) : 12;
        monitorTime.textContent = `Age: ${activeTrade.elapsedCandles}/${limit} candles`;
        
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

        // Render Action Button based on state
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
            Trend:${currentSignal.confidenceBreakdown.trend} SMC:${currentSignal.confidenceBreakdown.smc} Mom:${currentSignal.confidenceBreakdown.momentum}
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
            Trend:${currentSignal.confidenceBreakdown.trend} SMC:${currentSignal.confidenceBreakdown.smc} Mom:${currentSignal.confidenceBreakdown.momentum}
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

    // Update scanner state for dashboard in chrome storage (isolated key per symbol)
    if (activeSymbol) {
      const scanState = {
        symbol: activeSymbol,
        direction: currentSignal.direction,
        probability: currentSignal.probability,
        pattern: currentSignal.patternName,
        reason: currentSignal.reason,
        indicators: lastIndicatorStates,
        currentTickPrice: currentTickPrice,
        lastUpdated: Date.now()
      };
      chrome.storage.local.set({ ['tabState_' + activeSymbol]: scanState });
    }
  }

  setInterval(() => {
    if (!checkContextSafety()) return;
    chrome.storage.local.get('journalLastClearedTime', (res) => {
      syncJournalWithDatabase(res.journalLastClearedTime || 0, () => {
        runCalculations();
      });
    });
  }, 15000);

})();
