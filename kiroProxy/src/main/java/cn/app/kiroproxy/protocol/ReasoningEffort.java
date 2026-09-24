package cn.app.kiroproxy.protocol;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.stream.Collectors;

/**
 * 推理强度档位。
 *
 * <p>线上值固定小写：Kiro 的聊天 UI 自己做显示层转换（{@code xhigh -> xHigh}，其余首字母大写），
 * 并且会把选中的原值回传到 {@code additionalModelRequestFields.reasoning.effort}，
 * 所以这里的 {@link #wire()} 必须与声明给 Kiro 的 {@code enum} 完全一致。
 *
 * <p>声明顺序即强度顺序（低 → 高），降级阶梯依赖这个次序。
 */
public enum ReasoningEffort {
    LOW, MEDIUM, HIGH, XHIGH, MAX;

    /**
     * canonical body 上承载推理强度的字段名。
     *
     * <p>刻意取成 OpenAI Chat Completions 的原生参数名，这样该协议的 adapter 靠
     * {@code deepCopy()} 就天然带上了，不需要额外映射。
     */
    public static final String CANONICAL_FIELD = "reasoning_effort";

    /** 协议线上值，全小写。 */
    public String wire() {
        return name().toLowerCase(Locale.ROOT);
    }

    public static Optional<ReasoningEffort> parse(String value) {
        if (value == null) return Optional.empty();
        String normalized = value.trim().toLowerCase(Locale.ROOT);
        if (normalized.isEmpty()) return Optional.empty();
        for (ReasoningEffort effort : values()) {
            if (effort.wire().equals(normalized)) return Optional.of(effort);
        }
        return Optional.empty();
    }

    /**
     * 解析数据库里的逗号分隔配置。
     *
     * <p>未知值直接忽略而不是抛异常：这条路径在请求链路上，历史脏数据或降级过的枚举
     * 不应该让整个模型列表拉取失败。写入侧（管理接口）才做严格校验。
     */
    public static List<ReasoningEffort> parseList(String csv) {
        if (csv == null || csv.isBlank()) return List.of();
        LinkedHashSet<ReasoningEffort> found = new LinkedHashSet<>();
        for (String part : csv.split(",")) parse(part).ifPresent(found::add);
        List<ReasoningEffort> ordered = new ArrayList<>(found);
        ordered.sort(Comparator.naturalOrder());
        return List.copyOf(ordered);
    }

    /**
     * 把请求档位夹到模型实际声明的档位集合里。
     *
     * <p>Kiro 窗口可能拿着过期的 schema（管理员刚缩减了档位），也可能把上一个模型记住的
     * 档位带到当前模型上，所以不能直接透传。取不超过请求值的最高档，请求值低于所有
     * 可选档时退回最低档；模型没声明任何档位则返回空表示不下发。
     */
    public static Optional<ReasoningEffort> clamp(ReasoningEffort requested, List<ReasoningEffort> allowed) {
        if (requested == null || allowed == null || allowed.isEmpty()) return Optional.empty();
        if (allowed.contains(requested)) return Optional.of(requested);
        ReasoningEffort best = null;
        for (ReasoningEffort candidate : allowed) {
            if (candidate.compareTo(requested) <= 0 && (best == null || candidate.compareTo(best) > 0)) {
                best = candidate;
            }
        }
        return Optional.of(best == null ? allowed.get(0) : best);
    }

    public static String format(List<ReasoningEffort> levels) {
        if (levels == null || levels.isEmpty()) return "";
        return levels.stream().sorted().distinct().map(ReasoningEffort::wire).collect(Collectors.joining(","));
    }
}
