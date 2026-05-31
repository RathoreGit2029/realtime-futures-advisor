import { Constraint, ConstraintResult, MarketContext } from '../engine/Types';
import { CorrelationEngine } from '../engine/CorrelationEngine';

export class PortfolioHeatConstraint implements Constraint {
  public id = 'PortfolioHeatConstraint';

  public evaluate(ctx: MarketContext): ConstraintResult {
    const walletBalance = ctx.portfolioWalletBalance || 1000;
    const activeTrades = ctx.portfolioTrades || [];
    
    // 1. Gather all trades including prospective one
    const allTrades: Array<{
      symbol: string;
      direction: 'LONG' | 'SHORT';
      positionSize: number;
      entryPrice: number;
      marginRequired: number;
      weight: number;
    }> = [];

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
      
      const kellyFactor = ctx.kellyFactor ?? 0.25;
      const rawKelly = R > 0 ? kellyFactor * ((p * R - (1 - p)) / R) : 0.025;
      const clampedKelly = Math.max(0.01, Math.min(0.10, rawKelly)); // clamped to 1% - 10%
      
      const riskAmount = walletBalance * clampedKelly;
      const positionSize = riskPerUnit > 0 ? riskAmount / riskPerUnit : 0;
      
      if (positionSize > 0) {
        const lev = (pt as any).leverage || 3;
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

    // 2. Evaluate Aggregate Margin Constraint (limit maxPortfolioMargin)
    let totalMargin = 0;
    for (const trade of allTrades) {
      totalMargin += trade.marginRequired;
    }
    const marginRatio = totalMargin / walletBalance;
    const maxPortfolioMargin = ctx.maxPortfolioMargin ?? 0.30;
    if (marginRatio > maxPortfolioMargin) {
      return {
        passed: false,
        confidenceImpact: 0,
        reason: `Aggregate margin exceeds limit: ${(marginRatio * 100).toFixed(2)}% > ${(maxPortfolioMargin * 100).toFixed(2)}%`
      };
    }

    // 3. Evaluate Portfolio Heat Constraint (limit maxPortfolioHeat)
    let doubleSum = 0;
    for (const t1 of allTrades) {
      for (const t2 of allTrades) {
        const rho = CorrelationEngine.getCorrelation(t1.symbol, t2.symbol);
        doubleSum += t1.weight * t2.weight * rho;
      }
    }
    const portfolioHeat = Math.sqrt(Math.max(0, doubleSum));
    const maxPortfolioHeat = ctx.maxPortfolioHeat ?? 0.15;
    if (portfolioHeat > maxPortfolioHeat) {
      return {
        passed: false,
        confidenceImpact: 0,
        reason: `Correlation-weighted portfolio heat exceeds limit: ${(portfolioHeat * 100).toFixed(2)}% > ${(maxPortfolioHeat * 100).toFixed(2)}%`,
        metadata: { portfolioHeat }
      };
    }

    return {
      passed: true,
      confidenceImpact: 0,
      reason: `Portfolio heat is within bounds: ${(portfolioHeat * 100).toFixed(2)}% (limit ${(maxPortfolioHeat * 100).toFixed(2)}%), margin is ${(marginRatio * 100).toFixed(2)}% (limit ${(maxPortfolioMargin * 100).toFixed(2)}%).`,
      metadata: { portfolioHeat }
    };
  }
}
