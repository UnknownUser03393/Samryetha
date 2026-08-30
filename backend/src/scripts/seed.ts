/**
 * 幂等 seed：示例学校 + 管理员/版主/学生 + 6 个动态 Board + 示例讨论/回复/关注/收藏。
 * 用法：pnpm seed
 */
import { Algorithm, hash } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import { loadEnv } from "../config/env.js";
import { buildContainer } from "../app/container.js";
import { renderMarkdown } from "../infrastructure/markdown.js";
import {
  boardMembers,
  boards,
  discussions,
  discussionFollows,
  discussionSaves,
  replies,
  schools,
  userFollows,
  users,
} from "../infrastructure/db/schema.js";

const PASSWORD = "SeedPass123!";
const DOMAIN = "example.edu.cn";
const NOW = new Date();

const BOARD_DEFS = [
  { slug: "campus", name: "Campus life", description: "Everything happening around campus", visibility: "public", postingPolicy: "everyone" },
  { slug: "study", name: "Study", description: "Homework help, exams, study groups", visibility: "public", postingPolicy: "everyone" },
  { slug: "clubs", name: "Clubs", description: "Clubs and societies", visibility: "public", postingPolicy: "members" },
  { slug: "photography-club", name: "Photography club", description: "Share your shots", visibility: "members", postingPolicy: "members" },
  { slug: "lost-and-found", name: "Lost & found", description: "Lost something? Found something?", visibility: "public", postingPolicy: "members" },
  { slug: "off-topic", name: "Off-topic", description: "Anything goes", visibility: "public", postingPolicy: "everyone" },
] as const;

const SEED_DISCUSSIONS: { board: string; author: string; title: string; body: string; pinned?: boolean; locked?: boolean }[] = [
  { board: "campus", author: "sora", title: "食堂今天中午的酸菜鱼真的绝了", body: "排队二十分钟值了，强烈推荐。\n\n不过二楼的座位还是太少了。" },
  { board: "campus", author: "lin", title: "失物招领：图书馆三楼捡到一副 AirPods", body: "在靠窗的位置，描述一下盒子里的字，我就还给你。" },
  { board: "campus", author: "sora", title: "校园卡补办流程（更新版）", body: "先去行政楼 302 挂失，带上学生证，当场就能拿到新卡。\n\n⚠️ 注意：挂失 24 小时内的消费损失可以申诉。", pinned: true },
  { board: "study", author: "momo", title: "明天数学周测范围确认", body: "老师说的是第二章到第四章，还是第三章到第四章？\n\n评论区有人知道吗。" },
  { board: "study", author: "sora", title: "分享一个记笔记的方法：Cornell 法", body: "左栏关键词，右栏笔记，底部总结。亲测对期末复习很有用。" },
  { board: "clubs", author: "lin", title: "摄影社招新：本周六下午 3 点", body: "带相机来，没有的话用手机也行。社团在艺术楼 201。" },
  { board: "photography-club", author: "momo", title: "秋天到了，拍了几张梧桐大道", body: "今天下午光线很好，附几张。[梧桐大道秋色]" },
  { board: "lost-and-found", author: "lin", title: "捡到一本《高等数学》上册", body: "扉页写着一个「陈」字，来 5 班找我领。" },
  { board: "off-topic", author: "momo", title: "昨晚宿舍楼下的猫叫了一整晚", body: "有没有人管管，黑猫白猫都叫，声控灯都亮了一夜。" },
];

