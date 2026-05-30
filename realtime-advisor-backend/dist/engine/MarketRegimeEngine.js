"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarketRegimeEngine = void 0;
const Types_js_1 = require("./Types.js");
const EventSourcing_js_1 = require("./EventSourcing.js");
class MarketRegimeEngine {
    logger = EventSourcing_js_1.EventLog.getInstance();
    /**
     * Classify regime from a full MarketContext.
     * Used internally after context is built.
     */
    classify(context) {
        return this.classifyRaw(context);
    }
    /**
     * Classify regime from a partial context object.
     * Called by AntigravityEngine before the full immutable context is assembled,
     * and directly from background.js via the engine bundle.
     *
     * Rules are evaluated in priority order — first match wins.
     */
    classifyRaw(inputs) {
        const { volatility, trendState, sessionState } = inputs;
        const isTradeSession = sessionState.currentSession === 'LONDON' ||
            sessionState.currentSession === 'NEW_YORK' ||
            sessionState.currentSession === 'ASIA';
        let newRegime;
        if (volatility.historicalRank > 95) {
            // Extreme volatility overrides everything — do not trade
            newRegime = Types_js_1.MarketRegime.HIGH_VOLATILITY;
        }
        else if (isTradeSession && volatility.isExpanding && trendState.strength > 60) {
            newRegime = Types_js_1.MarketRegime.TRENDING;
        }
        else if (volatility.isCompressing && trendState.strength < 30) {
            newRegime = Types_js_1.MarketRegime.COMPRESSION;
        }
        else if (trendState.direction === 'SIDEWAYS' && volatility.atr > 0) {
            newRegime = Types_js_1.MarketRegime.MEAN_REVERTING;
        }
        else {
            newRegime = Types_js_1.MarketRegime.CHOPPY;
        }
        // Log regime transitions
        const previousRegime = inputs.regime;
        if (previousRegime !== undefined && previousRegime !== newRegime) {
            this.logger.append({
                type: 'RegimeChanged',
                correlationId: inputs.symbol,
                payload: {
                    from: previousRegime,
                    to: newRegime,
                    volatilityRank: volatility.historicalRank,
                    trendStrength: trendState.strength,
                    session: sessionState.currentSession
                }
            });
        }
        return newRegime;
    }
    /**
     * Returns the classification with a full explanation of which rule fired.
     */
    explainClassification(inputs) {
        const { volatility, trendState, sessionState } = inputs;
        const isTradeSession = sessionState.currentSession === 'LONDON' ||
            sessionState.currentSession === 'NEW_YORK' ||
            sessionState.currentSession === 'ASIA';
        let regime;
        let ruleFired;
        if (volatility.historicalRank > 95) {
            regime = Types_js_1.MarketRegime.HIGH_VOLATILITY;
            ruleFired = 'volatilityRank > 95';
        }
        else if (isTradeSession && volatility.isExpanding && trendState.strength > 60) {
            regime = Types_js_1.MarketRegime.TRENDING;
            ruleFired = 'tradeSession && isExpanding && strength > 60';
        }
        else if (volatility.isCompressing && trendState.strength < 30) {
            regime = Types_js_1.MarketRegime.COMPRESSION;
            ruleFired = 'isCompressing && strength < 30';
        }
        else if (trendState.direction === 'SIDEWAYS' && volatility.atr > 0) {
            regime = Types_js_1.MarketRegime.MEAN_REVERTING;
            ruleFired = 'direction === SIDEWAYS && atr > 0';
        }
        else {
            regime = Types_js_1.MarketRegime.CHOPPY;
            ruleFired = 'default';
        }
        return {
            regime,
            ruleFired,
            inputs: {
                volatilityRank: volatility.historicalRank,
                isExpanding: volatility.isExpanding,
                isCompressing: volatility.isCompressing,
                trendStrength: trendState.strength,
                trendDirection: trendState.direction,
                isTradeSession
            }
        };
    }
}
exports.MarketRegimeEngine = MarketRegimeEngine;
