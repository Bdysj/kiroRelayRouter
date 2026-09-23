package cn.app.kiroproxy.config;

public record RelayModel(String modelId, String displayName, long maxInputTokens, long maxOutputTokens) {
    public RelayModel(String modelId, String displayName) {
        this(modelId, displayName, 1_000_000L, 128_000L);
    }
}
