import { MarketContext, SystemEvent } from '../engine/Types';
import { EventLog } from '../engine/EventSourcing';

export class ExecutionSafetyLayer {
  private logger = EventLog.getInstance();

  /**
   * Validates if a generated signal is safe to execute in the real market.
   * Simulates institutional conditions like slippage and delayed fills.
   */
  public validateExecution(context: MarketContext, intendedDirection: 'LONG' | 'SHORT', intendedEntryPrice: number): { safe: boolean; adjustedEntry?: number; reason?: string } {
    const { spread, currentPrice, volatility } = context;

    // Simulation: Price moved away before we could fill (Stale Tick)
    const deviation = Math.abs(currentPrice - intendedEntryPrice);
    if (deviation > volatility.atr * 0.05) {
      this.logger.append({
        type: 'ExecutionRejected',
        correlationId: context.symbol,
        payload: { reason: `Price deviated too far from intended entry. Deviation=${deviation}` },
        marketSnapshot: context
      });
      return { safe: false, reason: 'Price deviated too far (Stale Entry)' };
    }

    // Simulation: Slippage estimation
    const estimatedSlippage = spread * 1.5; // Institutional conservative estimate
    const adjustedEntry = intendedDirection === 'LONG' 
      ? currentPrice + estimatedSlippage 
      : currentPrice - estimatedSlippage;

    // If adjusted entry completely ruins the Risk:Reward of the trade (e.g. puts us past a structural point), reject.
    // (Assuming RR check is done upstream, but this provides the penalized fill price).

    this.logger.append({
      type: 'ExecutionValidated',
      correlationId: context.symbol,
      payload: { intendedEntryPrice, adjustedEntry, estimatedSlippage },
      marketSnapshot: context
    });

    return {
      safe: true,
      adjustedEntry
    };
  }
}
