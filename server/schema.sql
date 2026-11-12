-- 油势 · 自建后端数据库结构
--
-- PostgreSQL。集合与表的对应见 docs/self-hosted-backend.md。
--
-- 命名约定：库里用 snake_code，业务层用 camelCase，转换集中在 DAO 层。
-- 唯一索引同时承担去重职责：通知靠 dedup_key，提醒记录也靠 dedup_key。

-- 当前价：每个 (region_code, fuel_id) 一条
CREATE TABLE IF NOT EXISTS oil_prices (
  id            BIGSERIAL PRIMARY KEY,
  region_code   TEXT NOT NULL,
  region_name   TEXT,
  fuel_id       TEXT NOT NULL,
  fuel_name     TEXT,
  price         NUMERIC(6, 2) NOT NULL,
  change_amount NUMERIC(6, 2) NOT NULL DEFAULT 0,
  change_at     DATE,
  source        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (region_code, fuel_id)
);

-- 历史价：每个 (region_code, fuel_id, date) 一条
CREATE TABLE IF NOT EXISTS oil_price_history (
  id            BIGSERIAL PRIMARY KEY,
  region_code   TEXT NOT NULL,
  fuel_id       TEXT NOT NULL,
  date          DATE NOT NULL,
  price         NUMERIC(6, 2) NOT NULL,
  source        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (region_code, fuel_id, date)
);

-- 调价节点：每次调价一条
CREATE TABLE IF NOT EXISTS oil_adjust_events (
  id            BIGSERIAL PRIMARY KEY,
  date          DATE NOT NULL,
  title         TEXT,
  deltas        JSONB NOT NULL DEFAULT '{}'::jsonb,
  source        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 调价通知：dedup_key 唯一，用来做去重
CREATE TABLE IF NOT EXISTS oil_notices (
  id            BIGSERIAL PRIMARY KEY,
  dedup_key     TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL DEFAULT 'official',
  title         TEXT,
  published_at  TIMESTAMPTZ,
  execute_at    DATE,
  changes       JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary       TEXT,
  prices        JSONB NOT NULL DEFAULT '{}'::jsonb,
  source        JSONB NOT NULL DEFAULT '{}'::jsonb,
  review_status TEXT NOT NULL DEFAULT 'pending',
  raw           TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 下一轮调价窗口
CREATE TABLE IF NOT EXISTS oil_windows (
  id            BIGSERIAL PRIMARY KEY,
  date          DATE NOT NULL,
  time          TEXT,
  cycle_start   DATE,
  is_official   BOOLEAN NOT NULL DEFAULT FALSE,
  basis         TEXT,
  forecast      JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 预测方向 up/down/flat。幅度解析不出来时靠它表达方向，
  -- 不能让前端把「幅度未知」当成「持平 0」
  forecast_direction TEXT,
  source        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 国际行情：每个 symbol 一条（存整条曲线）
CREATE TABLE IF NOT EXISTS oil_markets (
  id            BIGSERIAL PRIMARY KEY,
  symbol        TEXT NOT NULL UNIQUE,
  name          TEXT,
  price         NUMERIC(10, 2),
  change_amount NUMERIC(10, 2) DEFAULT 0,
  change_percent NUMERIC(10, 4) DEFAULT 0,
  open          NUMERIC(10, 2),
  prev_close    NUMERIC(10, 2),
  high          NUMERIC(10, 2),
  low           NUMERIC(10, 2),
  series        JSONB NOT NULL DEFAULT '[]'::jsonb,
  delayed       BOOLEAN NOT NULL DEFAULT FALSE,
  quote_time    TEXT,
  source        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 用户标识
CREATE TABLE IF NOT EXISTS oil_users (
  id            BIGSERIAL PRIMARY KEY,
  openid        TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 提醒规则：按 user_id
CREATE TABLE IF NOT EXISTS alert_rules (
  id                BIGSERIAL PRIMARY KEY,
  user_id           TEXT NOT NULL,
  region_code       TEXT NOT NULL,
  fuel_id           TEXT NOT NULL,
  official_drop     BOOLEAN NOT NULL DEFAULT TRUE,
  target_price      NUMERIC(6, 2),
  predict_drop      BOOLEAN NOT NULL DEFAULT FALSE,
  subscribe_granted BOOLEAN NOT NULL DEFAULT FALSE,
  extra             JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, region_code, fuel_id)
);

-- 提醒记录：dedup_key 唯一，保证同一个「规则 + 事件」只发一次
CREATE TABLE IF NOT EXISTS alert_logs (
  id            BIGSERIAL PRIMARY KEY,
  user_id       TEXT NOT NULL,
  dedup_key     TEXT NOT NULL UNIQUE,
  time          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent          BOOLEAN NOT NULL DEFAULT FALSE,
  fail_reason   TEXT,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- 采集运行记录：前端用它显示「同步状态」
CREATE TABLE IF NOT EXISTS collector_runs (
  id            BIGSERIAL PRIMARY KEY,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'idle',
  source_name   TEXT,
  results       JSONB NOT NULL DEFAULT '[]'::jsonb,
  needs_review  JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- 老库补列：CREATE TABLE IF NOT EXISTS 不会改动已存在的表，
-- 部署脚本每次都会跑这个文件，所以补列放这里（重复执行安全）。
ALTER TABLE oil_windows ADD COLUMN IF NOT EXISTS forecast_direction TEXT;

-- 查询用的索引
CREATE INDEX IF NOT EXISTS idx_history_region_date ON oil_price_history (region_code, date);
CREATE INDEX IF NOT EXISTS idx_history_fuel_date ON oil_price_history (fuel_id, date);
CREATE INDEX IF NOT EXISTS idx_notices_kind_execute ON oil_notices (kind, execute_at DESC);
CREATE INDEX IF NOT EXISTS idx_notices_review ON oil_notices (review_status);
CREATE INDEX IF NOT EXISTS idx_rules_user ON alert_rules (user_id);
CREATE INDEX IF NOT EXISTS idx_logs_user_time ON alert_logs (user_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_events_date ON oil_adjust_events (date);
