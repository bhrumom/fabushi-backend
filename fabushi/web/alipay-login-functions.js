// 支付宝登录相关处理函数

import { generateToken, verifyToken, jsonResponse, verifyPassword, createPasswordHash } from './auth-utils.js';
import { importPrivateKey, importPublicKey, generateSign, verifySign } from './alipay-utils.js';
import { calculateTrialEndDate } from './stripe-config.js';
import { generateUserNo } from './src/services/external-numbers.js';
import { serializeAccountUser } from './src/contracts/account-user.js';

const DEFAULT_WORKER_URL = 'https://api.ombhrum.com';
const DEFAULT_WEB_APP_URL = 'https://ombhrum.com';

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function buildUrl(baseUrl, path) {
  return `${trimTrailingSlash(baseUrl)}${path}`;
}

function generateSecureState() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }
  throw new Error('当前运行环境不支持安全随机数生成');
}

function getWorkerUrl(env) {
  return trimTrailingSlash(env.WORKER_URL || DEFAULT_WORKER_URL);
}

function getWebAppUrl(env) {
  return trimTrailingSlash(
    env.ALIPAY_WEB_APP_URL ||
      env.WEB_APP_URL ||
      env.FRONTEND_URL ||
      DEFAULT_WEB_APP_URL
  );
}

function createAlipayWebRedirectUrl(env) {
  return new URL('/index.html', getWebAppUrl(env) + '/');
}

function getAlipayOAuthRedirectUrl(env, callbackType) {
  if (callbackType === 'mobile') {
    return env.ALIPAY_MOBILE_AUTH_REDIRECT_URL ||
      env.ALIPAY_AUTH_REDIRECT_URL ||
      buildUrl(getWorkerUrl(env), '/api/auth/alipay/callback');
  }

  if (callbackType === 'macos') {
    return env.ALIPAY_MACOS_AUTH_REDIRECT_URL ||
      buildUrl(getWorkerUrl(env), '/api/auth/alipay/macos-callback');
  }

  return env.ALIPAY_WEB_AUTH_REDIRECT_URL ||
    env.ALIPAY_AUTH_REDIRECT_URL ||
    buildUrl(getWorkerUrl(env), '/api/auth/alipay/callback');
}

// 生成支付宝登录URL
async function generateAlipayLoginUrl(env, platform) {
  try {
    console.log('生成支付宝登录URL开始');

    // 检查平台参数
    let callbackType = 'web';
    let isMobileApp = false;
    let isMacOSApp = false;

    if (platform === 'macos') {
      isMacOSApp = true;
      callbackType = 'macos';
    } else if (platform === 'ios' || platform === 'android') {
      isMobileApp = true;
      callbackType = 'mobile';
    }

    console.log('平台检测:', { platform, isMobileApp, isMacOSApp, callbackType });

    console.log('环境变量检查:', {
      hasAppId: !!env.ALIPAY_APP_ID,
      hasWorkerUrl: !!env.WORKER_URL,
      hasUsersKv: !!env.USERS_KV,
      isMobileApp,
      isMacOSApp,
      callbackType
    });

    const state = generateSecureState();
    const appId = env.ALIPAY_APP_ID;

    if (!appId) {
      console.error('支付宝应用ID未配置');
      return jsonResponse({ error: '支付宝应用ID未配置' }, 500);
    }

    const alipayRedirectUrl = getAlipayOAuthRedirectUrl(env, callbackType);
    const redirectUri = encodeURIComponent(alipayRedirectUrl);

    const authUrl = `https://openauth.alipay.com/oauth2/publicAppAuthorize.htm?app_id=${appId}&scope=auth_user&redirect_uri=${redirectUri}&state=${state}`;

    // 存储state用于验证，macOS应用需要特殊标记
    if (env.DB) {
      const stateData = {
        type: platform === 'cli' ? 'cli' : callbackType,
        timestamp: Date.now(),
        valid: true,
        status: 'pending'
      };
      const expiresAt = new Date(Date.now() + 600000).toISOString(); // 10分钟后过期
      await env.DB.prepare(
        'INSERT INTO alipay_states (state, state_data, expires_at) VALUES (?, ?, ?)'
      ).bind(state, JSON.stringify(stateData), expiresAt).run();
      console.log('state已存储到D1:', stateData);
    } else {
      console.warn('DB未绑定，跳过state存储');
    }

    const response = jsonResponse({
      authUrl: authUrl,
      state: state,
      appId: appId,
      platform: callbackType
    });

    console.log('支付宝登录 URL 已生成:', { platform: callbackType });
    return response;

  } catch (error) {
    console.error('生成支付宝登录URL失败:', error);
    console.error('错误堆栈:', error.stack);
    return jsonResponse({ error: '生成支付宝登录URL失败: ' + error.message }, 500);
  }
}

