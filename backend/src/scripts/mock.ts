/**
 * 追加一批 mock 数据（在 seed 基础上增量填充）：新增学生用户、跨板块讨论、
 * 回复/关注/收藏/通知，时间戳错开最近三天（部分落在今天，驱动首页活跃数据）。
 *
 * 用法：pnpm mock
 * 幂等：检测到 mock 用户 wei 已存在即跳过。
 * 重置：删掉 backend/data/app.db*（app.db / -shm / -wal）后依次跑 pnpm seed && pnpm mock。
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
  notifications,
  replies,
  userFollows,
  users,
} from "../infrastructure/db/schema.js";

const PASSWORD = "SeedPass123!";
const DOMAIN = "example.edu.cn";

type MockReply = { author: string; body: string; hoursAfter?: number; parentIndex?: number };
type MockDisc = {
  board: string;
  author: string;
  title: string;
  body: string;
  hoursAgo: number;
  pinned?: boolean;
  replies?: MockReply[];
};

const NEW_USERS: { username: string; displayName: string; bio?: string }[] = [
  { username: "wei", displayName: "Wei Zhang", bio: "食堂测评博主，主业吃饭。" },
  { username: "han", displayName: "Han Zhou", bio: "吸猫选手。" },
  { username: "yu", displayName: "Yu Chen", bio: "想进摄影社但还没钱买相机。" },
  { username: "jia", displayName: "Jia Liu", bio: "辩论队打工人。" },
  { username: "qi", displayName: "Qi Sun", bio: "考研备考中。" },
  { username: "shi", displayName: "Shi Wang", bio: "跑步+数码。" },
];

const MOCK_DISCUSSIONS: MockDisc[] = [
  {
    board: "campus", author: "sora", hoursAgo: 1, title: "宿舍楼下新开的奶茶店居然可以选甜度了",
    body: "之前不是只能三分糖吗，今天去发现加了个自助甜度按钮。\n\n点了个**芋泥波波**五分糖，还不错。你们喝过那个芝士葡萄了吗？",
    replies: [
      { author: "momo", body: "芝士葡萄喝过，有点甜，建议三分糖。" },
      { author: "lin", body: "老板终于听劝了，我上次说了一嘴，居然真改了 hhh" },
      { author: "wei", body: "新店都是这套路，先观察几天再吹（dog" },
    ],
  },
  {
    board: "off-topic", author: "wei", hoursAgo: 3, title: "你们宿舍晚上几点熄灯",
    body: "我们宿舍约定 11 点半熄灯，但最近隔壁天天打游戏到两点。\n\n全校平均熄灯时间是多少？投票一下：**A. 11点前 B. 11-12点 C. 随缘**",
    replies: [
      { author: "shi", body: "我们随缘，谁困谁关灯。" },
      { author: "han", body: "11 点半，雷打不动，早睡人狂喜。" },
    ],
  },
  {
    board: "study", author: "chen", hoursAgo: 5, pinned: true, title: "操作系统期末重点整理（个人版）",
    body: "趁复习整理了一份，基于去年真题和老师 ppt，**仅供参考**。\n\n- 进程调度：SJF / 时间片轮转，必考一道计算\n- 死锁：四个必要条件 + 银行家算法例题\n- 虚拟内存：页面置换 LRU/OPT 对比\n- 文件系统：目录结构 + 磁盘调度电梯算法\n\npdf 放评论区了，有错的欢迎指正。",
    replies: [
      { author: "yu", body: "太救命了，正好看到电梯算法不会。" },
      { author: "chen", body: "电梯算法看这一题就行：磁道 100 道，初始 50 朝大号方向……", parentIndex: 0 },
      { author: "sora", body: "已加精，建议人手一份。" },
    ],
  },
  {
    board: "photography-club", author: "momo", hoursAgo: 6, title: "分享一张今晚的月亮",
    body: "今晚月亮真亮，iPhone 拉满都拍清楚了。\n\n![月亮](https://dummyimage.com/600x400/1a1a1c/eceeef&text=Moon)\n\n有没有人拍了更清晰的，评论区交流下参数。",
    replies: [
      { author: "yu", body: "这个月亮太干净了，用了三脚架吗？" },
      { author: "momo", body: "手持的，快门压到 1/250 就稳了。", parentIndex: 0 },
    ],
  },
  {
    board: "campus", author: "han", hoursAgo: 8, title: "校园里的流浪猫好像多了几只，有人想一起喂吗",
    body: "最近在教学楼后门看到三只新来的小猫，都很亲人。\n\n想组个小队轮流喂，周末一起带点猫粮过去？**校猫名单**持续更新中。",
    replies: [
      { author: "momo", body: "报名！我宿舍还有半袋猫粮。" },
      { author: "fang", body: "注意别喂咸的，之前有人喂剩菜小猫拉肚子了。" },
    ],
  },
  {
    board: "clubs", author: "shi", hoursAgo: 11, title: "跑步爱好者群，早上六点半操场见",
    body: "建了个跑步群，欢迎新手。\n\n每周二/四/六早上 **6:30** 操场主席台集合，跑 3-5km，配速不卡人。\n\n> 夏天还是早上凉快，夜跑夏天太闷了。",
    replies: [
      { author: "qi", body: "六点半……我还是夜跑吧，早八人都起不来。" },
      { author: "shi", body: "哈哈可以先从周末开始试一次。", parentIndex: 0 },
    ],
  },
  {
    board: "study", author: "qi", hoursAgo: 27, title: "考研自习室在哪里预约？",
    body: "图书馆 5 楼的自习室现在要预约了吗？还是先到先得。\n\n下学期要开始正式复习了，想提前搞清楚规则。",
    replies: [
      { author: "sora", body: "今年开始走线上预约，当天 0 点放号，抢不到就第二天早点去。" },
    ],
  },
  {
    board: "campus", author: "wei", hoursAgo: 29, title: "食堂三楼新窗口的沙茶面测评",
    body: "三楼角落新开的沙茶面，**13 块**，料给得挺足（有瘦肉、鱿鱼、豆芽）。\n\n沙茶酱偏稠，辣度可选。总体 8/10，扣两分因为排队太慢。",
  },
  {
    board: "lost-and-found", author: "fang", hoursAgo: 31, title: "失物招领：操场捡到一只黑色保温杯",
    body: "操场西侧看台捡到的，**黑色、无盖套**，杯身贴了张「不喝热水会死」的贴纸。\n\n来 3 号宿舍楼 215 找我领，或者评论区认领。",
    replies: [
      { author: "wei", body: "是我舍友的，他说那贴纸是他贴的 hhh 我让他去拿。" },
    ],
  },
  {
    board: "clubs", author: "lin", hoursAgo: 33, title: "音乐社周六晚上草坪音乐会预告",
    body: "本周六晚 **7 点**，南草坪，音乐社专场。\n\n歌单预告：吉他弹唱 + 两首乐队曲目，欢迎带野餐垫来听。\n\n如果下雨改到活动中心 201。",
    replies: [
      { author: "han", body: "上次音乐会带垫子去听了，氛围真的可以。" },
      { author: "jia", body: "能不能点歌，想听《海阔天空》。" },
      { author: "lin", body: "安排！", parentIndex: 1 },
    ],
  },
  {
    board: "study", author: "yu", hoursAgo: 35, title: "有没有一起组队刷 LeetCode 的",
    body: "秋招前想突击一下算法。\n\n计划：每周日晚上线上碰头，互相讲一道题 + 周中打卡。**目标**：三个月刷完 hot 100。\n\n评论区扣 1 拉群。",
    replies: [
      { author: "chen", body: "1，正在刷链表那节。" },
      { author: "sora", body: "组队效率确实高，去年我就是这么过的。" },
    ],
  },
  {
    board: "off-topic", author: "han", hoursAgo: 37, title: "推荐一部最近在看的剧",
    body: "《小巷人家》看完了，暖得不行。\n\n还开了个悬疑的坑，怕晚上睡不着不敢往下看。\n\n大家最近在看什么？求安利。",
    replies: [
      { author: "jia", body: "最近在看纪录片《风味人间》，下饭神片。" },
    ],
  },
  {
    board: "campus", author: "momo", hoursAgo: 51, title: "期末周图书馆的占座情况越来越夸张了",
    body: "早上 7 点去 4 楼自习区，已经坐满一半了，桌上全是书，人没来几个。\n\n学校要不要管管这种**用书占座**的？",
    replies: [
      { author: "chen", body: "支持管理，占座超过半小时就该清。" },
      { author: "qi", body: "提前一晚放书占位更离谱，第二天直接过去。" },
    ],
  },
  {
    board: "study", author: "sora", hoursAgo: 53, title: "线性代数答疑时间改了，注意",
    body: "老师这周四的答疑从下午 2 点改到 **3 点半**，地点不变，还是数学楼 408。\n\n带上一周的作业册，他会现场批改。",
    replies: [
      { author: "fang", body: "谢谢提醒，差点白跑一趟。" },
    ],
  },
  {
    board: "clubs", author: "jia", hoursAgo: 55, title: "辩论队招新：不需要口才，只需要逻辑",
    body: "下周三晚上 **7 点**，活动中心 302，辩论队试训。\n\n0 基础也可以来，主要看能不能把话说圆。现场随机抽辩题，大家一起聊聊。",
    replies: [
      { author: "lin", body: "打过两场辩论，逻辑比口才重要是真的。" },
    ],
  },
  {
    board: "photography-club", author: "yu", hoursAgo: 57, title: "胶片入门，买什么相机好？",
    body: "想入胶片坑，预算 **1500 以内**。\n\n目前在看：佳能 AE-1、奥林巴斯 OM-1、尼康 FM2。有没有玩过的说说哪个更合适？",
    replies: [
      { author: "momo", body: "AE-1 入门最稳，测光准，配件好找。" },
      { author: "shi", body: "预算够建议直接 FM2，皮实，以后出手也保值。" },
    ],
  },
  {
    board: "lost-and-found", author: "qi", hoursAgo: 59, title: "图书馆四楼有人拿错我的水杯了，麻烦还一下",
    body: "今天下午在 4 楼靠窗的位置，我白色保温杯被拿走了，桌上留下一个**蓝色**的（应该是拿错那位兄台的）。\n\n看到这条麻烦放回原位或者交到一楼前台，我把蓝的也放前台了。",
  },
  {
    board: "off-topic", author: "jia", hoursAgo: 61, title: "今年冬天会很冷吗，要不要提前买羽绒服",
    body: "气象台说今年可能是**冷冬**，学校暖气据说要等 11 月中才开。\n\n要不要趁双十一先把羽绒服买了？还是等十月看气温再说。",
    replies: [
      { author: "wei", body: "等双十一吧，早买也得等降温才穿。" },
    ],
  },
];

async function main(): Promise<void> {
  const env = loadEnv();
  const container = await buildContainer(env, { runMigrations: true });
  try {
    const existing = await container.db.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, "wei"))
      .get();
    if (existing) {
      console.log("Mock data already present — skipping.");
      return;
    }

    const passwordHash = await hash(PASSWORD, { algorithm: Algorithm.Argon2id });
    const now = Date.now();

    await container.db.tx(async (tx) => {
      // ---- 新用户 ----
      const insertedUsers = await tx
        .insert(users)
        .values(
          NEW_USERS.map((u) => ({
            username: u.username,
            email: `${u.username}@${DOMAIN}`,
            display_name: u.displayName,
            bio: u.bio ?? "",
            password_hash: passwordHash,
            role: "student" as const,
            status: "active" as const,
            email_domain: DOMAIN,
            email_verified_at: new Date(now),
            last_seen_at: new Date(now - 30 * 60_000),
          })),
        )
        .returning({ id: users.id, username: users.username });
      const userBy = new Map(insertedUsers.map((u) => [u.username, u.id]));

      const allUsers = await tx.select().from(users);
      const idOf = (username: string) => allUsers.find((u) => u.username === username)?.id!;
      const allBoards = await tx.select().from(boards);
      const boardIdOf = (slug: string) => allBoards.find((b) => b.slug === slug)?.id!;

      // ---- 板块成员关系（让 memberCount 有数） ----
      const membership: [string, string][] = [
        ["wei", "campus"], ["wei", "off-topic"],
        ["han", "campus"], ["han", "off-topic"],
        ["yu", "study"], ["yu", "photography-club"],
        ["jia", "clubs"], ["jia", "off-topic"],
        ["qi", "study"], ["qi", "lost-and-found"],
        ["shi", "clubs"], ["shi", "photography-club"],
        // 发过帖的存量用户也要是成员，否则数据跟板块 posting policy 矛盾（members-only 板块）
        ["momo", "photography-club"],
        ["fang", "lost-and-found"],
      ];
      for (const [username, slug] of membership) {
        await tx
          .insert(boardMembers)
          .values({ board_id: boardIdOf(slug), user_id: idOf(username), role: "member" })
          .onConflictDoNothing();
      }

      // ---- 讨论 + 回复 ----
      const notifDefs: { for: string; actor: string; discussionId: number; replyId: number }[] = [];
      for (const d of MOCK_DISCUSSIONS) {
        const createdAt = new Date(now - d.hoursAgo * 3600_000);
        const [disc] = await tx
          .insert(discussions)
          .values({
            board_id: boardIdOf(d.board),
            author_id: idOf(d.author),
            title: d.title,
            body_md: d.body,
            body_html: renderMarkdown(d.body),
            is_pinned: d.pinned ? 1 : 0,
            created_at: createdAt,
          })
          .returning({ id: discussions.id });
        if (!disc) continue;

        let lastReplyAt: Date | null = null;
        if (d.replies?.length) {
          const replyIds: number[] = [];
          for (const [i, r] of d.replies.entries()) {
            // 默认错开 24min + 每楼 6min，避免同一帖子回复时间戳全挤在一起；
            // 并夹到「不晚于 1 分钟前」，防止刚发的帖子回复落在未来。
            const repliedAt = new Date(
              Math.min(createdAt.getTime() + (r.hoursAfter ?? (0.4 + i * 0.1)) * 3600_000, now - 60_000),
            );
            const [reply] = await tx
              .insert(replies)
              .values({
                discussion_id: disc.id,
                author_id: idOf(r.author),
                parent_reply_id: r.parentIndex !== undefined ? replyIds[r.parentIndex] ?? null : null,
                body_md: r.body,
                body_html: renderMarkdown(r.body),
                created_at: repliedAt,
              })
              .returning({ id: replies.id });
            replyIds.push(reply!.id);
            if (!lastReplyAt || repliedAt > lastReplyAt) lastReplyAt = repliedAt;
            // 给讨论作者发一条回复通知（挑一部分，展示未读角标）
            if (i < 3 && d.author !== r.author) {
              notifDefs.push({ for: d.author, actor: r.author, discussionId: disc.id, replyId: reply!.id });
            }
          }
          // 进入该分支必有回复，lastReplyAt 已在循环内赋值
          await tx
            .update(discussions)
            .set({ reply_count: replyIds.length, last_reply_at: lastReplyAt!, updated_at: lastReplyAt! })
            .where(eq(discussions.id, disc.id));
        }
      }

      // ---- 通知 ----
      // 该表没有唯一约束，onConflictDoNothing 是空操作；幂等由外层 wei 存在性守卫保证。
      for (const n of notifDefs.slice(0, 6)) {
        await tx.insert(notifications).values({
          user_id: idOf(n.for),
          actor_user_id: idOf(n.actor),
          type: "reply",
          discussion_id: n.discussionId,
          reply_id: n.replyId,
          body: "回复了你的讨论",
          is_read: 0,
        });
      }

      // ---- 关注 / 收藏 ----
      const soraId = idOf("sora");
      const momoId = idOf("momo");
      const chenId = idOf("chen");
      const weiId = idOf("wei");
      const allDiscs = await tx.select().from(discussions);
      const findDisc = (title: string) => allDiscs.find((x) => x.title === title)?.id;
      const followPairs: [string, string][] = [
        ["fang", "wei"], ["yu", "sora"], ["han", "momo"], ["jia", "lin"], ["qi", "chen"],
      ];
      for (const [a, b] of followPairs) {
        await tx.insert(userFollows).values({ follower_id: idOf(a), followee_id: idOf(b) }).onConflictDoNothing();
      }
      await tx
        .insert(discussionFollows)
        .values([
          { user_id: soraId, discussion_id: findDisc("宿舍楼下新开的奶茶店居然可以选甜度了")! },
          { user_id: soraId, discussion_id: findDisc("操作系统期末重点整理（个人版）")! },
          { user_id: momoId, discussion_id: findDisc("考研自习室在哪里预约？")! },
          { user_id: chenId, discussion_id: findDisc("有没有一起组队刷 LeetCode 的")! },
        ])
        .onConflictDoNothing();
      await tx
        .insert(discussionSaves)
        .values([
          { user_id: momoId, discussion_id: findDisc("分享一张今晚的月亮")! },
          { user_id: weiId, discussion_id: findDisc("食堂三楼新窗口的沙茶面测评")! },
        ])
        .onConflictDoNothing();

      console.log(
        `Mock inserted: ${insertedUsers.length} users, ${MOCK_DISCUSSIONS.length} discussions, ${allDiscs.length} total.`,
      );
    });
  } finally {
    await container.close();
  }
}

main().catch((err) => {
  console.error("Mock failed:", err);
  process.exit(1);
});
