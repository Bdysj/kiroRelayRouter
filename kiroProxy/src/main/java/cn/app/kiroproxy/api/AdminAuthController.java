package cn.app.kiroproxy.api;

import cn.app.kiroproxy.auth.AdminJwtService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/admin/auth")
public class AdminAuthController {
    private final JdbcTemplate jdbc;
    private final AdminJwtService jwt;

    public AdminAuthController(JdbcTemplate jdbc, AdminJwtService jwt) {
        this.jdbc = jdbc;
        this.jwt = jwt;
    }

    @PostMapping("/login")
    public LoginResponse login(@Valid @RequestBody LoginRequest request) {
        List<String> accounts = jdbc.queryForList(
                "select username from admin_account where username=? and password=?",
                String.class, request.username().trim(), request.password());
        if (accounts.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "管理员账号或密码错误");
        }
        AdminJwtService.IssuedJwt issued = jwt.issue(accounts.get(0));
        return new LoginResponse(issued.token(), "Bearer", issued.expiresAt(), accounts.get(0));
    }

    public record LoginRequest(@NotBlank String username, @NotBlank String password) {}
    public record LoginResponse(String token, String tokenType, java.time.Instant expiresAt, String username) {}
}
