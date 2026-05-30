/**
 * Deterministic Event Log
 * 
 * Provides fully deterministic event sourcing with replay capabilities.
 * All events are immutable and ordered by sequence number.
 */

import { SystemEvent, createSystemEvent, MarketContext } from './Types.js';
import { Clock } from './DeterministicClock.js';

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
  private static readonly MAX_MEMORY_EVENTS = 10000;
  private static readonly KEEP_EVENTS_COUNT = 5000;

  private events: SystemEvent[] = [];
  private lastEventHash: string = '';
  private sequenceCounter: number = 0;
  private clock: Clock;
  private stateGetter?: () => any;
  private stateRestorer?: (state: any) => void;
  
  private syncEventHandler?: (event: SystemEvent) => void;
  private syncSnapshotHandler?: (sequenceNumber: number, state: any) => void;
  private hydrationHandler?: (startSeq: number) => Promise<{ events: SystemEvent[]; snapshotState: any | null }>;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  public getClock(): Clock {
    return this.clock;
  }

  public registerStateGetter(getter: () => any): void {
    this.stateGetter = getter;
  }

  public registerStateRestorer(restorer: (state: any) => void): void {
    this.stateRestorer = restorer;
  }

  public registerSyncEventHandler(handler: (event: SystemEvent) => void): void {
    this.syncEventHandler = handler;
  }

  public registerSyncSnapshotHandler(handler: (sequenceNumber: number, state: any) => void): void {
    this.syncSnapshotHandler = handler;
  }

  public registerHydrationHandler(handler: (startSeq: number) => Promise<{ events: SystemEvent[]; snapshotState: any | null }>): void {
    this.hydrationHandler = handler;
  }

  /**
   * Append a new deterministic event to the log
   */
  public append(
    type: string,
    correlationId: string,
    payload: any,
    marketContextSnapshot?: MarketContext
  ): SystemEvent {
    const timestamp = this.clock.now();
    const sequenceNumber = this.sequenceCounter;

    // Strict sequence check
    if (this.events.length > 0) {
      const last = this.events[this.events.length - 1];
      if (sequenceNumber !== last.sequenceNumber + 1) {
        throw new Error(`State violation: Sequence jump detected. Expected: ${last.sequenceNumber + 1}, Got: ${sequenceNumber}`);
      }
    }
    
    const eventId = `${correlationId}-${sequenceNumber}`;
    
    const event = createSystemEvent({
      exchangeTimestamp: timestamp,
      receiveTimestamp: Date.now(),
      sequenceNumber,
      eventId,
      correlationId,
      type,
      payload,
      marketContextSnapshot,
      eventVersion: 1,
      previousEventHash: this.lastEventHash
    });
    
    this.events.push(event);
    this.sequenceCounter++;
    this.lastEventHash = event.deterministicHash;
    
    // Sync to SQLite Authoritative Store
    this.postEventToBackend(event);

    // Snapshot Checkpointing Pipeline
    if (sequenceNumber > 0 && sequenceNumber % 10000 === 0) {
      this.triggerSnapshotCheckpoint(sequenceNumber);
    }

    // Keep memory usage bounded in SW session runtime
    this.manageMemoryBounds();
    
    return event;
  }

  private manageMemoryBounds(): void {
    if (this.events.length > DeterministicEventLog.MAX_MEMORY_EVENTS) {
      this.events = this.events.slice(-DeterministicEventLog.KEEP_EVENTS_COUNT);
    }
  }

  private postEventToBackend(event: SystemEvent): void {
    if (this.syncEventHandler) {
      try {
        this.syncEventHandler(event);
      } catch (err: any) {
        console.error(`[Event Store] Direct event sync failed:`, err.message);
      }
      return;
    }

    if (typeof fetch === 'undefined') return;

    fetch('http://localhost:4000/api/advisor/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    })
    .then(res => {
      if (!res.ok) {
        console.warn(`[Event Store] Failed to sync event ${event.sequenceNumber}: ${res.status}`);
      }
    })
    .catch(err => {
      console.warn(`[Event Store] Backend unreachable for event ${event.sequenceNumber}:`, err.message);
    });
  }

  private triggerSnapshotCheckpoint(sequenceNumber: number): void {
    if (!this.stateGetter) return;
    const stateData = this.stateGetter();

    if (this.syncSnapshotHandler) {
      try {
        this.syncSnapshotHandler(sequenceNumber, stateData);
      } catch (err: any) {
        console.error(`[Event Store] Direct snapshot sync failed:`, err.message);
      }
      return;
    }

    if (typeof fetch === 'undefined') return;

    try {
      fetch('http://localhost:4000/api/advisor/snapshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sequenceNumber,
          stateData,
          timestamp: Date.now()
        })
      })
      .then(res => {
        if (res.ok) {
          console.log(`[Event Store] Snapshot checkpoint created at sequence ${sequenceNumber}`);
        }
      })
      .catch(() => {});
    } catch (e) {
      console.error('[Event Store] Checkpoint snapshot generation failed:', e);
    }
  }

  /**
   * Hydrates the Event Log from the SQLite backend store
   */
  public async hydrate(): Promise<void> {
    if (this.hydrationHandler) {
      try {
        console.log(`[Event Store] Hydrating directly via registered handler...`);
        const res = await this.hydrationHandler(0);
        
        if (res.snapshotState && this.stateRestorer) {
          this.stateRestorer(res.snapshotState);
        }
        
        if (res.events && Array.isArray(res.events)) {
          if (res.events.length > 0) {
            this.events = res.events;
            const lastEvent = this.events[this.events.length - 1];
            this.sequenceCounter = lastEvent.sequenceNumber + 1;
            this.lastEventHash = lastEvent.deterministicHash;
          }
        }
        console.log(`[Event Store] Direct hydration complete. sequenceCounter=${this.sequenceCounter}`);
      } catch (err: any) {
        console.error('[Event Store] Direct hydration failed:', err.message);
      }
      return;
    }

    if (typeof fetch === 'undefined') return;

    try {
      // 1. Fetch latest snapshot
      const snapshotRes = await fetch('http://localhost:4000/api/advisor/snapshots/latest');
      let startSeq = 0;
      let stateData = null;

      if (snapshotRes.ok) {
        const snapshot = (await snapshotRes.json()) as any;
        if (snapshot && typeof snapshot.sequenceNumber === 'number') {
          startSeq = snapshot.sequenceNumber + 1;
          stateData = snapshot.stateData;
          console.log(`[Event Store] Hydrating from latest snapshot at sequence ${snapshot.sequenceNumber}`);
        }
      }

      // 2. Fetch subsequent events
      const eventsRes = await fetch(`http://localhost:4000/api/advisor/events?fromSequence=${startSeq}`);
      if (eventsRes.ok) {
        const events = await eventsRes.json();
        if (Array.isArray(events)) {
          if (events.length > 0) {
            console.log(`[Event Store] Hydrating and replaying ${events.length} events since sequence ${startSeq}`);
            this.events = events;
            
            const lastEvent = this.events[this.events.length - 1];
            this.sequenceCounter = lastEvent.sequenceNumber + 1;
            this.lastEventHash = lastEvent.deterministicHash;
          } else if (startSeq > 0) {
            // No new events since snapshot, set sequence counter based on snapshot
            this.events = [];
            this.sequenceCounter = startSeq;
          }
        }
      }

      // 3. Restore snapshot state
      if (stateData && this.stateRestorer) {
        this.stateRestorer(stateData);
      }
    } catch (err: any) {
      console.error('[Event Store] Hydration failed:', err.message);
    }
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
        filteredEvents = filteredEvents.filter(e => e.exchangeTimestamp >= filter.startTimestamp!);
      }
      if (filter.endTimestamp !== undefined) {
        filteredEvents = filteredEvents.filter(e => e.exchangeTimestamp <= filter.endTimestamp!);
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
    const avgEventSize = 1024; // 1KB average
    return this.events.length * avgEventSize;
  }
}