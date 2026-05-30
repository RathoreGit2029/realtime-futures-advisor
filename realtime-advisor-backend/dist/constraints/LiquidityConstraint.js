"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LiquidityConstraint = void 0;
const Types_js_1 = require("../engine/Types.js");
class LiquidityConstraint {
    id = 'LiquidityConstraint';
    evaluate(ctx) {
        const { liquidityState, marketState, trendState } = ctx;
        // Only strictly enforce sweep requirement if we are looking for a reversal or displacement entry
        if (marketState === Types_js_1.MarketState.EXECUTION_WINDOW) {
            if (!liquidityState.hasSweep) {
                return {
                    passed: false,
                    confidenceImpact: 0,
                    reason: 'No liquidity sweep detected prior to execution window. Institutional trap risk high.'
                };
            }
            if (liquidityState.sweepQuality < 40) {
                return {
                    passed: false,
                    confidenceImpact: 0,
                    reason: `Sweep quality too low (${liquidityState.sweepQuality}). Potential weak hands trap.`
                };
            }
            // Ensure sweep direction opposes the intended trade direction (sweep retail longs to go long)
            const intendedTradeDirection = trendState.direction;
            if (intendedTradeDirection === 'UP' && liquidityState.recentSweepDirection === 'BEARISH') {
                return {
                    passed: false,
                    confidenceImpact: 0,
                    reason: 'Sweep direction opposes logical entry. Swept highs, but looking for longs.'
                };
            }
            if (intendedTradeDirection === 'DOWN' && liquidityState.recentSweepDirection === 'BULLISH') {
                return {
                    passed: false,
                    confidenceImpact: 0,
                    reason: 'Sweep direction opposes logical entry. Swept lows, but looking for shorts.'
                };
            }
        }
        return {
            passed: true,
            confidenceImpact: 0,
            reason: 'Liquidity sweep confirmed and valid.'
        };
    }
}
exports.LiquidityConstraint = LiquidityConstraint;
