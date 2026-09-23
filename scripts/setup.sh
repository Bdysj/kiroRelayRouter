#!/usr/bin/env bash
#
# kiroRelayRouter 一键环境准备脚本 / one-shot environment bootstrap
#
# 做三件事 / It does three things:
#   1. 按 requirements.txt 校验宿主环境版本（缺失或过旧会明确报出）。
#      Verify host prerequisites declared in requirements.txt.
#   2. 从 *.example 模板生成本地配置文件，已存在的不覆盖。
#      Create local config files from *.example templates, never overwriting.
#   3. 安装前端与后端依赖。
#      Install frontend and backend dependencies.
#
# 用法 / Usage:
#   ./scripts/setup.sh                 完整执行 / full run
#   ./scripts/setup.sh --check-only    只校验环境 / verify prerequisites only
#   ./scripts/setup.sh --skip-deps     跳过依赖安装 / skip dependency installation
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKEND_DIR="kiroProxy"
FRONTEND_DIR="kiro-proxy-frontend"
EXTENSION_DIR="kiro-relayrouter"
REQUIREMENTS_FILE="requirements.txt"

CHECK_ONLY=0
SKIP_DEPS=0
for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=1 ;;
    --skip-deps)  SKIP_DEPS=1 ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_DIM=$'\033[2m'
else
  C_RESET=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_DIM=''
fi

FAILURES=0
WARNINGS=0

section() { printf '\n%s==> %s%s\n' "$C_BLUE" "$1" "$C_RESET"; }
ok()      { printf '  %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
warn()    { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; WARNINGS=$((WARNINGS + 1)); }
fail()    { printf '  %s✗%s %s\n' "$C_RED" "$C_RESET" "$1"; FAILURES=$((FAILURES + 1)); }
note()    { printf '    %s%s%s\n' "$C_DIM" "$1" "$C_RESET"; }

# ---------------------------------------------------------------------------
# 版本比较：用 sort -V 做语义化比较，避免 10 < 9 这类字符串陷阱。
# Version comparison via sort -V so that 10 sorts above 9.
# ---------------------------------------------------------------------------
version_ge() {
  [ "$1" = "$2" ] && return 0
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]
}

# 只保留形如 1.2.3 的数字版本片段 / keep the first dotted numeric version found
extract_version() {
  grep -oE '[0-9]+(\.[0-9]+)*' <<<"$1" | head -n1
}

# 读取单个 java 可执行文件的主版本号，把 1.8.0_x 归一化成 8。
# Read the feature version of one java binary, normalising legacy 1.8.0_x to 8.
java_version_of() {
  local bin="$1" raw v
  [ -x "$bin" ] || return 1
  # `java -version` 输出到 stderr。`java -version` writes to stderr.
  raw="$("$bin" -version 2>&1 | head -n1)" || return 1
  v="$(grep -oE '"[^"]+"' <<<"$raw" | tr -d '"' | head -n1)"
  [ -n "$v" ] || v="$(extract_version "$raw")"
  [ -n "$v" ] || return 1
  case "$v" in
    1.8*) printf '8\n' ;;
    1.*)  cut -d. -f2 <<<"$v" ;;
    *)    extract_version "$v" ;;
  esac
}

# 依次考察 JAVA_HOME、PATH 上的 java，以及 macOS 上已注册的所有 JDK，取最高版本。
# 这样「全局 java 是 8 但机器上装了 17」不会被误判为缺失。
# Probe JAVA_HOME, the java on PATH, and every JDK registered with macOS, then keep
# the highest. A global java 8 alongside an installed JDK 17 is not a false failure.
JAVA_BEST_BIN=''
detect_best_java() {
  local candidates=() bin version best='' best_bin=''

  [ -n "${JAVA_HOME:-}" ] && candidates+=("$JAVA_HOME/bin/java")
  if command -v java >/dev/null 2>&1; then
    candidates+=("$(command -v java)")
  fi
  if [ -x /usr/libexec/java_home ]; then
    while IFS= read -r home; do
      [ -n "$home" ] && candidates+=("$home/bin/java")
    done < <(/usr/libexec/java_home -V 2>&1 | grep -oE '/[^ ]*/Contents/Home' || true)
  fi

  for bin in "${candidates[@]}"; do
    version="$(java_version_of "$bin" 2>/dev/null)" || continue
    [ -n "$version" ] || continue
    if [ -z "$best" ] || version_ge "$version" "$best"; then
      best="$version"
      best_bin="$bin"
    fi
  done

  [ -n "$best" ] || return 1
  JAVA_BEST_BIN="$best_bin"
  printf '%s\n' "$best"
}

# 只回传最佳 JDK 的可执行文件路径 / emit only the path of the winning JDK binary
java_best_binary() {
  detect_best_java >/dev/null 2>&1 || return 0
  printf '%s\n' "$JAVA_BEST_BIN"
}

