import { jsonResponse } from '../utils/response.js';
import { createPasswordHash, generateToken, verifyToken } from '../../auth-utils.js';
import { calculateTrialEndDate } from '../../stripe-config.js';
import { handlePasswordLogin as handleLogin } from './password-login.js';
import { handleUpdateProfile, handleUploadAvatar } from './profile.js';

export { handleLogin, handleUpdateProfile, handleUploadAvatar };

function serializeUser(user) {
  return {
    username: user.username,
    email: user.email || '',
    nickname: user.nickname || user.username,
    avatar: user.avatar || user.alipay_avatar || user.wechat_headimgurl || null,
    phoneNumber: user.phone_number || null,
    firebaseUid: user.firebase_uid || null,
    alipayUserId: user.alipay_user_id || null,
    alipayNickname: user.alipay_nickname || null,
    alipayAvatar: user.alipay_avatar || null,
    hasPassword: Boolean(user.password_hash && user.salt),
    mainPractice: user.main_practice_title ? {
      title: user.main_practice_title,
      filePath: user.main_practice_file_path,
      selectedAt: user.main_practice_selected_at
    } : null,
    createdAt: user.created_at,
    emailVerified: user.email_verified === 1,
    membership: {
      type: user.membership_type || 'expired',
      expiresAt: user.membership_expires_at || user.free_trial_end_date || null
    }
  };
}

async function safeRun(db, sql, ...params) {
  try {
    await db.prepare(sql).bind(...params).run();
  } catch (error) {
    console.warn('账户删除引用清理跳过:', error?.message || error);
  }
}

async function runInTransaction(db, action) {
  await db.prepare('BEGIN TRANSACTION').run();
  try {
    const result = await action();
    await db.prepare('COMMIT').run();
    return result;
  } catch (error) {
    try {
      await db.prepare('ROLLBACK').run();
    } catch (rollbackError) {
      console.warn('账户删除事务回滚失败:', rollbackError?.message || rollbackError);
    }
    throw error;
  }
}

async function deleteUserArtifacts(db, username, email) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const deletions = [
    ['DELETE FROM meditation_group_members WHERE group_id IN (SELECT id FROM meditation_groups WHERE owner_username = ?)', username],
    ['DELETE FROM meditation_groups WHERE owner_username = ?', username],
    ['DELETE FROM meditation_group_members WHERE username = ?', username],
    ['DELETE FROM meditation_records WHERE username = ?', username],
    ['DELETE FROM meditation_goals WHERE username = ?', username],
    ['DELETE FROM meditation_settings WHERE username = ?', username],
    ['DELETE FROM user_practice_privacy WHERE username = ?', username],
    ['DELETE FROM user_follows WHERE follower_username = ? OR following_username = ?', username, username],
    ['DELETE FROM notifications WHERE username = ? OR related_username = ?', username, username],
    ['DELETE FROM sync_log WHERE username = ?', username],
    ['DELETE FROM user_sync_state WHERE username = ?', username],
    ['DELETE FROM comments WHERE user_id = ? OR username = ?', username, username],
    ['DELETE FROM likes WHERE username = ?', username],
    ['DELETE FROM favorites WHERE username = ?', username],
    ['DELETE FROM content_likes WHERE user_id = ? OR username = ?', username, username],
    ['DELETE FROM content_favorites WHERE username = ?', username],
    ['DELETE FROM content_reports WHERE reporter_user_id = ?', username],
    ['DELETE FROM user_blocks WHERE blocked_user_id = ?', username],
    ['DELETE FROM email_username_mapping WHERE username = ?', username],
  ];

  if (normalizedEmail) {
    deletions.push(['DELETE FROM email_username_mapping WHERE email = ?', normalizedEmail]);
  }

  for (const [sql, ...params] of deletions) {
    await safeRun(db, sql, ...params);
  }
}

async function clearLeaderboardCaches(env) {
  await Promise.allSettled([
    env.USERS_KV?.delete('leaderboard:cache'),
    env.USERS_KV?.delete('leaderboard:cache:v2'),
    env.USERS_KV?.delete('leaderboard:practice:v2'),
    env.USERS_KV?.delete('leaderboard:practice:v3'),
    env.USERS_KV?.delete('leaderboard:practice:v4')
  ]);
}

