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
    const commitsResponse = await fetch(
      `https://api.github.com/repos/${repoOwner}/${repoName}/commits?author=${username}&since=${since.toISOString()}&per_page=100`,
      { headers: getGithubHeaders(token) },
    );

    console.log(commitsResponse.url);

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
      console.log(userCommits);

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
    const orgsResponse = await fetch(
      `https://api.github.com/users/${username}/orgs`,
      { headers: getGithubHeaders(config.githubToken) },
    );

    console.log(orgsResponse.url);

    if (!orgsResponse.ok) {
      console.error("Failed to fetch user organizations");
      return { commits: 0, repos: 0 };
    }

    const orgs = await orgsResponse.json() as Array<{ login: string }>;

    for (const org of orgs) {
      if (processedOrgRepos >= maxRepos) break;

      // 除外組織をスキップ
      if (config.excludeOrgs.includes(org.login)) {
        continue;
      }

      try {
        // 組織のパブリックリポジトリを取得
        const orgReposResponse = await fetch(
          `https://api.github.com/orgs/${org.login}/repos?type=public&sort=updated&per_page=${config.maxReposPerOrg}`,
          { headers: getGithubHeaders(config.githubToken) },
        );

        console.log(orgReposResponse.url);

        if (orgReposResponse.ok) {
          const orgRepos = await orgReposResponse.json() as Array<{
            name: string;
            updated_at: string;
          }>;

          for (const repo of orgRepos) {
            console.log(repo.name, repo.updated_at);
            if (processedOrgRepos >= maxRepos) break;

            console.log("Processing repo:", repo.name);

            // 除外リポジトリをスキップ
            if (config.excludeRepos.includes(repo.name)) {
              continue;
            }

            const repoUpdated = new Date(repo.updated_at);
            if (repoUpdated < since) {
              continue;
            }

            // このリポジトリにユーザーがコミットしているかチェック
            const commits = await getRepoCommits(
              username,
              org.login,
              repo.name,
              since,
              config.githubToken,
            );

            if (commits > 0) {
              totalOrgCommits += commits;
              processedOrgRepos++;
            }

            // レート制限対策
            await new Promise((resolve) =>
              setTimeout(resolve, config.githubToken ? 50 : 100)
            );
          }
        } else {
          console.error(await orgReposResponse.json());
          continue;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, config.githubToken ? 100 : 200)
        );
      } catch (error) {
        console.error(`Error processing org ${org.login}:`, error);
        continue;
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
  const ownedRepos = await fetch(
    `https://api.github.com/users/${username}/repos?type=owner&sort=updated&per_page=30`,
    { headers: getGithubHeaders(config.githubToken) },
  );

  if (ownedRepos.ok) {
    const repos = await ownedRepos.json() as Array<{
      name: string;
      updated_at: string;
    }>;

    for (const repo of repos) {
      if (processedRepos >= 20) break; // 全体で最大20リポジトリ

      // 除外リポジトリをスキップ
      if (config.excludeRepos.includes(repo.name)) {
        continue;
      }

      const repoUpdated = new Date(repo.updated_at);
      if (repoUpdated < since) continue;

      const commits = await getRepoCommits(
        username,
        username,
        repo.name,
        since,
        config.githubToken,
      );

      if (commits > 0) {
        totalCommits += commits;
        repoSources.owned++;
        processedRepos++;
      }

      // レート制限対策
      await new Promise((resolve) =>
        setTimeout(resolve, config.githubToken ? 50 : 100)
      );
    }
  }

  console.log(processedRepos, totalCommits);

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

    if (
      cached && !shouldUpdateCache(cached.lastUpdated, config.jstUpdateHour)
    ) {
      data = cached;
    } else {
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
