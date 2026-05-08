import { jsonResponse } from '../utils/response.js';
import { createPasswordHash, verifyToken } from '../../auth-utils.js';

function normalizeOptionalString(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeDisplayName(value) {
  const name = normalizeOptionalString(value);
  if (!name) return name;
  if (name.includes('@')) throw new Error('昵称不能包含 @，邮箱请填写到邮箱字段');
  if (/\s/.test(name)) throw new Error('昵称不能包含空格');
  if (name.length < 2 || name.length > 32) throw new Error('昵称长度需为 2-32 个字符');
  return name;
}

function normalizeEmail(value) {
  const email = normalizeOptionalString(value);
  if (!email) return email;
  const normalized = email.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('邮箱格式不正确');
  return normalized;
}

function normalizePhone(value) {
  const phone = normalizeOptionalString(value);
  if (!phone) return phone;
  if (!/^\+?[0-9]{6,20}$/.test(phone)) throw new Error('手机号格式不正确');
  return phone;
}

function serializeUser(user) {
  return {
    id: user.id,
    userId: user.id,
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
  if (tokenData?.username) return await db.getUser(tokenData.username);
  return null;
}

async function authenticate(request, env, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: jsonResponse({ error: '未提供认证信息' }, 401) };
  }

  const tokenData = await verifyToken(authHeader.substring(7), env);
  if (!tokenData) return { error: jsonResponse({ error: '认证失败，请重新登录' }, 401) };

  const user = await resolveAuthenticatedUser(db, tokenData);
  if (!user) return { error: jsonResponse({ error: '用户不存在' }, 404) };
  return { tokenData, user };
}

async function safeRun(db, sql, ...params) {
  try {
    await db.prepare(sql).bind(...params).run();
  } catch (error) {
    console.warn('资料引用更新跳过:', error?.message || error);
  }
}

async function applyEmailMapping(db, oldEmail, newEmail, user) {
  if (oldEmail) {
    await safeRun(db, 'DELETE FROM email_username_mapping WHERE email = ?', oldEmail.toLowerCase());
  }
  if (user?.id !== undefined && user?.id !== null) {
    await safeRun(db, 'DELETE FROM email_username_mapping WHERE user_id = ?', user.id);
  }
  if (newEmail) {
    await safeRun(
      db,
      'INSERT OR REPLACE INTO email_username_mapping (email, username, user_id) VALUES (?, ?, ?)',
      newEmail,
      user.username,
      user.id
    );
  }
}

export async function handleUploadAvatar(request, env, db) {
  const auth = await authenticate(request, env, db);
  if (auth.error) return auth.error;
  const { imageBase64 } = await request.json();
  if (!imageBase64) return jsonResponse({ error: '缺少头像图片数据' }, 400);

  const avatarUrl = `https://example.com/avatar/${auth.user.id}`;
  await db.prepare('UPDATE users SET avatar = ?, nickname = ?, updated_at = ? WHERE id = ?')
    .bind(avatarUrl, auth.user.nickname || auth.user.username, new Date().toISOString(), auth.user.id)
    .run();

  const updatedUser = db.getUserById ? await db.getUserById(auth.user.id) : await db.getUser(auth.user.username);
  return jsonResponse({ success: true, avatar: avatarUrl, user: serializeUser(updatedUser) });
}

export async function handleUpdateProfile(request, env, db) {
  try {
    const auth = await authenticate(request, env, db);
    if (auth.error) return auth.error;

    const body = await request.json();
    const rawDisplayName = body.nickname !== undefined ? body.nickname : body.username;
    let displayName;
    let newEmail;
    let newPhone;
    try {
      displayName = rawDisplayName !== undefined ? normalizeDisplayName(rawDisplayName) : undefined;
      newEmail = body.email !== undefined ? normalizeEmail(body.email) : undefined;
      newPhone = body.phoneNumber !== undefined ? normalizePhone(body.phoneNumber) : undefined;
    } catch (error) {
      return jsonResponse({ error: error.message }, 400);
    }

    if (rawDisplayName !== undefined && !displayName) {
      return jsonResponse({ error: '请输入昵称' }, 400);
    }

    const currentUser = auth.user;
    const updates = [];
    const values = [];
    const updatedAt = new Date().toISOString();

    if (newEmail !== undefined && newEmail) {
      const existingUser = await db.getUserByEmail(newEmail);
      if (existingUser && existingUser.id !== currentUser.id) {
        return jsonResponse({ error: '该邮箱已被其他账号使用' }, 400);
      }
    }

    if (newPhone !== undefined && newPhone) {
      const existingUser = await db.getUserByPhone(newPhone);
      if (existingUser && existingUser.id !== currentUser.id) {
        return jsonResponse({ error: '该手机号已被其他账号使用' }, 400);
      }
    }

    if (displayName !== undefined) {
      updates.push('nickname = ?');
      values.push(displayName);
    }
    if (newEmail !== undefined) {
      updates.push('email = ?', 'email_verified = ?');
      values.push(newEmail || '', newEmail ? 1 : 0);
    }
    if (newPhone !== undefined) {
      updates.push('phone_number = ?');
      values.push(newPhone);
    }
    if (body.password !== undefined && String(body.password).length > 0) {
      if (currentUser.password_hash && currentUser.salt) {
        return jsonResponse({ error: '当前账号已设置密码，请使用修改密码功能' }, 400);
      }
      const password = String(body.password);
      if (password.length < 6 || password.length > 128) {
        return jsonResponse({ error: '密码长度需为 6-128 位' }, 400);
      }
      const passwordCreds = await createPasswordHash(password);
      updates.push('password_hash = ?', 'salt = ?', 'iterations = ?', 'algo = ?');
      values.push(passwordCreds.passwordHash, passwordCreds.salt, passwordCreds.iterations, passwordCreds.algo);
    }

    if (updates.length === 0) {
      return jsonResponse({ message: '没有需要更新的字段', user: serializeUser(currentUser) });
    }

    updates.push('updated_at = ?');
    values.push(updatedAt, currentUser.id);

    await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
    if (newEmail !== undefined) {
      await applyEmailMapping(db, currentUser.email, newEmail, currentUser);
    }

    const updatedUser = db.getUserById ? await db.getUserById(currentUser.id) : await db.getUser(currentUser.username);
    return jsonResponse({ success: true, message: '个人资料更新成功', user: serializeUser(updatedUser) });
  } catch (error) {
    console.error('更新个人资料失败:', error);
    return jsonResponse({ error: error.message || '更新个人资料失败' }, 500);
  }
}
