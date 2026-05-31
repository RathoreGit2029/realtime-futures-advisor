import { WebSocket } from 'ws';
import { AntigravityEngine } from './AntigravityEngine.js';
import { EventLog } from './EventSourcing.js';
import { 
  calculateEMA, calculateRSI, calculateMACD, calculateATR, detectLiquiditySweep, detectOrderBlocks, detectFVG, Candle,
  getSwingFractals, updateLiquidityPools, detectLiquiditySweeps, detectMarketStructureShift, calculateDisplacement, updateFVGRegistry, calculateDealingRange,
  LiquidityPool, FVGRegistryItem, SweepEvent, MSSEvent, DealingRange
} from './Indicators.js';
import { CorrelationEngine } from './CorrelationEngine.js';
import { MarketRegime, MarketState, RawMarketInput, MarketContext } from './Types.js';
import { db } from '../db/index.js';
import { advisorSignals } from '../db/schema.js';
import { eq, desc, lt, and, or, sql } from 'drizzle-orm';
import { DatabaseSync } from 'node:sqlite';

export interface SystemSettings {
  timeframe: string;
  leverage: number;
  triggerThreshold: number;
  customStopLoss: string;
  customTakeProfit: string;
  targetMode: string; // 'STRUCTURAL' | 'CUSTOM'
  customTpSlMode: string; // 'position' | 'ROE'
  enableTechnical: boolean;
  enableSMC: boolean;
  enableCircuitBreaker: boolean;
  enableAudio: boolean;
  enableAutoPilot: boolean;
  sandboxMode: boolean;
  alertPhone: string;
  riskAmount?: number;
  timeoutCandles?: number;
  sweepLookback?: number;
  sweepWickRatio?: number;
  maxSpreadPct?: number;
  kellyFactor?: number;
  maxPortfolioHeat?: number;
  maxPortfolioMargin?: number;
}

export interface ActiveTrade {
  id?: string;
  dbId?: string; // Postgres UUID
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  leverage: number;
  positionSize: number;
  marginRequired: number;
  riskAmount: number;
  probability: number;
  patternName: string;
  rsiValue?: number | null;
  ema9?: string | null;
  ema21?: string | null;
  bullishObCount?: number | null;
  bearishObCount?: number | null;
  status: string;
  actualOutcome: string | null;
  triggerTime: number;
  elapsedCandles: number;
  timeframe: string;
  triggerCatalyst: string;
  
  // SMC/ICT fields
  displacementScore?: number | null;
  sweptPoolType?: string | null;
  sweptPoolPrice?: string | null;
  mssPrice?: string | null;
  fvgTop?: string | null;
  fvgBottom?: string | null;
  dealingRangeHigh?: string | null;
  dealingRangeLow?: string | null;
  equilibrium?: string | null;
}

export interface SymbolState {
  symbol: string;
  useSpotAPI: boolean;
  candles: Candle[];
  lastWsEventTime: number;
  currentTickPrice: number;
  lastIndicatorStates: {
    rsi: number;
    ema9: number;
    ema21: number;
    bullishOB: number;
    bearishOB: number;
  } | null;
  advisorMode: 'HUNTING' | 'MONITORING';
  lastRegime: MarketRegime | null;
  dagDecision: any | null;
  currentSignal: any | null;
  
  // REST Polled Data
  fundingRate: number | null;
  lastOIValue: number | null;
  oiDelta: number | null;
  lsRatio: number | null;
  pdh: number | null;
  pdl: number | null;
  ema21_15m: number | null;
  ema21_1h: number | null;

  // SMC/ICT arrays and events
  dailyCandles: Candle[];
  liquidityPools: LiquidityPool[];
  fvgRegistry: FVGRegistryItem[];
  lastSweep: SweepEvent | null;
  lastMSS: MSSEvent | null;
  lastDealingRange: DealingRange | null;
  lastDisplacementScore?: number | null;
 
  // L2 Order Book Stats
  bestBid: number;
  bestAsk: number;
  spread: number;
  orderbookDepth: number;
  orderbookImbalance: number; // 0 to 1
}

export class BinanceWebSocketManager {
  private static instance: BinanceWebSocketManager | null = null;
  
