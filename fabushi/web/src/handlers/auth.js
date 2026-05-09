import { jsonResponse } from '../utils/response.js';
import { createPasswordHash, generateToken, verifyToken } from '../../auth-utils.js';
import { calculateTrialEndDate } from '../../stripe-config.js';
import { handlePasswordLogin as handleLogin } from './password-login.js';
import { handleUpdateProfile, handleUploadAvatar } from './profile.js';
import { AccountUserRepository } from '../repositories/account-user-command-repository.js';
import { asApiError } from '../contracts/api-error.js';
import { registerAccountCommand } from '../use-cases/account-registration.js';
import { getAuthenticatedUserInfo } from '../use-cases/authenticated-user.js';
import { deleteAccountCommand } from '../use-cases/delete-account.js';

export { handleLogin, handleUpdateProfile, handleUploadAvatar };

function serializeUser(user) {
  const userNo = user.user_no ?? user.id ?? null;

  return {
    id: user.id,
    userId: user.id,
    userNo,
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

async function resolveAuthenticatedUser(db, tokenData) {
  if (tokenData?.userId !== undefined && tokenData?.userId !== null && db.getUserById) {
    const user = await db.getUserById(tokenData.userId);
    if (user) return user;
  }
  if (tokenData?.username) {
    return await db.getUser(tokenData.username);
  }
  return null;
}

// 注册
export async function handleRegister(request, env, db) {
  const repository = new AccountUserRepository(db);

  try {
    const payload = await registerAccountCommand(await request.json(), env, repository);
    return jsonResponse(payload, 201);
  } catch (error) {
    const apiError = asApiError(error, '注册失败');
    return jsonResponse({ error: apiError.message }, apiError.status);
  }
}

// 获取用户信息
export async function handleGetUserInfo(request, env, db) {
  const repository = new AccountUserRepository(db);

  try {
    const payload = await getAuthenticatedUserInfo(request, env, repository);
    return jsonResponse(payload);
  } catch (error) {
    const apiError = asApiError(error, '获取用户信息失败');
    return jsonResponse({ error: apiError.message }, apiError.status);
  }
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

    if (user) {
      if (user.firebase_uid !== firebaseUid || user.phone_number !== phoneNumber) {
        if (db.updateUserById) {
          await db.updateUserById(user.id, { firebase_uid: firebaseUid, phone_number: phoneNumber });
        } else {
          await db.prepare(`
            UPDATE users SET firebase_uid = ?, phone_number = ?, updated_at = ?
            WHERE username = ?
          `).bind(firebaseUid, phoneNumber, new Date().toISOString(), user.username).run();
        }
        user = db.getUserById ? await db.getUserById(user.id) : await db.getUser(user.username);
      }

      return jsonResponse({
        success: true,
        token: await generateToken({ id: user.id, username: user.username }, env),
        username: user.username,
        userId: user.id,
        userNo: user.user_no ?? user.id ?? null,
        isNewUser: false,
        user: serializeUser(user)
      });
    }

    const username = `user_${Date.now().toString(36)}`;
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

    const createdUser = db.getUserById
      ? await db.getUserByEmail(email)
      : await db.getUser(username);
    const fallbackUser = createdUser || {
      id: null,
      user_no: null,
      username,
      email,
      phone_number: phoneNumber,
      membership_type: 'trial',
      free_trial_end_date: trialEndDate.toISOString(),
      created_at: new Date().toISOString(),
      email_verified: 1
    };

    return jsonResponse({
      success: true,
      token: await generateToken({ id: createdUser?.id, username }, env),
      username,
      userId: createdUser?.id,
      userNo: createdUser?.user_no ?? createdUser?.id ?? null,
      isNewUser: isNewUser ?? true,
      user: serializeUser(fallbackUser)
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
      const updates = {};
      if (appleEmail && !user.email) updates.email = appleEmail;
      const fullName = [givenName, familyName].filter(Boolean).join(' ');
      if (fullName && !user.nickname) updates.nickname = user.username;
      if (Object.keys(updates).length > 0) {
        if (db.updateUserById) {
          await db.updateUserById(user.id, updates);
        } else {
          await db.updateUser(user.username, updates);
        }
        user = db.getUserById ? await db.getUserById(user.id) : await db.getUser(user.username);
      }

      return jsonResponse({
        success: true,
        token: await generateToken({ id: user.id, username: user.username }, env),
        username: user.username,
        userId: user.id,
        userNo: user.user_no ?? user.id ?? null,
        isNewUser: false,
        user: serializeUser(user)
      });
    }

    const username = `apple_${Date.now().toString(36)}`;
    const userEmail = appleEmail || `${appleUserId.substring(0, 16)}@apple.user`;
    const trialEndDate = calculateTrialEndDate();

    const existingEmailUser = await db.db.prepare('SELECT * FROM users WHERE email = ?').bind(userEmail).first();
    if (existingEmailUser) {
      const updates = { apple_user_id: appleUserId };
      if (!existingEmailUser.nickname) updates.nickname = existingEmailUser.username;
      if (db.updateUserById) {
        await db.updateUserById(existingEmailUser.id, updates);
      } else {
        await db.updateUser(existingEmailUser.username, updates);
      }
      const updated = db.getUserById ? await db.getUserById(existingEmailUser.id) : await db.getUser(existingEmailUser.username);
      return jsonResponse({
        success: true,
        token: await generateToken({ id: updated.id, username: updated.username }, env),
        username: updated.username,
        userId: updated.id,
        userNo: updated.user_no ?? updated.id ?? null,
        isNewUser: false,
        user: serializeUser(updated)
      });
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

    const createdUser = await db.getUser(username);
    return jsonResponse({
      success: true,
      token: await generateToken({ id: createdUser?.id, username }, env),
      username,
      userId: createdUser?.id,
      userNo: createdUser?.user_no ?? createdUser?.id ?? null,
      isNewUser: true,
      user: serializeUser(createdUser)
    });
  } catch (error) {
    console.error('Apple登录失败:', error);
    return jsonResponse({ error: 'Apple登录失败: ' + error.message }, 500);
  }
}

// 注销账户
export async function handleDeleteAccount(request, env, db) {
  const repository = new AccountUserRepository(db);

  try {
    const payload = await deleteAccountCommand(request, env, repository);
    return jsonResponse(payload, 200);
  } catch (error) {
    const apiError = asApiError(error, '注销账户失败');
    console.error('注销账户失败:', error);
    const message = apiError.status >= 500 ? '注销账户失败，请稍后重试' : apiError.message;
    return jsonResponse({ error: message }, apiError.status);
  }
}
