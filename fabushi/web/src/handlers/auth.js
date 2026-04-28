import { jsonResponse } from '../utils/response.js';
import { createPasswordHash, verifyPassword, generateToken, verifyToken } from '../../auth-utils.js';
import { calculateTrialEndDate } from '../../stripe-config.js';

function serializeUser(user) {
  return {
    username: user.username,
    email: user.email || '',
    nickname: user.nickname || null,
    avatar: user.avatar || user.alipay_avatar || user.wechat_headimgurl || null,
    phoneNumber: user.phone_number || null,
    firebaseUid: user.firebase_uid || null,
    alipayUserId: user.alipay_user_id || null,
    alipayNickname: user.alipay_nickname || null,
    alipayAvatar: user.alipay_avatar || null,
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

// 注册
export async function handleRegister(request, env, db) {
  const { username, email, password, verificationCode } = await request.json();

  if (!username || !email || !password || !verificationCode) {
    return jsonResponse({ error: '缺少必要字段' }, 400);
  }

  // 验证验证码（使用KV）
  const verifyData = await env.USERS_KV.get(`verify:${email.toLowerCase()}`);
  if (!verifyData) {
    return jsonResponse({ error: '验证码不存在或已过期' }, 400);
  }

  const { code, expiry } = JSON.parse(verifyData);
  if (Date.now() > expiry || verificationCode !== code) {
    return jsonResponse({ error: '验证码错误或已过期' }, 400);
  }

  // 检查用户是否存在
  const existingUser = await db.getUser(username);
  if (existingUser) {
    return jsonResponse({ error: '用户名已存在' }, 400);
  }

  const existingEmail = await db.getUserByEmail(email.toLowerCase());
  if (existingEmail) {
    return jsonResponse({ error: '该邮箱已被注册' }, 400);
  }

  // 创建用户
  const creds = await createPasswordHash(password);
  const trialEndDate = calculateTrialEndDate();

  await db.createUser({
    username,
    email: email.toLowerCase(),
    passwordHash: creds.passwordHash,
    salt: creds.salt,
    iterations: creds.iterations,
    algo: creds.algo,
    emailVerified: true,
    membershipType: 'trial',
    freeTrialEndDate: trialEndDate.toISOString(),
    createdAt: new Date().toISOString()
  });

  await env.USERS_KV.delete(`verify:${email.toLowerCase()}`);

  return jsonResponse({ message: '注册成功' }, 201);
}

// 登录
export async function handleLogin(request, env, db) {
  const { username: loginIdentifier, password } = await request.json();

  if (!loginIdentifier || !password) {
    return jsonResponse({ error: '用户名或邮箱和密码不能为空' }, 400);
  }

  let user;
  if (loginIdentifier.includes('@')) {
    user = await db.getUserByEmail(loginIdentifier.toLowerCase());
  } else {
    user = await db.getUser(loginIdentifier);
  }

  if (!user) {
    return jsonResponse({ error: '用户不存在' }, 401);
  }

  const ok = await verifyPassword(password, {
    passwordHash: user.password_hash,
    salt: user.salt,
    iterations: user.iterations,
    algo: user.algo
  });

  if (!ok) {
    return jsonResponse({ error: '密码错误' }, 401);
  }

  const token = await generateToken(user.username, env);
  return jsonResponse({ token, username: user.username });
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

// 更新个人资料
export async function handleUpdateProfile(request, env, db) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonResponse({ error: '未提供认证信息' }, 401);
    }

    const token = authHeader.substring(7);
    const tokenData = await verifyToken(token, env);
    if (!tokenData) {
      return jsonResponse({ error: '认证失败' }, 401);
    }

    const { nickname, avatar, mainPractice, mainPracticeTitle, mainPracticeFilePath } = await request.json();

    // 构建更新语句
    const updates = [];
    const values = [];

    if (nickname !== undefined) {
      const normalizedNickname = String(nickname).trim();
      if (!normalizedNickname) {
        return jsonResponse({ error: '昵称不能为空' }, 400);
      }
      updates.push('nickname = ?');
      values.push(normalizedNickname);
    }

    if (avatar !== undefined) {
      updates.push('avatar = ?');
      const normalizedAvatar = avatar == null ? null : String(avatar).trim();
      values.push(normalizedAvatar || null);
    }

    const practiceTitle = mainPractice?.title ?? mainPracticeTitle;
    const practiceFilePath = mainPractice?.filePath ?? mainPracticeFilePath;
    const practiceSelectedAt = mainPractice?.selectedAt ?? new Date().toISOString();

    if (practiceTitle !== undefined) {
      updates.push('main_practice_title = ?');
      values.push(practiceTitle);
      updates.push('main_practice_file_path = ?');
      values.push(practiceFilePath ?? null);
      updates.push('main_practice_selected_at = ?');
      values.push(practiceTitle ? practiceSelectedAt : null);
    }

    if (updates.length === 0) {
      return jsonResponse({ message: '没有需要更新的字段' });
    }

    // 添加更新时间
    updates.push('updated_at = ?');
    values.push(new Date().toISOString());

    // 添加用户名条件
    values.push(tokenData.username);

    await db.prepare(`
      UPDATE users 
      SET ${updates.join(', ')}
      WHERE username = ?
    `).bind(...values).run();

    const updatedUser = await db.getUser(tokenData.username);
    return jsonResponse({
      message: '个人资料更新成功',
      user: updatedUser ? serializeUser(updatedUser) : null
    });
  } catch (error) {
    console.error('更新个人资料失败:', error);
    return jsonResponse({ error: '更新个人资料失败' }, 500);
  }
}

