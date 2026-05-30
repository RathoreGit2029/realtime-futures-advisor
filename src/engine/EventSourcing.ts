import { SystemEvent, MarketContext } from './Types';
import { Clock, SystemClock } from './DeterministicClock';
import { DeterministicEventLog } from './DeterministicEventLog';

/**
 * EventLog singleton.
 *
 * The singleton is module-level, so it is reset on every service worker restart.
 * That is acceptable — the event log is an in-session audit trail, not a
 * persistence layer.  Cross-session persistence is handled by chrome.storage
 * (active trades, journal stats) and PostgreSQL (resolved signals).
 *
 * To inject a deterministic clock for testing, call EventLog.getInstance(clock)
 * BEFORE any other code creates the singleton.
 */
export class EventLog {
  private eventLog: DeterministicEventLog;
  private static instance: EventLog | null = null;

  private constructor(clock: Clock) {
    this.eventLog = new DeterministicEventLog(clock);
  }

  public static getInstance(clock?: Clock): EventLog {
    if (!EventLog.instance) {
      EventLog.instance = new EventLog(clock ?? new SystemClock());
    }
    return EventLog.instance;
  }

  /** Reset singleton — only for tests */
  public static resetInstance(): void {
    EventLog.instance = null;
  }

  public append(
    event: Omit<SystemEvent, 'exchangeTimestamp' | 'receiveTimestamp' | 'eventId' | 'sequenceNumber' | 'deterministicHash' | 'previousEventHash' | 'eventVersion'>
  ): SystemEvent {
    return this.eventLog.append(
      event.type,
      event.correlationId,
      event.payload,
      event.marketContextSnapshot
    );
  }

  public async hydrate(): Promise<void> {
    await this.eventLog.hydrate();
  }

  public registerStateGetter(getter: () => any): void {
    this.eventLog.registerStateGetter(getter);
  }

  public registerStateRestorer(restorer: (state: any) => void): void {
    this.eventLog.registerStateRestorer(restorer);
  }

  public getEvents(filter?: {
    startTs?: number;
    endTs?: number;
    correlationId?: string;
    startSequence?: number;
    endSequence?: number;
    eventType?: string;
  }): SystemEvent[] {
    return this.eventLog.getEvents({
      startTimestamp: filter?.startTs,
      endTimestamp: filter?.endTs,
      correlationId: filter?.correlationId,
      startSequence: filter?.startSequence,
      endSequence: filter?.endSequence,
      eventType: filter?.eventType
    }).events;
  }

  public replayFrom(sequenceNumber: number, callback: (event: SystemEvent) => void): void {
    this.eventLog.replayFrom(sequenceNumber, callback);
  }

  public getReplayState() {
    return this.eventLog.getReplayState();
  }

  public clear(): void {
    this.eventLog.clear();
  }

  public getEventCount(): number {
    return this.eventLog.getEventCount();
  }

  public getMemoryUsage(): number {
    return this.eventLog.getMemoryUsage();
  }
}
