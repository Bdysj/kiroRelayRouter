package cn.app.kiroproxy.docs;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

@Service
public class DocsService {
    // Versioned so database migrations that normalize slugs cannot be masked by stale Redis data.
    private static final String CACHE_KEY = "docs:published:v4";
    private static final Pattern SLUG = Pattern.compile("[a-z0-9]+(?:-[a-z0-9]+)*");
    private static final Set<String> STATUSES = Set.of("DRAFT", "PUBLISHED");

    private final JdbcTemplate jdbc;
    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;
    private final DocsAssetService assets;

    public DocsService(JdbcTemplate jdbc, StringRedisTemplate redis, ObjectMapper objectMapper,
                       DocsAssetService assets) {
        this.jdbc = jdbc;
        this.redis = redis;
        this.objectMapper = objectMapper;
        this.assets = assets;
    }

    public DocsView publishedDocs() {
        try {
            String cached = redis.opsForValue().get(CACHE_KEY);
            if (cached != null) return objectMapper.readValue(cached, DocsView.class);
        } catch (Exception ignored) {
            // Redis is an optimization; documentation remains available without it.
        }
        DocsView docs = load(true);
        try {
            redis.opsForValue().set(CACHE_KEY, objectMapper.writeValueAsString(docs));
        } catch (Exception ignored) {
            // PostgreSQL remains the source of truth.
        }
        return docs;
    }

    public DocsView adminDocs() {
        return load(false);
    }

    private DocsView load(boolean publishedOnly) {
        String categorySql = "select id,title,sort_order,enabled,created_at,updated_at "
                + "from relay_doc_category " + (publishedOnly ? "where enabled=true " : "")
                + "order by sort_order,id";
        List<CategoryView> categories = jdbc.query(categorySql, this::categoryRow);
        if (categories.isEmpty()) return new DocsView("Kiro RelayRouter 使用教程", null, categories);

        String articleSql = "select id,category_id,title,slug,content_html,sort_order,status,published_at,created_at,updated_at "
                + "from relay_doc_article " + (publishedOnly ? "where status='PUBLISHED' " : "")
                + "order by category_id,sort_order,id";
        List<ArticleView> articles = jdbc.query(articleSql, this::articleRow);
        Map<Long, List<ArticleView>> grouped = new LinkedHashMap<>();
        Instant updatedAt = null;
        for (ArticleView article : articles) {
            grouped.computeIfAbsent(article.categoryId(), ignored -> new ArrayList<>()).add(article);
            if (updatedAt == null || article.updatedAt().isAfter(updatedAt)) updatedAt = article.updatedAt();
        }
        List<CategoryView> populated = categories.stream()
                .map(category -> category.withChildren(grouped.getOrDefault(category.id(), List.of())))
                .filter(category -> !publishedOnly || !category.children().isEmpty())
                .toList();
        return new DocsView("Kiro RelayRouter 使用教程", updatedAt, populated);
    }

    @Transactional
    public CategoryView createCategory(CategoryInput input) {
        var keys = new GeneratedKeyHolder();
        jdbc.update(connection -> {
            var statement = connection.prepareStatement(
                    "insert into relay_doc_category(title,sort_order,enabled) values (?,?,?)", new String[]{"id"});
            statement.setString(1, required(input.title(), "目录名称"));
            statement.setInt(2, input.sortOrder());
            statement.setBoolean(3, input.enabled());
            return statement;
        }, keys);
        long id = generatedId(keys);
        invalidate();
        return category(id);
    }

    @Transactional
    public CategoryView updateCategory(long id, CategoryInput input) {
        int changed = jdbc.update("update relay_doc_category set title=?,sort_order=?,enabled=?,updated_at=current_timestamp where id=?",
                required(input.title(), "目录名称"), input.sortOrder(), input.enabled(), id);
        if (changed == 0) throw notFound("目录");
        invalidate();
        return category(id);
    }

    @Transactional
    public void deleteCategory(long id) {
        List<String> articleContents = jdbc.queryForList(
                "select content_html from relay_doc_article where category_id=?", String.class, id);
        for (String content : articleContents) assets.deleteArticleMedia(content);
        if (jdbc.update("delete from relay_doc_category where id=?", id) == 0) throw notFound("目录");
        invalidate();
    }

    @Transactional
    public ArticleView createArticle(ArticleInput input) {
        validateArticle(input);
        String slug = resolvedNewSlug(input.slug());
        try {
            var keys = new GeneratedKeyHolder();
            jdbc.update(connection -> {
                var statement = connection.prepareStatement(
                        "insert into relay_doc_article(category_id,title,slug,content_html,sort_order,status,published_at) "
                                + "values (?,?,?,?,?,?,case when ?='PUBLISHED' then current_timestamp else null end)",
                        new String[]{"id"});
                statement.setLong(1, input.categoryId());
                statement.setString(2, required(input.title(), "文章标题"));
                statement.setString(3, slug);
                statement.setString(4, input.contentHtml() == null ? "" : input.contentHtml());
                statement.setInt(5, input.sortOrder());
                statement.setString(6, input.status());
                statement.setString(7, input.status());
                return statement;
            }, keys);
            long id = generatedId(keys);
            assets.reconcileArticleMedia("", input.contentHtml(), input.uploadSessionId());
            invalidate();
            return article(id);
        } catch (DuplicateKeyException error) {
            throw conflictSlug();
        }
    }