async function main(): Promise<void> {
  const env = loadEnv();
  const container = await buildContainer(env, { runMigrations: true });
  const db = container.db.db;
  try {
    const existingSchool = await db.select().from(schools).get();
    if (existingSchool) {
      console.log("Database already seeded — skipping.");
      return;
    }
    const passwordHash = await hash(PASSWORD, { algorithm: Algorithm.Argon2id });

    await db.insert(schools).values({ name: "示例学校", email_domain: DOMAIN });

    const userDefs = [
      { username: "sora", displayName: "Sora Yue", role: "admin" },
      { username: "lin", displayName: "Lin Wang", role: "moderator" },
      { username: "momo", displayName: "Momo Li", role: "student" },
      { username: "chen", displayName: "Chen Xu", role: "student" },
      { username: "fang", displayName: "Fang Zhao", role: "student" },
    ] as const;

    const insertedUsers = await db
      .insert(users)
      .values(
        userDefs.map((u, i) => ({
          username: u.username,
          email: `${u.username}@${DOMAIN}`,
          display_name: u.displayName,
          password_hash: passwordHash,
          role: u.role,
          status: "active" as const,
          email_domain: DOMAIN,
          email_verified_at: NOW,
        })),
      )
      .returning({ id: users.id, username: users.username, role: users.role });
    const byName = new Map(insertedUsers.map((u) => [u.username, u.id]));

    const insertedBoards = await db
      .insert(boards)
      .values(
        BOARD_DEFS.map((b) => ({
          slug: b.slug,
          name: b.name,
          description: b.description,
          visibility: b.visibility,
          posting_policy: b.postingPolicy,
          created_by_user_id: byName.get("sora"),
        })),
      )
      .returning({ id: boards.id, slug: boards.slug });
    const boardBySlug = new Map(insertedBoards.map((b) => [b.slug, b.id]));

    // 版主成员关系（演示 board-mod 授权）
    const modBoards = ["clubs", "photography-club", "off-topic"];
    for (const slug of modBoards) {
      const boardId = boardBySlug.get(slug)!;
      const linId = byName.get("lin")!;
      await db.insert(boardMembers).values({ board_id: boardId, user_id: linId, role: "moderator" }).onConflictDoNothing();
      await db.insert(boardMembers).values({ board_id: boardId, user_id: byName.get("sora")!, role: "moderator" }).onConflictDoNothing();
    }

    const discussionIds: number[] = [];
    for (const [i, d] of SEED_DISCUSSIONS.entries()) {
      const boardId = boardBySlug.get(d.board)!;
      const authorId = byName.get(d.author)!;
      const [row] = await db
        .insert(discussions)
        .values({
          board_id: boardId,
          author_id: authorId,
          title: d.title,
          body_md: d.body,
          body_html: renderMarkdown(d.body),
          is_pinned: d.pinned ? 1 : 0,
          is_locked: d.locked ? 1 : 0,
          created_at: new Date(NOW.getTime() - (SEED_DISCUSSIONS.length - i) * 3600_000),
        })
        .returning({ id: discussions.id });
      discussionIds.push(row.id);
    }

    // 少量回复 + 更新计数/活动时间
    const replyDefs: { discussion: string; author: string; body: string }[] = [
      { discussion: "食堂今天中午的酸菜鱼真的绝了", author: "momo", body: "酸菜鱼确实可以，但我更喜欢辣子鸡。" },
      { discussion: "食堂今天中午的酸菜鱼真的绝了", author: "lin", body: "周末去还有吗？" },
      { discussion: "明天数学周测范围确认", author: "chen", body: "第三章到第四章，老师刚在群里说了。" },
      { discussion: "明天数学周测范围确认", author: "sora", body: "谢了，差点复习错范围。" },
      { discussion: "摄影社招新：本周六下午 3 点", author: "fang", body: "请问需要自带三脚架吗？" },
    ];
    for (const r of replyDefs) {
      const discId = discussionIds[SEED_DISCUSSIONS.findIndex((d) => d.title === r.discussion)];
      const authorId = byName.get(r.author)!;
      await db.insert(replies).values({ discussion_id: discId, author_id: authorId, body_md: r.body, body_html: renderMarkdown(r.body) });
      const current = await db.select().from(discussions).where(eq(discussions.id, discId)).get();
      await db
        .update(discussions)
        .set({ reply_count: (current?.reply_count ?? 0) + 1, last_reply_at: NOW, updated_at: NOW })
        .where(eq(discussions.id, discId));
    }

    // 关注关系 + 收藏
    const sora = byName.get("sora")!;
    const momo = byName.get("momo")!;
    const lin = byName.get("lin")!;
    await db.insert(userFollows).values([
      { follower_id: sora, followee_id: momo },
      { follower_id: momo, followee_id: sora },
      { follower_id: lin, followee_id: sora },
    ]);
    await db.insert(discussionSaves).values([{ user_id: sora, discussion_id: discussionIds[3] }]);
    await db.insert(discussionFollows).values([{ user_id: momo, discussion_id: discussionIds[0] }]);

    console.log(`Seeded: ${insertedUsers.length} users, ${insertedBoards.length} boards, ${discussionIds.length} discussions.`);
  } finally {
    await container.close();
  }
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
