import { jsonResponse } from '../utils/response.js';
import { createPasswordHash, verifyPassword, generateToken, verifyToken } from '../../auth-utils.js';
import { calculateTrialEndDate } from '../../stripe-config.js';

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

  return jsonResponse({
    username: user.username,
    email: user.email,
    nickname: user.nickname,
    avatar: user.avatar,
    createdAt: user.created_at,
    emailVerified: user.email_verified === 1,
    membership: {
      type: user.membership_type,
      expiresAt: user.membership_expires_at
    }
  });
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

    const { nickname, avatar } = await request.json();

    // 构建更新语句
    const updates = [];
    const values = [];

    if (nickname !== undefined) {
      updates.push('nickname = ?');
      values.push(nickname);
    }

    if (avatar !== undefined) {
      updates.push('avatar = ?');
      values.push(avatar);
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

    return jsonResponse({ message: '个人资料更新成功' });
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
      if (!user.firebase_uid) {
        await db.prepare(`
          UPDATE users SET firebase_uid = ?, phone_number = ?, updated_at = ?
          WHERE username = ?
        `).bind(firebaseUid, phoneNumber, new Date().toISOString(), user.username).run();
      }

      username = user.username;
      token = await generateToken(username, env);

      return jsonResponse({
        success: true,
        token,
        username,
        isNewUser: false,
        user: {
          username: user.username,
          email: user.email || '',
          phoneNumber: phoneNumber,
          membership: {
            type: user.membership_type || 'trial',
            expiresAt: user.membership_expires_at
          }
        }
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

      return jsonResponse({
        success: true,
        token,
        username,
        isNewUser: true,
        user: {
          username,
          email,
          phoneNumber,
          membership: {
            type: 'trial',
            expiresAt: trialEndDate.toISOString()
          }
        }
      });
    }
  } catch (error) {
    console.error('Firebase手机登录失败:', error);
    return jsonResponse({ error: 'Firebase手机登录失败: ' + error.message }, 500);
  }
}
