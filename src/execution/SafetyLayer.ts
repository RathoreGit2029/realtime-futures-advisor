import { MarketContext } from '../engine/Types';

export interface ExecutionSafetyResult {
  safe: boolean;
  adjustedEntryPrice: number;
  slippagePenalized: number;
  reason?: string;
}

export class ExecutionSafetyLayer {
  /**
   * Validates if a trade is safe to execute and calculates slippage penalties.
   */
  public validateExecution(
    ctx: MarketContext,
    direction: 'LONG' | 'SHORT',
    entryPrice: number
  ): ExecutionSafetyResult {
    const { volatility, spread, currentPrice } = ctx;

    // Stale Tick Gate: reject if market price has moved away from intended entry by > 5% of ATR
    const atrValue = volatility.atr || 0.1;
    const deviation = Math.abs(currentPrice - entryPrice);
    const maxDeviation = atrValue * 0.05;

    if (deviation > maxDeviation) {
      return {
        safe: false,
        adjustedEntryPrice: entryPrice,
        slippagePenalized: 0,
        reason: `Stale Tick Gate: Price drifted too far. Deviation=${deviation.toFixed(4)}, Max Allowed=${maxDeviation.toFixed(4)}`
      };
    }

    // Calculate slippage penalized entry price (using 1.5 * spread)
    const slippagePenalized = spread * 1.5;
    const adjustedEntryPrice = direction === 'LONG'
      ? currentPrice + slippagePenalized
      : currentPrice - slippagePenalized;

    return {
      safe: true,
      adjustedEntryPrice,
      slippagePenalized
    };
  }
}
