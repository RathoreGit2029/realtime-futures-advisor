CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS advisor_signals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    symbol VARCHAR(15) NOT NULL,
    direction VARCHAR(5) NOT NULL,
    entry_price DECIMAL(18, 8) NOT NULL,
    stop_loss DECIMAL(18, 8) NOT NULL,
    target_1 DECIMAL(18, 8) NOT NULL,
    target_2 DECIMAL(18, 8) NOT NULL,
    position_size DECIMAL(18, 8) NOT NULL,
    margin_required DECIMAL(18, 8) NOT NULL,
    leverage INTEGER NOT NULL,
    risk_amount DECIMAL(18, 8) NOT NULL,
    probability INTEGER NOT NULL,
    pattern_name VARCHAR(50) NOT NULL,
    rsi_value INTEGER,
    ema_9 DECIMAL(18, 8),
    ema_21 DECIMAL(18, 8),
    bullish_ob_count INTEGER,
    bearish_ob_count INTEGER,
    confidence_trend INTEGER,
    confidence_smc INTEGER,
    confidence_momentum INTEGER,
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

CREATE UNIQUE INDEX IF NOT EXISTS unique_active_symbol
    ON advisor_signals (symbol)
    WHERE status IN ('ACTIVE', 'SANDBOX_ACTIVE');

CREATE INDEX IF NOT EXISTS idx_advisor_signals_created_at ON advisor_signals (created_at DESC);
