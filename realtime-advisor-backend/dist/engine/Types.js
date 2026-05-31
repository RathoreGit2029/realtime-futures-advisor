"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarketRegime = exports.MarketState = void 0;
exports.createMarketContext = createMarketContext;
exports.createSystemEvent = createSystemEvent;
var MarketState;
(function (MarketState) {
    MarketState["ACCUMULATION"] = "ACCUMULATION";
    MarketState["LIQUIDITY_SWEEP"] = "LIQUIDITY_SWEEP";
    MarketState["DISPLACEMENT"] = "DISPLACEMENT";
    MarketState["RETRACEMENT"] = "RETRACEMENT";
    MarketState["EXECUTION_WINDOW"] = "EXECUTION_WINDOW";
    MarketState["ACTIVE_POSITION"] = "ACTIVE_POSITION";
    MarketState["EXIT"] = "EXIT";
    MarketState["NO_TRADE"] = "NO_TRADE";
    MarketState["EXPANSION"] = "EXPANSION";
    MarketState["REVERSAL"] = "REVERSAL";
    MarketState["CHOPPY"] = "CHOPPY";
})(MarketState || (exports.MarketState = MarketState = {}));
var MarketRegime;
(function (MarketRegime) {
    MarketRegime["TRENDING"] = "TRENDING";
    MarketRegime["MEAN_REVERTING"] = "MEAN_REVERTING";
    MarketRegime["CHOPPY"] = "CHOPPY";
    MarketRegime["EXPANSION"] = "EXPANSION";
    MarketRegime["COMPRESSION"] = "COMPRESSION";
    MarketRegime["HIGH_VOLATILITY"] = "HIGH_VOLATILITY";
    MarketRegime["LOW_LIQUIDITY"] = "LOW_LIQUIDITY";
    MarketRegime["NEWS_EVENT"] = "NEWS_EVENT";
    MarketRegime["LIQUIDATION_CASCADE"] = "LIQUIDATION_CASCADE";
})(MarketRegime || (exports.MarketRegime = MarketRegime = {}));
/**
 * Browser-safe deterministic hash (djb2 variant).
 * Works in Chrome service workers, Node.js, and test environments.
 * Not cryptographic — used only for equality checking and replay verification.
 */
function deterministicHashOf(input) {
    let h = 5381;
    for (let i = 0; i < input.length; i++) {
        h = ((h << 5) + h) ^ input.charCodeAt(i);
        h = h >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}
/**
 * Assemble a full immutable MarketContext from a complete set of fields.
 * Called internally by the engine after regime and confidence are resolved.
 */
function createMarketContext(base) {
    const sequenceNumber = base.sequenceNumber ?? 0;
    const hashInput = JSON.stringify({
        timestamp: base.timestamp,
        sequenceNumber,
        symbol: base.symbol,
        regime: base.regime,
        marketState: base.marketState,
        volatility: base.volatility,
        liquidityState: base.liquidityState,
        trendState: base.trendState,
        sessionState: base.sessionState,
        displacementQuality: base.displacementQuality,
        spread: base.spread,
        orderbookDepth: base.orderbookDepth,
        orderbookImbalance: base.orderbookImbalance,
        confidence: base.confidence,
        currentPrice: base.currentPrice,
        positionActive: base.positionActive,
        portfolioTrades: base.portfolioTrades,
        portfolioWalletBalance: base.portfolioWalletBalance,
        prospectiveTrade: base.prospectiveTrade,
        maxSpreadPct: base.maxSpreadPct,
        sweepLookback: base.sweepLookback,
        sweepWickRatio: base.sweepWickRatio,
        kellyFactor: base.kellyFactor,
        maxPortfolioHeat: base.maxPortfolioHeat,
        maxPortfolioMargin: base.maxPortfolioMargin,
        displacementScore: base.displacementScore,
        sweptPoolType: base.sweptPoolType,
        sweptPoolPrice: base.sweptPoolPrice,
        mssPrice: base.mssPrice,
        fvgTop: base.fvgTop,
        fvgBottom: base.fvgBottom,
        dealingRangeHigh: base.dealingRangeHigh,
        dealingRangeLow: base.dealingRangeLow,
        equilibrium: base.equilibrium,
        primaryTarget: base.primaryTarget,
        secondaryTarget: base.secondaryTarget
    });
    return {
        ...base,
        sequenceNumber,
        deterministicHash: deterministicHashOf(hashInput)
    };
}
/**
 * Create a deterministic SystemEvent.
 * Browser-safe — no Node.js APIs used.
 */
function createSystemEvent(base) {
    const sequenceNumber = base.sequenceNumber ?? 0;
    const hashInput = JSON.stringify({
        exchangeTimestamp: base.exchangeTimestamp,
        receiveTimestamp: base.receiveTimestamp,
        sequenceNumber,
        eventId: base.eventId,
        correlationId: base.correlationId,
        type: base.type,
        payload: base.payload,
        decisionMetadata: base.decisionMetadata,
        eventVersion: base.eventVersion,
        previousEventHash: base.previousEventHash
    });
    return {
        ...base,
        sequenceNumber,
        deterministicHash: deterministicHashOf(hashInput),
        previousEventHash: base.previousEventHash
    };
}
