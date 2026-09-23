ALTER TABLE public.relay_model
    ADD COLUMN max_input_tokens BIGINT NOT NULL DEFAULT 1000000,
    ADD COLUMN max_output_tokens BIGINT NOT NULL DEFAULT 128000;

ALTER TABLE public.relay_model
    ADD CONSTRAINT relay_model_max_input_tokens_positive CHECK (max_input_tokens > 0),
    ADD CONSTRAINT relay_model_max_output_tokens_positive CHECK (max_output_tokens > 0);

COMMENT ON COLUMN public.relay_model.max_input_tokens IS
    '向 Kiro 模型元数据声明的最大上下文窗口 Token 数';
COMMENT ON COLUMN public.relay_model.max_output_tokens IS
    '向 Kiro 模型元数据声明的单次最大输出 Token 数';