detect_version() {
  local component="$1"
  case "$component" in
    java) detect_best_java ;;
    maven)
      if [ -x "./$BACKEND_DIR/mvnw" ]; then
        # Wrapper 自带（only-script 模式，首次运行自动下载）。
        # Provided by the wrapper (only-script mode, downloaded on first run).
        grep -oE 'apache-maven-[0-9]+(\.[0-9]+)*' "./$BACKEND_DIR/.mvn/wrapper/maven-wrapper.properties" 2>/dev/null |
          head -n1 | sed 's/apache-maven-//'
        return 0
      fi
      command -v mvn >/dev/null 2>&1 || return 1
      extract_version "$(mvn -v 2>/dev/null | head -n1)"
      ;;
    node)
      command -v node >/dev/null 2>&1 || return 1
      extract_version "$(node -v 2>/dev/null)"
      ;;
    pnpm)
      command -v pnpm >/dev/null 2>&1 || return 1
      extract_version "$(pnpm -v 2>/dev/null)"
      ;;
    postgresql)
      if command -v psql >/dev/null 2>&1; then
        extract_version "$(psql --version 2>/dev/null)"
      elif command -v pg_config >/dev/null 2>&1; then
        extract_version "$(pg_config --version 2>/dev/null)"
      else
        return 1
      fi
      ;;
    redis)
      if command -v redis-server >/dev/null 2>&1; then
        extract_version "$(redis-server --version 2>/dev/null)"
      elif command -v redis-cli >/dev/null 2>&1; then
        extract_version "$(redis-cli --version 2>/dev/null)"
      else
        return 1
      fi
      ;;
    rabbitmq)
      if command -v rabbitmqctl >/dev/null 2>&1; then
        extract_version "$(rabbitmqctl version 2>/dev/null)"
      elif command -v rabbitmq-diagnostics >/dev/null 2>&1; then
        extract_version "$(rabbitmq-diagnostics server_version 2>/dev/null)"
      else
        return 1
      fi
      ;;
    *) return 1 ;;
  esac
}

# 中间件可以跑在容器或远端主机上，本机检测不到只告警，不阻断。
# Middleware may run in containers or on remote hosts: warn, never block.
is_optional_component() {
  case "$1" in
    postgresql|redis|rabbitmq|maven) return 0 ;;
    *) return 1 ;;
  esac
}

section "校验宿主环境 / Verifying host prerequisites ($REQUIREMENTS_FILE)"
if [ ! -f "$REQUIREMENTS_FILE" ]; then
  fail "找不到 $REQUIREMENTS_FILE / $REQUIREMENTS_FILE not found"
else
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="$(printf '%s' "$line" | tr -d '[:space:]')"
    [ -n "$line" ] || continue

    component="${line%%>=*}"
    required="${line##*>=}"
    if [ "$component" = "$line" ]; then
      warn "跳过无法解析的依赖行 / unparsable requirement: $line"
      continue
    fi

    if ! found="$(detect_version "$component")" || [ -z "$found" ]; then
      if is_optional_component "$component"; then
        warn "$component 未在本机检测到（需要 >= $required）"
        note "$component not found locally (>= $required required); fine if it runs in Docker or on another host."
      else
        fail "$component 未安装，需要 >= $required / not installed, >= $required required"
      fi
      continue
    fi

    if version_ge "$found" "$required"; then
      ok "$component $found (>= $required)"
      if [ "$component" = "java" ]; then
        # detect_version 在命令替换的子 shell 里跑过，JAVA_BEST_BIN 不会传回来，
        # 所以这里单独再取一次最佳 JDK 的路径。
        # detect_version ran in a command-substitution subshell, so JAVA_BEST_BIN did
        # not propagate. Resolve the winning JDK path separately.
        best_java_bin="$(java_best_binary)"
        path_java_version="$(java_version_of "$(command -v java 2>/dev/null || true)" 2>/dev/null || true)"
        if [ -n "$best_java_bin" ] && [ "$path_java_version" != "$found" ]; then
          note "PATH 上的 java 是 ${path_java_version:-未安装}，构建请指向 $best_java_bin"
          note "java on PATH is ${path_java_version:-absent}; point the build at $best_java_bin"
          note "export JAVA_HOME=\"$(dirname "$(dirname "$best_java_bin")")\""
        fi
      fi
    elif is_optional_component "$component"; then
      warn "$component $found 低于要求的 $required / below the required $required"
    else
      fail "$component $found 低于要求的 $required / below the required $required"
    fi
  done <"$REQUIREMENTS_FILE"
fi

