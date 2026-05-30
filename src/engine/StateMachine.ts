import { MarketState, MarketContext } from './Types';
import { EventLog } from './EventSourcing';

const VALID_TRANSITIONS: Record<MarketState, Set<MarketState>> = {
  [MarketState.NO_TRADE]: new Set([
    MarketState.NO_TRADE,
    MarketState.ACCUMULATION,
    MarketState.LIQUIDITY_SWEEP,
    MarketState.DISPLACEMENT,
    MarketState.RETRACEMENT
  ]),
  [MarketState.ACCUMULATION]: new Set([
    MarketState.NO_TRADE,
    MarketState.ACCUMULATION,
    MarketState.LIQUIDITY_SWEEP,
    MarketState.DISPLACEMENT
  ]),
  [MarketState.LIQUIDITY_SWEEP]: new Set([
    MarketState.NO_TRADE,
    MarketState.ACCUMULATION,
    MarketState.LIQUIDITY_SWEEP,
    MarketState.DISPLACEMENT,
    MarketState.EXECUTION_WINDOW
  ]),
  [MarketState.DISPLACEMENT]: new Set([
    MarketState.NO_TRADE,
    MarketState.ACCUMULATION,
    MarketState.DISPLACEMENT,
    MarketState.RETRACEMENT,
    MarketState.EXECUTION_WINDOW
  ]),
  [MarketState.RETRACEMENT]: new Set([
    MarketState.NO_TRADE,
    MarketState.ACCUMULATION,
    MarketState.RETRACEMENT,
    MarketState.EXECUTION_WINDOW
  ]),
  [MarketState.EXECUTION_WINDOW]: new Set([
    MarketState.NO_TRADE,
    MarketState.ACCUMULATION,
    MarketState.EXECUTION_WINDOW,
    MarketState.ACTIVE_POSITION
  ]),
  [MarketState.ACTIVE_POSITION]: new Set([
    MarketState.NO_TRADE,
    MarketState.ACTIVE_POSITION,
    MarketState.EXIT
  ]),
  [MarketState.EXIT]: new Set([
    MarketState.NO_TRADE,
    MarketState.ACCUMULATION,
    MarketState.EXIT
  ]),
  // For compatibility with legacy states
  [MarketState.EXPANSION]: new Set([MarketState.NO_TRADE, MarketState.ACCUMULATION]),
  [MarketState.REVERSAL]: new Set([MarketState.NO_TRADE, MarketState.ACCUMULATION]),
  [MarketState.CHOPPY]: new Set([MarketState.NO_TRADE, MarketState.ACCUMULATION])
};

export class StateMachine {
  private symbolStates: Map<string, MarketState> = new Map();
  private logger = EventLog.getInstance();

  public getCurrentState(symbol: string): MarketState {
    return this.symbolStates.get(symbol) ?? MarketState.NO_TRADE;
  }

  public determineNextState(context: MarketContext, hasActivePosition: boolean): MarketState {
    if (hasActivePosition) {
      return MarketState.ACTIVE_POSITION;
    }

    const currentState = this.getCurrentState(context.symbol);
    if (currentState === MarketState.ACTIVE_POSITION && !hasActivePosition) {
      return MarketState.EXIT;
    }

    if (currentState === MarketState.EXIT) {
      return MarketState.NO_TRADE;
    }

    const isTradeSession =
      context.sessionState.currentSession === 'LONDON' ||
      context.sessionState.currentSession === 'NEW_YORK' ||
      context.sessionState.currentSession === 'ASIA';

    if (!isTradeSession) {
      return MarketState.NO_TRADE;
    }

    // Accumulation: low volatility compressing
    if (context.volatility.isCompressing && context.trendState.direction === 'SIDEWAYS') {
      return MarketState.ACCUMULATION;
    }

    // Liquidity Sweep: sweep detected
    if (context.liquidityState.hasSweep) {
      return MarketState.LIQUIDITY_SWEEP;
    }

    // Displacement: high quality displacement
    if (context.displacementQuality > 75 && context.trendState.strength > 60) {
      return MarketState.DISPLACEMENT;
    }

    // Retracement: trend strength is moderate but direction matches HTF and no sweep currently
    if (context.trendState.direction !== 'SIDEWAYS' && context.displacementQuality < 50) {
      return MarketState.RETRACEMENT;
    }

    // Execution window: if context has raw EXECUTION_WINDOW or is ready
    if (context.marketState === MarketState.EXECUTION_WINDOW) {
      return MarketState.EXECUTION_WINDOW;
    }

    return MarketState.NO_TRADE;
  }

  public transitionTo(symbol: string, nextState: MarketState, reason: string): void {
    const currentState = this.getCurrentState(symbol);

    if (currentState === nextState) {
      return;
    }

    const isFirstTick = !this.symbolStates.has(symbol);
    if (isFirstTick) {
      this.symbolStates.set(symbol, nextState);
      this.logger.append({
        type: 'StateTransition',
        correlationId: symbol,
        payload: {
          from: 'INITIALIZING',
          to: nextState,
          reason: `Cold start initialization: ${reason}`
        }
      });
      console.log(`[FSM] ${symbol} initialized to ${nextState}. Reason: Cold start initialization`);
      return;
    }

    const validTransitions = VALID_TRANSITIONS[currentState];
    if (!validTransitions || !validTransitions.has(nextState)) {
      throw new Error(
        `State machine violation: Illegal transition attempt from ${currentState} to ${nextState} for symbol ${symbol}. Reason: ${reason}`
      );
    }

    this.symbolStates.set(symbol, nextState);

    // Journal the state transition event
    this.logger.append({
      type: 'StateTransition',
      correlationId: symbol,
      payload: {
        from: currentState,
        to: nextState,
        reason
      }
    });

    console.log(`[FSM] ${symbol} transitioned from ${currentState} -> ${nextState}. Reason: ${reason}`);
  }

  /** Force reset the state of a symbol (primarily for testing) */
  public forceState(symbol: string, state: MarketState): void {
    this.symbolStates.set(symbol, state);
  }
}
