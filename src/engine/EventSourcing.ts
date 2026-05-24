import { SystemEvent, MarketContext } from './Types';

export class EventLog {
  private events: SystemEvent[] = [];
  private pendingQueue: SystemEvent[] = [];
  private isProcessingQueue = false;
  private static instance: EventLog;

  private constructor() {}

  public static getInstance(): EventLog {
    if (!EventLog.instance) {
      EventLog.instance = new EventLog();
    }
    return EventLog.instance;
  }

  /**
   * Appends an event to the immutable log.
   */
  public append(event: Omit<SystemEvent, 'timestamp' | 'eventId'>): SystemEvent {
    const fullEvent: SystemEvent = {
      ...event,
      timestamp: Date.now(),
      eventId: crypto.randomUUID()
    };
    
    // In memory store capped at 1000 elements to prevent OOM
    this.events.push(fullEvent);
    if (this.events.length > 1000) {
      this.events.shift();
    }
    
    // Async flush to PostgreSQL Ledger via queue processor
    this.pendingQueue.push(fullEvent);
    this.triggerQueueProcessor();

    return fullEvent;
  }

  private triggerQueueProcessor(): void {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.pendingQueue.length === 0) {
      this.isProcessingQueue = false;
      return;
    }

    const event = this.pendingQueue[0];
    
    try {
      const response = await fetch('http://localhost:4000/api/advisor/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event)
      });
      
      if (response.ok) {
        // Success: shift from queue and move to next
        this.pendingQueue.shift();
      } else {
        // Backend error (e.g. rate limit, bad request): retry after delay
        console.warn(`PostgreSQL Ledger error ${response.status}, retrying in 5s...`);
        setTimeout(() => this.processQueue(), 5000);
        return;
      }
    } catch (err: any) {
      // Network unreachable: retry after delay
      console.warn('PostgreSQL Ledger offline, retrying in 5s:', err.message);
      setTimeout(() => this.processQueue(), 5000);
      return;
    }

    // Schedule next processing step (100ms spacing to prevent socket flooding)
    setTimeout(() => this.processQueue(), 100);
  }

  /**
   * Replays events for a given correlation ID or time range
   */
  public getEvents(filter?: { startTs?: number; endTs?: number; correlationId?: string }): SystemEvent[] {
    let result = this.events;
    if (filter) {
      if (filter.startTs) result = result.filter(e => e.timestamp >= filter.startTs!);
      if (filter.endTs) result = result.filter(e => e.timestamp <= filter.endTs!);
      if (filter.correlationId) result = result.filter(e => e.correlationId === filter.correlationId);
    }
    return result;
  }

  public clear(): void {
    this.events = [];
    this.pendingQueue = [];
    this.isProcessingQueue = false;
  }
}