// 通过支付宝授权码获取用户信息
async function getAlipayUserInfo(authCode, env) {
  const appId = env.ALIPAY_APP_ID;
  const privateKey = env.ALIPAY_PRIVATE_KEY;
  const alipayPublicKey = env.ALIPAY_PUBLIC_KEY;

  console.log('获取支付宝用户信息开始:', {
    hasAuthCode: Boolean(authCode),
    hasAppId: !!appId,
    hasPrivateKey: !!privateKey,
    hasAlipayPublicKey: !!alipayPublicKey,
    appIdLength: appId ? appId.length : 0
  });

  try {
    // 检查授权码是否有效
    if (!authCode || authCode.length < 10) {
      console.error('授权码无效: 授权码为空或太短');
      return {
        error: true,
        code: 'CODE_INVALID',
        message: '支付宝授权失败: 授权码无效或格式错误',
        details: { authCode: authCode ? 'invalid_format' : 'missing' }
      };
    }

    // 检查必要的支付宝配置
    if (!appId || !privateKey || !alipayPublicKey) {
      console.warn('支付宝配置不完整，使用模拟数据');
      console.warn('缺少的配置:', {
        appId: !appId,
        privateKey: !privateKey,
        alipayPublicKey: !alipayPublicKey
      });

      // 模拟用户信息（仅用于开发测试）
      const mockUserInfo = {
        user_id: 'mock_alipay_user_' + Date.now(),
        nick_name: '支付宝用户',
        avatar: 'https://tfsimg.alipay.com/images/partner/T1kFldXk0rXXXXXXXX',
        province: '浙江省',
        city: '杭州市',
        gender: 'M',
        isMock: true // 标记为模拟数据
      };
      return mockUserInfo;
    }

    // 第一步：使用auth_code换取access_token和user_id
    console.log('开始调用支付宝API获取access_token...');

    // 检查授权码是否已使用过（防止重复调用）
    if (env.USERS_KV) {
      const usedAuthCode = await env.USERS_KV.get(`used_auth_code:${authCode}`);
      if (usedAuthCode) {
        console.error('支付宝授权码已被使用');
        return {
          error: true,
          code: 'CODE_REUSED',
          message: '支付宝授权失败: 授权码已被使用，请重新登录',
          details: { reason: 'auth_code_already_used' }
        };
      }
    }

    const tokenResult = await getAccessToken(authCode, env);

    if (!tokenResult || tokenResult.code !== '10000') {
      console.error('获取access_token失败:', {
        code: tokenResult?.code,
        subCode: tokenResult?.sub_code,
        message: tokenResult?.msg || tokenResult?.sub_msg
      });
      // 不再抛出异常，而是返回错误信息
      const errorMsg = tokenResult?.msg || tokenResult?.sub_msg || '未知错误';

      // 检查是否是授权码无效错误
      if (tokenResult?.sub_code === 'isv.code-invalid' ||
        tokenResult?.sub_msg?.includes('授权码code无效')) {
        return {
          error: true,
          code: 'CODE_INVALID',
          message: '支付宝授权失败: 授权码已过期或无效，请重新尝试',
          details: tokenResult
        };
      }

      return {
        error: true,
        code: tokenResult?.code || 'UNKNOWN_ERROR',
        message: '支付宝授权失败: ' + errorMsg,
        details: tokenResult
      };
    }

    // 成功获取token后，标记授权码为已使用
    if (env.USERS_KV) {
      await env.USERS_KV.put(`used_auth_code:${authCode}`, '1', { expirationTtl: 3600 }); // 1小时内不能重复使用
      console.log('支付宝授权码已标记为已使用');
    }

    const { access_token, user_id, alipay_user_id, open_id } = tokenResult;
    const subject = getAlipayProviderSubject(tokenResult);
    console.log('成功获取access_token和支付宝身份:', {
      hasAccessToken: !!access_token,
      providerSubjectType: subject.type,
      hasUserId: !!user_id,
      hasOpenId: !!open_id,
      hasDeprecatedAlipayUserId: !!alipay_user_id
    });

    // 第二步：使用access_token获取用户详细信息
    console.log('开始获取用户详细信息...');
    const userInfoResult = await getUserInfoWithToken(access_token, env);

    if (!userInfoResult || userInfoResult.code !== '10000') {
      console.error('获取用户信息失败:', userInfoResult);
      // 如果获取用户信息失败，但至少返回了基本的user_id信息
      return {
        user_id: subject.value,
        provider_subject: subject.value,
        subject_type: subject.type,
        legacy_user_id: user_id || alipay_user_id || null,
        open_id: open_id || null,
        alipay_user_id: alipay_user_id || user_id || null,
        nick_name: userInfoResult?.nick_name || '支付宝用户',
        avatar: userInfoResult?.avatar || '',
        province: userInfoResult?.province || '',
        city: userInfoResult?.city || '',
        gender: userInfoResult?.gender || 'M',
        partial: true, // 标记这是部分信息
        error: userInfoResult?.code !== '10000' ? {
          code: userInfoResult?.code,
          message: userInfoResult?.msg || userInfoResult?.sub_msg,
          details: userInfoResult
        } : null
      };
    }

    const userInfo = userInfoResult;
    console.log('成功获取支付宝用户信息');

    return {
      user_id: subject.value,
      provider_subject: subject.value,
      subject_type: subject.type,
      legacy_user_id: user_id || alipay_user_id || null,
      open_id: open_id || null,
      alipay_user_id: alipay_user_id || user_id || null,
      nick_name: userInfo.nick_name || '支付宝用户',
      avatar: userInfo.avatar || '',
      province: userInfo.province || '',
      city: userInfo.city || '',
      gender: userInfo.gender || 'M'
    };

  } catch (error) {
    console.error('获取支付宝用户信息失败:', error);
    throw error;
  }
}

async function getUserByUsername(env, username) {
  if (!username) return null;
  return await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
}

async function getUserById(env, userId) {
  const normalizedUserId = Number(userId);
  if (!Number.isFinite(normalizedUserId)) return null;
  return await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(normalizedUserId).first();
}

async function getUserByUserNo(env, userNo) {
  const normalizedUserNo = Number(userNo);
  if (!Number.isFinite(normalizedUserNo)) return null;
  return await env.DB.prepare('SELECT * FROM users WHERE user_no = ?').bind(normalizedUserNo).first();
}

async function generateUniqueAlipayUserNo(env) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const candidate = generateUserNo();
    const existing = await getUserByUserNo(env, candidate);
    if (!existing) return candidate;
  }
  throw new Error('无法生成可用的 9 位用户号');
}

function normalizeIdentityValue(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function getAlipayProviderSubject(identity) {
  if (!identity || typeof identity !== 'object') {
    return {
      value: normalizeIdentityValue(identity),
      type: 'user_id',
      legacySubject: null
    };
  }

  const explicitSubject = normalizeIdentityValue(
    identity.provider_subject ||
      identity.providerSubject ||
      identity.alipayProviderSubject
  );
  if (explicitSubject) {
    return {
      value: explicitSubject,
      type: identity.subject_type || identity.subjectType || identity.alipaySubjectType || 'provider_subject',
      legacySubject: normalizeIdentityValue(identity.legacy_user_id || identity.legacyUserId)
    };
  }

  const openId = normalizeIdentityValue(
    identity.open_id ||
      identity.openId ||
      identity.alipayOpenId ||
      identity.alipay_open_id
  );
  const userId = normalizeIdentityValue(
    identity.user_id ||
      identity.userId ||
      identity.alipayUserId ||
      identity.alipay_user_id
  );

  if (openId) {
    return {
      value: openId,
      type: 'open_id',
      legacySubject: userId && userId !== openId ? userId : null
    };
  }

  return {
    value: userId,
    type: userId ? 'user_id' : null,
    legacySubject: null
  };
}

function getAlipayLookupSubjects(identity) {
  const subject = getAlipayProviderSubject(identity);
  return [subject.value, subject.legacySubject]
    .map(normalizeIdentityValue)
    .filter((value, index, values) => value && values.indexOf(value) === index);
}

function getAlipayPrimarySubject(identity) {
  return getAlipayProviderSubject(identity).value;
}

function getAlipayRegistrationIdentity(payload) {
  return {
    provider_subject: payload.alipayProviderSubject || payload.providerSubject || payload.alipayUserId,
    subject_type: payload.alipaySubjectType || payload.subjectType || (payload.alipayProviderSubject ? 'provider_subject' : 'user_id'),
    legacy_user_id: payload.alipayLegacyUserId || payload.alipay_legacy_user_id || payload.legacyUserId || null
  };
}

function sanitizeSyntheticEmailSubject(value) {
  return String(value || 'unknown')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80);
}

async function getUserByAlipayBinding(env, identity) {
  const identifiers = getAlipayLookupSubjects(identity);
  if (identifiers.length === 0) return null;

  for (const identifier of identifiers) {
    const binding = await env.DB.prepare(
      'SELECT user_id, username FROM alipay_bindings WHERE alipay_user_id = ?'
    ).bind(identifier).first();

    if (binding?.user_id !== undefined && binding?.user_id !== null) {
      const user = await getUserById(env, binding.user_id);
      if (user) return user;
    }

    if (binding?.username) {
      const user = await getUserByUsername(env, binding.username);
      if (user) return user;
    }
  }

  for (const identifier of identifiers) {
    const user = await env.DB.prepare(
      'SELECT * FROM users WHERE alipay_user_id = ?'
    ).bind(identifier).first();
    if (user) return user;
  }

  return null;
}

async function getUserIdentityByUsername(env, username) {
  if (!username) return null;
  return await env.DB.prepare(
    'SELECT * FROM users WHERE username = ?'
  ).bind(username).first();
}

