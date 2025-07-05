import type { Env, Config, HealthStatus } from "./types";

// 設定値の取得
export function getConfig(env: Env): Config {
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

// リトライ付きfetch関数
export async function fetchWithRetry(
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
export function isBotAccount(login?: string, name?: string, email?: string): boolean {
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

// 元気度の判定
export function getHealthStatus(
  commits: number,
  healthyThreshold: number,
  moderateThreshold: number,
): HealthStatus {
  if (commits >= healthyThreshold) {
    return "healthy";
  } else if (commits >= moderateThreshold) {
    return "moderate";
  } else {
    return "inactive";
  }
}