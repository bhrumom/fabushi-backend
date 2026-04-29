import { jsonResponse } from '../utils/response.js';
import { createPasswordHash, generateToken, verifyToken } from '../../auth-utils.js';

function normalizeOptionalString(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeUsername(value) {
  const username = normalizeOptionalString(value);
  if (!username) return username;
  if (username.includes('@')) {
    throw new Error('用户名不能包含 @，邮箱请填写到邮箱字段');
  }
  if (/\s/.test(username)) {
    throw new Error('用户名不能包含空格');
  }
  if (username.length < 2 || username.length > 32) {
    throw new Error('用户名长度需为 2-32 个字符');
  }
  return username;
}

function normalizeEmail(value) {
  const email = normalizeOptionalString(value);
  if (!email) return email;
  const normalized = email.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error('邮箱格式不正确');
  }
  return normalized;
}

function normalizePhone(value) {
  const phone = normalizeOptionalString(value);
  if (!phone) return phone;
  if (!/^\+?[0-9]{6,20}$/.test(phone)) {
    throw new Error('手机号格式不正确');
  }
  return phone;
}

function serializeUser(user) {
  return {
    username: user.username,
    email: user.email || '',
    nickname: user.username,
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

async function authenticate(request, env, db) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { error: jsonResponse({ error: '未提供认证信息' }, 401) };
  }

  const token = authHeader.substring(7);
  const tokenData = await verifyToken(token, env);
  if (!tokenData) {
    return { error: jsonResponse({ error: '认证失败，请重新登录' }, 401) };
  }

  const user = await db.getUser(tokenData.username);
  if (!user) {
    return { error: jsonResponse({ error: '用户不存在' }, 404) };
  }

  return { tokenData, user };
}

async function safeRun(db, sql, ...params) {
  try {
    await db.prepare(sql).bind(...params).run();
  } catch (error) {
    console.warn('资料引用更新跳过:', error?.message || error);
  }
}

async function updateUsernameReferences(db, oldUsername, newUsername) {
  await safeRun(db, 'UPDATE email_username_mapping SET username = ? WHERE username = ?', newUsername, oldUsername);
  await safeRun(db, 'UPDATE alipay_bindings SET username = ? WHERE username = ?', newUsername, oldUsername);
  await safeRun(db, 'UPDATE purchase_history SET user_id = ? WHERE user_id = ?', newUsername, oldUsername);
  await safeRun(db, 'UPDATE redeem_history SET username = ? WHERE username = ?', newUsername, oldUsername);
  await safeRun(db, 'UPDATE meditation_records SET username = ? WHERE username = ?', newUsername, oldUsername);
  await safeRun(db, 'UPDATE likes SET username = ? WHERE username = ?', newUsername, oldUsername);
  await safeRun(db, 'UPDATE favorites SET username = ? WHERE username = ?', newUsername, oldUsername);
}

async function applyEmailMapping(db, oldEmail, newEmail, username) {
  if (oldEmail && oldEmail.toLowerCase() !== newEmail) {
    await safeRun(db, 'DELETE FROM email_username_mapping WHERE email = ?', oldEmail.toLowerCase());
  }
  if (newEmail) {
    await safeRun(db, 'INSERT OR REPLACE INTO email_username_mapping (email, username) VALUES (?, ?)', newEmail, username);
  }
}