function alipayCallbackUserParams(user, alipayUser) {
  const userNo = user.user_no ?? user.id ?? '';
  const subject = getAlipayProviderSubject(alipayUser);
  return [
    `user_no=${encodeURIComponent(String(userNo))}`,
    `alipay_provider_subject=${encodeURIComponent(subject.value || '')}`,
    `alipay_subject_type=${encodeURIComponent(subject.type || '')}`,
    `alipay_user_id=${encodeURIComponent(subject.value || '')}`,
    `alipay_nickname=${encodeURIComponent(alipayUser.nick_name || user.alipay_nickname || user.nickname || '')}`,
    `alipay_avatar=${encodeURIComponent(alipayUser.avatar || user.alipay_avatar || user.avatar || '')}`,
  ].join('&');
}

function alipayRegistrationParams(alipayUser) {
  const subject = getAlipayProviderSubject(alipayUser);
  return [
    `alipay_provider_subject=${encodeURIComponent(subject.value || '')}`,
    `alipay_subject_type=${encodeURIComponent(subject.type || '')}`,
    `alipay_user_id=${encodeURIComponent(subject.value || '')}`,
    `alipay_nickname=${encodeURIComponent(alipayUser.nick_name || '')}`,
    `alipay_avatar=${encodeURIComponent(alipayUser.avatar || '')}`,
  ].join('&');
}

async function writeEmailUsernameMapping(env, email, user) {
  if (!email || !user?.username || user?.id === undefined || user?.id === null) return;
  await env.DB.prepare(
    'INSERT INTO email_username_mapping (email, username, user_id) VALUES (?, ?, ?)'
  ).bind(email, user.username, user.id).run();
}

async function writeAlipayBinding(env, alipayUserId, user, replaceExisting = false) {
  if (!alipayUserId || !user?.username || user?.id === undefined || user?.id === null) return;
  const sql = replaceExisting
    ? 'INSERT OR REPLACE INTO alipay_bindings (alipay_user_id, username, user_id, bound_at) VALUES (?, ?, ?, ?)'
    : 'INSERT INTO alipay_bindings (alipay_user_id, username, user_id, bound_at) VALUES (?, ?, ?, ?)';
  await env.DB.prepare(sql).bind(alipayUserId, user.username, user.id, new Date().toISOString()).run();
}

async function writeAlipayBindings(env, identity, user) {
  const providerSubject = getAlipayPrimarySubject(identity);
  await writeAlipayBinding(env, providerSubject, user, true);
}

async function backfillAlipayIdentity(env, user, identity, profile = {}) {
  if (!user?.id) return;

  const updates = {};
  const primaryUserId = getAlipayPrimarySubject(identity);

  if (primaryUserId && !user.alipay_user_id) {
    updates.alipay_user_id = primaryUserId;
  }
  if (profile.nick_name && !user.alipay_nickname) {
    updates.alipay_nickname = profile.nick_name;
  }
  if (profile.avatar && !user.alipay_avatar) {
    updates.alipay_avatar = profile.avatar;
  }
  if (primaryUserId && !user.alipay_bound_at) {
    updates.alipay_bound_at = new Date().toISOString();
  }

  if (Object.keys(updates).length > 0) {
    const fields = Object.keys(updates);
    const assignments = fields.map((field) => `${field} = ?`).join(', ');
    await env.DB.prepare(`UPDATE users SET ${assignments}, updated_at = ? WHERE id = ?`)
      .bind(...fields.map((field) => updates[field]), new Date().toISOString(), user.id)
      .run();
  }

  await writeAlipayBindings(env, identity, user);
}

// 处理支付宝登录
async function handleAlipayLogin(request, env) {
  try {
    const { auth_code, state } = await request.json();

    if (!auth_code) {
      return jsonResponse({ error: '缺少授权码' }, 400);
    }

    // 验证state
    if (state) {
      const storedState = await env.DB.prepare(
        'SELECT state_data FROM alipay_states WHERE state = ? AND expires_at > datetime("now")'
      ).bind(state).first();
      if (!storedState) {
        return jsonResponse({ error: '无效的state参数' }, 400);
      }
      // 删除已使用的state
      await env.DB.prepare('DELETE FROM alipay_states WHERE state = ?').bind(state).run();
    }

    // 获取支付宝用户信息
    const alipayUser = await getAlipayUserInfo(auth_code, env);

    // 检查是否是授权码无效错误
    if (alipayUser.error) {
      if (alipayUser.code === 'CODE_INVALID' ||
        alipayUser.sub_code === 'isv.code-invalid' ||
        (typeof alipayUser.error === 'string' && alipayUser.error.includes('授权码已过期或无效')) ||
        (typeof alipayUser.error === 'object' && alipayUser.error.message && typeof alipayUser.error.message === 'string' && alipayUser.error.message.includes('授权码已过期或无效'))) {
        return jsonResponse({
          error: '支付宝授权失败: 授权码已过期或无效，请重新尝试',
          code: 'CODE_INVALID',
          sub_code: alipayUser.sub_code,
          sub_msg: alipayUser.sub_msg
        }, 400);
      }
      const errorMessage = typeof alipayUser.error === 'string' ? alipayUser.error :
        (typeof alipayUser.error === 'object' && alipayUser.error.message ? alipayUser.error.message : '支付宝登录失败');
      return jsonResponse({ error: errorMessage }, 500);
    }

    const user = await getUserByAlipayBinding(env, alipayUser);
    if (user) {
      await backfillAlipayIdentity(env, user, alipayUser, alipayUser);
      const token = await generateToken({ id: user.id, username: user.username }, env);
      const subject = getAlipayProviderSubject(alipayUser);
      return jsonResponse({
        success: true,
        token,
        username: user.username,
        userId: user.id,
        userNo: user.user_no ?? user.id ?? null,
        isNewUser: false,
        loginMethod: 'alipay',
        alipayUser: {
          userId: subject.value,
          providerSubject: subject.value,
          subjectType: subject.type,
          nickname: alipayUser.nick_name,
          avatar: alipayUser.avatar
        },
        user: serializeAccountUser(user)
      });
    }

    // 新用户或未注册，返回用户信息供前端处理
    return jsonResponse({
      alipayUser,
      isNewUser: true,
      needsRegistration: true
    });

  } catch (error) {
    console.error('支付宝登录失败:', error);
    return jsonResponse({ error: '支付宝登录失败: ' + error.message }, 500);
  }
}

