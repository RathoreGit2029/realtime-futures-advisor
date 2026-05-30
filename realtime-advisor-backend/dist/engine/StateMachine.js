"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StateMachine = void 0;
const Types_js_1 = require("./Types.js");
const EventSourcing_js_1 = require("./EventSourcing.js");
const VALID_TRANSITIONS = {
    [Types_js_1.MarketState.NO_TRADE]: new Set([
        Types_js_1.MarketState.NO_TRADE,
        Types_js_1.MarketState.ACCUMULATION,
        Types_js_1.MarketState.LIQUIDITY_SWEEP,
        Types_js_1.MarketState.DISPLACEMENT,
        Types_js_1.MarketState.RETRACEMENT,
        Types_js_1.MarketState.EXECUTION_WINDOW
    ]),
    [Types_js_1.MarketState.ACCUMULATION]: new Set([
        Types_js_1.MarketState.NO_TRADE,
        Types_js_1.MarketState.ACCUMULATION,
        Types_js_1.MarketState.LIQUIDITY_SWEEP,
        Types_js_1.MarketState.DISPLACEMENT,
        Types_js_1.MarketState.RETRACEMENT,
        Types_js_1.MarketState.EXECUTION_WINDOW
    ]),
    [Types_js_1.MarketState.LIQUIDITY_SWEEP]: new Set([
        Types_js_1.MarketState.NO_TRADE,
        Types_js_1.MarketState.ACCUMULATION,
        Types_js_1.MarketState.LIQUIDITY_SWEEP,
        Types_js_1.MarketState.DISPLACEMENT,
        Types_js_1.MarketState.EXECUTION_WINDOW
    ]),
    [Types_js_1.MarketState.DISPLACEMENT]: new Set([
        Types_js_1.MarketState.NO_TRADE,
        Types_js_1.MarketState.ACCUMULATION,
        Types_js_1.MarketState.DISPLACEMENT,
        Types_js_1.MarketState.RETRACEMENT,
        Types_js_1.MarketState.EXECUTION_WINDOW
    ]),
    [Types_js_1.MarketState.RETRACEMENT]: new Set([
        Types_js_1.MarketState.NO_TRADE,
        Types_js_1.MarketState.ACCUMULATION,
        Types_js_1.MarketState.RETRACEMENT,
        Types_js_1.MarketState.EXECUTION_WINDOW
    ]),
    [Types_js_1.MarketState.EXECUTION_WINDOW]: new Set([
        Types_js_1.MarketState.NO_TRADE,
        Types_js_1.MarketState.ACCUMULATION,
        Types_js_1.MarketState.EXECUTION_WINDOW,
        Types_js_1.MarketState.ACTIVE_POSITION
    ]),
    [Types_js_1.MarketState.ACTIVE_POSITION]: new Set([
        Types_js_1.MarketState.NO_TRADE,
        Types_js_1.MarketState.ACTIVE_POSITION,
        Types_js_1.MarketState.EXIT
    ]),
    [Types_js_1.MarketState.EXIT]: new Set([
        Types_js_1.MarketState.NO_TRADE,
        Types_js_1.MarketState.ACCUMULATION,
        Types_js_1.MarketState.EXIT
    ]),
    // For compatibility with legacy states
    [Types_js_1.MarketState.EXPANSION]: new Set([Types_js_1.MarketState.NO_TRADE, Types_js_1.MarketState.ACCUMULATION]),
    [Types_js_1.MarketState.REVERSAL]: new Set([Types_js_1.MarketState.NO_TRADE, Types_js_1.MarketState.ACCUMULATION]),
    [Types_js_1.MarketState.CHOPPY]: new Set([Types_js_1.MarketState.NO_TRADE, Types_js_1.MarketState.ACCUMULATION])
};
class StateMachine {
    symbolStates = new Map();
    logger = EventSourcing_js_1.EventLog.getInstance();
    getCurrentState(symbol) {
        return this.symbolStates.get(symbol) ?? Types_js_1.MarketState.NO_TRADE;
    }
    determineNextState(context, hasActivePosition) {
        if (hasActivePosition) {
            return Types_js_1.MarketState.ACTIVE_POSITION;
        }
        const currentState = this.getCurrentState(context.symbol);
        if (currentState === Types_js_1.MarketState.ACTIVE_POSITION && !hasActivePosition) {
            return Types_js_1.MarketState.EXIT;
        }
        if (currentState === Types_js_1.MarketState.EXIT) {
            return Types_js_1.MarketState.NO_TRADE;
        }
        const isTradeSession = context.sessionState.currentSession === 'LONDON' ||
            context.sessionState.currentSession === 'NEW_YORK' ||
            context.sessionState.currentSession === 'ASIA';
        if (!isTradeSession) {
            return Types_js_1.MarketState.NO_TRADE;
        }
        // Accumulation: low volatility compressing
        if (context.volatility.isCompressing && context.trendState.direction === 'SIDEWAYS') {
            return Types_js_1.MarketState.ACCUMULATION;
        }
        // Liquidity Sweep: sweep detected
        if (context.liquidityState.hasSweep) {
            return Types_js_1.MarketState.LIQUIDITY_SWEEP;
        }
        // Displacement: high quality displacement
        if (context.displacementQuality > 75 && context.trendState.strength > 60) {
            return Types_js_1.MarketState.DISPLACEMENT;
        }
        // Retracement: trend strength is moderate but direction matches HTF and no sweep currently
        if (context.trendState.direction !== 'SIDEWAYS' && context.displacementQuality < 50) {
            return Types_js_1.MarketState.RETRACEMENT;
        }
        // Execution window: if context has raw EXECUTION_WINDOW or is ready
        if (context.marketState === Types_js_1.MarketState.EXECUTION_WINDOW) {
            return Types_js_1.MarketState.EXECUTION_WINDOW;
        }
        return Types_js_1.MarketState.NO_TRADE;
    }
    transitionTo(symbol, nextState, reason) {
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
            throw new Error(`State machine violation: Illegal transition attempt from ${currentState} to ${nextState} for symbol ${symbol}. Reason: ${reason}`);
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
    forceState(symbol, state) {
        this.symbolStates.set(symbol, state);
    }
}
exports.StateMachine = StateMachine;
