import { MarketState, MarketContext } from './Types';
import { EventLog } from './EventSourcing';

export class MarketStateMachine {
  private currentState: MarketState = MarketState.NO_TRADE;
  private logger = EventLog.getInstance();

  public getCurrentState(): MarketState {
    return this.currentState;
  }

  /**
   * Deterministic state transition
   */
  public transition(newState: MarketState, context: MarketContext, reason: string): boolean {
    const isValid = this.validateTransition(this.currentState, newState);
    
    if (isValid) {
      this.logger.append({
        type: 'StateTransition',
        correlationId: context.symbol,
        payload: {
          from: this.currentState,
          to: newState,
          reason
        },
        marketSnapshot: context
      });
      this.currentState = newState;
      return true;
    }

    this.logger.append({
      type: 'InvalidStateTransitionAttempt',
      correlationId: context.symbol,
      payload: {
        from: this.currentState,
        attemptedTo: newState,
        reason: 'Violated DAG topology'
      },
      marketSnapshot: context
    });

    return false;
  }

  private validateTransition(from: MarketState, to: MarketState): boolean {
    // Explicit Directed Graph rules for state transitions
    const validTransitions: Record<MarketState, MarketState[]> = {
      [MarketState.NO_TRADE]: [MarketState.ACCUMULATION, MarketState.CHOPPY],
      [MarketState.CHOPPY]: [MarketState.ACCUMULATION, MarketState.NO_TRADE],
      [MarketState.ACCUMULATION]: [MarketState.LIQUIDITY_SWEEP, MarketState.CHOPPY],
      [MarketState.LIQUIDITY_SWEEP]: [MarketState.DISPLACEMENT, MarketState.REVERSAL],
      [MarketState.DISPLACEMENT]: [MarketState.RETRACEMENT, MarketState.EXPANSION],
      [MarketState.RETRACEMENT]: [MarketState.EXECUTION_WINDOW, MarketState.REVERSAL],
      [MarketState.EXECUTION_WINDOW]: [MarketState.EXPANSION, MarketState.REVERSAL, MarketState.NO_TRADE],
      [MarketState.EXPANSION]: [MarketState.ACCUMULATION, MarketState.REVERSAL],
      [MarketState.REVERSAL]: [MarketState.ACCUMULATION, MarketState.CHOPPY]
    };

    return validTransitions[from]?.includes(to) ?? false;
  }
}
