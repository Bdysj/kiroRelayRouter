package cn.app.kiroproxy.protocol;

import java.net.URI;
import java.util.List;

/** CC Switch-style OpenAI URL joining, shared by production traffic and protocol probes. */
public final class UpstreamUrl {
    private UpstreamUrl() {}

    public static URI resolve(String baseUrl, RelayProtocol protocol) {
        URI base = URI.create(baseUrl.trim());
        URI endpoint = URI.create(protocol.path());
        if (base.getHost() == null || !("https".equalsIgnoreCase(base.getScheme())
                || "http".equalsIgnoreCase(base.getScheme())) || base.getRawUserInfo() != null
                || base.getRawFragment() != null || endpoint.isAbsolute()
                || endpoint.getRawAuthority() != null || endpoint.getRawFragment() != null) {
            throw new IllegalArgumentException("Invalid upstream base URL or protocol path");
        }
        String path = base.getRawPath().replaceFirst("/+$", "");
        String suffix = endpoint.getRawPath();
        if (suffix == null || suffix.isBlank()) throw new IllegalArgumentException("Empty protocol path");
        suffix = "/" + suffix.replaceFirst("^/+", "");
        boolean openAi = protocol.code() != ProtocolCode.ANTHROPIC_MESSAGES;
        if (openAi) {
            // Also accept a pasted full OpenAI endpoint, without appending /responses twice.
            for (String terminal : List.of("/responses/compact", "/chat/completions", "/responses", "/models")) {
                if (path.endsWith(terminal)) {
                    path = path.substring(0, path.length() - terminal.length());
                    break;
                }
            }
            if (path.isEmpty() && (protocol.pathOverride() == null || protocol.pathOverride().isBlank())) {
                path = "/v1";
            }
        }
        if (path.endsWith("/v1") && (suffix.equals("/v1") || suffix.startsWith("/v1/"))) {
            suffix = suffix.substring(3);
        }
        String query = base.getRawQuery();
        if (endpoint.getRawQuery() != null) {
            query = query == null || query.isEmpty() ? endpoint.getRawQuery() : query + "&" + endpoint.getRawQuery();
        }
        return URI.create(base.getScheme() + "://" + base.getRawAuthority() + path + suffix
                + (query == null ? "" : "?" + query));
    }
}
