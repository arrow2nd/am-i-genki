import { Hono } from "hono";
import type { Env, CacheData, BadgeStyle } from "./types";
import { getConfig, isBotAccount, getHealthStatus } from "./utils";
import { getCommitCount } from "./github";
import { shouldUpdateCache, updateCacheInBackground } from "./cache";
import { generateBadgeSVG, isValidBadgeStyle } from "./badge";

// アプリケーション初期化
const app = new Hono<{ Bindings: Env }>();

// メインエンドポイント：バッジ取得
app.get("/badge", async (c) => {
  const env = c.env;
  const config = getConfig(env);

  if (!config.username) {
    return c.text("GITHUB_USERNAME not configured", 500);
  }

  const cacheKey = `github-health:${config.username}`;

  try {
    // キャッシュチェック
    const cached = await env.AM_I_GENKI_CACHE.get(cacheKey, "json") as
      | CacheData
      | null;

    let data: CacheData;

    if (cached) {
      // キャッシュがある場合は常に返す（SWR）
      data = cached;

      // 更新が必要な場合はバックグラウンドで更新
      if (shouldUpdateCache(cached.lastUpdated, config.jstUpdateHour)) {
        // waitUntilを使ってバックグラウンド処理を実行
        c.executionCtx.waitUntil(
          updateCacheInBackground(env, config, cacheKey),
        );
      }
    } else {
      // キャッシュがない場合は同期的に取得
      // Botユーザーチェック（簡易チェック）
      if (isBotAccount(config.username)) {
        return c.text("Bot users are not supported", 400);
      }

      // 新規データ取得
      const result = await getCommitCount(
        config.username,
        config.monitoringDays,
        config,
      );

      const status = getHealthStatus(
        result.commits,
        config.healthyThreshold,
        config.moderateThreshold,
      );

      data = {
        commits: result.commits,
        status,
        lastUpdated: new Date().toISOString(),
        sources: result.sources,
      };

      // キャッシュ保存
      await env.AM_I_GENKI_CACHE.put(cacheKey, JSON.stringify(data), {
        expirationTtl: config.cacheTTL,
      });
    }

    // クエリパラメータからスタイルを取得
    const url = new URL(c.req.url);
    const styleParam = url.searchParams.get("style") || "flat";
    const badgeStyle: BadgeStyle = isValidBadgeStyle(styleParam)
      ? styleParam
      : "flat";

    // SVG生成とレスポンス
    const svg = generateBadgeSVG(data.status, data.commits, badgeStyle);

    return new Response(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=3600",
        "X-Commits": data.commits.toString(),
        "X-Status": data.status,
        "X-Username": config.username,
      },
    });
  } catch (error) {
    console.error("Error generating badge:", error);
    return c.text("Error generating badge", 500);
  }
});

// ヘルスチェックエンドポイント
app.get("/health", async (c) => {
  const config = getConfig(c.env);

  return c.json({
    status: "ok",
    service: "Am I Genki? Badge Service",
    configured: !!config.username,
    timestamp: new Date().toISOString(),
  });
});

export default app;