-- 放开价格字段的小数精度：numeric(20,8) -> numeric(30,12)。
-- 中转站实际成本价常见于「每 1M Token 报价」，在按单 Token 折算或小额分成场景下 8 位小数会被四舍五入，
-- 这里统一提升到 12 位小数，并保持 18 位整数位（30 - 12），足以覆盖任何合法报价。
-- numeric 放宽精度与标度是无损变更：已有数据按原值保留，仅补齐尾部的 0。

-- 1) 中转站 × 模型 的实际成本价阶梯（前端「实际中转价格」编辑的就是这张表）
ALTER TABLE public.relay_configuration_model_pricing
    ALTER COLUMN input_price TYPE numeric(30,12),
    ALTER COLUMN cache_input_price TYPE numeric(30,12),
    ALTER COLUMN cache_write_input_price TYPE numeric(30,12),
    ALTER COLUMN output_price TYPE numeric(30,12);

-- 2) 平台统一模型的官方参考价阶梯
ALTER TABLE public.relay_model_pricing
    ALTER COLUMN input_price TYPE numeric(30,12),
    ALTER COLUMN cache_input_price TYPE numeric(30,12),
    ALTER COLUMN cache_write_input_price TYPE numeric(30,12),
    ALTER COLUMN output_price TYPE numeric(30,12);

-- 3) 用量流水里的价格快照。必须同步放宽，否则高精度价格在计费落库时会被截断，
--    导致流水中的单价与配置的单价不一致。
ALTER TABLE public.relay_usage_record
    ALTER COLUMN input_price TYPE numeric(30,12),
    ALTER COLUMN cache_input_price TYPE numeric(30,12),
    ALTER COLUMN cache_write_input_price TYPE numeric(30,12),
    ALTER COLUMN output_price TYPE numeric(30,12);

COMMENT ON COLUMN public.relay_configuration_model_pricing.input_price IS
    '输入价，按 pricing_unit 计价，最多 12 位小数';
COMMENT ON COLUMN public.relay_configuration_model_pricing.cache_input_price IS
    '缓存读取价，按 pricing_unit 计价，最多 12 位小数';
COMMENT ON COLUMN public.relay_configuration_model_pricing.cache_write_input_price IS
    '缓存写入价，按 pricing_unit 计价，最多 12 位小数';
COMMENT ON COLUMN public.relay_configuration_model_pricing.output_price IS
    '输出价，按 pricing_unit 计价，最多 12 位小数';