// 注册
export async function handleRegister(request, env, db) {
  const { username, email, password, verificationCode } = await request.json();

  if (!username || !email || !password || !verificationCode) {
    return jsonResponse({ error: '缺少必要字段' }, 400);
  }

  const normalizedUsername = String(username).trim();
  const normalizedEmail = String(email).trim().toLowerCase();

  if (normalizedUsername.includes('@') || /\s/.test(normalizedUsername)) {
    return jsonResponse({ error: '用户名不能包含 @ 或空格' }, 400);
  }

  const verifyData = await env.USERS_KV.get(`verify:${normalizedEmail}`);
  if (!verifyData) {
    return jsonResponse({ error: '验证码不存在或已过期' }, 400);
  }

  const { code, expiry } = JSON.parse(verifyData);
  if (Date.now() > expiry || verificationCode !== code) {
    return jsonResponse({ error: '验证码错误或已过期' }, 400);
  }

  const existingUser = await db.getUser(normalizedUsername);
  if (existingUser) {
    return jsonResponse({ error: '用户名已存在' }, 400);
  }

  const existingEmail = await db.getUserByEmail(normalizedEmail);
  if (existingEmail) {
    return jsonResponse({ error: '该邮箱已被注册' }, 400);
  }

  const creds = await createPasswordHash(password);
  const trialEndDate = calculateTrialEndDate();

  await db.createUser({
    username: normalizedUsername,
    email: normalizedEmail,
    passwordHash: creds.passwordHash,
    salt: creds.salt,
    iterations: creds.iterations,
    algo: creds.algo,
    emailVerified: true,
    membershipType: 'trial',
    freeTrialEndDate: trialEndDate.toISOString(),
    createdAt: new Date().toISOString()
  });

  await env.USERS_KV.delete(`verify:${normalizedEmail}`);

  return jsonResponse({ message: '注册成功' }, 201);
}

// 获取用户信息
export async function handleGetUserInfo(request, env, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse({ error: '未提供认证信息' }, 401);
  }

  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  if (!tokenData) {
    return jsonResponse({ error: '认证失败' }, 401);
  }

  const user = await db.getUser(tokenData.username);
  if (!user) {
    return jsonResponse({ error: '用户不存在' }, 404);
  }

  return jsonResponse(serializeUser(user));
}

// Firebase手机号登录/注册
export async function handleFirebasePhoneLogin(request, env, db) {
  try {
    const { idToken, phoneNumber, firebaseUid, isNewUser } = await request.json();

    if (!idToken || !phoneNumber || !firebaseUid) {
      return jsonResponse({ error: '缺少必要参数' }, 400);
    }

    let user = await db.getUserByPhone(phoneNumber);
    if (!user) {
      user = await db.getUserByFirebaseUid(firebaseUid);
    }

    let token;
    let username;

    if (user) {
      if (user.firebase_uid !== firebaseUid || user.phone_number !== phoneNumber) {
        await db.prepare(`
          UPDATE users SET firebase_uid = ?, phone_number = ?, updated_at = ?
          WHERE username = ?
        `).bind(firebaseUid, phoneNumber, new Date().toISOString(), user.username).run();
        user = await db.getUser(user.username);
      }

      username = user.username;
      token = await generateToken(username, env);

      return jsonResponse({
        success: true,
        token,
        username,
        isNewUser: false,
        user: serializeUser(user)
      });
    }

    username = `user_${Date.now().toString(36)}`;
    const email = `${firebaseUid}@phone.user`;
    const trialEndDate = calculateTrialEndDate();

    await db.createPhoneUser({
      username,
      email,
      phoneNumber,
      firebaseUid,
      membershipType: 'trial',
      freeTrialEndDate: trialEndDate.toISOString(),
      createdAt: new Date().toISOString()
    });

    token = await generateToken(username, env);
    const createdUser = await db.getUser(username);

    return jsonResponse({
      success: true,
      token,
      username,
      isNewUser: isNewUser ?? true,
      user: createdUser ? serializeUser(createdUser) : {
        username,
        email,
        phoneNumber,
        membership: { type: 'trial', expiresAt: trialEndDate.toISOString() }
      }
    });
  } catch (error) {
    console.error('Firebase手机登录失败:', error);
    return jsonResponse({ error: 'Firebase手机登录失败: ' + error.message }, 500);
  }
}

