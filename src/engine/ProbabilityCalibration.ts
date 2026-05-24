import { MarketRegime, MarketContext } from './Types';
import { EventLog } from './EventSourcing';

export interface RegimeStats {
  wins: number;
  losses: number;
  winSums: number;
  lossSums: number;
}

export class ProbabilityCalibrationEngine {
  private regimeWinRates: Record<MarketRegime, RegimeStats> = {
    [MarketRegime.TRENDING]: { wins: 0, losses: 0, winSums: 0, lossSums: 0 },
    [MarketRegime.MEAN_REVERTING]: { wins: 0, losses: 0, winSums: 0, lossSums: 0 },
    [MarketRegime.CHOPPY]: { wins: 0, losses: 0, winSums: 0, lossSums: 0 },
    [MarketRegime.EXPANSION]: { wins: 0, losses: 0, winSums: 0, lossSums: 0 },
    [MarketRegime.COMPRESSION]: { wins: 0, losses: 0, winSums: 0, lossSums: 0 },
    [MarketRegime.HIGH_VOLATILITY]: { wins: 0, losses: 0, winSums: 0, lossSums: 0 },
    [MarketRegime.LOW_LIQUIDITY]: { wins: 0, losses: 0, winSums: 0, lossSums: 0 },
    [MarketRegime.NEWS_EVENT]: { wins: 0, losses: 0, winSums: 0, lossSums: 0 },
    [MarketRegime.LIQUIDATION_CASCADE]: { wins: 0, losses: 0, winSums: 0, lossSums: 0 }
  };

  /**
   * Calculates dynamic probability score based on historical performance in similar contexts.
   * Utilizes Laplace smoothing and expectancy filters to prevent overfitting.
   */
  public getCalibratedBaseConfidence(regime: MarketRegime): number {
    const stats = this.regimeWinRates[regime];
    const totalTrades = stats.wins + stats.losses;
    
    // Laplace smoothing: prior alpha = 2 (implies 50% Win Rate default prior)
    const alpha = 2;
    const smoothedWinRate = ((stats.wins + alpha) / (totalTrades + 2 * alpha)) * 100;
    
    if (totalTrades < 10) {
      return Math.round(smoothedWinRate);
    }
    
    // Expectancy calculation: (WinRate * AvgWin) - (LossRate * AvgLoss)
    const winRate = stats.wins / totalTrades;
    const lossRate = stats.losses / totalTrades;
    const avgWin = stats.wins > 0 ? (stats.winSums / stats.wins) : 0;
    const avgLoss = stats.losses > 0 ? (stats.lossSums / stats.losses) : 0;
    const expectancy = (winRate * avgWin) - (lossRate * avgLoss);
    
    let calibratedConfidence = smoothedWinRate;
    if (expectancy < 0) {
      calibratedConfidence = Math.max(0, smoothedWinRate * 0.5); // Demote negative expectancy
    } else if (expectancy > 0) {
      calibratedConfidence = Math.min(100, smoothedWinRate * 1.2); // Promote positive expectancy
    }
    
    return Math.round(calibratedConfidence);
  }

  public recordTradeResult(regime: MarketRegime, win: boolean, pnlPercent?: number): void {
    const stats = this.regimeWinRates[regime];
    const pnlValue = pnlPercent !== undefined ? Math.abs(pnlPercent) : 1.0;
    
    if (win) {
      stats.wins++;
      stats.winSums += pnlValue;
    } else {
      stats.losses++;
      stats.lossSums += pnlValue;
    }
  }
}
