CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS advisor_signals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    symbol VARCHAR(15) NOT NULL,
    direction VARCHAR(5) NOT NULL,
    entry_price DECIMAL(18, 8) NOT NULL,
    stop_loss DECIMAL(18, 8) NOT NULL,
    primary_target DECIMAL(18, 8) NOT NULL,
    secondary_target DECIMAL(18, 8),
    position_size DECIMAL(18, 8) NOT NULL,
    margin_required DECIMAL(18, 8) NOT NULL,
    leverage INTEGER NOT NULL,
    risk_amount DECIMAL(18, 8) NOT NULL,
    probability INTEGER NOT NULL,
    pattern_name VARCHAR(50) NOT NULL,
    displacement_score INTEGER,
    swept_pool_type VARCHAR(50),
    swept_pool_price DECIMAL(18, 8),
    mss_price DECIMAL(18, 8),
    fvg_top DECIMAL(18, 8),
    fvg_bottom DECIMAL(18, 8),
    dealing_range_high DECIMAL(18, 8),
    dealing_range_low DECIMAL(18, 8),
    equilibrium DECIMAL(18, 8),
    status VARCHAR(15) DEFAULT 'ACTIVE',
    pnl_percentage DECIMAL(10, 4) DEFAULT 0.0000,
    elapsed_candles INTEGER DEFAULT 0,
    timeframe VARCHAR(5) NOT NULL,
    action_taken BOOLEAN DEFAULT FALSE,
    hypothetical_outcome VARCHAR(15) DEFAULT 'ACTIVE',
    actual_outcome VARCHAR(15),
    trigger_catalyst VARCHAR(2000),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS advisor_events (
    sequence_number BIGINT PRIMARY KEY,
    exchange_timestamp BIGINT NOT NULL,
    receive_timestamp BIGINT NOT NULL,
    event_id VARCHAR(255) NOT NULL,
    correlation_id VARCHAR(255) NOT NULL,
    type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    market_context_snapshot JSONB,
    decision_metadata JSONB,
    event_version INTEGER NOT NULL,
    previous_event_hash VARCHAR(255),
    deterministic_hash VARCHAR(255) NOT NULL
);

CREATE TABLE IF NOT EXISTS advisor_snapshots (
    sequence_number BIGINT PRIMARY KEY,
    state_data JSONB NOT NULL,
    timestamp BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS unique_active_symbol
    ON advisor_signals (symbol)
    WHERE status IN ('ACTIVE', 'SANDBOX_ACTIVE');

CREATE INDEX IF NOT EXISTS idx_signals_created_at ON advisor_signals (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_events_type_seq ON advisor_events (type, sequence_number DESC);

CREATE INDEX IF NOT EXISTS idx_events_correlation ON advisor_events (correlation_id);
