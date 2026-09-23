package cn.app.kiroproxy.config;

import java.util.List;

public record RelayConfiguration(boolean enabled, String baseUrl, String apiKey, List<RelayModel> models) {
    public RelayModel defaultModel() {
        return models.isEmpty() ? null : models.get(0);
    }
}
