# Samryetha 错误模型

所有错误统一形状：

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Not found",
    "requestId": "req_abc12345",
    "details": {}
  }
}
```

- `code`：机器可读错误码（见下表）。
- `message`：人类可读描述。
- `requestId`：关联日志的请求 ID（`x-request-id` 响应头同值）。
- `details`：可选附加结构（如字段级校验错误、重试时间）。

统一由 `src/app/error.ts` 的 `AppError` 抛出，全局 error handler（`src/app/server.ts`）序列化。业务代码不直接拼错误响应。

## 错误码 → HTTP 状态

| code | HTTP | 场景 |
|------|------|------|
| `BAD_REQUEST` | 400 | 参数语义错误 |
| `AUTH_REQUIRED` | 401 | 未登录访问受保护资源 |
| `SESSION_EXPIRED` | 401 | 会话过期 |
| `INVALID_CREDENTIALS` | 401 | 登录凭据错误 |
| `EMAIL_NOT_VERIFIED` | 403 | 未验证邮箱访问受限能力 |
| `BANNED` | 403 | 账号被封禁 |
| `FORBIDDEN` | 403 | 授权失败（`can()` 拒绝） |
| `NOT_FOUND` | 404 | 资源不存在或已软删 |
| `CONFLICT` | 409 | 唯一性冲突、自引用冲突等 |
| `PAYLOAD_TOO_LARGE` | 413 | 请求体超限 |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | 不支持的内容类型 |
| `VALIDATION_ERROR` | 422 | Zod / Ajv 校验失败（含 `EMAIL_DOMAIN_NOT_ALLOWED`） |
| `RATE_LIMITED` | 429 | 触发限频，`details.retryAfterMs` 给重试时间 |
| `TOKEN_INVALID_OR_EXPIRED` | 400 | 验证码/重置 token 无效或过期 |
| `EMAIL_ALREADY_VERIFIED` | 409 | 重复验证 |
| `INTERNAL_ERROR` | 500 | 未捕获异常 |
| `SERVICE_UNAVAILABLE` | 503 | 依赖不可用 |

## 校验错误详情（VALIDATION_ERROR）

字段级错误进 `details`：

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "requestId": "req_...",
    "details": [
      { "field": "email", "message": "Invalid email", "code": "invalid_email" },
      { "field": "password", "message": "String must contain at least 8 character(s)", "code": "too_small" }
    ]
  }
}
```

`code` 值来源：Zod issue 的 `code`，或 `EMAIL_DOMAIN_NOT_ALLOWED` 等业务校验码。

## 限频

`@fastify/rate-limit` 全局 300 req/min。超限响应：

```json
{
  "error": { "code": "RATE_LIMITED", "message": "Too many requests", "requestId": "req_...", "details": { "retryAfterMs": 60000 } }
}
```

响应带 `Retry-After` 头。

## 约定

- 客户端应根据 HTTP 状态码 + `code` 分支处理，`message` 仅供展示。
- 软删资源（已删讨论/回复）对外表现为 `NOT_FOUND`，不泄露存在性。
- 登录失败统一 `INVALID_CREDENTIALS`（含不存在的账号，走 dummy argon2 验证缓解枚举时序）。
