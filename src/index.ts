import { Hono } from "hono";
import { makeBadge } from "badge-maker";

// 型定義
interface Env {
  GITHUB_USERNAME: string;
  HEALTHY_THRESHOLD?: string;
  MODERATE_THRESHOLD?: string;
  MONITORING_DAYS?: string;
  CACHE_TTL?: string;
  JST_UPDATE_HOUR?: string;
  GITHUB_TOKEN?: string;
  INCLUDE_ORG_REPOS?: string;
  MAX_REPOS_PER_ORG?: string;
  EXCLUDE_REPOS?: string;
  EXCLUDE_ORGS?: string;
  AM_I_GENKI_CACHE: KVNamespace;
}

interface CacheData {
  commits: number;
  status: "healthy" | "moderate" | "inactive";
  lastUpdated: string;
  sources: { owned: number; org: number };
}

// アプリケーション初期化
const app = new Hono<{ Bindings: Env }>();

// 設定値の取得
function getConfig(env: Env) {
  return {
    username: env.GITHUB_USERNAME,
    healthyThreshold: parseInt(env.HEALTHY_THRESHOLD || "15"),
    moderateThreshold: parseInt(env.MODERATE_THRESHOLD || "5"),
    monitoringDays: parseInt(env.MONITORING_DAYS || "14"),
    cacheTTL: parseInt(env.CACHE_TTL || "86400"),
    jstUpdateHour: parseInt(env.JST_UPDATE_HOUR || "8"),
    githubToken: env.GITHUB_TOKEN,
    includeOrgRepos: env.INCLUDE_ORG_REPOS === "true",
    maxReposPerOrg: parseInt(env.MAX_REPOS_PER_ORG || "5"),
    excludeRepos: env.EXCLUDE_REPOS
      ? env.EXCLUDE_REPOS.split(",").map((repo) => repo.trim())
      : ["dotfiles"],
    excludeOrgs: env.EXCLUDE_ORGS
      ? env.EXCLUDE_ORGS.split(",").map((org) => org.trim())
      : [],
  };
}

// GitHub APIヘッダー
function getGithubHeaders(token?: string): HeadersInit {
  const headers: HeadersInit = {
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "Am-I-Genki-Badge-Service",
  };
  if (token) {
    headers["Authorization"] = `token ${token}`;
  }
  return headers;
}

// リトライ付きfetch関数
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 3,
  initialDelay: number = 1000,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, options);

      // レート制限のチェック
      if (response.status === 429 || response.status === 403) {
        const retryAfter = response.headers.get("retry-after");
        const waitTime = retryAfter
          ? parseInt(retryAfter) * 1000
          : initialDelay * Math.pow(2, i);

        console.warn(`Rate limited. Waiting ${waitTime}ms before retry...`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      }

      // 5xxエラーの場合はリトライ
      if (response.status >= 500) {
        const waitTime = initialDelay * Math.pow(2, i);
        console.warn(
          `Server error ${response.status}. Retrying in ${waitTime}ms...`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      }

      return response;
    } catch (error) {
      lastError = error as Error;
      const waitTime = initialDelay * Math.pow(2, i);
      console.error(`Network error: ${error}. Retrying in ${waitTime}ms...`);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }

  throw lastError ||
    new Error(`Failed to fetch ${url} after ${maxRetries} retries`);
}

// Botアカウントかどうかを判定
function isBotAccount(login?: string, name?: string, email?: string): boolean {
  if (!login && !name && !email) return false;

  const botIndicators = [
    /dependabot/i,
    /renovate/i,
    /greenkeeper/i,
    /github-actions/i,
    /codecov/i,
    /snyk/i,
    /web-flow/i,
    /\[bot\]$/i,
    /-bot$/i,
    /bot-/i,
    /noreply@github\.com/,
  ];

  const checkString = `${login || ""} ${name || ""} ${email || ""}`
    .toLowerCase();
  return botIndicators.some((pattern) => pattern.test(checkString));
}

