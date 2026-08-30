// 通用加载占位：转圈小圆圈 + 一行说明。凡是等数据的地方都用它，
// 代替原来生硬的 "Loading…" 纯文本。
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <span className="spinner" aria-hidden="true" />
      {label && <span className="loading-label">{label}</span>}
    </div>
  );
}
