import type { ThreadVisibilityDto } from "@aep/contracts";

export const VISIBILITY_LABELS = {
  personal: "個人",
  members: "選んだメンバー",
  workspace: "ワークスペース全体",
} as const;

export const visibilityLabel = (visibility: ThreadVisibilityDto): string =>
  VISIBILITY_LABELS[visibility.kind];