function decodeBase64Image(imageBase64) {
  const clean = String(imageBase64 || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function avatarUrlFor(request, key) {
  const url = new URL(request.url);
  return `${url.origin}/r2?file=${encodeURIComponent(key)}`;
}

async function uploadAvatarObject(request, env, username, imageBase64, fileName, contentType) {
  if (!env.R2_BUCKET) {
    throw new Error('R2存储桶未绑定，无法保存头像到云端');
  }
  const bytes = decodeBase64Image(imageBase64);
  if (!bytes.length) {
    throw new Error('头像图片为空');
  }
  if (bytes.length > 3 * 1024 * 1024) {
    throw new Error('头像图片不能超过 3MB');
  }

  const safeContentType = contentType && String(contentType).startsWith('image/')
    ? String(contentType)
    : 'image/jpeg';
  const extensionFromType = safeContentType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
  const extensionFromName = String(fileName || '').split('.').pop()?.toLowerCase();
  const extension = extensionFromName && /^[a-z0-9]{2,5}$/.test(extensionFromName)
    ? extensionFromName
    : extensionFromType;
  const key = `avatars/${encodeURIComponent(username)}/${Date.now()}-${crypto.randomUUID()}.${extension}`;

  await env.R2_BUCKET.put(key, bytes, {
    httpMetadata: { contentType: safeContentType },
    customMetadata: { username }
  });

  return avatarUrlFor(request, key);
}

export async function handleUploadAvatar(request, env, db) {
  try {
    const auth = await authenticate(request, env, db);
    if (auth.error) return auth.error;

    const { imageBase64, fileName, contentType } = await request.json();
    if (!imageBase64) {
      return jsonResponse({ error: '缺少头像图片数据' }, 400);
    }

    const avatarUrl = await uploadAvatarObject(request, env, auth.user.username, imageBase64, fileName, contentType);

    await db.prepare('UPDATE users SET avatar = ?, nickname = ?, updated_at = ? WHERE username = ?')
      .bind(avatarUrl, auth.user.username, new Date().toISOString(), auth.user.username)
      .run();

    const updatedUser = await db.getUser(auth.user.username);
    return jsonResponse({
      success: true,
      avatar: avatarUrl,
      user: updatedUser ? serializeUser(updatedUser) : null
    });
  } catch (error) {
    console.error('上传头像失败:', error);
    return jsonResponse({ error: error.message || '上传头像失败' }, 500);
  }
}

export async function handleUpdateProfile(request, env, db) {
  try {
    const auth = await authenticate(request, env, db);
    if (auth.error) return auth.error;

    const body = await request.json();
    let newUsername;
    let newEmail;
    let newPhone;
    try {
      newUsername = body.username !== undefined ? normalizeUsername(body.username) : undefined;
      newEmail = body.email !== undefined ? normalizeEmail(body.email) : undefined;
      newPhone = body.phoneNumber !== undefined ? normalizePhone(body.phoneNumber) : undefined;
    } catch (validationError) {
      return jsonResponse({ error: validationError.message }, 400);
    }

    const oldUsername = auth.user.username;
    const targetUsername = newUsername || oldUsername;
    const updates = [];
    const values = [];
    let usernameChanged = false;

    if (newUsername !== undefined && newUsername !== oldUsername) {
      const existingUser = await db.getUser(newUsername);
      if (existingUser) {
        return jsonResponse({ error: '用户名已存在' }, 400);
      }
      updates.push('username = ?');
      values.push(newUsername);
      updates.push('nickname = ?');
      values.push(newUsername);
      usernameChanged = true;
    } else if (newUsername !== undefined) {
      updates.push('nickname = ?');
      values.push(newUsername);
    }

    if (newEmail !== undefined) {
      if (newEmail) {
        const existingEmailUser = await db.getUserByEmail(newEmail);
        if (existingEmailUser && existingEmailUser.username !== oldUsername) {
          return jsonResponse({ error: '该邮箱已被其他账号使用' }, 400);
        }
      }
      updates.push('email = ?');
      values.push(newEmail || '');
      updates.push('email_verified = ?');
      values.push(newEmail ? 1 : 0);
    }

    if (newPhone !== undefined) {
      if (newPhone) {
        const existingPhoneUser = await db.getUserByPhone(newPhone);
        if (existingPhoneUser && existingPhoneUser.username !== oldUsername) {
          return jsonResponse({ error: '该手机号已被其他账号使用' }, 400);
        }
      }
      updates.push('phone_number = ?');
      values.push(newPhone);
    }

    if (body.avatar !== undefined) {
      const avatar = normalizeOptionalString(body.avatar);
      updates.push('avatar = ?');
      values.push(avatar);
    }

    if (body.avatarData?.imageBase64) {
      const avatarUrl = await uploadAvatarObject(
        request,
        env,
        oldUsername,
        body.avatarData.imageBase64,
        body.avatarData.fileName,
        body.avatarData.contentType
      );
      updates.push('avatar = ?');
      values.push(avatarUrl);
    }

    if (body.password !== undefined && String(body.password).length > 0) {
      const hasPassword = Boolean(auth.user.password_hash && auth.user.salt);
      if (hasPassword) {
        return jsonResponse({ error: '当前账号已设置密码，请使用修改密码功能' }, 400);
      }
      const password = String(body.password);
      if (password.length < 6 || password.length > 128) {
        return jsonResponse({ error: '密码长度需为 6-128 位' }, 400);
      }
      const creds = await createPasswordHash(password);
      updates.push('password_hash = ?', 'salt = ?', 'iterations = ?', 'algo = ?');
      values.push(creds.passwordHash, creds.salt, creds.iterations, creds.algo);
    }

    const mainPractice = body.mainPractice;
    const practiceTitle = mainPractice?.title ?? body.mainPracticeTitle;
    const practiceFilePath = mainPractice?.filePath ?? body.mainPracticeFilePath;
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
      return jsonResponse({ message: '没有需要更新的字段', user: serializeUser(auth.user) });
    }

    updates.push('updated_at = ?');
    values.push(new Date().toISOString());
    values.push(oldUsername);

    await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE username = ?`).bind(...values).run();

    if (newEmail !== undefined) {
      await applyEmailMapping(db, auth.user.email, newEmail, targetUsername);
    } else if (usernameChanged && auth.user.email) {
      await applyEmailMapping(db, auth.user.email, auth.user.email.toLowerCase(), targetUsername);
    }

    if (usernameChanged) {
      await updateUsernameReferences(db, oldUsername, targetUsername);
    }

    const updatedUser = await db.getUser(targetUsername);
    const token = usernameChanged ? await generateToken(targetUsername, env) : undefined;

    return jsonResponse({
      success: true,
      message: '个人资料更新成功',
      token,
      user: updatedUser ? serializeUser(updatedUser) : null
    });
  } catch (error) {
    console.error('更新个人资料失败:', error);
    return jsonResponse({ error: error.message || '更新个人资料失败' }, 500);
  }
}
