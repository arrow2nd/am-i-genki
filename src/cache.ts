import type { Env, CacheData, Config } from "./types";
import { getCommitCount } from "./github";
import { getHealthStatus } from "./utils";
import { isBotAccount } from "./utils";

// キャッシュチェック（JST更新時刻考慮）
export function shouldUpdateCache(
  lastUpdated: string,
  jstUpdateHour: number,
): boolean {
  const lastUpdate = new Date(lastUpdated);
  const now = new Date();

  // JSTに変換（UTC+9）
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const jstLastUpdate = new Date(lastUpdate.getTime() + 9 * 60 * 60 * 1000);

  // 最終更新から24時間以上経過している場合
  if (now.getTime() - lastUpdate.getTime() > 24 * 60 * 60 * 1000) {
    return true;
  }

  // 最終更新日と現在日が異なり、現在時刻が更新時刻を過ぎている場合
  if (
    jstNow.getUTCDate() !== jstLastUpdate.getUTCDate() &&
    jstNow.getUTCHours() >= jstUpdateHour
  ) {
    return true;
  }

  return false;
}

// バックグラウンド更新関数
export async function updateCacheInBackground(
  env: Env,
  config: Config,
  cacheKey: string,
) {
  try {
    // Botユーザーチェック（簡易チェック）
    if (isBotAccount(config.username)) {
      console.error("Bot users are not supported");
      return;
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

    const data: CacheData = {
      commits: result.commits,
      status,
      lastUpdated: new Date().toISOString(),
      sources: result.sources,
    };

    // キャッシュ保存
    await env.AM_I_GENKI_CACHE.put(cacheKey, JSON.stringify(data), {
      expirationTtl: config.cacheTTL,
    });

    console.log(`Cache updated successfully for ${config.username}`);
  } catch (error) {
    console.error("Background cache update failed:", error);
    // エラーの詳細をログに出力
    if (error instanceof Error) {
      console.error("Error details:", {
        message: error.message,
        stack: error.stack,
      });
    }
  }
}