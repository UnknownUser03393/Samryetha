import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

// 客户端提交 canonical Markdown，服务端渲染 + 净化后缓存 HTML。
// 绝不直接信任客户端 HTML。
const ALLOWED_TAGS = [
  "p", "br", "hr", "strong", "em", "s", "u", "del", "ins",
  "a", "ul", "ol", "li", "blockquote", "code", "pre",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "img", "figure", "figcaption", "table", "thead", "tbody", "tr", "th", "td",
  "span", "div",
];

const ALLOWED_ATTRIBUTES = {
  a: ["href", "title", "target", "rel"],
  img: ["src", "alt", "title", "width", "height"],
  code: ["class"],
  span: ["class"],
  div: ["class"],
  th: ["align", "colspan"],
  td: ["align", "colspan"],
};

export function renderMarkdown(markdown: string): string {
  const raw = marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string;
  return sanitizeHtml(raw, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer nofollow", target: "_blank" }),
    },
  });
}