// 単一リポジトリのコミット数を取得
async function getRepoCommits(
  username: string,
  repoOwner: string,
  repoName: string,
  since: Date,
  token?: string,
): Promise<number> {
  try {
    const commitsResponse = await fetchWithRetry(
      `https://api.github.com/repos/${repoOwner}/${repoName}/commits?author=${username}&since=${since.toISOString()}&per_page=100`,
      { headers: getGithubHeaders(token) },
      3,
      500,
    );

    if (commitsResponse.ok) {
      const commits = await commitsResponse.json() as Array<{
        author?: { login: string };
        commit: {
          author: {
            name: string;
            email: string;
          };
        };
        parents: Array<{ sha: string }>;
      }>;

      // Bot・マージコミットを除外してユーザー本人のコミットのみカウント
      const userCommits = commits.filter((commit) => {
        const authorLogin = commit.author?.login;
        const authorName = commit.commit.author.name;
        const authorEmail = commit.commit.author.email;

        // マージコミット（親が2つ以上）を除外
        const isMergeCommit = commit.parents.length >= 2;

        return !isBotAccount(authorLogin, authorName, authorEmail) &&
          !isMergeCommit &&
          authorLogin === username;
      });

      return userCommits.length;
    }
  } catch (error) {
    console.error(`Error fetching commits for ${repoName}:`, error);
  }

  return 0;
}

// 組織リポジトリのコミット数を取得
async function getOrgRepoCommits(
  username: string,
  config: ReturnType<typeof getConfig>,
  since: Date,
  maxRepos: number,
): Promise<{ commits: number; repos: number }> {
  let totalOrgCommits = 0;
  let processedOrgRepos = 0;

  try {
    // ユーザーが所属する組織を取得
    const orgsResponse = await fetchWithRetry(
      `https://api.github.com/users/${username}/orgs`,
      { headers: getGithubHeaders(config.githubToken) },
    );

    if (!orgsResponse.ok) {
      console.error("Failed to fetch user organizations");
      return { commits: 0, repos: 0 };
    }

    const orgs = await orgsResponse.json() as Array<{ login: string }>;

    // 除外組織をフィルタリング
    const filteredOrgs = orgs.filter((org) =>
      !config.excludeOrgs.includes(org.login)
    );

    // 組織ごとのリポジトリを並列取得
    const orgReposPromises = filteredOrgs.map(async (org) => {
      try {
        const orgReposResponse = await fetchWithRetry(
          `https://api.github.com/orgs/${org.login}/repos?type=public&sort=updated&per_page=${config.maxReposPerOrg}`,
          { headers: getGithubHeaders(config.githubToken) },
        );

        if (orgReposResponse.ok) {
          const repos = await orgReposResponse.json() as Array<{
            name: string;
            updated_at: string;
          }>;
          return { org: org.login, repos };
        }
        return null;
      } catch (error) {
        console.error(`Error fetching repos for org ${org.login}:`, error);
        return null;
      }
    });

    const orgReposResults = await Promise.all(orgReposPromises);

    // 全てのリポジトリをフラット化して処理
    const allOrgRepos: Array<
      { org: string; repo: { name: string; updated_at: string } }
    > = [];

    for (const result of orgReposResults) {
      if (result && result.repos) {
        for (const repo of result.repos) {
          if (allOrgRepos.length >= maxRepos) break;

          const repoUpdated = new Date(repo.updated_at);
          if (
            repoUpdated >= since && !config.excludeRepos.includes(repo.name)
          ) {
            allOrgRepos.push({ org: result.org, repo });
          }
        }
      }
    }

    // バッチサイズ
    const batchSize = config.githubToken ? 5 : 3;

    // バッチ処理でコミット数を確認
    for (
      let i = 0;
      i < allOrgRepos.length && processedOrgRepos < maxRepos;
      i += batchSize
    ) {
      const batch = allOrgRepos.slice(
        i,
        Math.min(i + batchSize, allOrgRepos.length),
      );

      const batchPromises = batch.map(async ({ org, repo }) => {
        try {
          const commits = await getRepoCommits(
            username,
            org,
            repo.name,
            since,
            config.githubToken,
          );

          if (commits > 0) {
            return { commits, org, repo: repo.name };
          }
          return null;
        } catch (error) {
          console.error(`Error processing ${org}/${repo.name}:`, error);
          return null;
        }
      });

      const results = await Promise.all(batchPromises);

      for (const result of results) {
        if (result && processedOrgRepos < maxRepos) {
          totalOrgCommits += result.commits;
          processedOrgRepos++;
        }
      }

      // バッチ間の小さな遅延
      if (i + batchSize < allOrgRepos.length && processedOrgRepos < maxRepos) {
        await new Promise((resolve) =>
          setTimeout(resolve, config.githubToken ? 100 : 200)
        );
      }
    }
  } catch (error) {
    console.error("Error fetching organization repositories:", error);
  }

  return { commits: totalOrgCommits, repos: processedOrgRepos };
}

