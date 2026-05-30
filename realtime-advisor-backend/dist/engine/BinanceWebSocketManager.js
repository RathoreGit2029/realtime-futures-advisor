"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BinanceWebSocketManager = void 0;
const ws_1 = require("ws");
const AntigravityEngine_js_1 = require("./AntigravityEngine.js");
const EventSourcing_js_1 = require("./EventSourcing.js");
const Indicators_js_1 = require("./Indicators.js");
const Types_js_1 = require("./Types.js");
const index_js_1 = require("../db/index.js");
const schema_js_1 = require("../db/schema.js");
const drizzle_orm_1 = require("drizzle-orm");
class BinanceWebSocketManager {
    static instance = null;
    // Shared state matching background.js
    state = {
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
            timeoutCandles: 12
        },
        consecutiveLosses: 0,
        journalStats: { wins: 0, losses: 0, timeouts: 0 },
        sandboxJournalStats: { wins: 0, losses: 0, timeouts: 0 },
        walletBalance: 1000,
        sandboxWalletBalance: 1000,
        activeTrades: {}
    };
    symbolData = {};
    activeSockets = {};
    activePollIntervals = {};
    clientCallbacks = {}; // symbol -> callbacks
    wsClients = new Set(); // WebSocket client connections (extension clients)
    engine;
    dbSync;
    isHydrated = false;
    constructor() {
        // Registered on initialization in server.ts
    }
    static getInstance() {
        if (!BinanceWebSocketManager.instance) {
            BinanceWebSocketManager.instance = new BinanceWebSocketManager();
        }
        return BinanceWebSocketManager.instance;
    }
    init(dbSync) {
        this.dbSync = dbSync;
        // Initialize deterministic engine
        this.engine = new AntigravityEngine_js_1.AntigravityEngine();
        const logger = EventSourcing_js_1.EventLog.getInstance();
        // Direct SQLite Event Logging Integration (Write-Ahead Log Synchronicity)
        logger.registerSyncEventHandler((event) => {
            const insertEventStmt = this.dbSync.prepare(`
        INSERT INTO events (
          sequence_number, exchange_timestamp, receive_timestamp, event_id, correlation_id,
          type, payload, market_context_snapshot, decision_metadata, event_version,
          previous_event_hash, deterministic_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
            insertEventStmt.run(event.sequenceNumber, event.exchangeTimestamp, event.receiveTimestamp, event.eventId, event.correlationId, event.type, JSON.stringify(event.payload), event.marketContextSnapshot ? JSON.stringify(event.marketContextSnapshot) : null, event.decisionMetadata ? JSON.stringify(event.decisionMetadata) : null, event.eventVersion, event.previousEventHash || null, event.deterministicHash);
        });
        logger.registerSyncSnapshotHandler((sequenceNumber, stateData) => {
            const insertSnapshotStmt = this.dbSync.prepare(`
        INSERT OR REPLACE INTO snapshots (sequence_number, state_data, timestamp)
        VALUES (?, ?, ?)
      `);
            insertSnapshotStmt.run(sequenceNumber, JSON.stringify(stateData), Date.now());
        });
        logger.registerHydrationHandler(async () => {
            // 1. Fetch latest snapshot
            const latestSnapshotStmt = this.dbSync.prepare("SELECT * FROM snapshots ORDER BY sequence_number DESC LIMIT 1");
            const snapshot = latestSnapshotStmt.get();
            let startSeq = 0;
            let snapshotState = null;
            if (snapshot) {
                startSeq = snapshot.sequence_number + 1;
                snapshotState = JSON.parse(snapshot.state_data);
            }
            // 2. Fetch subsequent events
            const getEventsStmt = this.dbSync.prepare("SELECT * FROM events WHERE sequence_number >= ? ORDER BY sequence_number ASC");
            const events = getEventsStmt.all(startSeq);
            const parsedEvents = events.map(e => ({
                sequenceNumber: e.sequence_number,
                exchangeTimestamp: e.exchange_timestamp,
                receiveTimestamp: e.receive_timestamp,
                eventId: e.event_id,
                correlationId: e.correlation_id,
                type: e.type,
                payload: JSON.parse(e.payload),
                marketContextSnapshot: e.market_context_snapshot ? JSON.parse(e.market_context_snapshot) : undefined,
                decisionMetadata: e.decision_metadata ? JSON.parse(e.decision_metadata) : undefined,
                eventVersion: e.event_version,
                previousEventHash: e.previous_event_hash || undefined,
                deterministicHash: e.deterministic_hash
            }));
            return { events: parsedEvents, snapshotState };
        });
        // Register state getters and restorers
        logger.registerStateGetter(() => {
            return {
                probabilityState: this.engine.probEngine.serializeState(),
                journalStats: this.state.journalStats,
                sandboxJournalStats: this.state.sandboxJournalStats,
                consecutiveLosses: this.state.consecutiveLosses,
                walletBalance: this.state.walletBalance,
                sandboxWalletBalance: this.state.sandboxWalletBalance
            };
        });
        logger.registerStateRestorer((snapshotState) => {
            if (!snapshotState)
                return;
            if (snapshotState.probabilityState) {
                this.engine.probEngine.deserializeState(snapshotState.probabilityState);
                console.log('⚡ Event Sourcing: Bayesian probability restored from SQLite snapshot.');
            }
            if (snapshotState.journalStats)
                this.state.journalStats = snapshotState.journalStats;
            if (snapshotState.sandboxJournalStats)
                this.state.sandboxJournalStats = snapshotState.sandboxJournalStats;
            if (snapshotState.consecutiveLosses !== undefined)
                this.state.consecutiveLosses = snapshotState.consecutiveLosses;
            if (snapshotState.walletBalance !== undefined)
                this.state.walletBalance = snapshotState.walletBalance;
            if (snapshotState.sandboxWalletBalance !== undefined)
                this.state.sandboxWalletBalance = snapshotState.sandboxWalletBalance;
            console.log('💾 Event Sourcing: State restored from SQLite snapshot.');
        });
        // Hydrate state
        logger.hydrate()
            .then(() => {
            this.isHydrated = true;
            console.log('⚡ Event Sourcing: Direct database hydration complete.');
        })
            .catch(e => {
            this.isHydrated = true;
            console.error('⚠️ Event Sourcing: Direct database hydration failed:', e);
        });
    }
    registerClient(ws) {
        this.wsClients.add(ws);
        // Send current state and settings
        ws.send(JSON.stringify({
            type: 'INIT_STATE',
            state: {
                settings: this.state.settings,
                consecutiveLosses: this.state.consecutiveLosses,
                journalStats: this.state.journalStats,
                sandboxJournalStats: this.state.sandboxJournalStats,
                walletBalance: this.state.walletBalance,
                sandboxWalletBalance: this.state.sandboxWalletBalance,
                activeTrades: this.state.activeTrades
            }
        }));
    }
    unregisterClient(ws) {
        this.wsClients.delete(ws);
        // Clean subscriptions for this client
        for (const symbol in this.clientCallbacks) {
            // Find and remove any callbacks or references
            this.unsubscribe(symbol, ws);
        }
    }
    updateSettings(settings) {
        const oldTf = this.state.settings.timeframe;
        this.state.settings = { ...this.state.settings, ...settings };
        console.log('⚙️ Settings updated on backend:', this.state.settings);
        // Broadcast settings update to extension clients
        this.broadcast({
            type: 'SETTINGS_UPDATED',
            settings: this.state.settings
        });
        // Restart streams if timeframe changed
        if (settings.timeframe && settings.timeframe !== oldTf) {
            console.log(`🔄 Timeframe changed from ${oldTf} to ${settings.timeframe}. Restarting active streams...`);
            const symbols = Object.keys(this.symbolData);
            for (const sym of symbols) {
                this.restartStream(sym);
            }
        }
    }
    subscribe(symbol, client, onUpdate) {
        const sym = symbol.toUpperCase();
        if (!this.clientCallbacks[sym]) {
            this.clientCallbacks[sym] = new Set();
        }
        this.clientCallbacks[sym].add(onUpdate);
        if (!this.symbolData[sym]) {
            this.initializeSymbolContext(sym);
        }
        else {
            // Send immediate update
            onUpdate(this.buildTabState(sym));
        }
    }
    unsubscribe(symbol, client) {
        const sym = symbol.toUpperCase();
        const callbacks = this.clientCallbacks[sym];
        if (callbacks) {
            callbacks.delete(client);
            if (callbacks.size === 0) {
                delete this.clientCallbacks[sym];
                // Stop stream if no active trades depend on it
                const hasActiveTrade = !!this.state.activeTrades[sym];
                if (!hasActiveTrade) {
                    this.stopStream(sym);
                }
            }
        }
    }
    stopStream(symbol) {
        console.log(`🔌 Stopping Binance stream for inactive symbol: ${symbol}`);
        if (this.activeSockets[symbol]) {
            try {
                this.activeSockets[symbol].close();
            }
            catch (e) { }
            delete this.activeSockets[symbol];
        }
        if (this.activePollIntervals[symbol]) {
            clearInterval(this.activePollIntervals[symbol]);
            delete this.activePollIntervals[symbol];
        }
        delete this.symbolData[symbol];
    }
    restartStream(symbol) {
        if (this.activeSockets[symbol]) {
            this.stopStream(symbol);
            this.initializeSymbolContext(symbol);
        }
    }
    broadcast(message) {
        const payload = JSON.stringify(message);
        for (const client of this.wsClients) {
            try {
                client.send(payload);
            }
            catch (e) {
                this.wsClients.delete(client);
            }
        }
    }
    async initializeSymbolContext(symbol) {
        console.log(`⚙️ Initializing data context for ${symbol}...`);
        this.symbolData[symbol] = {
            symbol,
            useSpotAPI: false,
            candles: [],
            lastWsEventTime: Date.now(),
            currentTickPrice: 0,
            lastIndicatorStates: null,
            advisorMode: 'HUNTING',
            lastRegime: null,
            dagDecision: null,
            currentSignal: null,
            fundingRate: null,
            lastOIValue: null,
            oiDelta: null,
            lsRatio: null,
            pdh: null,
            pdl: null,
            ema21_15m: null,
            ema21_1h: null,
            bestBid: 0,
            bestAsk: 0,
            spread: 0,
            orderbookDepth: 0,
            orderbookImbalance: 0.5
        };
        // Load history and launch socket streams
        await this.fetchExchangePrecision(symbol);
        await this.fetchHistoricalCandles(symbol);
    }
    async fetchExchangePrecision(symbol) {
        const url = `https://fapi.binance.com/fapi/v1/exchangeInfo`;
        try {
            const res = await fetch(url);
            const data = await res.json();
            if (data && Array.isArray(data.symbols)) {
                const info = data.symbols.find((s) => s.symbol === symbol);
                if (info && this.symbolData[symbol]) {
                    this.symbolData[symbol].symbolPrecisions = {
                        pricePrecision: info.pricePrecision || 2,
                        quantityPrecision: info.quantityPrecision || 3
                    };
                    console.log(`⚖️ Precision parsed for ${symbol}: Price ${info.pricePrecision}, Quantity ${info.quantityPrecision}`);
                }
            }
        }
        catch (e) {
            console.warn(`[Binance REST] Failed to fetch precision for ${symbol}:`, e.message);
        }
    }
    async fetchHistoricalCandles(symbol) {
        const limit = 150;
        const interval = this.state.settings.timeframe;
        const spotUrl = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const futuresUrl = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        try {
            let res = await fetch(futuresUrl);
            if (!res.ok) {
                this.symbolData[symbol].useSpotAPI = true;
                res = await fetch(spotUrl);
            }
            const data = await res.json();
            if (Array.isArray(data)) {
                this.symbolData[symbol].candles = data.map(c => ({
                    time: parseInt(c[0]),
                    open: parseFloat(c[1]),
                    high: parseFloat(c[2]),
                    low: parseFloat(c[3]),
                    close: parseFloat(c[4]),
                    volume: parseFloat(c[5])
                }));
                const len = this.symbolData[symbol].candles.length;
                if (len > 0) {
                    this.symbolData[symbol].currentTickPrice = this.symbolData[symbol].candles[len - 1].close;
                }
                console.log(`📊 Full history loaded: ${len} candles for ${symbol}`);
                // Start streaming
                this.connectBinanceWebSocket(symbol);
                this.fetchRestMarketData(symbol);
                if (this.activePollIntervals[symbol])
                    clearInterval(this.activePollIntervals[symbol]);
                this.activePollIntervals[symbol] = setInterval(() => this.fetchRestMarketData(symbol), 5 * 60 * 1000);
            }
        }
        catch (err) {
            console.error(`❌ Failed to sync full history for ${symbol}:`, err.message);
            // Retry in 5 seconds
            setTimeout(() => this.initializeSymbolContext(symbol), 5000);
        }
    }
    connectBinanceWebSocket(symbol) {
        const symLower = symbol.toLowerCase();
        const sData = this.symbolData[symbol];
        if (!sData)
            return;
        const wsHost = sData.useSpotAPI ? "stream.binance.com" : "fstream.binance.com";
        const wsPath = sData.useSpotAPI ? "/stream" : "/market/stream";
        const tfStream = this.state.settings.timeframe === '1m'
            ? `${symLower}@kline_1m`
            : `${symLower}@kline_${this.state.settings.timeframe}/${symLower}@kline_1m`;
        // Add L2 order book combined stream to get bids/asks depth
        const wsUrl = `wss://${wsHost}${wsPath}?streams=${tfStream}/${symLower}@depth5`;
        if (this.activeSockets[symbol]) {
            try {
                this.activeSockets[symbol].close();
            }
            catch (e) { }
        }
        console.log(`🔌 Opening combined Binance stream for ${symbol}: ${wsUrl}`);
        const ws = new ws_1.WebSocket(wsUrl);
        this.activeSockets[symbol] = ws;
        ws.on('message', (messageData) => {
            if (!this.isHydrated)
                return; // Sequence tracking safety block
            try {
                const data = JSON.parse(messageData);
                const stream = data.stream;
                const payload = data.data;
                const isTfStream = stream.includes(`kline_${this.state.settings.timeframe}`);
                const is1mStream = stream.includes('kline_1m');
                const is1mTimeframe = this.state.settings.timeframe === '1m';
                const isDepthStream = stream.includes('depth5');
                const sData = this.symbolData[symbol];
                if (!sData)
                    return;
                if (payload && payload.E) {
                    sData.lastWsEventTime = parseInt(payload.E);
                }
                // Handle L2 depth update stream
                if (isDepthStream) {
                    const bids = payload.b || [];
                    const asks = payload.a || [];
                    if (bids.length > 0 && asks.length > 0) {
                        sData.bestBid = parseFloat(bids[0][0]);
                        sData.bestAsk = parseFloat(asks[0][0]);
                        sData.spread = sData.bestAsk - sData.bestBid;
                        // Imbalance calculation: sum of top 5 levels bid quantities / total volume
                        let totalBidVol = 0;
                        let totalAskVol = 0;
                        for (let i = 0; i < Math.min(5, bids.length); i++)
                            totalBidVol += parseFloat(bids[i][1]);
                        for (let i = 0; i < Math.min(5, asks.length); i++)
                            totalAskVol += parseFloat(asks[i][1]);
                        const totalVol = totalBidVol + totalAskVol;
                        sData.orderbookDepth = totalVol;
                        sData.orderbookImbalance = totalVol > 0 ? totalBidVol / totalVol : 0.5;
                    }
                    return;
                }
                // Handle 1m tick updates
                if (is1mStream) {
                    sData.currentTickPrice = parseFloat(payload.k.c);
                    if (sData.candles.length > 0) {
                        const lastCandle = sData.candles[sData.candles.length - 1];
                        lastCandle.close = sData.currentTickPrice;
                        if (sData.currentTickPrice > lastCandle.high)
                            lastCandle.high = sData.currentTickPrice;
                        if (sData.currentTickPrice < lastCandle.low)
                            lastCandle.low = sData.currentTickPrice;
                    }
                    this.trackActiveTradeLive(symbol);
                    // Stream updates to dashboard client immediately on tick
                    this.notifyClients(symbol);
                }
                // Handle timeframe candle close/adds
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
                    }
                    else {
                        sData.candles.push(latestCandle);
                        if (sData.candles.length > 200)
                            sData.candles.shift();
                        candleAdded = true;
                        const activeTrade = this.state.activeTrades[symbol];
                        if (activeTrade && (activeTrade.status === "ACTIVE" || activeTrade.status === "SANDBOX_ACTIVE")) {
                            activeTrade.elapsedCandles = Math.round((candleTime - activeTrade.triggerTime) / this.timeframeToMs(activeTrade.timeframe || this.state.settings.timeframe));
                            const limit = this.state.settings.timeoutCandles !== undefined ? this.state.settings.timeoutCandles : 12;
                            if (activeTrade.elapsedCandles >= limit) {
                                this.resolveActiveTrade(symbol, "TIMEOUT");
                            }
                        }
                    }
                    this.runCalculations(symbol);
                }
                else if (!isTfStream && is1mStream && !is1mTimeframe) {
                    this.runCalculations(symbol);
                }
            }
            catch (err) {
                console.error("SW error parsing WS frame:", err);
            }
        });
        ws.on('error', () => {
            console.warn(`WebSocket error on ${symbol}, restarting...`);
        });
        ws.on('close', () => {
            if (this.activeSockets[symbol] === ws) {
                setTimeout(() => this.connectBinanceWebSocket(symbol), 4000);
            }
        });
    }
    async fetchRestMarketData(symbol) {
        const sym = symbol.toUpperCase();
        const sData = this.symbolData[symbol];
        if (!sData)
            return;
        try {
            // 1. Funding
            fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`)
                .then(r => r.json())
                .then((d) => { sData.fundingRate = parseFloat(d.lastFundingRate); })
                .catch(() => { sData.fundingRate = null; });
            // 2. Open Interest
            fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}`)
                .then(r => r.json())
                .then((d) => {
                const oi = parseFloat(d.openInterest);
                if (sData.lastOIValue !== null)
                    sData.oiDelta = oi - sData.lastOIValue;
                sData.lastOIValue = oi;
            })
                .catch(() => { });
            // 3. L/S Ratio
            fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=5m&limit=1`)
                .then(r => r.json())
                .then((d) => {
                if (Array.isArray(d) && d.length > 0)
                    sData.lsRatio = parseFloat(d[0].longShortRatio);
            })
                .catch(() => { sData.lsRatio = null; });
            // 4. Daily Candles
            const dailyUrl = sData.useSpotAPI
                ? `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1d&limit=2`
                : `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1d&limit=2`;
            fetch(dailyUrl)
                .then(r => r.json())
                .then((d) => {
                if (Array.isArray(d) && d.length >= 2) {
                    sData.pdh = parseFloat(d[0][2]);
                    sData.pdl = parseFloat(d[0][3]);
                }
            })
                .catch(() => { });
            // 5. 15m HTF
            const url15m = sData.useSpotAPI
                ? `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=15m&limit=30`
                : `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=15m&limit=30`;
            fetch(url15m)
                .then(r => r.json())
                .then((d) => {
                if (Array.isArray(d) && d.length >= 21) {
                    const closes = d.map((c) => parseFloat(c[4]));
                    const k = 2 / 22;
                    let ema = closes[0];
                    for (let i = 1; i < closes.length; i++)
                        ema = closes[i] * k + ema * (1 - k);
                    sData.ema21_15m = ema;
                }
            })
                .catch(() => { sData.ema21_15m = null; });
            // 6. 1h HTF
            const url1h = sData.useSpotAPI
                ? `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1h&limit=30`
                : `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1h&limit=30`;
            fetch(url1h)
                .then(r => r.json())
                .then((d) => {
                if (Array.isArray(d) && d.length >= 21) {
                    const closes = d.map((c) => parseFloat(c[4]));
                    const k = 2 / 22;
                    let ema = closes[0];
                    for (let i = 1; i < closes.length; i++)
                        ema = closes[i] * k + ema * (1 - k);
                    sData.ema21_1h = ema;
                }
            })
                .catch(() => { sData.ema21_1h = null; });
        }
        catch (e) {
            console.warn('[Binance REST] error in background poll:', e);
        }
    }
    runCalculations(symbol) {
        const sData = this.symbolData[symbol];
        if (!sData || sData.candles.length < 50)
            return;
        const closes = sData.candles.map(c => c.close);
        const ema9 = (0, Indicators_js_1.calculateEMA)(closes, 9);
        const ema21 = (0, Indicators_js_1.calculateEMA)(closes, 21);
        const rsi = (0, Indicators_js_1.calculateRSI)(closes, 14);
        const macdData = (0, Indicators_js_1.calculateMACD)(closes);
        const curClose = closes[closes.length - 1];
        const curEma9 = ema9[ema9.length - 1];
        const curEma21 = ema21[ema21.length - 1];
        const curRsi = rsi[rsi.length - 1];
        const orderBlocks = (0, Indicators_js_1.detectOrderBlocks)(sData.candles);
        const fvg = (0, Indicators_js_1.detectFVG)(sData.candles);
        const sweeps = (0, Indicators_js_1.detectLiquiditySweep)(sData.candles);
        sData.lastIndicatorStates = {
            rsi: Math.round(curRsi),
            ema9: curEma9,
            ema21: curEma21,
            bullishOB: orderBlocks.bullish.filter(ob => ob.unmitigated).length,
            bearishOB: orderBlocks.bearish.filter(ob => ob.unmitigated).length
        };
        // Swtich modes
        const activeTrade = this.state.activeTrades[symbol];
        const positionActive = !!(activeTrade && (activeTrade.status === "ACTIVE" || activeTrade.status === "SANDBOX_ACTIVE"));
        sData.advisorMode = positionActive ? 'MONITORING' : 'HUNTING';
        const atrValues = (0, Indicators_js_1.calculateATR)(sData.candles, 14);
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
        const htfDataReady = sData.ema21_15m !== null && sData.ema21_1h !== null;
        const htfAligned = htfDataReady
            ? ((curClose > sData.ema21_15m && curClose > sData.ema21_1h && curEma9 > curEma21) ||
                (curClose < sData.ema21_15m && curClose < sData.ema21_1h && curEma9 < curEma21))
            : false;
        const dateObj = new Date(sData.lastWsEventTime);
        const utcDec = dateObj.getUTCHours() + dateObj.getUTCMinutes() / 60;
        let sessionName = 'ASIA';
        let isOverlapSession = false;
        if (utcDec >= 8 && utcDec < 14)
            sessionName = 'LONDON';
        else if (utcDec >= 14 && utcDec < 21)
            sessionName = 'NEW_YORK';
        else if (utcDec >= 21 || utcDec < 2)
            sessionName = 'POST_NY_CHOP';
        if (utcDec >= 13 && utcDec <= 14)
            isOverlapSession = true;
        const emaDiff = Math.abs(curEma9 - curEma21);
        const emaPct = (emaDiff / curClose) * 100;
        const trendDir = emaPct < 0.05 ? 'SIDEWAYS' : (curEma9 > curEma21 ? 'UP' : 'DOWN');
        const trendStrength = Math.min(100, Math.round(emaPct * 400));
        const hasSweep = sweeps.bullishSweep || sweeps.bearishSweep;
        const marketState = sData.advisorMode === "MONITORING"
            ? Types_js_1.MarketState.NO_TRADE
            : (hasSweep ? Types_js_1.MarketState.EXECUTION_WINDOW : Types_js_1.MarketState.NO_TRADE);
        const draftCtx = {
            timestamp: sData.lastWsEventTime,
            symbol: symbol,
            marketState,
            positionActive,
            volatility: { atr: curAtr, isExpanding, isCompressing, historicalRank: atrRank },
            liquidityState: {
                hasSweep,
                sweepQuality: this.computeSweepQuality(sData.candles, sweeps),
                recentSweepDirection: sweeps.bullishSweep ? 'BULLISH' : sweeps.bearishSweep ? 'BEARISH' : null
            },
            trendState: { direction: trendDir, strength: trendStrength, htfAlignment: htfAligned },
            sessionState: {
                currentSession: sessionName,
                isOverlap: isOverlapSession,
                minutesIntoSession: dateObj.getUTCMinutes()
            },
            displacementQuality: hasSweep ? Math.min(100, this.computeSweepQuality(sData.candles, sweeps)) : 0,
            spread: sData.spread > 0 ? sData.spread : Math.max(curClose * 0.0001, curAtr * 0.02),
            orderbookDepth: sData.orderbookDepth,
            orderbookImbalance: sData.orderbookImbalance,
            confidence: 50,
            currentPrice: curClose
        };
        try {
            const evaluation = this.engine.evaluateMarket(draftCtx);
            sData.dagDecision = evaluation.decision;
            sData.lastRegime = evaluation.context.regime;
            if (evaluation.halted) {
                sData.dagDecision = {
                    tradeEligible: false,
                    failedConstraints: ['CircuitBreaker'],
                    passedConstraints: [],
                    failureReasons: [evaluation.haltReason || 'Circuit breaker'],
                    finalConfidence: 0,
                    individualEvaluations: [],
                    totalEvaluationTime: 0,
                    deterministicHash: ''
                };
            }
            if (sData.advisorMode === "MONITORING") {
                this.runExitCalculations(symbol, curClose, curEma9, curEma21, curRsi, orderBlocks, sweeps);
            }
            else {
                sData.currentSignal = null;
                this.runAnalyzingCalculations(symbol, curClose, curEma9, curEma21, curRsi, macdData, orderBlocks, fvg, sweeps, evaluation.context);
            }
            // Notify subscribed listeners
            this.notifyClients(symbol);
        }
        catch (err) {
            console.error(`Constraint evaluation error for ${symbol}:`, err);
        }
    }
    runExitCalculations(symbol, curClose, curEma9, curEma21, curRsi, orderBlocks, sweeps) {
        // Handled in trackActiveTradeLive or explicit exit signals
    }
    async runAnalyzingCalculations(symbol, curClose, curEma9, curEma21, curRsi, macdData, orderBlocks, fvg, sweeps, ctx) {
        const sData = this.symbolData[symbol];
        if (!sData)
            return;
        let activePattern = "Scanning Range";
        if (sweeps.bullishSweep || sweeps.bearishSweep)
            activePattern = "Liquidity Sweep Reversal";
        else if (orderBlocks.bullish.some((ob) => curClose >= ob.low && curClose <= ob.high && ob.unmitigated))
            activePattern = "Bullish OB Hold";
        else if (orderBlocks.bearish.some((ob) => curClose >= ob.low && curClose <= ob.high && ob.unmitigated))
            activePattern = "Bearish OB Hold";
        const threshold = this.state.settings.triggerThreshold !== undefined ? this.state.settings.triggerThreshold : 78;
        const useCustom = this.state.settings.targetMode === 'CUSTOM';
        const isEligible = sData.dagDecision.tradeEligible;
        const failedList = sData.dagDecision.failedConstraints || [];
        const failReasons = sData.dagDecision.failureReasons || [];
        const effectiveConfidence = Math.max(0, Math.min(sData.dagDecision.finalConfidence, 100));
        sData.currentSignal = {
            direction: "WAITING",
            probability: effectiveConfidence,
            patternName: activePattern,
            reason: isEligible
                ? "Constraint gate passed"
                : (failReasons[0] || (failedList.length > 0 ? `Blocked: ${failedList.join(', ')}` : "Awaiting setup...")),
            triggerCatalyst: `Conf: ${effectiveConfidence}% (bayesian). Passed: [${(sData.dagDecision.passedConstraints || []).join(', ')}]. Failed: [${failedList.join(', ')}]`
        };
        const meetsThreshold = effectiveConfidence >= threshold;
        if (isEligible && meetsThreshold && ctx && ctx.trendState) {
            const intendedDirection = ctx.trendState.direction === 'UP' ? 'LONG' : (ctx.trendState.direction === 'DOWN' ? 'SHORT' : 'WAITING');
            if (intendedDirection !== 'WAITING') {
                // Run Execution Safety check
                let entryPrice = curClose;
                if (this.engine.safetyLayer) {
                    const safety = this.engine.safetyLayer.validateExecution(ctx, intendedDirection, curClose);
                    if (!safety.safe) {
                        sData.currentSignal = {
                            direction: "WAITING",
                            probability: effectiveConfidence,
                            patternName: activePattern,
                            reason: safety.reason || "Execution safety limit exceeded",
                            triggerCatalyst: `Rejection: ${safety.reason}`
                        };
                        return;
                    }
                    entryPrice = safety.adjustedEntryPrice;
                }
                sData.currentSignal.direction = intendedDirection;
                sData.currentSignal.probability = effectiveConfidence;
                sData.currentSignal.entry = entryPrice;
                if (useCustom) {
                    const lev = this.state.settings.leverage || 3;
                    const isPos = this.state.settings.customTpSlMode === 'position';
                    const slP = isPos ? parseFloat(this.state.settings.customStopLoss) : parseFloat(this.state.settings.customStopLoss) / lev;
                    const tpP = isPos ? parseFloat(this.state.settings.customTakeProfit) : parseFloat(this.state.settings.customTakeProfit) / lev;
                    if (intendedDirection === 'LONG') {
                        sData.currentSignal.stopLoss = entryPrice * (1 - (slP / 100));
                        sData.currentSignal.target1 = entryPrice * (1 + (tpP / 100));
                    }
                    else {
                        sData.currentSignal.stopLoss = entryPrice * (1 + (slP / 100));
                        sData.currentSignal.target1 = entryPrice * (1 - (tpP / 100));
                    }
                    sData.currentSignal.target2 = sData.currentSignal.target1;
                }
                else {
                    if (intendedDirection === 'LONG') {
                        const closestOB = orderBlocks.bullish.filter((ob) => ob.unmitigated && ob.low < entryPrice).pop();
                        sData.currentSignal.stopLoss = closestOB ? closestOB.low : entryPrice - (curAtr(sData.candles) * 1.5);
                        sData.currentSignal.target1 = entryPrice + (entryPrice - sData.currentSignal.stopLoss) * 1.5;
                        sData.currentSignal.target2 = entryPrice + (entryPrice - sData.currentSignal.stopLoss) * 2.5;
                    }
                    else {
                        const closestOB = orderBlocks.bearish.filter((ob) => ob.unmitigated && ob.high > entryPrice).pop();
                        sData.currentSignal.stopLoss = closestOB ? closestOB.high : entryPrice + (curAtr(sData.candles) * 1.5);
                        sData.currentSignal.target1 = entryPrice - (sData.currentSignal.stopLoss - entryPrice) * 1.5;
                        sData.currentSignal.target2 = entryPrice - (sData.currentSignal.stopLoss - entryPrice) * 2.5;
                    }
                }
                // Auto-pilot trade execution
                if (this.state.settings.enableAutoPilot && !this.state.activeTrades[symbol]) {
                    await this.executeAutoPilotTrade(symbol, intendedDirection, sData.currentSignal, effectiveConfidence, activePattern, curClose, curRsi, curEma9, curEma21, orderBlocks, ctx);
                }
            }
        }
    }
    async executeAutoPilotTrade(symbol, direction, signal, probability, patternName, curClose, curRsi, curEma9, curEma21, orderBlocks, ctx) {
        const stopLoss = signal.stopLoss;
        const entry = signal.entry || curClose;
        // Position Calculations
        const riskAmount = this.state.settings.riskAmount || 20;
        const riskPerUnit = Math.abs(entry - stopLoss);
        const positionSize = riskPerUnit > 0 ? riskAmount / riskPerUnit : 0;
        if (positionSize <= 0)
            return;
        const leverage = this.state.settings.leverage || 3;
        const marginRequired = (positionSize * entry) / leverage;
        const newTrade = {
            symbol,
            direction,
            entry,
            stopLoss,
            target1: signal.target1,
            target2: signal.target2,
            leverage,
            positionSize,
            marginRequired,
            riskAmount,
            probability,
            patternName,
            rsiValue: Math.round(curRsi),
            ema9: String(curEma9),
            ema21: String(curEma21),
            bullishObCount: orderBlocks.bullish.filter((ob) => ob.unmitigated).length,
            bearishObCount: orderBlocks.bearish.filter((ob) => ob.unmitigated).length,
            status: this.state.settings.sandboxMode ? "SANDBOX_ACTIVE" : "ACTIVE",
            actualOutcome: this.state.settings.sandboxMode ? "SANDBOX" : null,
            triggerTime: ctx.timestamp,
            elapsedCandles: 0,
            timeframe: this.state.settings.timeframe,
            triggerCatalyst: signal.triggerCatalyst || ""
        };
        try {
            // 1. Insert into PostgreSQL ledger
            const [dbSignal] = await index_js_1.db.insert(schema_js_1.advisorSignals).values({
                symbol: newTrade.symbol,
                direction: newTrade.direction,
                entryPrice: String(newTrade.entry),
                stopLoss: String(newTrade.stopLoss),
                target1: String(newTrade.target1),
                target2: String(newTrade.target2),
                positionSize: String(newTrade.positionSize),
                marginRequired: String(newTrade.marginRequired),
                leverage: Number(newTrade.leverage),
                riskAmount: String(newTrade.riskAmount),
                probability: Number(newTrade.probability),
                patternName: newTrade.patternName,
                rsiValue: newTrade.rsiValue,
                ema9: newTrade.ema9,
                ema21: newTrade.ema21,
                bullishObCount: newTrade.bullishObCount,
                bearishObCount: newTrade.bearishObCount,
                status: newTrade.status,
                hypotheticalOutcome: newTrade.status,
                actualOutcome: newTrade.actualOutcome,
                triggerCatalyst: newTrade.triggerCatalyst,
                timeframe: newTrade.timeframe
            }).returning();
            newTrade.dbId = dbSignal.id;
            this.state.activeTrades[symbol] = newTrade;
            console.log(`🚀 Systematic execution triggered for ${symbol}: ${direction} at ${entry} [Postgres ID: ${dbSignal.id}]`);
            // Log event
            EventSourcing_js_1.EventLog.getInstance().append({
                type: 'TradeExecutionTriggered',
                correlationId: symbol,
                payload: {
                    direction,
                    entry,
                    stopLoss,
                    target1: signal.target1,
                    dbId: dbSignal.id
                },
                marketContextSnapshot: ctx
            });
            // Broadcast changes to active trades to extension
            this.broadcast({
                type: 'ACTIVE_TRADES_UPDATED',
                activeTrades: this.state.activeTrades
            });
            this.broadcast({
                type: 'TRADE_TRIGGERED',
                symbol,
                trade: newTrade
            });
        }
        catch (e) {
            console.error('❌ Failed to persist execution signal to PostgreSQL:', e.message);
        }
    }
    trackActiveTradeLive(symbol) {
        const activeTrade = this.state.activeTrades[symbol];
        const sData = this.symbolData[symbol];
        if (!activeTrade || !sData)
            return;
        const price = sData.currentTickPrice;
        if (activeTrade.direction === "LONG") {
            if (price >= activeTrade.target1)
                this.resolveActiveTrade(symbol, "WIN");
            else if (price <= activeTrade.stopLoss)
                this.resolveActiveTrade(symbol, "LOSS");
        }
        else {
            if (price <= activeTrade.target1)
                this.resolveActiveTrade(symbol, "WIN");
            else if (price >= activeTrade.stopLoss)
                this.resolveActiveTrade(symbol, "LOSS");
        }
    }
    async resolveActiveTrade(symbol, outcome) {
        const activeTrade = this.state.activeTrades[symbol];
        const sData = this.symbolData[symbol];
        if (!activeTrade || !sData)
            return;
        const isSandbox = activeTrade.status === "SANDBOX_ACTIVE";
        const finalOutcome = isSandbox ? `SANDBOX_${outcome}` : outcome;
        activeTrade.status = finalOutcome;
        const leverage = activeTrade.leverage || 3;
        const currentPnlPercent = activeTrade.direction === "LONG"
            ? ((sData.currentTickPrice - activeTrade.entry) / activeTrade.entry) * 100 * leverage
            : ((activeTrade.entry - sData.currentTickPrice) / activeTrade.entry) * 100 * leverage;
        const marginRequired = (activeTrade.positionSize * activeTrade.entry) / leverage;
        const dollarPnL = marginRequired * (currentPnlPercent / 100);
        if (isSandbox) {
            this.state.sandboxWalletBalance += dollarPnL;
            if (outcome === "WIN")
                this.state.sandboxJournalStats.wins++;
            else if (outcome === "LOSS")
                this.state.sandboxJournalStats.losses++;
            else if (outcome === "TIMEOUT")
                this.state.sandboxJournalStats.timeouts++;
        }
        else {
            this.state.walletBalance += dollarPnL;
            if (outcome === "WIN") {
                this.state.journalStats.wins++;
                this.state.consecutiveLosses = 0;
            }
            else if (outcome === "LOSS") {
                this.state.journalStats.losses++;
                this.state.consecutiveLosses++;
            }
            else if (outcome === "TIMEOUT") {
                this.state.journalStats.timeouts++;
                this.state.consecutiveLosses++;
            }
        }
        // Record Bayesian stats update
        if (sData.lastRegime) {
            this.engine.probEngine.recordTradeResult(sData.lastRegime, outcome === "WIN", currentPnlPercent);
            // SQLite snapshot auto triggers inside EventLog.append checkpointing
        }
        // Persist to Postgres database
        if (activeTrade.dbId) {
            try {
                await index_js_1.db.update(schema_js_1.advisorSignals)
                    .set({
                    status: finalOutcome,
                    hypotheticalOutcome: finalOutcome,
                    actualOutcome: isSandbox ? 'SANDBOX' : (outcome),
                    pnlPercentage: String(currentPnlPercent.toFixed(4)),
                    elapsedCandles: activeTrade.elapsedCandles,
                    resolvedAt: new Date()
                })
                    .where((0, drizzle_orm_1.eq)(schema_js_1.advisorSignals.id, activeTrade.dbId));
                console.log(` Settle trade completed for ${symbol}: ${finalOutcome} (${currentPnlPercent.toFixed(2)}%)`);
            }
            catch (err) {
                console.warn(`[Advisor API] Postgres PUT/update signal ${activeTrade.dbId} failed:`, err.message);
            }
        }
        // Log resolution event
        EventSourcing_js_1.EventLog.getInstance().append({
            type: 'TradeOutcomeRecorded',
            correlationId: symbol,
            payload: {
                outcome,
                pnlPercent: currentPnlPercent,
                dollarPnL,
                dbId: activeTrade.dbId
            }
        });
        // Remove trade
        delete this.state.activeTrades[symbol];
        // Broadcast stats and active trade clears
        this.broadcast({
            type: 'TRADE_RESOLVED',
            symbol,
            outcome,
            journalStats: this.state.journalStats,
            sandboxJournalStats: this.state.sandboxJournalStats,
            consecutiveLosses: this.state.consecutiveLosses,
            walletBalance: this.state.walletBalance,
            sandboxWalletBalance: this.state.sandboxWalletBalance,
            activeTrades: this.state.activeTrades
        });
        // Recalculate indicators to adjust state machine
        this.runCalculations(symbol);
    }
    notifyClients(symbol) {
        const callbacks = this.clientCallbacks[symbol];
        if (callbacks) {
            const tabState = this.buildTabState(symbol);
            const updateData = {
                type: 'TAB_STATE_UPDATE',
                symbol,
                tabState
            };
            for (const client of callbacks) {
                try {
                    client(updateData);
                }
                catch (e) {
                    callbacks.delete(client);
                }
            }
        }
    }
    buildTabState(symbol) {
        const sData = this.symbolData[symbol];
        if (!sData)
            return null;
        return {
            symbol: symbol,
            direction: sData.currentSignal ? sData.currentSignal.direction : "WAITING",
            probability: sData.currentSignal ? sData.currentSignal.probability : 50,
            pattern: sData.currentSignal ? sData.currentSignal.patternName : "Scanning",
            currentTickPrice: sData.currentTickPrice,
            indicators: sData.lastIndicatorStates ? {
                rsi: sData.lastIndicatorStates.rsi,
                ema9: sData.lastIndicatorStates.ema9,
                ema21: sData.lastIndicatorStates.ema21,
                bullishOB: sData.lastIndicatorStates.bullishOB,
                bearishOB: sData.lastIndicatorStates.bearishOB
            } : { rsi: 50, ema9: 0, ema21: 0, bullishOB: 0, bearishOB: 0 },
            lastUpdated: Date.now()
        };
    }
    computeSweepQuality(candles, sweeps) {
        if (!sweeps.bullishSweep && !sweeps.bearishSweep)
            return 0;
        let quality = 50;
        const cc = candles[candles.length - 1];
        const range = cc.high - cc.low;
        if (range > 0) {
            if (sweeps.bullishSweep && (cc.close - cc.low) / range > 0.65)
                quality += 25;
            if (sweeps.bearishSweep && (cc.high - cc.close) / range > 0.65)
                quality += 25;
        }
        const recentVols = candles.slice(-21, -1).map(c => c.volume);
        const avgVol = recentVols.reduce((s, v) => s + v, 0) / Math.max(1, recentVols.length);
        if (cc.volume > avgVol * 1.5)
            quality += 15;
        return Math.min(100, quality);
    }
    timeframeToMs(timeframe) {
        const num = parseInt(timeframe);
        const unit = timeframe.replace(String(num), '');
        switch (unit) {
            case 'm': return num * 60 * 1000;
            case 'h': return num * 60 * 60 * 1000;
            case 'd': return num * 24 * 60 * 60 * 1000;
            default: return 5 * 60 * 1000;
        }
    }
}
exports.BinanceWebSocketManager = BinanceWebSocketManager;
// Inline helper for runAnalyzingCalculations
function curAtr(candles) {
    const atrs = (0, Indicators_js_1.calculateATR)(candles, 14);
    return atrs[atrs.length - 1] || 1;
}
