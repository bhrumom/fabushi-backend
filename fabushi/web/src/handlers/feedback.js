import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';

const DEFAULT_REPO_OWNER = 'bhrumom';
const DEFAULT_REPO_NAME = 'fabushi';
const DEFAULT_LABEL = 'user-feedback';
const DEFAULT_LABEL_COLOR = '0e8a16';
const DEFAULT_LABEL_DESCRIPTION = 'User-submitted product feedback';

function normalizeText(value, { maxLength = 1000 } = {}) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\r\n/g, '\n').substring(0, maxLength);
}

function normalizeDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  try {
    const json = JSON.stringify(value);
    if (!json) {
      return null;
    }

    if (json.length <= 12000) {
      return JSON.parse(json);
    }

    return {
      truncated: true,
      preview: json.substring(0, 12000),
    };
  } catch (error) {
    console.warn('无法序列化诊断信息，将忽略该字段:', error);
    return null;
  }
}

async function resolveReporter(request, env, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return null;
  }

  try {
    const token = authHeader.substring(7);
    const tokenData = await verifyToken(token, env);
    if (!tokenData?.username) {
      return null;
    }

    const user = await db.getUser(tokenData.username);
    if (!user) {
      return { username: tokenData.username };
    }

    return {
      username: user.username,
      email: user.email || '',
      phoneNumber: user.phone_number || '',
    };
  } catch (error) {
    console.warn('反馈接口解析登录用户失败，将按匿名处理:', error);
    return null;
  }
}

function buildIssueBody({ feedback, reporter }) {
  const diagnosticsSection = feedback.diagnostics
    ? [
        '### 自动采集诊断信息',
        '',
        '```json',
        JSON.stringify(feedback.diagnostics, null, 2),
        '```',
        '',
      ]
    : [];

  const lines = [
    '## 用户反馈',
    '',
    `- 标题: ${feedback.title}`,
    `- 页面入口: ${feedback.page || 'unknown'}`,
    `- 平台: ${feedback.platform || 'unknown'}`,
    `- App 版本: ${feedback.appVersion || 'unknown'}`,
    `- 分类: ${feedback.category || 'general'}`,
    `- 自动采集: ${feedback.autoCollected ? '是' : '否'}`,
    `- 联系方式: ${feedback.contact || '未提供'}`,
    `- 提交时间: ${new Date().toISOString()}`,
    `- 登录用户: ${reporter?.username || 'anonymous'}`,
    reporter?.email ? `- 用户邮箱: ${reporter.email}` : null,
    reporter?.phoneNumber ? `- 用户手机号: ${reporter.phoneNumber}` : null,
    '',
    '### 问题描述',
    '',
    feedback.description,
    '',
    ...diagnosticsSection,
    '---',
    '',
    '_This issue was created automatically from the in-app feedback form._',
  ];

  return lines.filter(Boolean).join('\n');
}

async function githubRequest(env, path, init) {
  const token = env.GITHUB_FEEDBACK_TOKEN;
  if (!token) {
    throw new Error('missing_feedback_token');
  }

  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'fabushi-feedback-worker',
      ...init?.headers,
    },
  });

  return response;
}

async function ensureFeedbackLabel(env) {
  const owner = env.GITHUB_FEEDBACK_REPO_OWNER || DEFAULT_REPO_OWNER;
  const repo = env.GITHUB_FEEDBACK_REPO_NAME || DEFAULT_REPO_NAME;
  const label = env.GITHUB_FEEDBACK_LABEL || DEFAULT_LABEL;

  const response = await githubRequest(env, `/repos/${owner}/${repo}/labels`, {
    method: 'POST',
    body: JSON.stringify({
      name: label,
      color: DEFAULT_LABEL_COLOR,
      description: DEFAULT_LABEL_DESCRIPTION,
    }),
  });

  if (response.ok || response.status === 422) {
    return label;
  }

  const errorText = await response.text();
  throw new Error(`ensure_label_failed:${response.status}:${errorText}`);
}

function issueTitlePrefix(feedback) {
  return feedback.category === 'startup_crash' ? '[崩溃反馈]' : '[反馈]';
}

async function createFeedbackIssue(env, feedback, reporter) {
  const owner = env.GITHUB_FEEDBACK_REPO_OWNER || DEFAULT_REPO_OWNER;
  const repo = env.GITHUB_FEEDBACK_REPO_NAME || DEFAULT_REPO_NAME;
  const label = await ensureFeedbackLabel(env);

  const response = await githubRequest(env, `/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: `${issueTitlePrefix(feedback)} ${feedback.title}`,
      body: buildIssueBody({ feedback, reporter }),
      labels: [label],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`create_issue_failed:${response.status}:${errorText}`);
  }

  return response.json();
}

export async function handleSubmitFeedback(request, env, db) {
  try {
    if (!env.GITHUB_FEEDBACK_TOKEN) {
      return jsonResponse({
        success: false,
        error: '反馈服务暂未配置完成，请稍后再试。',
      }, 503);
    }

    const body = await request.json();
    const feedback = {
      title: normalizeText(body.title, { maxLength: 120 }),
      description: normalizeText(body.description, { maxLength: 5000 }),
      contact: normalizeText(body.contact, { maxLength: 200 }),
      page: normalizeText(body.page, { maxLength: 80 }),
      platform: normalizeText(body.platform, { maxLength: 80 }),
      appVersion: normalizeText(body.appVersion, { maxLength: 80 }),
      category: normalizeText(body.category, { maxLength: 80 }),
      autoCollected: body.autoCollected === true,
      diagnostics: normalizeDiagnostics(body.diagnostics),
    };

    if (!feedback.title) {
      return jsonResponse({ success: false, error: '请填写问题标题' }, 400);
    }

    if (!feedback.description) {
      return jsonResponse({ success: false, error: '请填写问题描述' }, 400);
    }

    const reporter = await resolveReporter(request, env, db);
    const issue = await createFeedbackIssue(env, feedback, reporter);

    return jsonResponse({
      success: true,
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      message: '反馈已提交，我们会尽快处理。',
    }, 201);
  } catch (error) {
    console.error('提交反馈失败:', error);

    const message = String(error?.message || error);
    if (message === 'missing_feedback_token') {
      return jsonResponse({
        success: false,
        error: '反馈服务暂未配置完成，请稍后再试。',
      }, 503);
    }

    return jsonResponse({
      success: false,
      error: '反馈提交失败，请稍后重试。',
    }, 502);
  }
}
