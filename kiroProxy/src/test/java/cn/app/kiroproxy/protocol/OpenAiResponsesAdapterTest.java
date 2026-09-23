package cn.app.kiroproxy.protocol;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import org.junit.jupiter.api.Test;

class OpenAiResponsesAdapterTest {
    private final ObjectMapper mapper = new ObjectMapper();
    private final OpenAiResponsesAdapter adapter = new OpenAiResponsesAdapter();

    @Test
    void preservesIncompleteReasonInsteadOfReportingSuccessfulStop() throws Exception {
        String data = "{\"type\":\"response.incomplete\",\"response\":{\"model\":\"gpt-test\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"usage\":{\"input_tokens\":10,\"output_tokens\":20}}}";

        List<CanonicalStreamEvent> events = adapter.decode(mapper, "response.incomplete", data);

        assertThat(events).extracting(CanonicalStreamEvent::type)
                .containsExactly(CanonicalStreamEvent.Type.USAGE, CanonicalStreamEvent.Type.MODEL,
                        CanonicalStreamEvent.Type.FINISH, CanonicalStreamEvent.Type.DONE);
        assertThat(events.get(2).finishReason()).isEqualTo("max_output_tokens");
    }

    @Test
    void completedResponseStillReportsNormalStop() throws Exception {
        String data = "{\"type\":\"response.completed\",\"response\":{\"model\":\"gpt-test\"}}";

        List<CanonicalStreamEvent> events = adapter.decode(mapper, "response.completed", data);

        assertThat(events).extracting(CanonicalStreamEvent::type)
                .containsExactly(CanonicalStreamEvent.Type.MODEL, CanonicalStreamEvent.Type.FINISH,
                        CanonicalStreamEvent.Type.DONE);
        assertThat(events.get(1).finishReason()).isEqualTo("stop");
    }
}
