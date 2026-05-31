"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PortfolioHeatConstraint = void 0;
const CorrelationEngine_js_1 = require("../engine/CorrelationEngine.js");
class PortfolioHeatConstraint {
    id = 'PortfolioHeatConstraint';
    evaluate(ctx) {
        const walletBalance = ctx.portfolioWalletBalance || 1000;
        const activeTrades = ctx.portfolioTrades || [];
        // 1. Gather all trades including prospective one
        const allTrades = [];
        // Add existing trades
        for (const trade of activeTrades) {
            const entryPrice = trade.entry || ctx.currentPrice;
            const weight = (trade.direction === 'LONG' ? 1 : -1) * (trade.positionSize * entryPrice) / walletBalance;
            allTrades.push({
                symbol: trade.symbol,
                direction: trade.direction,
                positionSize: trade.positionSize,
                entryPrice,
                marginRequired: trade.marginRequired || 0,
                weight
            });
        }
        // Add prospective trade if present and not already active
        if (ctx.prospectiveTrade) {
            const pt = ctx.prospectiveTrade;
            const entry = ctx.currentPrice;
            // Calculate Fractional Kelly position sizing for the prospective trade
            // f* = 0.25 * (p * R - (1 - p)) / R
            const p = ctx.confidence / 100;
            const riskPerUnit = Math.abs(entry - pt.stopLoss);
            let R = 1.5; // Default risk-to-reward ratio if stopLoss is identical to entry
            if (riskPerUnit > 0) {
                R = Math.abs(pt.target1 - entry) / riskPerUnit;
            }
            const rawKelly = R > 0 ? 0.25 * ((p * R - (1 - p)) / R) : 0.025;
            const clampedKelly = Math.max(0.01, Math.min(0.10, rawKelly)); // clamped to 1% - 10%
            const riskAmount = walletBalance * clampedKelly;
            const positionSize = riskPerUnit > 0 ? riskAmount / riskPerUnit : 0;
            if (positionSize > 0) {
                const lev = pt.leverage || 3;
                const marginRequired = (positionSize * entry) / lev;
                const weight = (pt.direction === 'LONG' ? 1 : -1) * (positionSize * entry) / walletBalance;
                allTrades.push({
                    symbol: ctx.symbol,
                    direction: pt.direction,
                    positionSize,
                    entryPrice: entry,
                    marginRequired,
                    weight
                });
            }
        }
        if (allTrades.length === 0) {
            return {
                passed: true,
                confidenceImpact: 0,
                reason: 'Portfolio is empty, heat and margin bounds are nominal.'
            };
        }
        // 2. Evaluate Aggregate Margin Constraint (limit 30%)
        let totalMargin = 0;
        for (const trade of allTrades) {
            totalMargin += trade.marginRequired;
        }
        const marginRatio = totalMargin / walletBalance;
        if (marginRatio > 0.30) {
            return {
                passed: false,
                confidenceImpact: 0,
                reason: `Aggregate margin exceeds limit: ${(marginRatio * 100).toFixed(2)}% > 30%`
            };
        }
        // 3. Evaluate Portfolio Heat Constraint (limit 15%)
        let doubleSum = 0;
        for (const t1 of allTrades) {
            for (const t2 of allTrades) {
                const rho = CorrelationEngine_js_1.CorrelationEngine.getCorrelation(t1.symbol, t2.symbol);
                doubleSum += t1.weight * t2.weight * rho;
            }
        }
        const portfolioHeat = Math.sqrt(Math.max(0, doubleSum));
        if (portfolioHeat > 0.15) {
            return {
                passed: false,
                confidenceImpact: 0,
                reason: `Correlation-weighted portfolio heat exceeds limit: ${(portfolioHeat * 100).toFixed(2)}% > 15%`,
                metadata: { portfolioHeat }
            };
        }
        return {
            passed: true,
            confidenceImpact: 0,
            reason: `Portfolio heat is within bounds: ${(portfolioHeat * 100).toFixed(2)}% (limit 15%), margin is ${(marginRatio * 100).toFixed(2)}% (limit 30%).`,
            metadata: { portfolioHeat }
        };
    }
}
exports.PortfolioHeatConstraint = PortfolioHeatConstraint;
