/** Date → epoch 毫秒；null/undefined 保持 null。序列化层统一用毫秒输出。 */
export const toMs = (d: Date | null | undefined): number | null =>
  d ? d.getTime() : null;
