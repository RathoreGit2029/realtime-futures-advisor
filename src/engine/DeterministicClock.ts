/**
 * Deterministic Clock Interface
 * 
 * Provides deterministic time sources for replayable execution.
 * All time-dependent operations must use this interface instead of Date.now().
 */

export interface Clock {
  /** Get current deterministic timestamp */
  now(): number;
  
  /** Get monotonic sequence number */
  sequence(): number;
  
  /** Advance clock by specified milliseconds (for testing/replay) */
  advance(ms: number): void;
  
  /** Reset to initial state (for replay) */
  reset(): void;
}

/**
 * Production Clock — delegates to Date.now() on every call.
 * Determinism is achieved by injecting the timestamp into MarketContext
 * from the WebSocket event, not from this clock.
 */
export class SystemClock implements Clock {
  private sequenceNumber: number = 0;

  now(): number {
    return Date.now();
  }

  sequence(): number {
    return this.sequenceNumber++;
  }

  advance(_ms: number): void {
    // No-op for production clock — time advances naturally
  }

  reset(): void {
    this.sequenceNumber = 0;
  }
}

/**
 * Deterministic Test Clock - Fully controlled for testing and replay
 */
export class DeterministicTestClock implements Clock {
  private currentTime: number;
  private sequenceNumber: number = 0;
  
  constructor(initialTime: number = 0) {
    this.currentTime = initialTime;
  }
  
  now(): number {
    return this.currentTime;
  }
  
  sequence(): number {
    return this.sequenceNumber++;
  }
  
  advance(ms: number): void {
    this.currentTime += ms;
  }
  
  reset(): void {
    this.currentTime = 0;
    this.sequenceNumber = 0;
  }
  
  /** Set time to specific value */
  setTime(time: number): void {
    this.currentTime = time;
  }
}

/**
 * Replay Clock - Recreates exact timing from event stream
 */
export class ReplayClock implements Clock {
  private eventTimes: number[];
  private currentIndex: number = 0;
  private sequenceNumber: number = 0;
  
  constructor(eventTimestamps: number[]) {
    this.eventTimes = [...eventTimestamps].sort((a, b) => a - b);
  }
  
  now(): number {
    if (this.currentIndex >= this.eventTimes.length) {
      throw new Error('ReplayClock: No more events in stream');
    }
    return this.eventTimes[this.currentIndex];
  }
  
  sequence(): number {
    return this.sequenceNumber++;
  }
  
  advance(ms: number): void {
    // In replay mode, we advance to next event time
    this.currentIndex = Math.min(this.currentIndex + 1, this.eventTimes.length);
  }
  
  reset(): void {
    this.currentIndex = 0;
    this.sequenceNumber = 0;
  }
  
  /** Check if more events available */
  hasMoreEvents(): boolean {
    return this.currentIndex < this.eventTimes.length;
  }
}