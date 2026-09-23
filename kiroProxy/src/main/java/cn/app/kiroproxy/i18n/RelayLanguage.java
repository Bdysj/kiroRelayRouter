package cn.app.kiroproxy.i18n;

/** Language helpers for user-facing RelayRouter API responses. */
public final class RelayLanguage {
    public static final String EN = "en";
    public static final String ZH = "zh";

    private RelayLanguage() {}

    public static String normalize(String language) {
        return language != null && language.trim().toLowerCase(java.util.Locale.ROOT).startsWith(ZH) ? ZH : EN;
    }

    public static boolean english(String language) {
        return EN.equals(normalize(language));
    }

    public static String text(String language, String chinese, String english) {
        return english(language) ? english : chinese;
    }

    public static String requestId(String language, String requestId) {
        return text(language, "\n请求编号：", "\nRequest ID: ") + requestId;
    }
}