  // Shared state matching background.js
  public state = {
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
    } as SystemSettings,
    consecutiveLosses: 0,
    journalStats: { wins: 0, losses: 0, timeouts: 0 },
    sandboxJournalStats: { wins: 0, losses: 0, timeouts: 0 },
    walletBalance: 1000,
    sandboxWalletBalance: 1000,
    activeTrades: {} as Record<string, ActiveTrade>
  };

  private symbolData: Record<string, SymbolState> = {};
  private activeSockets: Record<string, WebSocket> = {};
  private activePollIntervals: Record<string, NodeJS.Timeout> = {};
  private clientCallbacks: Record<string, Set<(data: any) => void>> = {}; // symbol -> callbacks
  private wsClients: Set<any> = new Set(); // WebSocket client connections (extension clients)
  
  private engine!: AntigravityEngine;
  private dbSync!: DatabaseSync;
  private isHydrated = false;

  private constructor() {
    // Registered on initialization in server.ts
  }

  public static getInstance(): BinanceWebSocketManager {
    if (!BinanceWebSocketManager.instance) {
      BinanceWebSocketManager.instance = new BinanceWebSocketManager();
    }
    return BinanceWebSocketManager.instance;
  }

  public init(dbSync: DatabaseSync) {
    this.dbSync = dbSync;
    
    // Initialize deterministic engine
    this.engine = new AntigravityEngine();
    
    const logger = EventLog.getInstance();
    
    // Direct SQLite Event Logging Integration (Write-Ahead Log Synchronicity)
    logger.registerSyncEventHandler((event: any) => {
      const insertEventStmt = this.dbSync.prepare(`
        INSERT INTO events (
          sequence_number, exchange_timestamp, receive_timestamp, event_id, correlation_id,
          type, payload, market_context_snapshot, decision_metadata, event_version,
          previous_event_hash, deterministic_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertEventStmt.run(
        event.sequenceNumber,
        event.exchangeTimestamp,
        event.receiveTimestamp,
        event.eventId,
        event.correlationId,
        event.type,
        JSON.stringify(event.payload),
        event.marketContextSnapshot ? JSON.stringify(event.marketContextSnapshot) : null,
        event.decisionMetadata ? JSON.stringify(event.decisionMetadata) : null,
        event.eventVersion,
        event.previousEventHash || null,
        event.deterministicHash
      );
    });

    logger.registerSyncSnapshotHandler((sequenceNumber: number, stateData: any) => {
      const insertSnapshotStmt = this.dbSync.prepare(`
        INSERT OR REPLACE INTO snapshots (sequence_number, state_data, timestamp)
        VALUES (?, ?, ?)
      `);
      insertSnapshotStmt.run(
        sequenceNumber,
        JSON.stringify(stateData),
        Date.now()
      );
    });

    logger.registerHydrationHandler(async () => {
      // 1. Fetch latest snapshot
      const latestSnapshotStmt = this.dbSync.prepare("SELECT * FROM snapshots ORDER BY sequence_number DESC LIMIT 1");
      const snapshot = latestSnapshotStmt.get() as any;
      let startSeq = 0;
      let snapshotState = null;
      if (snapshot) {
        startSeq = snapshot.sequence_number + 1;
        snapshotState = JSON.parse(snapshot.state_data);
      }
      
      // 2. Fetch subsequent events
      const getEventsStmt = this.dbSync.prepare("SELECT * FROM events WHERE sequence_number >= ? ORDER BY sequence_number ASC");
      const events = getEventsStmt.all(startSeq) as any[];
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

      // Find absolute maximum sequence number in the SQLite store
      const maxEvents = this.dbSync.prepare("SELECT MAX(sequence_number) as m FROM events").get() as any;
      const maxSnapshots = this.dbSync.prepare("SELECT MAX(sequence_number) as m FROM snapshots").get() as any;
      const maxSeq = Math.max(
        maxEvents && maxEvents.m !== null ? maxEvents.m : -1,
        maxSnapshots && maxSnapshots.m !== null ? maxSnapshots.m : -1
      );

      return { events: parsedEvents, snapshotState, latestSequenceNumber: maxSeq };
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
      if (!snapshotState) return;
      if (snapshotState.probabilityState) {
        this.engine.probEngine.deserializeState(snapshotState.probabilityState);
        console.log('⚡ Event Sourcing: Bayesian probability restored from SQLite snapshot.');
      }
      if (snapshotState.journalStats) this.state.journalStats = snapshotState.journalStats;
      if (snapshotState.sandboxJournalStats) this.state.sandboxJournalStats = snapshotState.sandboxJournalStats;
      if (snapshotState.consecutiveLosses !== undefined) this.state.consecutiveLosses = snapshotState.consecutiveLosses;
      if (snapshotState.walletBalance !== undefined) this.state.walletBalance = snapshotState.walletBalance;
      if (snapshotState.sandboxWalletBalance !== undefined) this.state.sandboxWalletBalance = snapshotState.sandboxWalletBalance;
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

  public registerClient(ws: any) {
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

  public unregisterClient(ws: any) {
    this.wsClients.delete(ws);
    
    // Clean subscriptions for this client
    for (const symbol in this.clientCallbacks) {
      // Find and remove any callbacks or references
      this.unsubscribe(symbol, ws);
    }
  }

  public updateSettings(settings: Partial<SystemSettings>) {
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

  public subscribe(symbol: string, client: any, onUpdate: (data: any) => void) {
    const sym = symbol.toUpperCase();
    if (!this.clientCallbacks[sym]) {
      this.clientCallbacks[sym] = new Set();
    }
    this.clientCallbacks[sym].add(onUpdate);

    if (!this.symbolData[sym]) {
      this.initializeSymbolContext(sym);
    } else {
      // Send immediate update
      onUpdate(this.buildTabState(sym));
    }
  }

  public unsubscribe(symbol: string, client: any) {
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

  private stopStream(symbol: string) {
    console.log(`🔌 Stopping Binance stream for inactive symbol: ${symbol}`);
    if (this.activeSockets[symbol]) {
      try { this.activeSockets[symbol].close(); } catch(e) {}
      delete this.activeSockets[symbol];
    }
    if (this.activePollIntervals[symbol]) {
      clearInterval(this.activePollIntervals[symbol]);
      delete this.activePollIntervals[symbol];
    }
    delete this.symbolData[symbol];
  }

  private restartStream(symbol: string) {
    if (this.activeSockets[symbol]) {
      this.stopStream(symbol);
      this.initializeSymbolContext(symbol);
    }
  }

  private broadcast(message: any) {
    const payload = JSON.stringify(message);
    for (const client of this.wsClients) {
      try {
        client.send(payload);
      } catch (e) {
        this.wsClients.delete(client);
      }
    }
  }

  private async initializeSymbolContext(symbol: string) {
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
      dailyCandles: [],
      liquidityPools: [],
      fvgRegistry: [],
      lastSweep: null,
      lastMSS: null,
      lastDealingRange: null,
      lastDisplacementScore: null,
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

  private async fetchExchangePrecision(symbol: string) {
    const url = `https://fapi.binance.com/fapi/v1/exchangeInfo`;
    try {
      const res = await fetch(url);
      const data = await res.json() as any;
      if (data && Array.isArray(data.symbols)) {
        const info = data.symbols.find((s: any) => s.symbol === symbol);
        if (info && this.symbolData[symbol]) {
          (this.symbolData[symbol] as any).symbolPrecisions = {
            pricePrecision: info.pricePrecision || 2,
            quantityPrecision: info.quantityPrecision || 3
          };
          console.log(`⚖️ Precision parsed for ${symbol}: Price ${info.pricePrecision}, Quantity ${info.quantityPrecision}`);
        }
      }
    } catch (e: any) {
      console.warn(`[Binance REST] Failed to fetch precision for ${symbol}:`, e.message);
    }
  }

  private async fetchHistoricalCandles(symbol: string) {
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
      
      const data = await res.json() as any[];
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

        if (this.activePollIntervals[symbol]) clearInterval(this.activePollIntervals[symbol]);
        this.activePollIntervals[symbol] = setInterval(() => this.fetchRestMarketData(symbol), 5 * 60 * 1000);
      }
    } catch (err: any) {
      console.error(`❌ Failed to sync full history for ${symbol}:`, err.message);
      // Retry in 5 seconds
      setTimeout(() => this.initializeSymbolContext(symbol), 5000);
    }
  }

  private connectBinanceWebSocket(symbol: string) {
    const symLower = symbol.toLowerCase();
    const sData = this.symbolData[symbol];
    if (!sData) return;

    const wsHost = sData.useSpotAPI ? "stream.binance.com" : "fstream.binance.com";
    const wsPath = sData.useSpotAPI ? "/stream" : "/market/stream";
    const tfStream = this.state.settings.timeframe === '1m'
      ? `${symLower}@kline_1m`
      : `${symLower}@kline_${this.state.settings.timeframe}/${symLower}@kline_1m`;
    
    // Add L2 order book combined stream to get bids/asks depth
    const wsUrl = `wss://${wsHost}${wsPath}?streams=${tfStream}/${symLower}@depth5`;

    if (this.activeSockets[symbol]) {
      try { this.activeSockets[symbol].close(); } catch(e) {}
    }

    console.log(`🔌 Opening combined Binance stream for ${symbol}: ${wsUrl}`);
    const ws = new WebSocket(wsUrl);
    this.activeSockets[symbol] = ws;

    ws.on('message', (messageData: string) => {
      if (!this.isHydrated) return; // Sequence tracking safety block
      
      try {
        const data = JSON.parse(messageData);
        const stream = data.stream;
        const payload = data.data;
        const isTfStream = stream.includes(`kline_${this.state.settings.timeframe}`);
        const is1mStream = stream.includes('kline_1m');
        const is1mTimeframe = this.state.settings.timeframe === '1m';
        const isDepthStream = stream.includes('depth5');

        const sData = this.symbolData[symbol];
        if (!sData) return;

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
            for (let i = 0; i < Math.min(5, bids.length); i++) totalBidVol += parseFloat(bids[i][1]);
            for (let i = 0; i < Math.min(5, asks.length); i++) totalAskVol += parseFloat(asks[i][1]);
            
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
            if (sData.currentTickPrice > lastCandle.high) lastCandle.high = sData.currentTickPrice;
            if (sData.currentTickPrice < lastCandle.low) lastCandle.low = sData.currentTickPrice;
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
          } else {
            sData.candles.push(latestCandle);
            if (sData.candles.length > 200) sData.candles.shift();
            candleAdded = true;
            
            const activeTrade = this.state.activeTrades[symbol];
            if (activeTrade && (activeTrade.status === "ACTIVE" || activeTrade.status === "SANDBOX_ACTIVE")) {
              activeTrade.elapsedCandles = Math.round(
                (candleTime - activeTrade.triggerTime) / this.timeframeToMs(activeTrade.timeframe || this.state.settings.timeframe)
              );
              const limit = this.state.settings.timeoutCandles !== undefined ? this.state.settings.timeoutCandles : 12;
              if (activeTrade.elapsedCandles >= limit) {
                this.resolveActiveTrade(symbol, "TIMEOUT");
              }
            }

            // Recalculate correlation matrix on closed candle boundary
            const candlesMap: Record<string, Candle[]> = {};
            for (const sym in this.symbolData) {
              candlesMap[sym] = this.symbolData[sym].candles;
            }
            const matrix = CorrelationEngine.calculateCorrelationMatrix(candlesMap);
            CorrelationEngine.setMatrix(matrix);
          }

          this.runCalculations(symbol);
        } else if (!isTfStream && is1mStream && !is1mTimeframe) {
          this.runCalculations(symbol);
        }
      } catch (err) {
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

  private async fetchRestMarketData(symbol: string) {
    const sym = symbol.toUpperCase();
    const sData = this.symbolData[symbol];
    if (!sData) return;

    try {
      // 1. Funding
      fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`)
        .then(r => r.json())
        .then((d: any) => { sData.fundingRate = parseFloat(d.lastFundingRate); })
        .catch(() => { sData.fundingRate = null; });

      // 2. Open Interest
      fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}`)
        .then(r => r.json())
        .then((d: any) => {
          const oi = parseFloat(d.openInterest);
          if (sData.lastOIValue !== null) sData.oiDelta = oi - sData.lastOIValue;
          sData.lastOIValue = oi;
        })
        .catch(() => {});

      // 3. L/S Ratio
      fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=5m&limit=1`)
        .then(r => r.json())
        .then((d: any) => {
          if (Array.isArray(d) && d.length > 0) sData.lsRatio = parseFloat(d[0].longShortRatio);
        })
        .catch(() => { sData.lsRatio = null; });

      // 4. Daily Candles
      const dailyUrl = sData.useSpotAPI
        ? `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=1d&limit=10`
        : `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1d&limit=10`;
      fetch(dailyUrl)
        .then(r => r.json())
        .then((d: any) => {
          if (Array.isArray(d) && d.length >= 2) {
            sData.dailyCandles = d.map(c => ({
              time: parseInt(c[0]),
              open: parseFloat(c[1]),
              high: parseFloat(c[2]),
              low: parseFloat(c[3]),
              close: parseFloat(c[4]),
              volume: parseFloat(c[5])
            }));
            const prevDay = sData.dailyCandles[sData.dailyCandles.length - 2];
            if (prevDay) {
              sData.pdh = prevDay.high;
              sData.pdl = prevDay.low;
            }
          }
        })
        .catch(() => {});

      // 5. 15m HTF
      const url15m = sData.useSpotAPI
        ? `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=15m&limit=30`
        : `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=15m&limit=30`;
      fetch(url15m)
        .then(r => r.json())
        .then((d: any) => {
          if (Array.isArray(d) && d.length >= 21) {
            const closes = d.map((c: any) => parseFloat(c[4]));
            const k = 2 / 22;
            let ema = closes[0];
            for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
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
        .then((d: any) => {
          if (Array.isArray(d) && d.length >= 21) {
            const closes = d.map((c: any) => parseFloat(c[4]));
            const k = 2 / 22;
            let ema = closes[0];
            for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
            sData.ema21_1h = ema;
          }
        })
        .catch(() => { sData.ema21_1h = null; });

    } catch (e) {
      console.warn('[Binance REST] error in background poll:', e);
    }
  }

  private runCalculations(symbol: string) {
    const sData = this.symbolData[symbol];
    if (!sData || sData.candles.length < 50) return;

    const closes = sData.candles.map(c => c.close);
    const ema9 = calculateEMA(closes, 9);
    const ema21 = calculateEMA(closes, 21);
    const rsi = calculateRSI(closes, 14);
    const macdData = calculateMACD(closes);

    const curClose = closes[closes.length - 1];
    const curEma9 = ema9[ema9.length - 1];
    const curEma21 = ema21[ema21.length - 1];
    const curRsi = rsi[rsi.length - 1];

    const orderBlocks = detectOrderBlocks(sData.candles);
    const legacyFVG = detectFVG(sData.candles);
    const legacySweeps = detectLiquiditySweep(sData.candles, this.state.settings.sweepLookback ?? 30, this.state.settings.sweepWickRatio ?? 0.5);

    sData.lastIndicatorStates = {
      rsi: Math.round(curRsi),
      ema9: curEma9,
      ema21: curEma21,
      bullishOB: orderBlocks.bullish.filter(ob => ob.unmitigated).length,
      bearishOB: orderBlocks.bearish.filter(ob => ob.unmitigated).length
    };

    // Switch modes
    const activeTrade = this.state.activeTrades[symbol];
    const positionActive = !!(activeTrade && (activeTrade.status === "ACTIVE" || activeTrade.status === "SANDBOX_ACTIVE"));
    sData.advisorMode = positionActive ? 'MONITORING' : 'HUNTING';

    const atrValues = calculateATR(sData.candles, 14);
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
      ? ((curClose > sData.ema21_15m! && curClose > sData.ema21_1h! && curEma9 > curEma21) ||
         (curClose < sData.ema21_15m! && curClose < sData.ema21_1h! && curEma9 < curEma21))
      : false;

    const dateObj = new Date(sData.lastWsEventTime);
    const utcDec = dateObj.getUTCHours() + dateObj.getUTCMinutes() / 60;
    let sessionName: 'ASIA' | 'LONDON' | 'NEW_YORK' | 'POST_NY_CHOP' = 'ASIA';
    let isOverlapSession = false;
    if (utcDec >= 8 && utcDec < 14) sessionName = 'LONDON';
    else if (utcDec >= 14 && utcDec < 21) sessionName = 'NEW_YORK';
    else if (utcDec >= 21 || utcDec < 2) sessionName = 'POST_NY_CHOP';
    if (utcDec >= 13 && utcDec <= 14) isOverlapSession = true;

    const emaDiff = Math.abs(curEma9 - curEma21);
    const emaPct = (emaDiff / curClose) * 100;
    const trendDir: 'UP' | 'DOWN' | 'SIDEWAYS' = emaPct < 0.05 ? 'SIDEWAYS' : (curEma9 > curEma21 ? 'UP' : 'DOWN');
    const trendStrength = Math.min(100, Math.round(emaPct * 400));

    // --- Run SMC/ICT calculations ---
    let hasSweep = false;
    let sweepQuality = 0;
    let recentSweepDirection: 'BULLISH' | 'BEARISH' | null = null;
    let marketState = MarketState.NO_TRADE;
    let displacementScore = 0;

    // FVG registry & pools update
    sData.liquidityPools = updateLiquidityPools(sData.candles, sData.dailyCandles, sData.liquidityPools);
    sData.fvgRegistry = updateFVGRegistry(sData.candles, sData.fvgRegistry, sData.currentTickPrice);

    // Detect sweeps
    const sweep = detectLiquiditySweeps(sData.candles, sData.liquidityPools, sData.currentTickPrice);
    if (sweep) {
      sData.lastSweep = sweep;
      sData.lastMSS = null;
      sData.lastDealingRange = null;
      sData.lastDisplacementScore = null;
    }

    // Detect MSS and Displacement
    if (sData.lastSweep && !sData.lastMSS) {
      const mss = detectMarketStructureShift(sData.candles, sData.lastSweep);
      if (mss) {
        sData.lastMSS = mss;
        sData.lastDisplacementScore = calculateDisplacement(sData.candles, mss.candleIndex);
        sData.lastDealingRange = calculateDealingRange(sData.lastSweep.sweepPrice, sData.lastSweep.direction, sData.candles);
      }
    }

    let activeFVG: FVGRegistryItem | null = null;

    if (this.state.settings.enableSMC) {
      if (sData.lastSweep) {
        hasSweep = true;
        sweepQuality = this.computeSMCExecutionSweepQuality(sData.candles, sData.lastSweep);
        recentSweepDirection = sData.lastSweep.direction === 'LONG' ? 'BULLISH' : 'BEARISH';
      }

      if (sData.lastDisplacementScore !== null && sData.lastDisplacementScore !== undefined) {
        displacementScore = sData.lastDisplacementScore;
      }

      // Check for active touch of FVG inside Premium/Discount
      if (sData.lastSweep && sData.lastMSS && displacementScore >= 60 && sData.lastDealingRange) {
        const dir = sData.lastSweep.direction;
        const eq = sData.lastDealingRange.equilibrium;
        const sweepTime = sData.lastSweep.time;

        const matchingFVGs = sData.fvgRegistry.filter(f => 
          f.direction === (dir === 'LONG' ? 'BULLISH' : 'BEARISH') && 
          f.status !== 'MITIGATED' &&
          f.creationTime >= sweepTime
        );

        if (matchingFVGs.length > 0) {
          matchingFVGs.sort((a, b) => b.creationTime - a.creationTime);
          const fvg = matchingFVGs[0];

          if (dir === 'LONG') {
            const isTouch = sData.currentTickPrice <= fvg.top && sData.currentTickPrice >= fvg.bottom;
            const isDiscount = sData.currentTickPrice < eq;
            if (isTouch && isDiscount) {
              activeFVG = fvg;
            }
          } else {
            const isTouch = sData.currentTickPrice >= fvg.bottom && sData.currentTickPrice <= fvg.top;
            const isPremium = sData.currentTickPrice > eq;
            if (isTouch && isPremium) {
              activeFVG = fvg;
            }
          }
        }
      }

      // Determine FSM State
      marketState = sData.advisorMode === 'MONITORING'
        ? MarketState.NO_TRADE
        : (activeFVG ? MarketState.EXECUTION_WINDOW : MarketState.NO_TRADE);

    } else {
      // Legacy Technical Indicators
      hasSweep = legacySweeps.bullishSweep || legacySweeps.bearishSweep;
      sweepQuality = this.computeSweepQuality(sData.candles, legacySweeps);
      recentSweepDirection = legacySweeps.bullishSweep ? 'BULLISH' : legacySweeps.bearishSweep ? 'BEARISH' : null;
      marketState = sData.advisorMode === 'MONITORING'
        ? MarketState.NO_TRADE
        : (hasSweep ? MarketState.EXECUTION_WINDOW : MarketState.NO_TRADE);
    }

    // Pre-calculate prospective trade parameters if there's no active trade on this symbol
    const intendedDirection = this.state.settings.enableSMC
      ? (sData.lastSweep && sData.lastMSS && (sData.lastDisplacementScore ?? 0) >= 60 ? sData.lastSweep.direction : 'WAITING')
      : (trendDir === 'UP' ? 'LONG' : (trendDir === 'DOWN' ? 'SHORT' : 'WAITING'));
      
    let prospectiveTrade: RawMarketInput['prospectiveTrade'] = undefined;

    if (intendedDirection !== 'WAITING' && !activeTrade) {
      const useCustom = this.state.settings.targetMode === 'CUSTOM';
      let prospectiveStopLoss = 0;
      let prospectiveTarget1 = 0;
      if (useCustom) {
        const lev = this.state.settings.leverage || 3;
        const isPos = this.state.settings.customTpSlMode === 'position';
        const slP = isPos ? parseFloat(this.state.settings.customStopLoss) : parseFloat(this.state.settings.customStopLoss) / lev;
        const tpP = isPos ? parseFloat(this.state.settings.customTakeProfit) : parseFloat(this.state.settings.customTakeProfit) / lev;

        if (intendedDirection === 'LONG') {
          prospectiveStopLoss = curClose * (1 - (slP / 100));
          prospectiveTarget1 = curClose * (1 + (tpP / 100));
        } else {
          prospectiveStopLoss = curClose * (1 + (slP / 100));
          prospectiveTarget1 = curClose * (1 - (tpP / 100));
        }
      } else {
        if (this.state.settings.enableSMC && sData.lastSweep && sData.lastDealingRange) {
          prospectiveStopLoss = sData.lastSweep.sweepPrice;
          const oppTarget = this.findOpposingTarget(sData.liquidityPools, intendedDirection as 'LONG' | 'SHORT', curClose);
          prospectiveTarget1 = oppTarget ? oppTarget : (intendedDirection === 'LONG'
            ? curClose + (curClose - prospectiveStopLoss) * 2.0
            : curClose - (prospectiveStopLoss - curClose) * 2.0
          );
        } else {
          if (intendedDirection === 'LONG') {
            const closestOB = orderBlocks.bullish.filter((ob: any) => ob.unmitigated && ob.low < curClose).pop();
            prospectiveStopLoss = closestOB ? closestOB.low : curClose - (curAtr * 1.5);
            prospectiveTarget1 = curClose + (curClose - prospectiveStopLoss) * 1.5;
          } else {
            const closestOB = orderBlocks.bearish.filter((ob: any) => ob.unmitigated && ob.high > curClose).pop();
            prospectiveStopLoss = closestOB ? closestOB.high : curClose + (curAtr * 1.5);
            prospectiveTarget1 = curClose - (prospectiveStopLoss - curClose) * 1.5;
          }
        }
      }
      prospectiveTrade = {
        direction: intendedDirection as 'LONG' | 'SHORT',
        stopLoss: prospectiveStopLoss,
        target1: prospectiveTarget1,
        target2: this.state.settings.enableSMC ? (intendedDirection === 'LONG'
          ? curClose + (curClose - prospectiveStopLoss) * 3.0
          : curClose - (prospectiveStopLoss - curClose) * 3.0
        ) : prospectiveTarget1,
        leverage: this.state.settings.leverage || 3
      };
    }

    const isSandbox = !!this.state.settings.sandboxMode;
    const portfolioWalletBalance = isSandbox ? this.state.sandboxWalletBalance : this.state.walletBalance;
    const portfolioTrades = Object.values(this.state.activeTrades).filter(t => 
      isSandbox ? t.status === 'SANDBOX_ACTIVE' : t.status === 'ACTIVE'
    );

    const draftCtx: RawMarketInput = {
      timestamp: sData.lastWsEventTime,
      symbol: symbol,
      marketState,
      positionActive,
      volatility: { atr: curAtr, isExpanding, isCompressing, historicalRank: atrRank },
      liquidityState: {
        hasSweep,
        sweepQuality,
        recentSweepDirection
      },
      trendState: { direction: trendDir, strength: trendStrength, htfAlignment: htfAligned },
      sessionState: {
        currentSession: sessionName,
        isOverlap: isOverlapSession,
        minutesIntoSession: dateObj.getUTCMinutes()
      },
      displacementQuality: this.state.settings.enableSMC ? displacementScore : (hasSweep ? Math.min(100, sweepQuality) : 0),
      spread: sData.spread > 0 ? sData.spread : Math.max(curClose * 0.0001, curAtr * 0.02),
      orderbookDepth: sData.orderbookDepth,
      orderbookImbalance: sData.orderbookImbalance,
      confidence: 50,
      currentPrice: curClose,
      portfolioWalletBalance,
      portfolioTrades,
      prospectiveTrade,
      maxSpreadPct: this.state.settings.maxSpreadPct,
      sweepLookback: this.state.settings.sweepLookback,
      sweepWickRatio: this.state.settings.sweepWickRatio,
      kellyFactor: this.state.settings.kellyFactor,
      maxPortfolioHeat: this.state.settings.maxPortfolioHeat,
      maxPortfolioMargin: this.state.settings.maxPortfolioMargin,

      // SMC fields
      displacementScore: this.state.settings.enableSMC ? displacementScore : undefined,
      sweptPoolType: this.state.settings.enableSMC && sData.lastSweep ? sData.lastSweep.pool.type : undefined,
      sweptPoolPrice: this.state.settings.enableSMC && sData.lastSweep ? sData.lastSweep.pool.price : undefined,
      mssPrice: this.state.settings.enableSMC && sData.lastMSS ? sData.lastMSS.mssPrice : undefined,
      fvgTop: this.state.settings.enableSMC && activeFVG ? activeFVG.top : undefined,
      fvgBottom: this.state.settings.enableSMC && activeFVG ? activeFVG.bottom : undefined,
      dealingRangeHigh: this.state.settings.enableSMC && sData.lastDealingRange ? sData.lastDealingRange.high : undefined,
      dealingRangeLow: this.state.settings.enableSMC && sData.lastDealingRange ? sData.lastDealingRange.low : undefined,
      equilibrium: this.state.settings.enableSMC && sData.lastDealingRange ? sData.lastDealingRange.equilibrium : undefined,
      primaryTarget: this.state.settings.enableSMC && prospectiveTrade ? prospectiveTrade.target1 : undefined,
      secondaryTarget: this.state.settings.enableSMC && prospectiveTrade ? prospectiveTrade.target2 : undefined
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

      // Log PortfolioRiskEvaluated event
      const heatEval = evaluation.decision.individualEvaluations.find(
        (e: any) => e.constraintId === 'PortfolioHeatConstraint'
      );
      const portfolioHeat = heatEval?.metadata?.portfolioHeat ?? 0;

      let totalMargin = 0;
      for (const t of portfolioTrades) {
        totalMargin += t.marginRequired || 0;
      }
      if (prospectiveTrade && evaluation.decision.tradeEligible) {
        const p = evaluation.context.confidence / 100;
        const entry = curClose;
        const riskPerUnit = Math.abs(entry - prospectiveTrade.stopLoss);
        let R = 1.5;
        if (riskPerUnit > 0) {
          R = Math.abs(prospectiveTrade.target1 - entry) / riskPerUnit;
        }
        const rawKelly = R > 0 ? 0.25 * ((p * R - (1 - p)) / R) : 0.025;
        const clampedKelly = Math.max(0.01, Math.min(0.10, rawKelly));
        const riskAmount = portfolioWalletBalance * clampedKelly;
        const positionSize = riskPerUnit > 0 ? riskAmount / riskPerUnit : 0;
        const lev = prospectiveTrade.leverage || 3;
        totalMargin += (positionSize * entry) / lev;
      }

      EventLog.getInstance().append({
        type: 'PortfolioRiskEvaluated',
        correlationId: symbol,
        payload: {
          portfolioHeat,
          walletBalance: portfolioWalletBalance,
          marginRatio: portfolioWalletBalance > 0 ? totalMargin / portfolioWalletBalance : 0
        },
        marketContextSnapshot: evaluation.context
      });

      if (sData.advisorMode === "MONITORING") {
        this.runExitCalculations(symbol, curClose, curEma9, curEma21, curRsi, orderBlocks, legacySweeps);
      } else {
        sData.currentSignal = null;
        this.runAnalyzingCalculations(symbol, curClose, curEma9, curEma21, curRsi, macdData, orderBlocks, legacyFVG, legacySweeps, evaluation.context);
      }

      // Notify subscribed listeners
      this.notifyClients(symbol);
    } catch (err: any) {
      console.error(`Constraint evaluation error for ${symbol}:`, err);
    }
  }

  private runExitCalculations(symbol: string, curClose: number, curEma9: number, curEma21: number, curRsi: number, orderBlocks: any, sweeps: any) {
    // Handled in trackActiveTradeLive or explicit exit signals
  }

  private async runAnalyzingCalculations(
    symbol: string, curClose: number, curEma9: number, curEma21: number, curRsi: number,
    macdData: any, orderBlocks: any, fvg: any, sweeps: any, ctx: MarketContext
  ) {
    const sData = this.symbolData[symbol];
    if (!sData) return;

    let activePattern = "Scanning Range";
    if (this.state.settings.enableSMC) {
      if (ctx.marketState === MarketState.EXECUTION_WINDOW) {
        activePattern = "SMC FVG Retracement Entry";
      } else if (sData.lastSweep && sData.lastMSS) {
        activePattern = "SMC Sweep & MSS Confirmed";
      } else if (sData.lastSweep) {
        activePattern = "SMC Sweep Detected";
      }
    } else {
      if (sweeps.bullishSweep || sweeps.bearishSweep) activePattern = "Liquidity Sweep Reversal";
      else if (orderBlocks.bullish.some((ob: any) => curClose >= ob.low && curClose <= ob.high && ob.unmitigated)) activePattern = "Bullish OB Hold";
      else if (orderBlocks.bearish.some((ob: any) => curClose >= ob.low && curClose <= ob.high && ob.unmitigated)) activePattern = "Bearish OB Hold";
    }

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
      const intendedDirection = this.state.settings.enableSMC
        ? (sData.lastSweep && sData.lastMSS && (sData.lastDisplacementScore ?? 0) >= 60 ? sData.lastSweep.direction : 'WAITING')
        : (ctx.trendState.direction === 'UP' ? 'LONG' : (ctx.trendState.direction === 'DOWN' ? 'SHORT' : 'WAITING'));
        
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
          } else {
            sData.currentSignal.stopLoss = entryPrice * (1 + (slP / 100));
            sData.currentSignal.target1 = entryPrice * (1 - (tpP / 100));
          }
          sData.currentSignal.target2 = sData.currentSignal.target1;
        } else {
          if (this.state.settings.enableSMC && sData.lastSweep && sData.lastDealingRange) {
            sData.currentSignal.stopLoss = sData.lastSweep.sweepPrice;
            const oppTarget = this.findOpposingTarget(sData.liquidityPools, intendedDirection as 'LONG' | 'SHORT', entryPrice);
            sData.currentSignal.target1 = oppTarget ? oppTarget : (intendedDirection === 'LONG'
              ? entryPrice + (entryPrice - sData.currentSignal.stopLoss) * 2.0
              : entryPrice - (sData.currentSignal.stopLoss - entryPrice) * 2.0
            );
            sData.currentSignal.target2 = sData.currentSignal.target1;
          } else {
            if (intendedDirection === 'LONG') {
              const closestOB = orderBlocks.bullish.filter((ob: any) => ob.unmitigated && ob.low < entryPrice).pop();
              sData.currentSignal.stopLoss = closestOB ? closestOB.low : entryPrice - (curAtr(sData.candles) * 1.5);
              sData.currentSignal.target1 = entryPrice + (entryPrice - sData.currentSignal.stopLoss) * 1.5;
              sData.currentSignal.target2 = entryPrice + (entryPrice - sData.currentSignal.stopLoss) * 2.5;
            } else {
              const closestOB = orderBlocks.bearish.filter((ob: any) => ob.unmitigated && ob.high > entryPrice).pop();
              sData.currentSignal.stopLoss = closestOB ? closestOB.high : entryPrice + (curAtr(sData.candles) * 1.5);
              sData.currentSignal.target1 = entryPrice - (sData.currentSignal.stopLoss - entryPrice) * 1.5;
              sData.currentSignal.target2 = entryPrice - (sData.currentSignal.stopLoss - entryPrice) * 2.5;
            }
          }
        }

        // Auto-pilot trade execution
        if (this.state.settings.enableAutoPilot && !this.state.activeTrades[symbol]) {
          await this.executeAutoPilotTrade(symbol, intendedDirection, sData.currentSignal, effectiveConfidence, activePattern, curClose, curRsi, curEma9, curEma21, orderBlocks, ctx);
        }
      }
    }
  }

  private async executeAutoPilotTrade(
    symbol: string, direction: 'LONG' | 'SHORT', signal: any, probability: number,
    patternName: string, curClose: number, curRsi: number, curEma9: number, curEma21: number, orderBlocks: any, ctx: MarketContext
  ) {
    const stopLoss = signal.stopLoss;
    const entry = signal.entry || curClose;
    
    // Position Calculations with Quarter-Kelly sizing
    const walletBalance = this.state.settings.sandboxMode ? this.state.sandboxWalletBalance : this.state.walletBalance;
    const p = probability / 100;
    const riskPerUnit = Math.abs(entry - stopLoss);
    
    let R = 1.5;
    if (riskPerUnit > 0) {
      R = Math.abs(signal.target1 - entry) / riskPerUnit;
    }
    
    // Fractional Kelly Sizing formula: f* = 0.25 * (p * R - (1 - p)) / R
    const rawKelly = R > 0 ? 0.25 * ((p * R - (1 - p)) / R) : 0.025;
    const clampedKelly = Math.max(0.01, Math.min(0.10, rawKelly)); // Clamped to 1% - 10%
    
    const riskAmount = walletBalance * clampedKelly;
    const positionSize = riskPerUnit > 0 ? riskAmount / riskPerUnit : 0;
    if (positionSize <= 0) return;

    const leverage = this.state.settings.leverage || 3;
    const marginRequired = (positionSize * entry) / leverage;

    const newTrade: ActiveTrade = {
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
      status: this.state.settings.sandboxMode ? "SANDBOX_ACTIVE" : "ACTIVE",
      actualOutcome: this.state.settings.sandboxMode ? "SANDBOX" : null,
      triggerTime: ctx.timestamp,
      elapsedCandles: 0,
      timeframe: this.state.settings.timeframe,
      triggerCatalyst: signal.triggerCatalyst || "",
      displacementScore: ctx.displacementScore ?? null,
      sweptPoolType: ctx.sweptPoolType ?? null,
      sweptPoolPrice: ctx.sweptPoolPrice != null ? String(ctx.sweptPoolPrice) : null,
      mssPrice: ctx.mssPrice != null ? String(ctx.mssPrice) : null,
      fvgTop: ctx.fvgTop != null ? String(ctx.fvgTop) : null,
      fvgBottom: ctx.fvgBottom != null ? String(ctx.fvgBottom) : null,
      dealingRangeHigh: ctx.dealingRangeHigh != null ? String(ctx.dealingRangeHigh) : null,
      dealingRangeLow: ctx.dealingRangeLow != null ? String(ctx.dealingRangeLow) : null,
      equilibrium: ctx.equilibrium != null ? String(ctx.equilibrium) : null
    };

    try {
      // 1. Insert into PostgreSQL ledger
      const [dbSignal] = await db.insert(advisorSignals).values({
        symbol: newTrade.symbol,
        direction: newTrade.direction,
        entryPrice: String(newTrade.entry),
        stopLoss: String(newTrade.stopLoss),
        primaryTarget: String(newTrade.target1),
        secondaryTarget: newTrade.target2 != null ? String(newTrade.target2) : null,
        positionSize: String(newTrade.positionSize),
        marginRequired: String(newTrade.marginRequired),
        leverage: Number(newTrade.leverage),
        riskAmount: String(newTrade.riskAmount),
        probability: Number(newTrade.probability),
        patternName: newTrade.patternName,
        displacementScore: newTrade.displacementScore ?? null,
        sweptPoolType: newTrade.sweptPoolType ?? null,
        sweptPoolPrice: newTrade.sweptPoolPrice ?? null,
        mssPrice: newTrade.mssPrice ?? null,
        fvgTop: newTrade.fvgTop ?? null,
        fvgBottom: newTrade.fvgBottom ?? null,
        dealingRangeHigh: newTrade.dealingRangeHigh ?? null,
        dealingRangeLow: newTrade.dealingRangeLow ?? null,
        equilibrium: newTrade.equilibrium ?? null,
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
      EventLog.getInstance().append({
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
    } catch (e: any) {
      console.error('❌ Failed to persist execution signal to PostgreSQL:', e.message);
    }
  }

  private trackActiveTradeLive(symbol: string) {
    const activeTrade = this.state.activeTrades[symbol];
    const sData = this.symbolData[symbol];
    if (!activeTrade || !sData) return;

    const price = sData.currentTickPrice;
    if (activeTrade.direction === "LONG") {
      if (price >= activeTrade.target1) {
        this.resolveActiveTrade(symbol, "WIN");
        return;
      } else if (price <= activeTrade.stopLoss) {
        this.resolveActiveTrade(symbol, "LOSS");
        return;
      }
    } else {
      if (price <= activeTrade.target1) {
        this.resolveActiveTrade(symbol, "WIN");
        return;
      } else if (price >= activeTrade.stopLoss) {
        this.resolveActiveTrade(symbol, "LOSS");
        return;
      }
    }

    // SMC early exit rules
    if (this.state.settings.enableSMC) {
      if (sData.lastSweep && sData.lastSweep.time > activeTrade.triggerTime) {
        if (sData.lastSweep.direction !== activeTrade.direction) {
          console.log(`⚠️ SMC EARLY EXIT: Opposing sweep detected for ${symbol} at ${price}. Closing trade...`);
          this.resolveActiveTrade(symbol, "TIMEOUT");
          return;
        }
      }
      if (sData.lastMSS && sData.candles[sData.lastMSS.candleIndex].time > activeTrade.triggerTime) {
        if (sData.lastMSS.direction !== activeTrade.direction) {
          console.log(`⚠️ SMC EARLY EXIT: Opposing MSS detected for ${symbol} at ${price}. Closing trade...`);
          this.resolveActiveTrade(symbol, "TIMEOUT");
          return;
        }
      }
    }
  }

  private async resolveActiveTrade(symbol: string, outcome: 'WIN' | 'LOSS' | 'TIMEOUT') {
    const activeTrade = this.state.activeTrades[symbol];
    const sData = this.symbolData[symbol];
    if (!activeTrade || !sData) return;

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
      if (outcome === "WIN") this.state.sandboxJournalStats.wins++;
      else if (outcome === "LOSS") this.state.sandboxJournalStats.losses++;
      else if (outcome === "TIMEOUT") this.state.sandboxJournalStats.timeouts++;
    } else {
      this.state.walletBalance += dollarPnL;
      if (outcome === "WIN") { this.state.journalStats.wins++; this.state.consecutiveLosses = 0; }
      else if (outcome === "LOSS") { this.state.journalStats.losses++; this.state.consecutiveLosses++; }
      else if (outcome === "TIMEOUT") { this.state.journalStats.timeouts++; this.state.consecutiveLosses++; }
    }

    // Record Bayesian stats update
    if (sData.lastRegime) {
      this.engine.probEngine.recordTradeResult(sData.lastRegime, outcome === "WIN", currentPnlPercent);
      // SQLite snapshot auto triggers inside EventLog.append checkpointing
    }

    // Persist to Postgres database
    if (activeTrade.dbId) {
      try {
        await db.update(advisorSignals)
          .set({
            status: finalOutcome,
            hypotheticalOutcome: finalOutcome,
            actualOutcome: isSandbox ? 'SANDBOX' : (outcome),
            pnlPercentage: String(currentPnlPercent.toFixed(4)),
            elapsedCandles: activeTrade.elapsedCandles,
            resolvedAt: new Date()
          })
          .where(eq(advisorSignals.id, activeTrade.dbId));
        console.log(` Settle trade completed for ${symbol}: ${finalOutcome} (${currentPnlPercent.toFixed(2)}%)`);
      } catch (err: any) {
        console.warn(`[Advisor API] Postgres PUT/update signal ${activeTrade.dbId} failed:`, err.message);
      }
    }

    // Log resolution event
    EventLog.getInstance().append({
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

  private notifyClients(symbol: string) {
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
        } catch (e) {
          callbacks.delete(client);
        }
      }
    }
  }

  private buildTabState(symbol: string) {
    const sData = this.symbolData[symbol];
    if (!sData) return null;
    
    const activeFVGs = sData.fvgRegistry.filter(f => f.mitigationPercent < 100);
    const activeFVG = activeFVGs.length > 0 ? activeFVGs[activeFVGs.length - 1] : null;

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
      displacementScore: sData.lastDisplacementScore || null,
      sweptPoolType: sData.lastSweep ? sData.lastSweep.pool.type : null,
      sweptPoolPrice: sData.lastSweep ? sData.lastSweep.sweepPrice : null,
      mssPrice: sData.lastMSS ? sData.lastMSS.mssPrice : null,
      fvgTop: activeFVG ? activeFVG.top : null,
      fvgBottom: activeFVG ? activeFVG.bottom : null,
      dealingRangeHigh: sData.lastDealingRange ? sData.lastDealingRange.high : null,
      dealingRangeLow: sData.lastDealingRange ? sData.lastDealingRange.low : null,
      equilibrium: sData.lastDealingRange ? sData.lastDealingRange.equilibrium : null,
      entry: sData.currentSignal ? (sData.currentSignal.entry || null) : null,
      stopLoss: sData.currentSignal ? (sData.currentSignal.stopLoss || null) : null,
      target1: sData.currentSignal ? (sData.currentSignal.target1 || null) : null,
      target2: sData.currentSignal ? (sData.currentSignal.target2 || null) : null,
      primaryTarget: sData.currentSignal ? (sData.currentSignal.target1 || sData.currentSignal.primaryTarget || null) : null,
      secondaryTarget: sData.currentSignal ? (sData.currentSignal.target2 || sData.currentSignal.secondaryTarget || null) : null,
      reason: sData.currentSignal ? (sData.currentSignal.reason || null) : null,
      triggerCatalyst: sData.currentSignal ? (sData.currentSignal.triggerCatalyst || null) : null,
      lastUpdated: Date.now()
    };
  }

  private computeSweepQuality(candles: Candle[], sweeps: any) {
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

  private computeSMCExecutionSweepQuality(candles: Candle[], sweep: SweepEvent | null) {
    if (!sweep) return 0;
    let quality = 50;
    const cc = candles[candles.length - 1];
    const range = cc.high - cc.low;
    if (range > 0) {
      if (sweep.direction === 'LONG' && (cc.close - cc.low) / range > 0.65) quality += 25;
      if (sweep.direction === 'SHORT' && (cc.high - cc.close) / range > 0.65) quality += 25;
    }
    const recentVols = candles.slice(-21, -1).map(c => c.volume);
    const avgVol = recentVols.reduce((s, v) => s + v, 0) / Math.max(1, recentVols.length);
    if (cc.volume > avgVol * 1.5) quality += 15;
    quality += (sweep.pool.strength || 1) * 2;
    return Math.min(100, quality);
  }

  private findOpposingTarget(pools: LiquidityPool[], direction: 'LONG' | 'SHORT', currentPrice: number): number | null {
    const activeOpposing = pools.filter(p => 
      p.status === 'ACTIVE' && 
      p.levelType === (direction === 'LONG' ? 'BSL' : 'SSL')
    );
    if (activeOpposing.length === 0) return null;
    
    if (direction === 'LONG') {
      const above = activeOpposing.filter(p => p.price > currentPrice);
      if (above.length === 0) return null;
      above.sort((a, b) => a.price - b.price);
      return above[0].price;
    } else {
      const below = activeOpposing.filter(p => p.price < currentPrice);
      if (below.length === 0) return null;
      below.sort((a, b) => b.price - a.price);
      return below[0].price;
    }
  }

  private timeframeToMs(timeframe: string): number {
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

// Inline helper for runAnalyzingCalculations
function curAtr(candles: Candle[]): number {
  const atrs = calculateATR(candles, 14);
  return atrs[atrs.length - 1] || 1;
}