    @Transactional
    public ArticleView updateArticle(long id, ArticleInput input) {
        validateArticle(input);
        List<String> existingContent = jdbc.queryForList(
                "select content_html from relay_doc_article where id=?", String.class, id);
        if (existingContent.isEmpty()) throw notFound("文章");
        String articleSlug;
        if (input.slug() == null || input.slug().isBlank()) {
            List<String> current = jdbc.queryForList("select slug from relay_doc_article where id=?", String.class, id);
            if (current.isEmpty()) throw notFound("文章");
            articleSlug = current.get(0);
        } else {
            validateSlug(input.slug());
            articleSlug = input.slug();
        }
        try {
            int changed = jdbc.update("update relay_doc_article set category_id=?,title=?,slug=?,content_html=?,sort_order=?,status=?,"
                            + "published_at=case when ?='PUBLISHED' then coalesce(published_at,current_timestamp) else null end,updated_at=current_timestamp where id=?",
                    input.categoryId(), required(input.title(), "文章标题"), articleSlug,
                    input.contentHtml() == null ? "" : input.contentHtml(), input.sortOrder(), input.status(), input.status(), id);
            if (changed == 0) throw notFound("文章");
            assets.reconcileArticleMedia(existingContent.get(0), input.contentHtml(), input.uploadSessionId());
            invalidate();
            return article(id);
        } catch (DuplicateKeyException error) {
            throw conflictSlug();
        }
    }

    @Transactional
    public ArticleView publish(long id) {
        if (jdbc.update("update relay_doc_article set status='PUBLISHED',published_at=coalesce(published_at,current_timestamp),updated_at=current_timestamp where id=?", id) == 0) {
            throw notFound("文章");
        }
        invalidate();
        return article(id);
    }

    @Transactional
    public void deleteArticle(long id) {
        List<String> existingContent = jdbc.queryForList(
                "select content_html from relay_doc_article where id=?", String.class, id);
        if (existingContent.isEmpty()) throw notFound("文章");
        assets.deleteArticleMedia(existingContent.get(0));
        if (jdbc.update("delete from relay_doc_article where id=?", id) == 0) throw notFound("文章");
        invalidate();
    }

    private void validateArticle(ArticleInput input) {
        if (!STATUSES.contains(input.status())) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "文章状态无效");
        Integer exists = jdbc.queryForObject("select count(*) from relay_doc_category where id=?", Integer.class, input.categoryId());
        if (exists == null || exists == 0) throw notFound("所属目录");
    }

    private CategoryView category(long id) {
        List<CategoryView> rows = jdbc.query("select id,title,sort_order,enabled,created_at,updated_at from relay_doc_category where id=?", this::categoryRow, id);
        if (rows.isEmpty()) throw notFound("目录");
        return rows.get(0);
    }

    private ArticleView article(long id) {
        List<ArticleView> rows = jdbc.query("select id,category_id,title,slug,content_html,sort_order,status,published_at,created_at,updated_at from relay_doc_article where id=?", this::articleRow, id);
        if (rows.isEmpty()) throw notFound("文章");
        return rows.get(0);
    }

    private CategoryView categoryRow(ResultSet rs, int row) throws SQLException {
        return new CategoryView(rs.getLong("id"), rs.getString("title"),
                rs.getInt("sort_order"), rs.getBoolean("enabled"), instant(rs, "created_at"),
                instant(rs, "updated_at"), List.of());
    }

    private ArticleView articleRow(ResultSet rs, int row) throws SQLException {
        return new ArticleView(rs.getLong("id"), rs.getLong("category_id"), rs.getString("title"),
                rs.getString("slug"), rs.getString("content_html"), rs.getInt("sort_order"),
                rs.getString("status"), nullableInstant(rs, "published_at"), instant(rs, "created_at"), instant(rs, "updated_at"));
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        return rs.getTimestamp(column).toInstant();
    }

    private static Instant nullableInstant(ResultSet rs, String column) throws SQLException {
        Timestamp value = rs.getTimestamp(column);
        return value == null ? null : value.toInstant();
    }

    private void invalidate() {
        try { redis.delete(CACHE_KEY); } catch (Exception ignored) { }
    }

    private static void validateSlug(String slug) {
        if (slug == null || !SLUG.matcher(slug).matches()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Slug 只能包含小写字母、数字和连字符");
        }
    }

    private static String resolvedNewSlug(String slug) {
        if (slug == null || slug.isBlank()) return "article-" + UUID.randomUUID().toString().substring(0, 8);
        validateSlug(slug);
        return slug;
    }

    private static String required(String value, String label) {
        if (value == null || value.isBlank()) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, label + "不能为空");
        return value.trim();
    }

    private static ResponseStatusException notFound(String name) {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, name + "不存在");
    }

    private static ResponseStatusException conflictSlug() {
        return new ResponseStatusException(HttpStatus.CONFLICT, "Slug 已存在");
    }

    private static long generatedId(GeneratedKeyHolder keys) {
        Number key = keys.getKey();
        if (key == null) throw new IllegalStateException("无法获取新建内容 ID");
        return key.longValue();
    }

    public record DocsView(String title, Instant updatedAt, List<CategoryView> sections) {}
    public record CategoryView(long id, String title, int sortOrder, boolean enabled,
                               Instant createdAt, Instant updatedAt, List<ArticleView> children) {
        CategoryView withChildren(List<ArticleView> value) {
            return new CategoryView(id, title, sortOrder, enabled, createdAt, updatedAt, value);
        }
    }
    public record ArticleView(long id, long categoryId, String title, String slug, String contentHtml,
                              int sortOrder, String status, Instant publishedAt, Instant createdAt, Instant updatedAt) {}
    public record CategoryInput(String title, int sortOrder, boolean enabled) {}
    public record ArticleInput(long categoryId, String title, String slug, String contentHtml, int sortOrder,
                               String status, String uploadSessionId) {}
}
