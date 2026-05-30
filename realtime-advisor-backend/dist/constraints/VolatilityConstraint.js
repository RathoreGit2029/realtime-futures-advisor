"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VolatilityConstraint = void 0;
class VolatilityConstraint {
    id = 'VolatilityConstraint';
    evaluate(ctx) {
        const { volatility, spread } = ctx;
        if (volatility.historicalRank > 95) {
            return {
                passed: false,
                confidenceImpact: 0,
                reason: `Volatility rank ${volatility.historicalRank} > 95. Too dangerous to execute.`
            };
        }
        // Spread expansion check during high volatility
        if (volatility.isExpanding && spread > volatility.atr * 0.1) {
            return {
                passed: false,
                confidenceImpact: 0,
                reason: `Spread expansion detected during volatility spike. Spread=${spread}, ATR=${volatility.atr}`
            };
        }
        return {
            passed: true,
            confidenceImpact: 0,
            reason: 'Volatility conditions are within safe execution parameters.'
        };
    }
}
exports.VolatilityConstraint = VolatilityConstraint;
