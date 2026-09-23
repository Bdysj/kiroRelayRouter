package cn.app.kiroproxy.protocol;

public enum ProtocolCode {
    OPENAI_CHAT_COMPLETIONS("/chat/completions"),
    OPENAI_RESPONSES("/responses"),
    ANTHROPIC_MESSAGES("/messages");

    private final String defaultPath;

    ProtocolCode(String defaultPath) { this.defaultPath = defaultPath; }

    public String defaultPath() { return defaultPath; }
}