# ---------------------------------------------------------------------------
# 从模板生成本地配置 / materialise local config from templates
# ---------------------------------------------------------------------------
copy_template() {
  local template="$1" target="$2"
  if [ ! -f "$template" ]; then
    warn "缺少模板 / missing template: $template"
    return
  fi
  if [ -f "$target" ]; then
    ok "已存在，保持不变 / already present, left untouched: $target"
    return
  fi
  cp "$template" "$target"
  ok "已生成 / created: $target"
  note "请把其中的 CHANGE_ME 替换为真实值 / replace every CHANGE_ME with a real value"
}

if [ "$CHECK_ONLY" -eq 0 ]; then
  section "生成本地配置 / Creating local configuration"
  copy_template "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.dev.env"
  copy_template "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.prod.env"
  copy_template "$FRONTEND_DIR/.env.example" "$FRONTEND_DIR/.env.local"
  note "这些文件都已被 .gitignore 排除 / all of these are git-ignored"
fi

# ---------------------------------------------------------------------------
# 安装依赖 / install dependencies
# ---------------------------------------------------------------------------
if [ "$CHECK_ONLY" -eq 0 ] && [ "$SKIP_DEPS" -eq 0 ]; then
  section "安装前端依赖 / Installing frontend dependencies"
  if command -v pnpm >/dev/null 2>&1; then
    (cd "$FRONTEND_DIR" && pnpm install --frozen-lockfile)
    ok "$FRONTEND_DIR: pnpm install 完成 / done"
  else
    fail "pnpm 不可用，跳过前端依赖 / pnpm unavailable, frontend dependencies skipped"
    note "安装方式 / install with: npm install -g pnpm"
  fi

  section "预热后端依赖 / Warming up backend dependencies"
  if [ -x "$BACKEND_DIR/mvnw" ]; then
    (cd "$BACKEND_DIR" && ./mvnw -q -B dependency:go-offline)
    ok "$BACKEND_DIR: Maven 依赖已下载 / Maven dependencies downloaded"
  else
    fail "找不到可执行的 $BACKEND_DIR/mvnw / $BACKEND_DIR/mvnw is not executable"
  fi

  section "校验扩展 / Verifying the Kiro extension"
  if command -v node >/dev/null 2>&1; then
    (cd "$EXTENSION_DIR" && node build.js >/dev/null && node --check src/extension.js)
    ok "$EXTENSION_DIR: 构建与语法校验通过 / build and syntax check passed"
    note "扩展默认指向 http://127.0.0.1:8080，私有部署请用 RELAYROUTER_BACKEND_ENDPOINT 注入真实地址"
    note "The extension targets http://127.0.0.1:8080 by default; inject your own host via RELAYROUTER_BACKEND_ENDPOINT."
  else
    fail "node 不可用，跳过扩展校验 / node unavailable, extension check skipped"
  fi
fi

# ---------------------------------------------------------------------------
section "结果 / Result"
if [ "$FAILURES" -gt 0 ]; then
  printf '%s%d 项失败、%d 项告警。请先解决失败项。%s\n' "$C_RED" "$FAILURES" "$WARNINGS" "$C_RESET"
  printf '%s%d failure(s), %d warning(s). Resolve the failures before continuing.%s\n' "$C_RED" "$FAILURES" "$WARNINGS" "$C_RESET"
  exit 1
fi

printf '%s环境就绪（%d 项告警）。%s\n' "$C_GREEN" "$WARNINGS" "$C_RESET"
printf '%sEnvironment is ready (%d warning(s)).%s\n' "$C_GREEN" "$WARNINGS" "$C_RESET"

cat <<'NEXT'

下一步 / Next steps
  1. 填写凭据 / fill in credentials
       kiroProxy/.dev.env            PostgreSQL、Redis、RabbitMQ、JWT、Cloudflare R2
       kiro-proxy-frontend/.env.local  VITE_KIRO_API_BASE_URL
  2. 启动后端（Flyway 会自动建表并写入种子数据）/ start the backend (Flyway migrates on boot)
       cd kiroProxy && SPRING_PROFILES_ACTIVE=dev ./mvnw spring-boot:run
  3. 启动管理后台 / start the admin console
       cd kiro-proxy-frontend && pnpm dev
  4. 立刻修改种子管理员口令 / change the seeded admin credential immediately
       UPDATE public.admin_account SET username = '<your-admin>', password = '<strong-password>';
  5. 构建 Kiro 扩展 / build the Kiro extension
       cd kiro-relayrouter && RELAYROUTER_BACKEND_ENDPOINT=https://your-domain.example pnpm run package

文档里的示例图片指向占位域名，需要替换成你自己的 Cloudflare R2 公共域名后才能显示。
Seeded article images point at a placeholder R2 host and stay broken until you swap in your own
Cloudflare R2 public domain. See README.md for details.
NEXT
