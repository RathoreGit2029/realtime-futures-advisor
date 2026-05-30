/**
 * Deterministic Event Log
 * 
 * Provides fully deterministic event sourcing with replay capabilities.
 * All events are immutable and ordered by sequence number.
 */

import { SystemEvent, createSystemEvent, MarketContext } from './Types';
import { Clock } from './DeterministicClock';

export interface EventFilter {
  startSequence?: number;
  endSequence?: number;
  startTimestamp?: number;
  endTimestamp?: number;
  correlationId?: string;
  eventType?: string;
}

export interface EventStream {
  events: SystemEvent[];
  startSequence: number;
  endSequence: number;
  totalEvents: number;
}

export interface ReplayState {
  currentSequence: number;
  lastEventHash: string;
  totalEventsProcessed: number;
}

export class DeterministicEventLog {
  private events: SystemEvent[] = [];
  private lastEventHash: string = '';
  private sequenceCounter: number = 0;
  private clock: Clock;
  
  /** Maximum events in memory (archived events are persisted) */
  private static readonly MAX_MEMORY_EVENTS = 10000;
  
  /** Archive threshold - when to start archiving old events */
  private static readonly ARCHIVE_THRESHOLD = 5000;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /**
   * Append a new deterministic event to the log
   */
  public append(
    type: string,
    correlationId: string,
    payload: any,
    marketSnapshot?: MarketContext
  ): SystemEvent {
    const timestamp = this.clock.now();
    const sequenceNumber = this.sequenceCounter++;
    const eventId = `${correlationId}-${sequenceNumber}`;
    
    const event = createSystemEvent({
      timestamp,
      sequenceNumber,
      eventId,
      correlationId,
      type,
      payload,
      marketSnapshot,
      previousEventHash: this.lastEventHash
    });
    
    this.events.push(event);
    this.lastEventHash = event.deterministicHash;
    
    // Manage memory bounds
    this.manageMemoryBounds();
    
    return event;
  }

  /**
   * Get events with deterministic filtering
   */
  public getEvents(filter?: EventFilter): EventStream {
    let filteredEvents = this.events;
    
    if (filter) {
      if (filter.startSequence !== undefined) {
        filteredEvents = filteredEvents.filter(e => e.sequenceNumber >= filter.startSequence!);
      }
      if (filter.endSequence !== undefined) {
        filteredEvents = filteredEvents.filter(e => e.sequenceNumber <= filter.endSequence!);
      }
      if (filter.startTimestamp !== undefined) {
        filteredEvents = filteredEvents.filter(e => e.timestamp >= filter.startTimestamp!);
      }
      if (filter.endTimestamp !== undefined) {
        filteredEvents = filteredEvents.filter(e => e.timestamp <= filter.endTimestamp!);
      }
      if (filter.correlationId) {
        filteredEvents = filteredEvents.filter(e => e.correlationId === filter.correlationId);
      }
      if (filter.eventType) {
        filteredEvents = filteredEvents.filter(e => e.type === filter.eventType);
      }
    }
    
    const startSequence = filteredEvents.length > 0 ? filteredEvents[0].sequenceNumber : 0;
    const endSequence = filteredEvents.length > 0 ? filteredEvents[filteredEvents.length - 1].sequenceNumber : 0;
    
    return {
      events: [...filteredEvents],
      startSequence,
      endSequence,
      totalEvents: filteredEvents.length
    };
  }

  /**
   * Get event by sequence number (deterministic)
   */
  public getEvent(sequenceNumber: number): SystemEvent | undefined {
    return this.events.find(e => e.sequenceNumber === sequenceNumber);
  }

  /**
   * Get current replay state
   */
  public getReplayState(): ReplayState {
    return {
      currentSequence: this.sequenceCounter,
      lastEventHash: this.lastEventHash,
      totalEventsProcessed: this.events.length
    };
  }

  /**
   * Replay events from a specific sequence number
   */
  public replayFrom(sequenceNumber: number, callback: (event: SystemEvent) => void): void {
    const eventsToReplay = this.events.filter(e => e.sequenceNumber >= sequenceNumber);
    
    // Verify event chain integrity
    this.verifyEventChain(eventsToReplay);
    
    // Replay events in order
    eventsToReplay.forEach(callback);
  }

  /**
   * Verify event chain integrity
   */
  private verifyEventChain(events: SystemEvent[]): boolean {
    if (events.length === 0) return true;
    
    // Sort by sequence number
    const sortedEvents = [...events].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    
    // Check sequence continuity
    for (let i = 1; i < sortedEvents.length; i++) {
      if (sortedEvents[i].sequenceNumber !== sortedEvents[i - 1].sequenceNumber + 1) {
        throw new Error(`Event chain broken at sequence ${sortedEvents[i - 1].sequenceNumber}`);
      }
      
      // Check hash chain
      if (sortedEvents[i].previousEventHash !== sortedEvents[i - 1].deterministicHash) {
        throw new Error(`Event hash chain broken at sequence ${sortedEvents[i].sequenceNumber}`);
      }
    }
    
    return true;
  }

  /**
   * Manage memory bounds by archiving old events
   */
  private manageMemoryBounds(): void {
    if (this.events.length > DeterministicEventLog.MAX_MEMORY_EVENTS) {
      // In production, this would archive events to persistent storage
      // For now, we just trim to keep memory bounded
      const eventsToKeep = this.events.slice(-DeterministicEventLog.ARCHIVE_THRESHOLD);
      this.events = eventsToKeep;
      
      // Update last event hash
      if (this.events.length > 0) {
        this.lastEventHash = this.events[this.events.length - 1].deterministicHash;
      }
    }
  }

  /**
   * Clear all events (for testing)
   */
  public clear(): void {
    this.events = [];
    this.lastEventHash = '';
    this.sequenceCounter = 0;
  }

  /**
   * Get total event count
   */
  public getEventCount(): number {
    return this.events.length;
  }

  /**
   * Get memory usage estimate
   */
  public getMemoryUsage(): number {
    // Rough estimate: average event size * number of events
    const avgEventSize = 1024; // 1KB average
    return this.events.length * avgEventSize;
  }
}