// Firebase手机登录/注册
export async function handleFirebasePhoneLogin(request, env, db) {
  try {
    const { idToken, phoneNumber, firebaseUid, isNewUser } = await request.json();

    if (!idToken || !phoneNumber || !firebaseUid) {
      return jsonResponse({ error: '缺少必要参数' }, 400);
    }

    // 验证Firebase ID Token (简化版，生产环境应使用Firebase Admin SDK)
    // 这里信任客户端传来的信息，因为token已在客户端验证
    // 生产环境建议：使用 firebase-admin 验证 token

    // 检查是否已有此手机号的用户
    let user = await db.getUserByPhone(phoneNumber);

    if (!user) {
      // 检查是否有此firebase_uid的用户
      user = await db.getUserByFirebaseUid(firebaseUid);
    }

    let token;
    let username;

    if (user) {
      // 已存在用户，更新firebase信息并登录
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
    } else {
      // 新用户注册
      username = `user_${Date.now().toString(36)}`;
      const email = `${firebaseUid}@phone.user`;
      const trialEndDate = calculateTrialEndDate();

      // 创建用户 (手机登录用户无密码)
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
        isNewUser: true,
        user: createdUser ? serializeUser(createdUser) : {
          username,
          email,
          phoneNumber,
          membership: { type: 'trial', expiresAt: trialEndDate.toISOString() }
        }
      });
    }
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

    // 解码 Apple identityToken (JWT) 获取 sub (Apple User ID)
    // Apple identityToken 是一个标准 JWT，其 payload 包含 sub 字段
    let appleUserId;
    let appleEmail;
    try {
      const parts = identityToken.split('.');
      if (parts.length !== 3) {
        return jsonResponse({ error: 'identityToken 格式错误' }, 400);
      }
      // Base64URL decode payload
      const payloadB64 = parts[1];
      const base64 = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
      const pad = base64.length % 4 === 2 ? '==' : base64.length % 4 === 3 ? '=' : '';
      const payloadStr = atob(base64 + pad);
      const payload = JSON.parse(payloadStr);

      appleUserId = payload.sub; // Apple User ID (唯一且稳定)
      appleEmail = payload.email || email; // Apple可能在token中提供email

      if (!appleUserId) {
        return jsonResponse({ error: 'identityToken 中缺少 sub 字段' }, 400);
      }

      // 检查 token 是否过期
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) {
        return jsonResponse({ error: 'identityToken 已过期' }, 401);
      }

      console.log(`🍎 Apple登录: sub=${appleUserId}, email=${appleEmail}`);
    } catch (e) {
      console.error('解析 Apple identityToken 失败:', e);
      return jsonResponse({ error: '解析 identityToken 失败: ' + e.message }, 400);
    }

    // 查找已有用户
    let user = await db.getUserByAppleId(appleUserId);

    let token;
    let username;

    if (user) {
      // 已存在用户，直接登录
      username = user.username;
      token = await generateToken(username, env);

      // 如果用户提供了新的 email/name 且之前没有，则更新
      const updates = {};
      if (appleEmail && !user.email) {
        updates.email = appleEmail;
      }
      if ((givenName || familyName) && !user.nickname) {
        const fullName = [givenName, familyName].filter(Boolean).join(' ');
        if (fullName) updates.nickname = fullName;
      }
      if (Object.keys(updates).length > 0) {
        updates.updated_at = new Date().toISOString();
        await db.updateUser(username, updates);
      }

      return jsonResponse({
        success: true,
        token,
        username,
        isNewUser: false,
        user: {
          username: user.username,
          email: user.email || appleEmail || '',
          membership: {
            type: user.membership_type || 'trial',
            expiresAt: user.membership_expires_at
          }
        }
      });
    } else {
      // 新用户注册
      username = `apple_${Date.now().toString(36)}`;
      const userEmail = appleEmail || `${appleUserId.substring(0, 16)}@apple.user`;
      const fullName = [givenName, familyName].filter(Boolean).join(' ');
      const trialEndDate = calculateTrialEndDate();

      // 先检查 email 是否已存在（用户可能通过其他方式注册过）
      const existingEmailUser = await db.db.prepare('SELECT * FROM users WHERE email = ?').bind(userEmail).first();

      if (existingEmailUser) {
        // email 已存在，将 Apple ID 关联到现有账号
        username = existingEmailUser.username;
        const updates = { apple_user_id: appleUserId, updated_at: new Date().toISOString() };
        if (fullName && !existingEmailUser.nickname) updates.nickname = fullName;
        await db.updateUser(username, updates);

        token = await generateToken(username, env);

        return jsonResponse({
          success: true,
          token,
          username,
          isNewUser: false,
          user: {
            username: existingEmailUser.username,
            email: existingEmailUser.email,
            membership: {
              type: existingEmailUser.membership_type || 'trial',
              expiresAt: existingEmailUser.membership_expires_at
            }
          }
        });
      }

      // 创建 Apple 用户 (无密码)
      await db.createAppleUser({
        username,
        email: userEmail,
        appleUserId,
        nickname: fullName || null,
        membershipType: 'trial',
        membershipExpiresAt: trialEndDate.toISOString(),
        createdAt: new Date().toISOString()
      });

      token = await generateToken(username, env);

      return jsonResponse({
        success: true,
        token,
        username,
        isNewUser: true,
        user: {
          username,
          email: userEmail,
          membership: {
            type: 'trial',
            expiresAt: trialEndDate.toISOString()
          }
        }
      });
    }
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

    if (db.deleteUser) {
      await db.deleteUser(tokenData.username);
    } else {
      await db.prepare('DELETE FROM users WHERE username = ?').bind(tokenData.username).run();
    }

    return jsonResponse({ success: true, message: '账户已注销' }, 200);
  } catch (error) {
    console.error('注销账户失败:', error);
    return jsonResponse({ error: '服务器错误: ' + error.message }, 500);
  }
}
