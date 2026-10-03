package cn.app.kiroproxy.protocol;

import static org.assertj.core.api.Assertions.*;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

class UpstreamUrlTest {
    @ParameterizedTest
    @CsvSource({
        "https://relay.example, https://relay.example/v1/responses",
        "https://relay.example/, https://relay.example/v1/responses",
        "https://relay.example/v1, https://relay.example/v1/responses",
        "https://relay.example/v1/, https://relay.example/v1/responses",
        "https://relay.example/openai, https://relay.example/openai/responses",
        "https://relay.example/v1/responses, https://relay.example/v1/responses",
        "https://relay.example/v1/chat/completions, https://relay.example/v1/responses",
        "https://relay.example/v1/responses/compact, https://relay.example/v1/responses",
        "https://relay.example/v1?api-version=test, https://relay.example/v1/responses?api-version=test"
    })
    void matchesCcSwitchOpenAiBaseUrlSemantics(String base, String expected) {
        assertThat(UpstreamUrl.resolve(base, responses(null)).toString()).isEqualTo(expected);
    }

    @Test void preservesOverrideAndQueriesWithoutDoubleVersion() {
        assertThat(UpstreamUrl.resolve("https://relay.example/v1/?api-version=2026", responses("/v1/responses?mode=test")))
                .hasToString("https://relay.example/v1/responses?api-version=2026&mode=test");
        assertThat(UpstreamUrl.resolve("https://relay.example", responses("/custom/responses")))
                .hasToString("https://relay.example/custom/responses");
        assertThat(UpstreamUrl.resolve("https://relay.example/prefix%20path", responses(null)))
                .hasToString("https://relay.example/prefix%20path/responses");
    }

    @Test void doesNotRewriteExistingAnthropicPaths() {
        var anthropic = new RelayProtocol(0, ProtocolCode.ANTHROPIC_MESSAGES, true, 10, null,
                Set.of(), "UNVERIFIED", null, null);
        assertThat(UpstreamUrl.resolve("https://relay.example/v1/", anthropic))
                .hasToString("https://relay.example/v1/messages");
    }

    @Test void rejectsAbsoluteOverrideAndCredentialsInUrl() {
        assertThatIllegalArgumentException().isThrownBy(() -> UpstreamUrl.resolve(
                "https://relay.example/v1", responses("https://other.example/responses")));
        assertThatIllegalArgumentException().isThrownBy(() -> UpstreamUrl.resolve(
                "https://secret@relay.example/v1", responses(null)));
        assertThatIllegalArgumentException().isThrownBy(() -> UpstreamUrl.resolve(
                "https://relay.example/v1#fragment", responses(null)));
    }

    private RelayProtocol responses(String path) {
        return new RelayProtocol(0, ProtocolCode.OPENAI_RESPONSES, true, 10, path,
                Set.of(), "UNVERIFIED", null, null);
    }
}
