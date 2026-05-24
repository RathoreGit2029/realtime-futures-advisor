import { MarketContext, SystemEvent } from '../engine/Types';
import { EventLog } from '../engine/EventSourcing';

export class CircuitBreakerEngine {
  private logger = EventLog.getInstance();

  /**
   * Evaluates system health and market conditions to determine if trading should halt.
   */
  public evaluateSystemHealth(context: MarketContext, recentEvents: SystemEvent[]): { halted: boolean; reason?: string } {
    const { volatility, spread } = context;

    // Check 1: Extreme Volatility Anomalies
    if (volatility.atr > 0 && spread > volatility.atr * 0.25) {
      this.logger.append({
        type: 'CircuitBreakerTriggered',
        correlationId: context.symbol,
        payload: { reason: 'Spread exploded relative to ATR' }
      });
      return { halted: true, reason: 'Spread exploded relative to ATR' };
    }

    // Check 2: Stale Data / Latency Spikes
    // If the tick timestamp is more than 3000ms old, halt execution
    const latency = Date.now() - context.timestamp;
    if (latency > 3000) {
      this.logger.append({
        type: 'CircuitBreakerTriggered',
        correlationId: context.symbol,
        payload: { reason: `Data latency spike: ${latency}ms` }
      });
      return { halted: true, reason: `Data latency spike: ${latency}ms` };
    }

    // Check 3: Cascade Failures (e.g., consecutive execution safety rejections)
    const recentExecutionRejections = recentEvents.filter(e => e.type === 'ExecutionRejected');
    if (recentExecutionRejections.length > 5) {
       return { halted: true, reason: 'High frequency execution rejections (Execution Failure Cascade)' };
    }

    return { halted: false };
  }
}
