import { StateMachine } from '../engine/StateMachine';
import { MarketState } from '../engine/Types';
import { EventLog } from '../engine/EventSourcing';
import { DeterministicTestClock } from '../engine/DeterministicClock';

describe('Explicit State Machine', () => {
  let clock: DeterministicTestClock;
  let fsm: StateMachine;

  beforeEach(() => {
    clock = new DeterministicTestClock(1000);
    EventLog.resetInstance();
    EventLog.getInstance(clock);
    fsm = new StateMachine();
  });

  test('defaults to NO_TRADE state', () => {
    expect(fsm.getCurrentState('BTCUSDT')).toBe(MarketState.NO_TRADE);
  });

  test('cold start initializes directly to any state without matrix validation', () => {
    const symbol = 'BTCUSDT';
    // Cold start directly to RETRACEMENT
    fsm.transitionTo(symbol, MarketState.RETRACEMENT, 'Cold start detection');
    expect(fsm.getCurrentState(symbol)).toBe(MarketState.RETRACEMENT);

    const events = EventLog.getInstance().getEvents({ eventType: 'StateTransition' });
    expect(events).toHaveLength(1);
    expect(events[0].payload.from).toBe('INITIALIZING');
    expect(events[0].payload.to).toBe(MarketState.RETRACEMENT);
  });

  test('valid transition flow succeeds and logs StateTransition events after initialization', () => {
    const symbol = 'BTCUSDT';
    // Initialize FSM state for the symbol to NO_TRADE to simulate already initialized state
    fsm.forceState(symbol, MarketState.NO_TRADE);
    
    // 1. NO_TRADE -> ACCUMULATION (valid)
    fsm.transitionTo(symbol, MarketState.ACCUMULATION, 'Entering trading session');
    expect(fsm.getCurrentState(symbol)).toBe(MarketState.ACCUMULATION);

    // 2. ACCUMULATION -> LIQUIDITY_SWEEP (valid)
    fsm.transitionTo(symbol, MarketState.LIQUIDITY_SWEEP, 'Sweep detected');
    expect(fsm.getCurrentState(symbol)).toBe(MarketState.LIQUIDITY_SWEEP);

    // 3. LIQUIDITY_SWEEP -> EXECUTION_WINDOW (valid)
    fsm.transitionTo(symbol, MarketState.EXECUTION_WINDOW, 'Confidence high & sweep confirmed');
    expect(fsm.getCurrentState(symbol)).toBe(MarketState.EXECUTION_WINDOW);

    // 4. EXECUTION_WINDOW -> ACTIVE_POSITION (valid)
    fsm.transitionTo(symbol, MarketState.ACTIVE_POSITION, 'Order filled');
    expect(fsm.getCurrentState(symbol)).toBe(MarketState.ACTIVE_POSITION);

    // 5. ACTIVE_POSITION -> EXIT (valid)
    fsm.transitionTo(symbol, MarketState.EXIT, 'TP hit');
    expect(fsm.getCurrentState(symbol)).toBe(MarketState.EXIT);

    // 6. EXIT -> NO_TRADE (valid)
    fsm.transitionTo(symbol, MarketState.NO_TRADE, 'Cooling down');
    expect(fsm.getCurrentState(symbol)).toBe(MarketState.NO_TRADE);

    // Check transition event logs
    const events = EventLog.getInstance().getEvents({ eventType: 'StateTransition' });
    expect(events).toHaveLength(6);
    expect(events[0].payload.from).toBe(MarketState.NO_TRADE);
    expect(events[0].payload.to).toBe(MarketState.ACCUMULATION);
    expect(events[1].payload.from).toBe(MarketState.ACCUMULATION);
    expect(events[1].payload.to).toBe(MarketState.LIQUIDITY_SWEEP);
  });

  test('invalid transitions throw a validation error immediately to fail closed after initialization', () => {
    const symbol = 'BTCUSDT';
    // Initialize FSM state for the symbol to NO_TRADE
    fsm.forceState(symbol, MarketState.NO_TRADE);
    expect(fsm.getCurrentState(symbol)).toBe(MarketState.NO_TRADE);

    // Illegal: NO_TRADE -> ACTIVE_POSITION directly without setup/execution window
    expect(() => {
      fsm.transitionTo(symbol, MarketState.ACTIVE_POSITION, 'Rogue transition attempt');
    }).toThrow(/State machine violation: Illegal transition attempt/);

    // Verify state did not change
    expect(fsm.getCurrentState(symbol)).toBe(MarketState.NO_TRADE);

    // Try another illegal jump: ACCUMULATION -> EXIT
    fsm.transitionTo(symbol, MarketState.ACCUMULATION, 'Valid transition');
    expect(() => {
      fsm.transitionTo(symbol, MarketState.EXIT, 'Illegal exit');
    }).toThrow(/State machine violation: Illegal transition attempt/);
  });

  test('allows emergency shutdown from ACTIVE_POSITION to NO_TRADE', () => {
    const symbol = 'BTCUSDT';
    
    // Force FSM state to ACTIVE_POSITION to simulate emergency
    fsm.forceState(symbol, MarketState.ACTIVE_POSITION);
    expect(fsm.getCurrentState(symbol)).toBe(MarketState.ACTIVE_POSITION);

    // Transition directly to NO_TRADE (should be allowed as safety release valve)
    fsm.transitionTo(symbol, MarketState.NO_TRADE, 'Emergency halt');
    expect(fsm.getCurrentState(symbol)).toBe(MarketState.NO_TRADE);
  });
});