// 注册新用户（支持一键注册）
async function registerAlipayUser(request, env) {
  try {
    const payload = await request.json();
    const { username, email, password, captcha, alipayNickname, alipayAvatar, oneClick } = payload;
    const alipayIdentity = getAlipayRegistrationIdentity(payload);
    const alipayProviderSubject = getAlipayPrimarySubject(alipayIdentity);
    const alipaySubjectType = getAlipayProviderSubject(alipayIdentity).type;

    // 一键注册模式：自动生成用户名和邮箱
    if (oneClick === true) {
      if (!alipayProviderSubject) {
        return jsonResponse({ error: '缺少支付宝用户标识' }, 400);
      }

      const existingUser = await getUserByAlipayBinding(env, alipayIdentity);
      if (existingUser) {
        await backfillAlipayIdentity(
          env,
          existingUser,
          alipayIdentity,
          { nick_name: alipayNickname, avatar: alipayAvatar }
        );
        const token = await generateToken({ id: existingUser.id, username: existingUser.username }, env);
        return jsonResponse({
          success: true,
          message: '支付宝账号已登录',
          token,
          username: existingUser.username,
          userId: existingUser.id,
          userNo: existingUser.user_no ?? existingUser.id ?? null,
          email: existingUser.email,
          isNewUser: false,
          isOneClick: true,
          alipayProviderSubject,
          alipaySubjectType,
          user: serializeAccountUser(existingUser)
        });
      }

      // 生成默认用户名（基于支付宝昵称或用户ID）
      const baseUsername = alipayNickname || '支付宝用户';
      let autoUsername = baseUsername;
      let counter = 1;

      // 确保用户名唯一
      let usernameCheck = await env.DB.prepare(
        'SELECT username FROM users WHERE username = ?'
      ).bind(autoUsername).first();
      while (usernameCheck) {
        autoUsername = `${baseUsername}_${counter}`;
        counter++;
        usernameCheck = await env.DB.prepare(
          'SELECT username FROM users WHERE username = ?'
        ).bind(autoUsername).first();
      }

      // 生成唯一邮箱（添加时间戳确保唯一性）
      const autoEmail = `alipay_${sanitizeSyntheticEmailSubject(alipayProviderSubject)}_${Date.now()}@alipay.user`;

      // 创建新用户
      const creds = await createPasswordHash('alipay_default_password'); // 默认密码
      const userNo = await generateUniqueAlipayUserNo(env);

      const userData = {
        username: autoUsername,
        userNo,
        email: autoEmail,
        password: creds.passwordHash,
        alipayProviderSubject,
        alipaySubjectType,
        alipayNickname: alipayNickname,
        alipayAvatar: alipayAvatar,
        alipayBoundAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        emailVerified: true, // 支付宝用户默认已验证
        membershipType: 'trial', // 默认试用会员
        membershipExpiresAt: calculateTrialEndDate().toISOString()
      };

      await env.DB.prepare(`
        INSERT INTO users (
          user_no, username, email, password_hash, salt, iterations, algo,
          email_verified, membership_type, membership_expires_at,
          alipay_user_id, alipay_nickname, alipay_avatar,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        userNo, autoUsername, autoEmail, creds.passwordHash, creds.salt, creds.iterations, creds.algo,
        1,
        'trial',
        calculateTrialEndDate().toISOString(),
        alipayProviderSubject, alipayNickname || '支付宝用户', alipayAvatar || null,
        new Date().toISOString(), new Date().toISOString()
      ).run();

      const createdUser = await getUserIdentityByUsername(env, autoUsername);
      if (!createdUser) {
        throw new Error('支付宝一键注册成功后未能读取 users.id');
      }

      await writeEmailUsernameMapping(env, autoEmail, createdUser);
      await writeAlipayBindings(
        env,
        alipayIdentity,
        createdUser
      );

      const token = await generateToken({ id: createdUser.id, username: createdUser.username }, env);

      return jsonResponse({
        success: true,
        message: '一键注册成功',
        token,
        username: createdUser.username,
        userId: createdUser.id,
        userNo: createdUser.user_no ?? userNo,
        email: createdUser.email,
        isOneClick: true,
        alipayProviderSubject,
        alipaySubjectType,
        user: serializeAccountUser(createdUser)
      });
    }

    // 传统注册模式：需要完整信息
    const normalizedEmail = email.toLowerCase().trim();
    const normalizedUsername = username.trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return jsonResponse({ error: '邮箱格式不正确' }, 400);
    }

    if (password.length < 6) {
      return jsonResponse({ error: '密码长度至少6位' }, 400);
    }

    if (!normalizedUsername || normalizedUsername.length < 2) {
      return jsonResponse({ error: '用户名至少2个字符' }, 400);
    }

    if (!captcha || captcha.length < 4) {
      return jsonResponse({ error: '请输入有效的验证码' }, 400);
    }

    if (!alipayProviderSubject) {
      return jsonResponse({ error: '缺少支付宝用户标识' }, 400);
    }

    const existingEmail = await env.DB.prepare(
      'SELECT user_id, username FROM email_username_mapping WHERE email = ?'
    ).bind(normalizedEmail).first();
    if (existingEmail) {
      return jsonResponse({ error: '该邮箱已被注册' }, 400);
    }

    const existingAlipay = await getUserByAlipayBinding(env, alipayIdentity);
    if (existingAlipay) {
      return jsonResponse({ error: '该支付宝账号已注册其他用户' }, 400);
    }

    const creds = await createPasswordHash(password);
    const userNo = await generateUniqueAlipayUserNo(env);

    await env.DB.prepare(`
      INSERT INTO users (
        user_no, username, email, password_hash, salt, iterations, algo,
        email_verified, membership_type,
        alipay_user_id, alipay_nickname, alipay_avatar,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userNo, normalizedUsername, normalizedEmail, creds.passwordHash, creds.salt, creds.iterations, creds.algo,
      1, 'free',
      alipayProviderSubject, alipayNickname || '支付宝用户', alipayAvatar || null,
      new Date().toISOString(), new Date().toISOString()
    ).run();

    const createdUser = await getUserIdentityByUsername(env, normalizedUsername);
    if (!createdUser) {
      throw new Error('支付宝注册成功后未能读取 users.id');
    }

    await writeEmailUsernameMapping(env, normalizedEmail, createdUser);
    await writeAlipayBindings(
      env,
      alipayIdentity,
      createdUser
    );

    const token = await generateToken({ id: createdUser.id, username: createdUser.username }, env);

    return jsonResponse({
      success: true,
      message: '注册成功',
      token,
      username: createdUser.username,
      userId: createdUser.id,
      userNo: createdUser.user_no ?? userNo,
      email: createdUser.email,
      alipayProviderSubject,
      alipaySubjectType,
      user: serializeAccountUser(createdUser)
    });

  } catch (error) {
    console.error('支付宝用户注册失败:', error);
    return jsonResponse({ error: '注册失败: ' + error.message }, 500);
  }
}

// 发送注册验证码
async function sendRegistrationCaptcha(request, env) {
  try {
    const payload = await request.json();
    const { username, password, nickname, avatar, email } = payload;
    const alipayIdentity = getAlipayRegistrationIdentity(payload);
    const alipayProviderSubject = getAlipayPrimarySubject(alipayIdentity);
    const alipaySubjectType = getAlipayProviderSubject(alipayIdentity).type;

    if (!alipayProviderSubject || !username || !password) {
      return jsonResponse({ error: '缺少必要参数' }, 400);
    }

    const normalizedUsername = String(username).trim();
    const normalizedEmail = email ? String(email).trim().toLowerCase() : null;

    const existingUser = await env.DB.prepare(
      'SELECT username FROM users WHERE username = ?'
    ).bind(normalizedUsername).first();
    if (existingUser) {
      return jsonResponse({ error: '用户名已存在' }, 400);
    }

    if (normalizedEmail) {
      const emailMapped = await env.DB.prepare(
        'SELECT user_id, username FROM email_username_mapping WHERE email = ?'
      ).bind(normalizedEmail).first();
      if (emailMapped) {
        return jsonResponse({ error: '该邮箱已被注册' }, 400);
      }
    }

    const existingBinding = await getUserByAlipayBinding(env, alipayIdentity);
    if (existingBinding) {
      return jsonResponse({ error: '该支付宝账号已注册其他用户' }, 400);
    }

    const creds = await createPasswordHash(password);
    const userNo = await generateUniqueAlipayUserNo(env);
    const trialEndDate = calculateTrialEndDate();

    await env.DB.prepare(`
      INSERT INTO users (
        user_no, username, email, password_hash, salt, iterations, algo,
        email_verified, membership_type, membership_expires_at,
        alipay_user_id, alipay_nickname, alipay_avatar,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userNo, normalizedUsername, normalizedEmail, creds.passwordHash, creds.salt, creds.iterations, creds.algo,
      normalizedEmail ? 1 : 0, 'trial', trialEndDate.toISOString(),
      alipayProviderSubject, nickname || '支付宝用户', avatar || '',
      new Date().toISOString(), new Date().toISOString()
    ).run();

    const createdUser = await getUserIdentityByUsername(env, normalizedUsername);
    if (!createdUser) {
      throw new Error('支付宝注册成功后未能读取 users.id');
    }

    if (normalizedEmail) {
      await writeEmailUsernameMapping(env, normalizedEmail, createdUser);
    }
    await writeAlipayBindings(
      env,
      alipayIdentity,
      createdUser
    );

    const token = await generateToken({ id: createdUser.id, username: createdUser.username }, env);
    return jsonResponse({
      token,
      username: createdUser.username,
      userId: createdUser.id,
      userNo: createdUser.user_no ?? userNo,
      alipayProviderSubject,
      alipaySubjectType,
      user: serializeAccountUser(createdUser),
      message: '注册成功，支付宝账号已注册'
    }, 201);

  } catch (error) {
    console.error('支付宝注册失败:', error);
    return jsonResponse({ error: '支付宝注册失败: ' + error.message }, 500);
  }
}

// 检查邮箱是否可用（注册前检查）
async function checkEmailAvailability(request, env) {
  try {
    const { email } = await request.json();

    const normalizedEmail = email.toLowerCase().trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return jsonResponse({ error: '邮箱格式不正确' }, 400);
    }

    const existingUser = await env.DB.prepare(
      'SELECT user_id, username FROM email_username_mapping WHERE email = ?'
    ).bind(normalizedEmail).first();

    return jsonResponse({
      success: true,
      available: !existingUser,
      message: existingUser ? '该邮箱已被注册' : '邮箱可用'
    });

  } catch (error) {
    console.error('邮箱检查失败:', error);
    return jsonResponse({ error: '邮箱检查失败: ' + error.message }, 500);
  }
}

// 处理支付宝回调（Web）
async function handleAlipayCallback(request, env) {
  try {
    const url = new URL(request.url);
    const authCode = url.searchParams.get('auth_code');
    const state = url.searchParams.get('state');

    console.log('收到支付宝回调:', {
      hasAuthCode: Boolean(authCode),
      hasState: Boolean(state)
    });

    if (!authCode) {
      const redirectUrl = createAlipayWebRedirectUrl(env);
      redirectUrl.hash = 'error=missing_auth_code&error_message=缺少授权码';
      return Response.redirect(redirectUrl.toString(), 302);
    }

    if (authCode.length < 10) {
      console.error('支付宝回调授权码格式无效');
      const redirectUrl = createAlipayWebRedirectUrl(env);
      redirectUrl.hash = 'error=invalid_auth_code&error_message=授权码格式无效';
      return Response.redirect(redirectUrl.toString(), 302);
    }

    let callbackStateType = 'web';
    if (state) {
      const storedState = await env.DB.prepare(
        'SELECT state_data FROM alipay_states WHERE state = ? AND expires_at > datetime("now")'
      ).bind(state).first();
      if (!storedState) {
        console.error('支付宝回调 state 参数无效');
        const redirectUrl = createAlipayWebRedirectUrl(env);
        redirectUrl.hash = 'error=invalid_state&error_message=登录状态无效，请重新登录';
        return Response.redirect(redirectUrl.toString(), 302);
      }

      try {
        const stateData = JSON.parse(storedState.state_data);
        callbackStateType = stateData.type || 'web';
        if (stateData.type === 'mobile') {
          console.log('标准OAuth回调检测到移动端state，转入移动端回调处理');
          return await handleMobileAlipayCallback(request, env);
        }
        if (stateData.type === 'macos') {
          console.log('标准OAuth回调检测到macOS state，转入macOS回调处理');
          return await handleMacOSAlipayCallback(request, env);
        }
      } catch (parseError) {
        console.warn('解析state数据失败，继续按Web回调处理:', parseError);
      }

      if (callbackStateType !== 'cli') {
        await env.DB.prepare('DELETE FROM alipay_states WHERE state = ?').bind(state).run();
      }
    }

    const alipayUser = await getAlipayUserInfo(authCode, env);
    console.log('支付宝用户信息已获取:', {
      hasProviderSubject: Boolean(getAlipayPrimarySubject(alipayUser))
    });

    if (!alipayUser || !alipayUser.user_id) {
      console.error('支付宝用户信息不完整');
      const redirectUrl = createAlipayWebRedirectUrl(env);
      redirectUrl.hash = 'error=invalid_alipay_user&error_message=支付宝用户信息不完整';
      return Response.redirect(redirectUrl.toString(), 302);
    }

    const user = await getUserByAlipayBinding(env, alipayUser);
    if (user) {
      await backfillAlipayIdentity(env, user, alipayUser, alipayUser);
      const token = await generateToken({ id: user.id, username: user.username }, env);
      if (callbackStateType === 'cli' && state) {
        const cliSession = {
          type: 'cli',
          status: 'complete',
          token,
          username: user.username,
          user: serializeAccountUser(user)
        };
        const expiresAt = new Date(Date.now() + 600000).toISOString();
        await env.DB.prepare(
          'UPDATE alipay_states SET state_data = ?, expires_at = ? WHERE state = ?'
        ).bind(JSON.stringify(cliSession), expiresAt, state).run();
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>大乘 CLI 登录成功</title><main style="font:16px system-ui;max-width:560px;margin:15vh auto;padding:24px"><h1>大乘 CLI 登录成功</h1><p>授权已安全交给正在等待的终端，现在可以关闭此页面。</p></main>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
      const redirectUrl = createAlipayWebRedirectUrl(env);
      redirectUrl.hash = `token=${token}&username=${encodeURIComponent(user.username)}&login_method=alipay&${alipayCallbackUserParams(user, alipayUser)}`;

      console.log('支付宝登录成功，正在跳转到 Flutter 主应用');
      return Response.redirect(redirectUrl.toString(), 302);
    }

    if (callbackStateType === 'cli' && state) {
      const cliRegistration = {
        type: 'cli',
        status: 'registration_required',
        needsRegistration: true
      };
      await env.DB.prepare(
        'UPDATE alipay_states SET state_data = ? WHERE state = ?'
      ).bind(JSON.stringify(cliRegistration), state).run();
    }
    const redirectUrl = createAlipayWebRedirectUrl(env);
    redirectUrl.hash = `alipay_auth_code=${authCode}&${alipayRegistrationParams(alipayUser)}&needs_registration=true&login_method=alipay`;

    console.log('支付宝账号需要注册，正在跳转到 Flutter 主应用');
    return Response.redirect(redirectUrl.toString(), 302);

  } catch (error) {
    console.error('支付宝回调处理失败:', error);
    const redirectUrl = createAlipayWebRedirectUrl(env);
    redirectUrl.hash = `error=callback_failed&error_message=${encodeURIComponent(error.message || '支付宝登录处理失败')}`;
    return Response.redirect(redirectUrl.toString(), 302);
  }
}

// CLI OAuth completion is a one-time capability keyed by the random state.
// The access token is deleted from D1 immediately after the Rust client reads it.
async function handleAlipayCliSession(request, env) {
  const state = new URL(request.url).searchParams.get('state')?.trim();
  if (!state) return jsonResponse({ error: '缺少登录状态' }, 400);
  const row = await env.DB.prepare(
    'SELECT state_data FROM alipay_states WHERE state = ? AND expires_at > datetime("now")'
  ).bind(state).first();
  if (!row) return jsonResponse({ error: '登录状态不存在或已过期' }, 404);

  let data;
  try {
    data = JSON.parse(row.state_data);
  } catch {
    return jsonResponse({ error: '登录状态损坏' }, 500);
  }
  if (data.type !== 'cli') return jsonResponse({ error: '登录状态类型不匹配' }, 404);
  if (data.status === 'pending') {
    return jsonResponse({ success: true, status: 'pending' }, 202);
  }
  if (data.status === 'registration_required') {
    await env.DB.prepare(
      'DELETE FROM alipay_states WHERE state = ? AND state_data = ?'
    ).bind(state, row.state_data).run();
    return jsonResponse({
      success: false,
      status: 'registration_required',
      needsRegistration: true,
      error: '该支付宝账号需要先在大乘 App 中完成注册'
    }, 409);
  }
  if (data.status !== 'complete' || !data.token) {
    return jsonResponse({ error: '登录状态无效' }, 409);
  }
  const consumed = await env.DB.prepare(
    'DELETE FROM alipay_states WHERE state = ? AND state_data = ?'
  ).bind(state, row.state_data).run();
  if (consumed.meta?.changes === 0) {
    return jsonResponse({ error: '登录结果已被读取' }, 409);
  }
  return jsonResponse({
    success: true,
    status: 'complete',
    token: data.token,
    username: data.username,
    user: data.user
  });
}

// 处理 macOS 支付宝回调
async function handleMacOSAlipayCallback(request, env) {
  try {
    const url = new URL(request.url);
    const authCode = url.searchParams.get('auth_code');
    const state = url.searchParams.get('state');

    console.log('收到 macOS 支付宝回调:', {
      hasAuthCode: Boolean(authCode),
      hasState: Boolean(state)
    });

    const appScheme = 'com.ombhrum.fabushi://';

    if (!authCode) {
      const redirectUrl = `${appScheme}error=missing_auth_code&error_message=${encodeURIComponent('缺少授权码')}`;
      return Response.redirect(redirectUrl, 302);
    }

    if (state) {
      const storedStateData = await env.DB.prepare(
        'SELECT state_data FROM alipay_states WHERE state = ? AND expires_at > datetime("now")'
      ).bind(state).first();
      if (!storedStateData) {
        const redirectUrl = `${appScheme}error=invalid_state&error_message=${encodeURIComponent('登录状态无效，请重新登录')}`;
        return Response.redirect(redirectUrl, 302);
      }
      await env.DB.prepare('DELETE FROM alipay_states WHERE state = ?').bind(state).run();
    }

    const alipayUser = await getAlipayUserInfo(authCode, env);
    if (!alipayUser || !alipayUser.user_id) {
      const redirectUrl = `${appScheme}error=invalid_alipay_user&error_message=${encodeURIComponent('支付宝用户信息不完整')}`;
      return Response.redirect(redirectUrl, 302);
    }

    const user = await getUserByAlipayBinding(env, alipayUser);
    if (user) {
      await backfillAlipayIdentity(env, user, alipayUser, alipayUser);
      const token = await generateToken({ id: user.id, username: user.username }, env);
      const redirectUrl = `${appScheme}alipay_auth_code=${authCode}&state=${state || ''}&token=${token}&username=${encodeURIComponent(user.username)}&isNewUser=false&loginMethod=alipay&${alipayCallbackUserParams(user, alipayUser)}`;
      return Response.redirect(redirectUrl, 302);
    }

    const redirectUrl = `${appScheme}alipay_auth_code=${authCode}&state=${state || ''}&isNewUser=true&needsRegistration=true&loginMethod=alipay&${alipayRegistrationParams(alipayUser)}`;
    return Response.redirect(redirectUrl, 302);
  } catch (error) {
    console.error('macOS 支付宝回调处理失败:', error);
    const redirectUrl = `com.ombhrum.fabushi://error=callback_failed&error_message=${encodeURIComponent(error.message || '支付宝登录处理失败')}`;
    return Response.redirect(redirectUrl, 302);
  }
}

// 导出函数
// 使用auth_code换取access_token和user_id
async function getAccessToken(authCode, env) {
  try {
    const appId = env.ALIPAY_APP_ID;
    const privateKey = env.ALIPAY_PRIVATE_KEY;

    console.log('开始获取支付宝 access_token:', { hasAuthCode: Boolean(authCode) });

    // 验证授权码格式
    if (!authCode || authCode.length < 10) {
      console.error('授权码格式无效:', { authCode: authCode ? 'invalid_length' : 'missing' });
      return {
        code: 'CODE_INVALID',
        msg: '授权码无效',
        sub_code: 'isv.code-invalid',
        sub_msg: '授权码格式错误或已过期'
      };
    }

    // 检查支付宝配置
    if (!appId || !privateKey) {
      console.error('支付宝配置缺失:', {
        hasAppId: !!appId,
        hasPrivateKey: !!privateKey
      });
      return {
        code: 'CONFIG_ERROR',
        msg: '支付宝配置不完整',
        sub_code: 'missing_config',
        sub_msg: '缺少必要的支付宝API配置'
      };
    }

    // 构建请求参数
    const timestamp = new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).replace(/\//g, '-');
    const params = {
      app_id: appId,
      method: 'alipay.system.oauth.token',
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: timestamp,
      version: '1.0',
      grant_type: 'authorization_code',
      code: authCode
    };

    // 导入私钥并生成签名
    const privateKeyObj = await importPrivateKey(privateKey);
    const sign = await generateSign(params, privateKeyObj);
    params.sign = sign;

    console.log('支付宝 access_token 请求已签名:', {
      appId: Boolean(appId),
      sandbox: env.ALIPAY_USE_SANDBOX === 'true'
    });

    const gatewayUrl = env.ALIPAY_USE_SANDBOX === 'true' ?
      'https://openapi-sandbox.dl.alipaydev.com/gateway.do' :
      'https://openapi.alipay.com/gateway.do';
    const response = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      body: new URLSearchParams(params).toString()
    });

    if (!response.ok) {
      throw new Error(`支付宝API请求失败: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    console.log('支付宝 access_token 响应已收到:', {
      hasSuccessResponse: Boolean(result.alipay_system_oauth_token_response),
      hasErrorResponse: Boolean(result.error_response)
    });

    if (result.alipay_system_oauth_token_response) {
      const tokenResponse = result.alipay_system_oauth_token_response;
      if (tokenResponse.access_token) {
        const alipayUserId = tokenResponse.user_id || null;
        const alipayOpenId = tokenResponse.open_id || null;
        const deprecatedAlipayUserId = tokenResponse.alipay_user_id || null;
        const subject = getAlipayProviderSubject({
          user_id: alipayUserId,
          open_id: alipayOpenId,
          alipay_user_id: deprecatedAlipayUserId
        });
        return {
          code: '10000',
          access_token: tokenResponse.access_token,
          user_id: alipayUserId,
          open_id: alipayOpenId,
          provider_subject: subject.value,
          subject_type: subject.type,
          legacy_user_id: subject.legacySubject,
          alipay_user_id: deprecatedAlipayUserId,
          expires_in: tokenResponse.expires_in,
          refresh_token: tokenResponse.refresh_token,
          re_expires_in: tokenResponse.re_expires_in
        };
      } else if (tokenResponse.code) {
        return {
          code: tokenResponse.code,
          msg: tokenResponse.msg,
          sub_code: tokenResponse.sub_code,
          sub_msg: tokenResponse.sub_msg
        };
      }
      return {
        code: 'UNKNOWN_ERROR',
        msg: '支付宝API返回未知响应格式',
        sub_code: 'unknown',
        sub_msg: JSON.stringify(tokenResponse)
      };
    } else if (result.error_response) {
      const errorResponse = result.error_response;
      console.error('支付宝API错误响应:', errorResponse);
      return {
        code: errorResponse.code || 'API_ERROR',
        msg: errorResponse.msg || '支付宝API返回错误',
        sub_code: errorResponse.sub_code || 'unknown',
        sub_msg: errorResponse.sub_msg || JSON.stringify(errorResponse)
      };
    }

    console.error('支付宝 API 响应格式不正确');
    return {
      code: 'INVALID_RESPONSE',
      msg: '支付宝API响应格式不正确',
      sub_code: 'invalid_format',
      sub_msg: '响应缺少 alipay_system_oauth_token_response 字段'
    };

  } catch (error) {
    console.error('获取access_token失败:', error);
    throw error;
  }
}

// 使用access_token获取用户详细信息
async function getUserInfoWithToken(accessToken, env) {
  try {
    const appId = env.ALIPAY_APP_ID;
    const privateKey = env.ALIPAY_PRIVATE_KEY;

    const timestamp = new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).replace(/\//g, '-');
    const params = {
      app_id: appId,
      method: 'alipay.user.info.share',
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: timestamp,
      version: '1.0',
      auth_token: accessToken
    };

    const privateKeyObj = await importPrivateKey(privateKey);
    const sign = await generateSign(params, privateKeyObj);
    params.sign = sign;

    console.log('支付宝用户信息请求已签名:', {
      appId: Boolean(appId),
      sandbox: env.ALIPAY_USE_SANDBOX === 'true'
    });

    const gatewayUrl = env.ALIPAY_USE_SANDBOX === 'true' ?
      'https://openapi-sandbox.dl.alipaydev.com/gateway.do' :
      'https://openapi.alipay.com/gateway.do';
    const response = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      body: new URLSearchParams(params).toString()
    });

    if (!response.ok) {
      throw new Error(`支付宝API请求失败: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    console.log('支付宝用户信息响应已收到:', {
      hasSuccessResponse: Boolean(result.alipay_user_info_share_response),
      hasErrorResponse: Boolean(result.error_response)
    });

    if (result.alipay_user_info_share_response) {
      const userInfoResponse = result.alipay_user_info_share_response;
      if (userInfoResponse.code === '10000') {
        return {
          code: '10000',
          nick_name: userInfoResponse.nick_name || '支付宝用户',
          avatar: userInfoResponse.avatar || '',
          province: userInfoResponse.province || '',
          city: userInfoResponse.city || '',
          gender: userInfoResponse.gender || 'M',
          user_type: userInfoResponse.user_type,
          is_certified: userInfoResponse.is_certified,
          is_student_certified: userInfoResponse.is_student_certified
        };
      }
      return {
        code: userInfoResponse.code,
        msg: userInfoResponse.msg,
        sub_code: userInfoResponse.sub_code,
        sub_msg: userInfoResponse.sub_msg
      };
    } else if (result.error_response) {
      const errorResponse = result.error_response;
      console.error('支付宝用户信息API错误响应:', errorResponse);
      return {
        code: errorResponse.code || 'API_ERROR',
        msg: errorResponse.msg || '支付宝用户信息API返回错误',
        sub_code: errorResponse.sub_code || 'unknown',
        sub_msg: errorResponse.sub_msg || JSON.stringify(errorResponse)
      };
    }

    console.error('支付宝用户信息 API 响应格式不正确');
    return {
      code: 'INVALID_RESPONSE',
      msg: '支付宝用户信息API响应格式不正确',
      sub_code: 'invalid_format',
      sub_msg: '响应缺少 alipay_user_info_share_response 字段'
    };

  } catch (error) {
    console.error('获取用户信息失败:', error);
    throw error;
  }
}

// 处理移动端应用（iOS/Android）支付宝登录回调 - 重定向到App的URL Scheme
async function handleMobileAlipayCallback(request, env) {
  try {
    const url = new URL(request.url);
    const authCode = url.searchParams.get('auth_code');
    const state = url.searchParams.get('state');

    console.log('收到移动端应用支付宝登录回调:', {
      hasAuthCode: Boolean(authCode),
      hasState: Boolean(state)
    });

    const appScheme = 'com.ombhrum.fabushi://';

    if (!authCode) {
      const redirectUrl = `${appScheme}error=missing_auth_code&error_message=${encodeURIComponent('缺少授权码')}`;
      console.error('移动端支付宝回调缺少授权码，重定向到应用:', redirectUrl);
      return Response.redirect(redirectUrl, 302);
    }

    if (authCode.length < 10) {
      console.error('移动端支付宝回调授权码格式无效');
      const redirectUrl = `${appScheme}error=invalid_auth_code&error_message=${encodeURIComponent('授权码格式无效')}`;
      return Response.redirect(redirectUrl, 302);
    }

    if (state) {
      const storedStateData = await env.DB.prepare(
        'SELECT state_data FROM alipay_states WHERE state = ? AND expires_at > datetime("now")'
      ).bind(state).first();
      if (!storedStateData) {
        console.error('移动端支付宝回调 state 参数无效');
        const redirectUrl = `${appScheme}error=invalid_state&error_message=${encodeURIComponent('登录状态无效，请重新登录')}`;
        return Response.redirect(redirectUrl, 302);
      }

      try {
        const stateData = JSON.parse(storedStateData.state_data);
        if (stateData.type !== 'mobile') {
          console.warn('state类型不匹配，期望mobile，实际:', stateData.type);
        }
      } catch (parseError) {
        console.warn('解析state数据失败:', parseError);
      }

      await env.DB.prepare('DELETE FROM alipay_states WHERE state = ?').bind(state).run();
    }

    const alipayUserResult = await getAlipayUserInfo(authCode, env);

    if (alipayUserResult.error) {
      console.error('获取支付宝用户信息失败:', alipayUserResult);

      if (alipayUserResult.code === 'CODE_INVALID' || alipayUserResult.code === 'CODE_REUSED') {
        const errorMessage = alipayUserResult.message || '支付宝授权失败';
        const redirectUrl = `${appScheme}error=auth_failed&error_message=${encodeURIComponent(errorMessage)}&error_code=${alipayUserResult.code}`;
        console.log('移动端支付宝授权失败，重定向到应用:', redirectUrl);
        return Response.redirect(redirectUrl, 302);
      }

      return jsonResponse({
        error: '支付宝登录失败',
        details: alipayUserResult.message,
        code: alipayUserResult.code,
        fullError: alipayUserResult.details
      }, 500);
    }

    const alipayUser = alipayUserResult;
    console.log('移动端已获取支付宝用户信息:', {
      hasProviderSubject: Boolean(getAlipayPrimarySubject(alipayUser))
    });

    if (!alipayUser || !alipayUser.user_id) {
      console.error('移动端应用支付宝用户信息不完整:', alipayUser);
      const redirectUrl = `${appScheme}error=invalid_alipay_user&error_message=${encodeURIComponent('支付宝用户信息不完整')}`;
      return Response.redirect(redirectUrl, 302);
    }

    const user = await getUserByAlipayBinding(env, alipayUser);
    if (user) {
      await backfillAlipayIdentity(env, user, alipayUser, alipayUser);
      console.log('🔐 移动端生成 token 前 - JWT_SECRET 状态:', env.JWT_SECRET ? '已配置' : '未配置');
      const token = await generateToken({ id: user.id, username: user.username }, env);
      console.log('✅ 移动端 token 已生成');

      console.log('移动端应用支付宝登录成功，用户已注册');

      const redirectUrl = `${appScheme}alipay_auth_code=${authCode}&state=${state}&token=${token}&username=${encodeURIComponent(user.username)}&isNewUser=false&loginMethod=alipay&${alipayCallbackUserParams(user, alipayUser)}`;

      console.log('移动端应用支付宝登录成功，正在重定向到应用');
      return Response.redirect(redirectUrl, 302);
    }

    console.log('移动端应用新用户或未注册支付宝账号，重定向到应用进行注册');

    const redirectUrl = `${appScheme}alipay_auth_code=${authCode}&state=${state}&isNewUser=true&needsRegistration=true&loginMethod=alipay&${alipayRegistrationParams(alipayUser)}`;

    console.log('移动端支付宝账号需要注册，正在重定向到应用');
    return Response.redirect(redirectUrl, 302);

  } catch (error) {
    console.error('移动端应用支付宝回调处理失败:', error);
    const redirectUrl = `com.ombhrum.fabushi://error=callback_failed&error_message=${encodeURIComponent(error.message || '支付宝登录处理失败')}`;
    return Response.redirect(redirectUrl, 302);
  }
}

// ==================== SDK授权登录 ====================

/**
 * 生成支付宝SDK授权字符串
 * 用于移动端SDK直接调用支付宝APP进行授权
 * 授权字符串需要使用应用私钥签名
 */
async function generateAlipayAuthString(env) {
  try {
    const appId = env.ALIPAY_APP_ID;
    const privateKey = env.ALIPAY_PRIVATE_KEY;

    if (!appId || !privateKey) {
      console.error('支付宝配置不完整', { hasAppId: !!appId, hasPrivateKey: !!privateKey });
      return jsonResponse({ error: '支付宝配置不完整' }, 500);
    }

    const pid = env.ALIPAY_PID;
    if (!pid) {
      console.error('警告: ALIPAY_PID 未配置，SDK授权可能失败');
    }

    const targetId = generateSecureState();

    const authParams = {
      apiname: 'com.alipay.account.auth',
      app_id: appId,
      app_name: 'mc',
      auth_type: 'AUTHACCOUNT',
      biz_type: 'openservice',
      method: 'alipay.open.auth.sdk.code.get',
      product_id: 'APP_FAST_LOGIN',
      scope: 'auth_user',
      sign_type: 'RSA2',
      target_id: targetId,
    };

    if (pid) {
      authParams.pid = pid;
    }

    console.log('正在生成支付宝 SDK 授权字符串');

    const cryptoKey = await importPrivateKey(privateKey);
    const sign = await generateSign(authParams, cryptoKey);

    console.log('签名生成成功，长度:', sign.length);

    const authStrParts = [];
    const sortedKeys = Object.keys(authParams).sort();
    for (const key of sortedKeys) {
      authStrParts.push(`${key}=${authParams[key]}`);
    }
    authStrParts.push(`sign=${encodeURIComponent(sign)}`);

    const authString = authStrParts.join('&');

    console.log('生成的授权字符串长度:', authString.length);

    return jsonResponse({
      success: true,
      authString: authString,
      targetId: targetId
    });

  } catch (error) {
    console.error('生成SDK授权字符串失败:', error);
    return jsonResponse({ error: '生成授权字符串失败: ' + error.message }, 500);
  }
}

/**
 * 处理获取SDK授权字符串请求 - API端点处理函数
 */
async function handleGetAlipayAuthString(request, env) {
  return await generateAlipayAuthString(env);
}

/**
 * 处理SDK授权登录（接收auth_code，换取用户信息并登录）
 */
async function handleAlipaySDKLogin(request, env) {
  try {
    const { auth_code, target_id } = await request.json();

    if (!auth_code) {
      return jsonResponse({ error: '缺少授权码auth_code' }, 400);
    }

    console.log('正在完成支付宝 SDK 授权登录');

    const alipayUser = await getAlipayUserInfo(auth_code, env);

    if (alipayUser.error) {
      console.error('获取支付宝用户信息失败:', alipayUser);

      if (alipayUser.code === 'CODE_INVALID' || alipayUser.code === 'CODE_REUSED') {
        return jsonResponse({
          error: alipayUser.message || '支付宝授权失败',
          code: alipayUser.code
        }, 400);
      }

      return jsonResponse({
        error: '支付宝登录失败',
        details: alipayUser.message
      }, 500);
    }

    console.log('支付宝 SDK 用户信息已获取');

    if (!alipayUser || !alipayUser.user_id) {
      return jsonResponse({ error: '支付宝用户信息不完整' }, 400);
    }

    const user = await getUserByAlipayBinding(env, alipayUser);
    if (user) {
      await backfillAlipayIdentity(env, user, alipayUser, alipayUser);
      const token = await generateToken({ id: user.id, username: user.username }, env);
      const subject = getAlipayProviderSubject(alipayUser);

      return jsonResponse({
        success: true,
        token,
        username: user.username,
        userId: user.id,
        userNo: user.user_no ?? user.id ?? null,
        isNewUser: false,
        loginMethod: 'alipay_sdk',
        alipayUser: {
          userId: subject.value,
          providerSubject: subject.value,
          subjectType: subject.type,
          nickname: alipayUser.nick_name,
          avatar: alipayUser.avatar
        },
        user: serializeAccountUser(user)
      });
    }

    return jsonResponse({
      success: true,
      isNewUser: true,
      needsRegistration: true,
      alipayUser: {
        userId: getAlipayPrimarySubject(alipayUser),
        providerSubject: getAlipayPrimarySubject(alipayUser),
        subjectType: getAlipayProviderSubject(alipayUser).type,
        nickname: alipayUser.nick_name,
        avatar: alipayUser.avatar
      }
    });

  } catch (error) {
    console.error('SDK授权登录失败:', error);
    return jsonResponse({ error: 'SDK登录失败: ' + error.message }, 500);
  }
}

export { generateAlipayLoginUrl, getAlipayUserInfo, handleAlipayLogin, registerAlipayUser, checkEmailAvailability, sendRegistrationCaptcha, getAccessToken, getUserInfoWithToken, handleAlipayCallback, handleAlipayCliSession, handleMacOSAlipayCallback, handleMobileAlipayCallback, generateAlipayAuthString, handleGetAlipayAuthString, handleAlipaySDKLogin };
