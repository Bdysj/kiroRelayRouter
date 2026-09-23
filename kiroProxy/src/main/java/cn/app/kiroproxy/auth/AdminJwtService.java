package cn.app.kiroproxy.auth;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import javax.crypto.SecretKey;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class AdminJwtService {
    private final SecretKey key;
    private final Duration expiration;

    public AdminJwtService(
            @Value("${kiro.admin.jwt-secret}") String secret,
            @Value("${kiro.admin.jwt-expiration:12h}") Duration expiration) {
        if (secret == null || secret.getBytes(StandardCharsets.UTF_8).length < 32) {
            throw new IllegalArgumentException("kiro.admin.jwt-secret 至少需要 32 字节");
        }
        this.key = Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
        this.expiration = expiration;
    }

    public IssuedJwt issue(String username) {
        Instant now = Instant.now();
        Instant expiresAt = now.plus(expiration);
        String token = Jwts.builder()
                .subject(username)
                .claim("role", "ADMIN")
                .issuedAt(Date.from(now))
                .expiration(Date.from(expiresAt))
                .signWith(key)
                .compact();
        return new IssuedJwt(token, expiresAt);
    }

    public String verifyAndGetUsername(String token) {
        try {
            Claims claims = Jwts.parser().verifyWith(key).build()
                    .parseSignedClaims(token).getPayload();
            if (!"ADMIN".equals(claims.get("role", String.class))) return null;
            return claims.getSubject();
        } catch (JwtException | IllegalArgumentException error) {
            return null;
        }
    }

    public record IssuedJwt(String token, Instant expiresAt) {}
}