// コミット数の取得（組織リポジトリ対応版）
async function getCommitCount(
  username: string,
  monitoringDays: number,
  config: ReturnType<typeof getConfig>,
): Promise<{ commits: number; sources: { owned: number; org: number } }> {
  // 指定日数前の日付を計算
  const since = new Date();
  since.setDate(since.getDate() - monitoringDays);

  let totalCommits = 0;
  let processedRepos = 0;
  const repoSources = { owned: 0, org: 0 };

  // ユーザーの所有リポジトリを取得・処理
  const ownedRepos = await fetchWithRetry(
    `https://api.github.com/users/${username}/repos?type=owner&sort=updated&per_page=30`,
    { headers: getGithubHeaders(config.githubToken) },
  );

  if (ownedRepos.ok) {
    const repos = await ownedRepos.json() as Array<{
      name: string;
      updated_at: string;
    }>;

    // 処理対象のリポジトリをフィルタリング
    const reposToProcess = repos
      .filter((repo) => {
        if (processedRepos >= 20) return false;
        if (config.excludeRepos.includes(repo.name)) return false;
        const repoUpdated = new Date(repo.updated_at);
        return repoUpdated >= since;
      })
      .slice(0, 20);

    // バッチサイズ（同時実行数）
    const batchSize = config.githubToken ? 5 : 3;

    // バッチ処理で並列化
    for (let i = 0; i < reposToProcess.length; i += batchSize) {
      const batch = reposToProcess.slice(i, i + batchSize);

      const batchPromises = batch.map(async (repo) => {
        try {
          const commits = await getRepoCommits(
            username,
            username,
            repo.name,
            since,
            config.githubToken,
          );

          if (commits > 0) {
            return { commits, isOwned: true };
          }
          return null;
        } catch (error) {
          console.error(`Error processing repo ${repo.name}:`, error);
          return null;
        }
      });

      const results = await Promise.all(batchPromises);

      for (const result of results) {
        if (result) {
          totalCommits += result.commits;
          repoSources.owned++;
          processedRepos++;
        }
      }

      // バッチ間の小さな遅延
      if (i + batchSize < reposToProcess.length) {
        await new Promise((resolve) =>
          setTimeout(resolve, config.githubToken ? 100 : 200)
        );
      }
    }
  }

  // 組織リポジトリも含める場合
  if (config.includeOrgRepos && processedRepos < 20) {
    const orgResult = await getOrgRepoCommits(
      username,
      config,
      since,
      20 - processedRepos,
    );
    totalCommits += orgResult.commits;
    repoSources.org = orgResult.repos;
    processedRepos += orgResult.repos;
  }

  return { commits: totalCommits, sources: repoSources };
}

// 元気度の判定
function getHealthStatus(
  commits: number,
  healthyThreshold: number,
  moderateThreshold: number,
): "healthy" | "moderate" | "inactive" {
  if (commits >= healthyThreshold) {
    return "healthy";
  } else if (commits >= moderateThreshold) {
    return "moderate";
  } else {
    return "inactive";
  }
}

// 有効なバッジスタイル
const VALID_BADGE_STYLES = [
  "flat",
  "flat-square",
  "plastic",
  "for-the-badge",
  "social",
] as const;
type BadgeStyle = typeof VALID_BADGE_STYLES[number];

// バッジスタイルの検証
function isValidBadgeStyle(style: string): style is BadgeStyle {
  return VALID_BADGE_STYLES.includes(style as BadgeStyle);
}

// SVGバッジの生成（badge-makerを使用）
function generateBadgeSVG(
  status: "healthy" | "moderate" | "inactive",
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

// キャッシュチェック（JST更新時刻考慮）
function shouldUpdateCache(
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
async function updateCacheInBackground(
  env: Env,
  config: ReturnType<typeof getConfig>,
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
