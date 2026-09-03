import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/infrastructure/markdown.js";
import { LocalDiskStorage } from "../src/infrastructure/storage/local.js";

describe("renderMarkdown 净化", () => {
  it("剥离 script 标签", () => {
    const html = renderMarkdown("hello <script>alert(1)</script>");
    expect(html).not.toContain("<script");
    expect(html).toContain("hello");
  });

  it("剥离 img onerror 事件属性", () => {
    const html = renderMarkdown("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("onerror");
  });

  it("拒绝 javascript: 协议链接", () => {
    const html = renderMarkdown("<a href='javascript:alert(1)'>click</a>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click");
  });

  it("链接强制 noopener + blank", () => {
    const html = renderMarkdown("[外部](https://example.com)");
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('target="_blank"');
  });

  it("普通 markdown 正常渲染", () => {
    const html = renderMarkdown("## 标题\n\n**加粗** 和 *斜体*");
    expect(html).toContain("<h2");
    expect(html).toContain("<strong>加粗</strong>");
  });

  it("iframe 等危险标签被丢弃", () => {
    const html = renderMarkdown("<iframe src='https://evil.com'></iframe><p>safe</p>");
    expect(html).not.toContain("iframe");
    expect(html).toContain("safe");
  });
});

describe("LocalDiskStorage HMAC 签名", () => {
  const storage = new LocalDiskStorage("./test-uploads", "test-secret");

  it("合法签名通过验证", () => {
    const path = "/api/attachments/upload/abc";
    const expires = String(Date.now() + 60_000);
    const sig = (storage as unknown as { sign: (m: string, p: string, e: string) => string }).sign("PUT", path, expires);
    expect(storage.verifySignature?.("PUT", path, expires, sig)).toBe(true);
  });

  it("篡改签名被拒绝", () => {
    const path = "/api/attachments/upload/abc";
    const expires = String(Date.now() + 60_000);
    const sig = (storage as unknown as { sign: (m: string, p: string, e: string) => string }).sign("PUT", path, expires);
    const tampered = (sig[0] === "a" ? "b" : "a") + sig.slice(1);
    expect(tampered).not.toBe(sig);
    expect(storage.verifySignature?.("PUT", path, expires, tampered)).toBe(false);
  });

  it("过期时间戳不匹配被拒绝", () => {
    const path = "/api/attachments/upload/abc";
    const sig = (storage as unknown as { sign: (m: string, p: string, e: string) => string }).sign("PUT", path, "1");
    expect(storage.verifySignature?.("PUT", path, "2", sig)).toBe(false);
  });

  it("路径或方法不同被拒绝", () => {
    const path = "/api/attachments/upload/abc";
    const expires = String(Date.now() + 60_000);
    const sig = (storage as unknown as { sign: (m: string, p: string, e: string) => string }).sign("PUT", path, expires);
    expect(storage.verifySignature?.("GET", path, expires, sig)).toBe(false);
  });
});
