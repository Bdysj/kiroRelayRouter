ALTER TABLE public.relay_model
    ADD COLUMN reasoning_levels character varying(128) DEFAULT ''::character varying NOT NULL,
    ADD COLUMN reasoning_default_level character varying(16);

ALTER TABLE public.relay_model
    ADD CONSTRAINT ck_relay_model_reasoning_default CHECK (reasoning_default_level IS NULL
        OR reasoning_default_level IN ('low', 'medium', 'high', 'xhigh', 'max'));

COMMENT ON COLUMN public.relay_model.reasoning_levels IS
    '向 Kiro 声明的推理强度档位，逗号分隔的小写值（low,medium,high,xhigh,max）；留空表示该模型不支持思考强度，Kiro 不渲染档位下拉框';
COMMENT ON COLUMN public.relay_model.reasoning_default_level IS
    '档位下拉框的默认选中项，必须出现在 reasoning_levels 中；留空则取最低档';
