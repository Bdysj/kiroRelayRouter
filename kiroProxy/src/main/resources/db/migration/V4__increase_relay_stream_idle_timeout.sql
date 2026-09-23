ALTER TABLE public.relay_configuration
    ALTER COLUMN read_timeout_ms SET DEFAULT 600000;

-- Only migrate the former product default; preserve administrator-selected values.
UPDATE public.relay_configuration
SET read_timeout_ms = 600000,
    updated_at = CURRENT_TIMESTAMP,
    version = version + 1
WHERE read_timeout_ms = 120000;

COMMENT ON COLUMN public.relay_configuration.read_timeout_ms IS
    '上游流式请求的无数据空闲超时，单位毫秒';
