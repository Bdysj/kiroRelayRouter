package cn.app.kiroproxy.proxy;

import static org.assertj.core.api.Assertions.assertThat;
import cn.app.kiroproxy.protocol.OpenAiResponsesAdapter;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

class KiroProtocolToolHistoryTest {
    private final ObjectMapper mapper = new ObjectMapper();

    @Test void toolOutputsPrecedeUserTextInHistoryAndCurrentTurn() throws Exception {
        var body = mapper.readTree("""
            {"conversationState":{"history":[
              {"userInputMessage":{"content":"read file"}},
              {"assistantResponseMessage":{"content":"","toolUses":[{
                "toolUseId":"call-1","name":"read","input":{"path":"a.txt"}}]}},
              {"userInputMessage":{"content":"continue","userInputMessageContext":{"toolResults":[{
                "toolUseId":"call-1","content":[{"text":"first output"}]}]}}},
              {"assistantResponseMessage":{"content":"","toolUses":[{
                "toolUseId":"call-2","name":"read","input":{"path":"b.txt"}}]}}
             ],"currentMessage":{"userInputMessage":{"content":"now summarize","userInputMessageContext":{
               "toolResults":[{"toolUseId":"call-2","content":[{"json":{"result":"second output"}}]}]}}}}}
            """);
        var canonical = KiroProtocol.translateRequest(mapper, body, "gpt-6.1-sol");
        assertThat(canonical.path("messages")).extracting(node -> node.path("role").asText())
                .containsExactly("user", "assistant", "tool", "user", "assistant", "tool", "user");
        var input = new OpenAiResponsesAdapter().encode(mapper, canonical).path("input");
        assertThat(input.path(1).path("type").asText()).isEqualTo("function_call");
        assertThat(input.path(2).path("call_id").asText()).isEqualTo("call-1");
        assertThat(input.path(4).path("call_id").asText()).isEqualTo("call-2");
        assertThat(input.path(5).path("call_id").asText()).isEqualTo("call-2");
        assertThat(input.path(5).path("output").asText()).isEqualTo("{\"result\":\"second output\"}");
    }

    @Test void toolOnlyTurnsDoNotInventEmptyUserMessages() throws Exception {
        var body = mapper.readTree("""
            {"conversationState":{"history":[
              {"assistantResponseMessage":{"toolUses":[{"toolUseId":"call-1","name":"read","input":{}}]}},
              {"userInputMessage":{"content":"","userInputMessageContext":{"toolResults":[{
                "toolUseId":"call-1","content":[{"text":"OK"}]}]}}}
              ],"currentMessage":{"userInputMessage":{"content":"","userInputMessageContext":{
                "toolResults":[{"toolUseId":"call-2","content":[{"text":"OK"}]}]}}}}}
            """);
        var canonical = KiroProtocol.translateRequest(mapper, body, "gpt-6.1-sol");
        assertThat(canonical.path("messages")).extracting(node -> node.path("role").asText())
                .containsExactly("assistant", "tool", "tool");
    }
}
