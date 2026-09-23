package cn.app.kiroproxy.docs;

import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.net.URI;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.imageio.ImageIO;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.PutObjectRequest;

@Service
public class DocsAssetService {
    private static final Logger log = LoggerFactory.getLogger(DocsAssetService.class);
    private static final long MAX_SIZE = 10L * 1024 * 1024;
    private static final Duration PENDING_TTL = Duration.ofHours(12);
    private static final String CLEANUP_QUEUE = "docs:media:cleanup";
    private static final String SESSION_PREFIX = "docs:media:session:";
    private static final Pattern IMAGE_SRC = Pattern.compile("<img\\b[^>]*?\\bsrc\\s*=\\s*(['\"])(.*?)\\1", Pattern.CASE_INSENSITIVE);
    private static final Pattern SESSION_ID = Pattern.compile("[a-zA-Z0-9_-]{8,80}");
    private static final Set<String> IMAGE_TYPES = Set.of("image/png", "image/jpeg", "image/gif", "image/webp");

    private final JdbcTemplate jdbc;
    private final StringRedisTemplate redis;
    private final String bucket;
    private final String publicBaseUrl;
    private final S3Client s3;

    public DocsAssetService(
            JdbcTemplate jdbc,
            StringRedisTemplate redis,
            @Value("${cloudflare.r2.endpoint:}") String endpoint,
            @Value("${cloudflare.r2.access-key-id:}") String accessKey,
            @Value("${cloudflare.r2.secret-access-key:}") String secretKey,
            @Value("${cloudflare.r2.bucket:}") String bucket,
            @Value("${cloudflare.r2.public-base-url:}") String publicBaseUrl,
            @Value("${cloudflare.r2.region:auto}") String region) {
        this.jdbc = jdbc;
        this.redis = redis;
        this.bucket = bucket;
        this.publicBaseUrl = publicBaseUrl.replaceAll("/+$", "");
        this.s3 = endpoint.isBlank() || accessKey.isBlank() || secretKey.isBlank() ? null : S3Client.builder()
                .endpointOverride(URI.create(endpoint))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(accessKey, secretKey)))
                .region(Region.of(region))
                .forcePathStyle(true)
                .build();
    }

    public AssetView upload(MultipartFile file, Long articleId, String uploadSessionId) {
        if (file.isEmpty()) throw badRequest("请选择图片");
        if (file.getSize() > MAX_SIZE) throw badRequest("图片不能超过 10MB");
        String contentType = file.getContentType() == null ? "" : file.getContentType().toLowerCase(Locale.ROOT);
        if (!IMAGE_TYPES.contains(contentType)) throw badRequest("仅支持 PNG、JPEG、GIF 和 WebP 图片");
        if (uploadSessionId == null || !SESSION_ID.matcher(uploadSessionId).matches()) throw badRequest("图片上传会话无效");
        requireR2();
        if (articleId != null) {
            Integer count = jdbc.queryForObject("select count(*) from relay_doc_article where id=?", Integer.class, articleId);
            if (count == null || count == 0) throw new ResponseStatusException(HttpStatus.NOT_FOUND, "文章不存在");
        }

        byte[] bytes;
        try { bytes = file.getBytes(); }
        catch (Exception error) { throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "无法读取图片", error); }
        String hash = sha256(bytes);
        List<AssetView> duplicate = findByHash(hash);
        if (!duplicate.isEmpty()) {
            AssetView existing = duplicate.get(0);
            if (existing.status() == 0) schedulePending(existing.key(), uploadSessionId);
            return existing;
        }

        String original = file.getOriginalFilename() == null ? "clipboard-image.png" : file.getOriginalFilename();
        String safeName = original.replaceAll("[^a-zA-Z0-9._-]", "-").replaceAll("-+", "-");
        if (safeName.isBlank()) safeName = "image";
        LocalDate now = LocalDate.now(ZoneOffset.UTC);
        String key = "relayrouter/docs/%04d/%02d/%s-%s".formatted(now.getYear(), now.getMonthValue(), UUID.randomUUID(), safeName);
        try {
            s3.putObject(PutObjectRequest.builder().bucket(bucket).key(key).contentType(contentType).build(), RequestBody.fromBytes(bytes));
        } catch (Exception error) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "图片上传到 R2 失败", error);
        }

        int[] dimensions = dimensions(bytes);
        String url = publicBaseUrl + "/" + key;
        try {
            var keys = new GeneratedKeyHolder();
            jdbc.update(connection -> {
                var statement = connection.prepareStatement("""
                        insert into r2_media_files(object_key,original_filename,content_type,file_size,content_hash,width,height,status,ref_count)
                        values (?,?,?,?,?,?,?,0,0)
                        """, new String[]{"id"});
                statement.setString(1, key);
                statement.setString(2, original);
                statement.setString(3, contentType);
                statement.setLong(4, bytes.length);
                statement.setString(5, hash);
                if (dimensions[0] < 0) statement.setNull(6, java.sql.Types.INTEGER); else statement.setInt(6, dimensions[0]);
                if (dimensions[1] < 0) statement.setNull(7, java.sql.Types.INTEGER); else statement.setInt(7, dimensions[1]);
                return statement;
            }, keys);
            Number id = keys.getKey();
            if (id == null) throw new IllegalStateException("无法获取媒体 ID");
            schedulePending(key, uploadSessionId);
            return new AssetView(id.longValue(), url, key, original, contentType, bytes.length,
                    hash, nullableDimension(dimensions[0]), nullableDimension(dimensions[1]), 0, 0);
        } catch (DuplicateKeyException race) {
            deleteFromR2(key);
            List<AssetView> existing = findByHash(hash);
            if (existing.isEmpty()) throw race;
            if (existing.get(0).status() == 0) schedulePending(existing.get(0).key(), uploadSessionId);
            return existing.get(0);
        }
    }

    public void reconcileArticleMedia(String oldHtml, String newHtml, String uploadSessionId) {
        Set<String> oldKeys = objectKeys(oldHtml);
        Set<String> newKeys = objectKeys(newHtml);
        Set<String> added = new HashSet<>(newKeys);
        added.removeAll(oldKeys);
        Set<String> removed = new HashSet<>(oldKeys);
        removed.removeAll(newKeys);
        for (String key : added) {
            jdbc.update("update r2_media_files set status=1,ref_count=ref_count+1,updated_at=current_timestamp where object_key=?", key);
            removePending(key);
        }
        for (String key : newKeys) removePending(key);
        for (String key : removed) {
            jdbc.update("""
                    update r2_media_files set ref_count=greatest(ref_count-1,0),
                      status=case when ref_count <= 1 then 0 else 1 end,updated_at=current_timestamp
                    where object_key=?
                    """, key);
            Integer unused = jdbc.queryForObject("select count(*) from r2_media_files where object_key=? and status=0 and ref_count=0", Integer.class, key);
            if (unused != null && unused > 0) schedulePending(key, uploadSessionId == null ? "saved-edit" : uploadSessionId);
        }
        if (uploadSessionId != null && SESSION_ID.matcher(uploadSessionId).matches()) {
            try { redis.delete(SESSION_PREFIX + uploadSessionId); } catch (Exception ignored) { }
        }
    }

    /**
     * Releases every R2 image referenced by a physically deleted article.
     * Shared/deduplicated images are only removed from R2 after their final
     * article reference has gone away.
     */
    public void deleteArticleMedia(String html) {
        for (String key : objectKeys(html)) {
            jdbc.update("""
                    update r2_media_files set ref_count=greatest(ref_count-1,0),
                      status=case when ref_count <= 1 then 0 else 1 end,updated_at=current_timestamp
                    where object_key=?
                    """, key);
            cleanupOne(key);
        }
    }

    /**
     * Deliberately not transactional: this walks R2 over the network, and
     * holding a database transaction across those calls would both pin a
     * connection for the whole batch and let one unreachable object roll back
     * the rows already cleaned up, leaving records that point at objects R2 has
     * already dropped. Each key is claimed and finished on its own instead, so
     * one failure only costs that key and the next run retries it.
     */
    @Scheduled(fixedDelayString = "${kiro.docs.media-cleanup-delay-ms:60000}")
    public void cleanupExpiredMedia() {
        if (s3 == null) return;
        Set<String> candidates = new HashSet<>();
        try {
            Set<String> expired = redis.opsForZSet().rangeByScore(CLEANUP_QUEUE, 0, Instant.now().toEpochMilli(), 0, 100);
            if (expired != null) candidates.addAll(expired);
        } catch (Exception ignored) { }
        candidates.addAll(jdbc.queryForList("""
                select object_key from r2_media_files
                where status=0 and ref_count=0 and updated_at < current_timestamp - interval '12 hours'
                order by updated_at limit 100
                """, String.class));
        for (String key : candidates) {
            try {
                cleanupOne(key);
            } catch (RuntimeException error) {
                log.warn("orphan media cleanup failed key={} reason={}", key, error.getClass().getSimpleName());
            }
        }
    }

    /**
     * The delete of the {@code r2_media_files} row is the claim rather than a
     * separate check, because {@code object_key} is unique: exactly one caller
     * can report a deleted row, so exactly one caller goes on to delete the R2
     * object. Two instances polling the same database therefore never issue
     * competing deletes for one object, and a still-referenced image is left
     * alone by the same predicate as before.
     * <p>
     * The row is removed before the object on purpose. If R2 then refuses, the
     * object is orphaned but nothing in the database still points at it, which
     * is the cheaper of the two inconsistencies.
     */
    private void cleanupOne(String key) {
        int claimed = jdbc.update("delete from r2_media_files where object_key=? and status=0 and ref_count=0", key);
        if (claimed == 0) { removePending(key); return; }
        jdbc.update("delete from relay_doc_asset where object_key=?", key);
        deleteFromR2(key);
        removePending(key);
    }

    private Set<String> objectKeys(String html) {
        Set<String> result = new HashSet<>();
        if (html == null || html.isBlank() || publicBaseUrl.isBlank()) return result;
        Matcher matcher = IMAGE_SRC.matcher(html);
        String prefix = publicBaseUrl + "/";
        while (matcher.find()) if (matcher.group(2).startsWith(prefix)) result.add(matcher.group(2).substring(prefix.length()));
        return result;
    }

    private void schedulePending(String key, String sessionId) {
        long expiresAt = Instant.now().plus(PENDING_TTL).toEpochMilli();
        try {
            redis.opsForZSet().add(CLEANUP_QUEUE, key, expiresAt);
            String sessionKey = SESSION_PREFIX + sessionId;
            redis.opsForSet().add(sessionKey, key);
            redis.expire(sessionKey, PENDING_TTL);
        } catch (Exception ignored) { }
    }

    private void removePending(String key) {
        try { redis.opsForZSet().remove(CLEANUP_QUEUE, key); } catch (Exception ignored) { }
    }

    private List<AssetView> findByHash(String hash) {
        return jdbc.query("""
                select id,object_key,original_filename,content_type,file_size,content_hash,width,height,status,ref_count
                from r2_media_files where content_hash=?
                """, (rs, row) -> new AssetView(rs.getLong("id"), publicBaseUrl + "/" + rs.getString("object_key"),
                rs.getString("object_key"), rs.getString("original_filename"), rs.getString("content_type"),
                rs.getLong("file_size"), rs.getString("content_hash"), (Integer) rs.getObject("width"),
                (Integer) rs.getObject("height"), rs.getInt("status"), rs.getInt("ref_count")), hash);
    }

    private void deleteFromR2(String key) {
        requireR2();
        try { s3.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(key).build()); }
        catch (Exception error) { throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "R2 孤立图片删除失败", error); }
    }

    private void requireR2() {
        if (s3 == null || bucket.isBlank() || publicBaseUrl.isBlank())
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "R2 对象存储尚未配置");
    }

    private static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (Exception impossible) { throw new IllegalStateException("无法计算图片哈希", impossible); }
    }

    private static int[] dimensions(byte[] bytes) {
        try {
            BufferedImage image = ImageIO.read(new ByteArrayInputStream(bytes));
            return image == null ? new int[]{-1, -1} : new int[]{image.getWidth(), image.getHeight()};
        } catch (Exception ignored) { return new int[]{-1, -1}; }
    }

    private static Integer nullableDimension(int value) { return value < 0 ? null : value; }
    private static ResponseStatusException badRequest(String message) { return new ResponseStatusException(HttpStatus.BAD_REQUEST, message); }

    public record AssetView(long id, String url, String key, String originalFilename, String contentType,
                            long fileSize, String contentHash, Integer width, Integer height, int status, int refCount) {}
}
