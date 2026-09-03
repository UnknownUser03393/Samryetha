/**
 * 演示数据脚本（已停用）：示例数据已随 release 清理。
 * 保留本文件作为占位；如需本地造演示数据，另行编写。
 */
async function main(): Promise<void> {
  console.log("Mock data has been removed. Use the built-in admin / dev accounts instead.");
}

main().catch((err) => {
  console.error("Mock failed:", err);
  process.exit(1);
});