// Apple登录/注册
export async function handleAppleLogin(request, env, db) {
  try {
    const { identityToken, authorizationCode, email, givenName, familyName } = await request.json();

    if (!identityToken || !authorizationCode) {
      return jsonResponse({ error: '缺少必要参数 (identityToken, authorizationCode)' }, 400);
    }

    let appleUserId;
    let appleEmail;
    try {
      const parts = identityToken.split('.');
      if (parts.length !== 3) {
        return jsonResponse({ error: 'identityToken 格式错误' }, 400);
      }
      const payloadB64 = parts[1];
      const base64 = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
      const pad = base64.length % 4 === 2 ? '==' : base64.length % 4 === 3 ? '=' : '';
      const payloadStr = atob(base64 + pad);
      const payload = JSON.parse(payloadStr);

      appleUserId = payload.sub;
      appleEmail = payload.email || email;

      if (!appleUserId) {
        return jsonResponse({ error: 'identityToken 中缺少 sub 字段' }, 400);
      }

      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) {
        return jsonResponse({ error: 'identityToken 已过期' }, 401);
      }
    } catch (e) {
      console.error('解析 Apple identityToken 失败:', e);
      return jsonResponse({ error: '解析 identityToken 失败: ' + e.message }, 400);
    }

    let user = await db.getUserByAppleId(appleUserId);

    if (user) {
      const username = user.username;
      const token = await generateToken(username, env);
      const updates = {};
      if (appleEmail && !user.email) updates.email = appleEmail;
      const fullName = [givenName, familyName].filter(Boolean).join(' ');
      if (fullName && !user.nickname) updates.nickname = username;
      if (Object.keys(updates).length > 0) await db.updateUser(username, updates);
      user = await db.getUser(username);

      return jsonResponse({ success: true, token, username, isNewUser: false, user: serializeUser(user) });
    }

    const username = `apple_${Date.now().toString(36)}`;
    const userEmail = appleEmail || `${appleUserId.substring(0, 16)}@apple.user`;
    const trialEndDate = calculateTrialEndDate();

    const existingEmailUser = await db.db.prepare('SELECT * FROM users WHERE email = ?').bind(userEmail).first();
    if (existingEmailUser) {
      await db.updateUser(existingEmailUser.username, { apple_user_id: appleUserId, nickname: existingEmailUser.username });
      const token = await generateToken(existingEmailUser.username, env);
      const updated = await db.getUser(existingEmailUser.username);
      return jsonResponse({ success: true, token, username: existingEmailUser.username, isNewUser: false, user: serializeUser(updated) });
    }

    await db.createAppleUser({
      username,
      email: userEmail,
      appleUserId,
      nickname: username,
      membershipType: 'trial',
      membershipExpiresAt: trialEndDate.toISOString(),
      createdAt: new Date().toISOString()
    });

    const token = await generateToken(username, env);
    const createdUser = await db.getUser(username);
    return jsonResponse({ success: true, token, username, isNewUser: true, user: serializeUser(createdUser) });
  } catch (error) {
    console.error('Apple登录失败:', error);
    return jsonResponse({ error: 'Apple登录失败: ' + error.message }, 500);
  }
}

// 注销账户
export async function handleDeleteAccount(request, env, db) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: '未提供认证信息' }, 401);
    }

    const token = authHeader.substring(7);
    const tokenData = await verifyToken(token, env);
    if (!tokenData) {
      return jsonResponse({ error: '认证失效，请重新登录' }, 401);
    }

    const user = await db.getUser(tokenData.username);
    if (!user) {
      return jsonResponse({ error: '用户不存在' }, 404);
    }

    await runInTransaction(db, async () => {
      await deleteUserArtifacts(db, tokenData.username, user.email);

      if (db.deleteUser) {
        await db.deleteUser(tokenData.username);
      } else {
        await db.prepare('DELETE FROM users WHERE username = ?').bind(tokenData.username).run();
      }
    });

    await clearLeaderboardCaches(env);

    return jsonResponse({ success: true, message: '账户已注销' }, 200);
  } catch (error) {
    console.error('注销账户失败:', error);
    return jsonResponse({ error: '服务器错误: ' + error.message }, 500);
  }
}
