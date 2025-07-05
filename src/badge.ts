import { makeBadge } from "badge-maker";
import type { HealthStatus, BadgeStyle, VALID_BADGE_STYLES } from "./types";

// バッジスタイルの検証
export function isValidBadgeStyle(style: string): style is BadgeStyle {
  return (VALID_BADGE_STYLES as readonly string[]).includes(style);
}

// SVGバッジの生成（badge-makerを使用）
export function generateBadgeSVG(
  status: HealthStatus,
  commits: number,
  style: BadgeStyle = "flat",
): string {
  const statusConfig = {
    healthy: { color: "brightgreen", text: "元気", emoji: "😎" },
    moderate: { color: "yellow", text: "いまいち", emoji: "😑" },
    inactive: { color: "red", text: "元気ない", emoji: "🙁" },
  };

  const config = statusConfig[status];
  const label = "Am I Genki?";
  const message = `${config.emoji} ${config.text} (${commits})`;

  return makeBadge({
    label,
    message,
    color: config.color,
    style,
  });
}