package cn.app.kiroproxy.config;

import cn.app.kiroproxy.protocol.ReasoningEffort;
import java.util.List;

public record RelayModel(String modelId, String displayName, long maxInputTokens, long maxOutputTokens,
                         List<ReasoningEffort> reasoningLevels, ReasoningEffort reasoningDefaultLevel) {

    public RelayModel {
        reasoningLevels = reasoningLevels == null ? List.of() : List.copyOf(reasoningLevels);
        // 默认档位必须落在可选档位里，否则 Kiro 会拿到一个不在 enum 中的 currentValue，
        // 下拉框会显示一个选不中的值。宁可退回最低档也不要不一致。
        if (reasoningDefaultLevel != null && !reasoningLevels.contains(reasoningDefaultLevel)) {
            reasoningDefaultLevel = null;
        }
    }

    public RelayModel(String modelId, String displayName) {
        this(modelId, displayName, 1_000_000L, 128_000L, List.of(), null);
    }

    public RelayModel(String modelId, String displayName, long maxInputTokens, long maxOutputTokens) {
        this(modelId, displayName, maxInputTokens, maxOutputTokens, List.of(), null);
    }

    /** 未声明任何档位即视为不支持思考强度，Kiro 不会渲染那个下拉框。 */
    public boolean reasoningSupported() {
        return !reasoningLevels.isEmpty();
    }

    /** 未显式配置默认档位时退回最低档，与 Kiro 自身的 {@code d[0]} 兜底保持一致。 */
    public ReasoningEffort effectiveDefaultLevel() {
        if (reasoningDefaultLevel != null) return reasoningDefaultLevel;
        return reasoningLevels.isEmpty() ? null : reasoningLevels.get(0);
    }
}
