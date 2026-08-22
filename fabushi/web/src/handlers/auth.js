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
import { isTestAccountRequest, testAccountUser } from '../utils/test-account.js';
import { verifyAppleIdentityToken, verifyFirebaseIdentityToken } from '../utils/provider-token-verifier.js';

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
    alipayProviderSubject: user.alipay_user_id || null,
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
  if (tokenData?.username) return await db.getUser(tokenData.username);
  return null;
}

function normalizePhone(value) {
  return String(value || '').trim();
}

function providerFailure(provider, error) {
  console.warn(`${provider} identity rejected:`, error?.message || error);
  return jsonResponse({ error: `${provider}身份验证失败` }, 401);
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
  if (await isTestAccountRequest(request, env)) return jsonResponse(testAccountUser());
  const repository = new AccountUserRepository(db);
  try {
    const payload = await getAuthenticatedUserInfo(request, env, repository);
    return jsonResponse(payload);
  } catch (error) {
    const apiError = asApiError(error, '获取用户信息失败');
    return jsonResponse({ error: apiError.message }, apiError.status);
  }
}

// Firebase 手机号登录/注册。所有账号选择和绑定只使用服务端验证过的 claims。
export async function handleFirebasePhoneLogin(request, env, db) {
  try {
    const { idToken, phoneNumber, firebaseUid, isNewUser } = await request.json();
    if (!idToken) return jsonResponse({ error: '缺少 Firebase idToken' }, 400);

    let claims;
    try {
      claims = await verifyFirebaseIdentityToken(idToken, env);
    } catch (error) {
      return providerFailure('Firebase', error);
    }

    const verifiedUid = String(claims.user_id || claims.sub || '').trim();
    const verifiedPhone = normalizePhone(claims.phone_number);
    if (!verifiedUid || !verifiedPhone) return jsonResponse({ error: 'Firebase 令牌缺少已验证手机号或用户标识' }, 401);
    if (firebaseUid && String(firebaseUid) !== verifiedUid) return jsonResponse({ error: 'Firebase 用户标识不匹配' }, 401);
    if (phoneNumber && normalizePhone(phoneNumber) !== verifiedPhone) return jsonResponse({ error: 'Firebase 手机号不匹配' }, 401);

    const byUid = await db.getUserByFirebaseUid(verifiedUid);
    const byPhone = await db.getUserByPhone(verifiedPhone);
    if (byUid && byPhone && byUid.id !== byPhone.id) {
      return jsonResponse({ error: 'Firebase 身份与手机号已绑定到不同账号，请联系客服处理' }, 409);
    }

    let user = byUid || byPhone;
    if (user) {
      if (user.firebase_uid && user.firebase_uid !== verifiedUid) {
        return jsonResponse({ error: '该手机号已绑定其他 Firebase 身份' }, 409);
      }
      if (user.phone_number && normalizePhone(user.phone_number) !== verifiedPhone) {
        return jsonResponse({ error: '该 Firebase 身份已绑定其他手机号' }, 409);
      }
      if (!user.firebase_uid || !user.phone_number) {
        if (db.updateUserById) {
          await db.updateUserById(user.id, { firebase_uid: verifiedUid, phone_number: verifiedPhone });
        } else {
          await db.prepare(`UPDATE users SET firebase_uid = ?, phone_number = ?, updated_at = ? WHERE username = ?`)
            .bind(verifiedUid, verifiedPhone, new Date().toISOString(), user.username).run();
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

    const username = `user_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const email = `${verifiedUid.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64)}@phone.user`;
    const trialEndDate = calculateTrialEndDate();
    await db.createPhoneUser({
      username,
      email,
      phoneNumber: verifiedPhone,
      firebaseUid: verifiedUid,
      membershipType: 'trial',
      freeTrialEndDate: trialEndDate.toISOString(),
      createdAt: new Date().toISOString()
    });

    const createdUser = db.getUserByEmail ? await db.getUserByEmail(email) : await db.getUser(username);
    if (!createdUser) throw new Error('Firebase user creation did not return a user');
    return jsonResponse({
      success: true,
      token: await generateToken({ id: createdUser.id, username: createdUser.username }, env),
      username: createdUser.username,
      userId: createdUser.id,
      userNo: createdUser.user_no ?? createdUser.id ?? null,
      isNewUser: isNewUser ?? true,
      user: serializeUser(createdUser)
    });
  } catch (error) {
    console.error('Firebase手机登录失败:', error?.message || error);
    return jsonResponse({ error: 'Firebase手机登录失败' }, 500);
  }
}

// Apple 登录/注册。禁止解析未验签 JWT；邮箱只信任 Apple 签名 claims。
export async function handleAppleLogin(request, env, db) {
  try {
    const { identityToken, authorizationCode, givenName, familyName, nonce } = await request.json();
    if (!identityToken || !authorizationCode) {
      return jsonResponse({ error: '缺少必要参数 (identityToken, authorizationCode)' }, 400);
    }

    let claims;
    try {
      claims = await verifyAppleIdentityToken(identityToken, env, nonce || '');
    } catch (error) {
      return providerFailure('Apple', error);
    }

    const appleUserId = String(claims.sub || '').trim();
    const appleEmail = claims.email ? String(claims.email).trim().toLowerCase() : '';
    const appleDisplayName = [givenName, familyName].filter(Boolean).join(' ').trim().slice(0, 120);
    if (!appleUserId) return jsonResponse({ error: 'Apple 身份缺少用户标识' }, 401);

    let user = await db.getUserByAppleId(appleUserId);
    if (user) {
      const updates = {};
      if (appleEmail && !user.email) updates.email = appleEmail;
      if (appleDisplayName && !user.nickname) updates.nickname = appleDisplayName;
      if (Object.keys(updates).length > 0) {
        if (db.updateUserById) await db.updateUserById(user.id, updates);
        else await db.updateUser(user.username, updates);
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

    // Account linking by email is allowed only for an email contained in the
    // cryptographically verified Apple token. Client-supplied email is ignored.
    if (appleEmail) {
      const existingEmailUser = await db.db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').bind(appleEmail).first();
      if (existingEmailUser) {
        if (existingEmailUser.apple_user_id && existingEmailUser.apple_user_id !== appleUserId) {
          return jsonResponse({ error: '该邮箱已绑定其他 Apple 身份' }, 409);
        }
        const updates = { apple_user_id: appleUserId };
        if (appleDisplayName && !existingEmailUser.nickname) updates.nickname = appleDisplayName;
        if (db.updateUserById) await db.updateUserById(existingEmailUser.id, updates);
        else await db.updateUser(existingEmailUser.username, updates);
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
    }

    const username = `apple_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const userEmail = appleEmail || `${appleUserId.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 48)}@apple.user`;
    const trialEndDate = calculateTrialEndDate();
    await db.createAppleUser({
      username,
      email: userEmail,
      appleUserId,
      nickname: appleDisplayName || username,
      membershipType: 'trial',
      membershipExpiresAt: trialEndDate.toISOString(),
      createdAt: new Date().toISOString()
    });

    const createdUser = await db.getUser(username);
    if (!createdUser) throw new Error('Apple user creation did not return a user');
    return jsonResponse({
      success: true,
      token: await generateToken({ id: createdUser.id, username: createdUser.username }, env),
      username: createdUser.username,
      userId: createdUser.id,
      userNo: createdUser.user_no ?? createdUser.id ?? null,
      isNewUser: true,
      user: serializeUser(createdUser)
    });
  } catch (error) {
    console.error('Apple登录失败:', error?.message || error);
    return jsonResponse({ error: 'Apple登录失败' }, 500);
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
