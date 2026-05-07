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
  const updates = [
    ['UPDATE email_username_mapping SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE alipay_bindings SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE orders SET user_id = ? WHERE user_id = ?', newUsername, oldUsername],
    ['UPDATE orders SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE purchase_history SET user_id = ? WHERE user_id = ?', newUsername, oldUsername],
    ['UPDATE purchase_history SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE redeem_history SET user_id = ? WHERE user_id = ?', newUsername, oldUsername],
    ['UPDATE redeem_history SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE memberships SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE meditation_records SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE meditation_goals SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE meditation_settings SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE meditation_group_members SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE meditation_groups SET owner_username = ? WHERE owner_username = ?', newUsername, oldUsername],
    ['UPDATE user_follows SET follower_username = ? WHERE follower_username = ?', newUsername, oldUsername],
    ['UPDATE user_follows SET following_username = ? WHERE following_username = ?', newUsername, oldUsername],
    ['UPDATE user_practice_privacy SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE notifications SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE notifications SET related_username = ? WHERE related_username = ?', newUsername, oldUsername],
    ['UPDATE sync_log SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE user_sync_state SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE comments SET user_id = ? WHERE user_id = ?', newUsername, oldUsername],
    ['UPDATE comments SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE likes SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE favorites SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE content_likes SET user_id = ? WHERE user_id = ?', newUsername, oldUsername],
    ['UPDATE content_likes SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE content_favorites SET username = ? WHERE username = ?', newUsername, oldUsername],
    ['UPDATE content_reports SET reporter_user_id = ? WHERE reporter_user_id = ?', newUsername, oldUsername],
    ['UPDATE user_blocks SET blocked_user_id = ? WHERE blocked_user_id = ?', newUsername, oldUsername]
  ];

  for (const [sql, ...params] of updates) {
    await safeRun(db, sql, ...params);
  }
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

function migrationPlaceholderEmail(username) {
  const normalized = String(username || 'user').replace(/[^a-zA-Z0-9._-]/g, '-');
  return `${normalized}__rename__${Date.now()}@local.invalid`;
}

function getFinalProfileState(user, {
  targetUsername,
  newEmail,
  newPhone,
  finalAvatar,
  passwordCreds,
  practiceTitle,
  practiceFilePath,
  practiceSelectedAt,
  updatedAt
}) {
  const email = newEmail !== undefined ? newEmail : normalizeOptionalString(user.email);
  const phone = newPhone !== undefined ? newPhone : normalizeOptionalString(user.phone_number);
  const practiceChanged = practiceTitle !== undefined;

  return {
    username: targetUsername,
    email,
    password_hash: passwordCreds?.passwordHash ?? user.password_hash ?? null,
    salt: passwordCreds?.salt ?? user.salt ?? null,
    iterations: passwordCreds?.iterations ?? user.iterations ?? null,
    algo: passwordCreds?.algo ?? user.algo ?? null,
    email_verified: newEmail !== undefined
      ? (email ? 1 : 0)
      : (user.email_verified ?? 0),
    alipay_user_id: normalizeOptionalString(user.alipay_user_id),
    alipay_nickname: normalizeOptionalString(user.alipay_nickname),
    alipay_avatar: normalizeOptionalString(user.alipay_avatar),
    alipay_bound_at: normalizeOptionalString(user.alipay_bound_at),
    wechat_openid: normalizeOptionalString(user.wechat_openid),
    wechat_nickname: normalizeOptionalString(user.wechat_nickname),
    wechat_headimgurl: normalizeOptionalString(user.wechat_headimgurl),
    wechat_bound_at: normalizeOptionalString(user.wechat_bound_at),
    phone_number: phone,
    firebase_uid: normalizeOptionalString(user.firebase_uid),
    apple_user_id: normalizeOptionalString(user.apple_user_id),
    nickname: targetUsername,
    avatar: finalAvatar !== undefined ? finalAvatar : normalizeOptionalString(user.avatar),
    bio: normalizeOptionalString(user.bio),
    main_practice_title: practiceChanged
      ? (practiceTitle ?? null)
      : normalizeOptionalString(user.main_practice_title),
    main_practice_file_path: practiceChanged
      ? (practiceTitle ? practiceFilePath ?? null : null)
      : normalizeOptionalString(user.main_practice_file_path),
    main_practice_selected_at: practiceChanged
      ? (practiceTitle ? practiceSelectedAt : null)
      : normalizeOptionalString(user.main_practice_selected_at),
    membership_type: user.membership_type || 'expired',
    membership_expires_at: normalizeOptionalString(user.membership_expires_at),
    free_trial_end_date: normalizeOptionalString(user.free_trial_end_date),
    stripe_customer_id: normalizeOptionalString(user.stripe_customer_id),
    subscription_id: normalizeOptionalString(user.subscription_id),
    total_transferred_bytes: user.total_transferred_bytes ?? 0,
    last_transfer_at: normalizeOptionalString(user.last_transfer_at),
    sync_version: user.sync_version ?? 1,
    extra_data: normalizeOptionalString(user.extra_data),
    created_at: user.created_at,
    updated_at: updatedAt
  };
}

function getNativeTransactionRunner(db) {
  const storage = db?.state?.storage;
  if (storage && typeof storage.transaction === 'function') {
    return (action) => storage.transaction(action);
  }
  if (storage && typeof storage.transactionSync === 'function') {
    return (action) => storage.transactionSync(action);
  }
  if (db && typeof db.transaction === 'function') {
    return (action) => db.transaction(action);
  }
  return null;
}

function getBatchRunner(db) {
  if (db && typeof db.batch === 'function') {
    return (statements) => db.batch(statements);
  }
  if (db?.db && typeof db.db.batch === 'function') {
    return (statements) => db.db.batch(statements);
  }
  return null;
}

async function runInTransaction(db, action) {
  const nativeTransaction = getNativeTransactionRunner(db);
  if (nativeTransaction) {
    return nativeTransaction(action);
  }

  return action();
}

async function migrateUsernameChange(db, user, {
  oldUsername,
  targetUsername,
  newEmail,
  newPhone,
  finalAvatar,
  passwordCreds,
  practiceTitle,
  practiceFilePath,
  practiceSelectedAt,
  updatedAt
}) {
  const finalState = getFinalProfileState(user, {
    targetUsername,
    newEmail,
    newPhone,
    finalAvatar,
    passwordCreds,
    practiceTitle,
    practiceFilePath,
    practiceSelectedAt,
    updatedAt
  });

  const detachOldUserStatement = db.prepare(`
    UPDATE users
    SET email = ?, phone_number = NULL, firebase_uid = NULL, apple_user_id = NULL,
        alipay_user_id = NULL, wechat_openid = NULL, updated_at = ?
    WHERE username = ?
  `).bind(
    migrationPlaceholderEmail(oldUsername),
    updatedAt,
    oldUsername
  );

  const insertNewUserStatement = db.prepare(`
    INSERT INTO users (
      username, email, password_hash, salt, iterations, algo, email_verified,
      alipay_user_id, alipay_nickname, alipay_avatar, alipay_bound_at,
      wechat_openid, wechat_nickname, wechat_headimgurl, wechat_bound_at,
      phone_number, firebase_uid, apple_user_id,
      nickname, avatar, bio,
      main_practice_title, main_practice_file_path, main_practice_selected_at,
      membership_type, membership_expires_at, free_trial_end_date,
      stripe_customer_id, subscription_id,
      total_transferred_bytes, last_transfer_at,
      sync_version, extra_data,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    finalState.username,
    finalState.email,
    finalState.password_hash,
    finalState.salt,
    finalState.iterations,
    finalState.algo,
    finalState.email_verified,
    finalState.alipay_user_id,
    finalState.alipay_nickname,
    finalState.alipay_avatar,
    finalState.alipay_bound_at,
    finalState.wechat_openid,
    finalState.wechat_nickname,
    finalState.wechat_headimgurl,
    finalState.wechat_bound_at,
    finalState.phone_number,
    finalState.firebase_uid,
    finalState.apple_user_id,
    finalState.nickname,
    finalState.avatar,
    finalState.bio,
    finalState.main_practice_title,
    finalState.main_practice_file_path,
    finalState.main_practice_selected_at,
    finalState.membership_type,
    finalState.membership_expires_at,
    finalState.free_trial_end_date,
    finalState.stripe_customer_id,
    finalState.subscription_id,
    finalState.total_transferred_bytes,
    finalState.last_transfer_at,
    finalState.sync_version,
    finalState.extra_data,
    finalState.created_at,
    finalState.updated_at
  );

  const deleteOldUserStatement = db.prepare('DELETE FROM users WHERE username = ?').bind(oldUsername);
  const d1BatchStatements = [detachOldUserStatement, insertNewUserStatement];

  if (user.email && user.email.toLowerCase() !== finalState.email) {
    d1BatchStatements.push(db.prepare('DELETE FROM email_username_mapping WHERE email = ?').bind(user.email.toLowerCase()));
  }
  if (finalState.email) {
    d1BatchStatements.push(db.prepare('INSERT OR REPLACE INTO email_username_mapping (email, username) VALUES (?, ?)').bind(finalState.email, targetUsername));
  }
  d1BatchStatements.push(deleteOldUserStatement);

  const runBatch = getBatchRunner(db);
  if (runBatch) {
    await runBatch(d1BatchStatements);
    await updateUsernameReferences(db, oldUsername, targetUsername);
    return;
  }

  await runInTransaction(db, async () => {
    await detachOldUserStatement.run();
    await insertNewUserStatement.run();
    await updateUsernameReferences(db, oldUsername, targetUsername);
    await applyEmailMapping(db, user.email, finalState.email, targetUsername);
    await deleteOldUserStatement.run();
  });
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
    const usernameChanged = targetUsername !== oldUsername;
    const updates = [];
    const values = [];
    const updatedAt = new Date().toISOString();

    if (newUsername !== undefined && newUsername !== oldUsername) {
      const existingUser = await db.getUser(newUsername);
      if (existingUser) {
        return jsonResponse({ error: '用户名已存在' }, 400);
      }
    }

    if (newEmail !== undefined && newEmail) {
      const existingEmailUser = await db.getUserByEmail(newEmail);
      if (existingEmailUser && existingEmailUser.username !== oldUsername) {
        return jsonResponse({ error: '该邮箱已被其他账号使用' }, 400);
      }
    }

    if (newPhone !== undefined && newPhone) {
      const existingPhoneUser = await db.getUserByPhone(newPhone);
      if (existingPhoneUser && existingPhoneUser.username !== oldUsername) {
        return jsonResponse({ error: '该手机号已被其他账号使用' }, 400);
      }
    }

    let finalAvatar;
    if (body.avatar !== undefined) {
      finalAvatar = normalizeOptionalString(body.avatar);
    }

    if (body.avatarData?.imageBase64) {
      finalAvatar = await uploadAvatarObject(
        request,
        env,
        targetUsername,
        body.avatarData.imageBase64,
        body.avatarData.fileName,
        body.avatarData.contentType
      );
    }

    let passwordCreds;
    if (body.password !== undefined && String(body.password).length > 0) {
      const hasPassword = Boolean(auth.user.password_hash && auth.user.salt);
      if (hasPassword) {
        return jsonResponse({ error: '当前账号已设置密码，请使用修改密码功能' }, 400);
      }
      const password = String(body.password);
      if (password.length < 6 || password.length > 128) {
        return jsonResponse({ error: '密码长度需为 6-128 位' }, 400);
      }
      passwordCreds = await createPasswordHash(password);
    }

    const mainPractice = body.mainPractice;
    const practiceTitle = mainPractice?.title ?? body.mainPracticeTitle;
    const practiceFilePath = mainPractice?.filePath ?? body.mainPracticeFilePath;
    const practiceSelectedAt = mainPractice?.selectedAt ?? updatedAt;

    if (!usernameChanged && newUsername !== undefined) {
      updates.push('nickname = ?');
      values.push(newUsername);
    }

    if (newEmail !== undefined) {
      updates.push('email = ?');
      values.push(newEmail || '');
      updates.push('email_verified = ?');
      values.push(newEmail ? 1 : 0);
    }

    if (newPhone !== undefined) {
      updates.push('phone_number = ?');
      values.push(newPhone);
    }

    if (finalAvatar !== undefined) {
      updates.push('avatar = ?');
      values.push(finalAvatar);
    }

    if (passwordCreds) {
      updates.push('password_hash = ?', 'salt = ?', 'iterations = ?', 'algo = ?');
      values.push(passwordCreds.passwordHash, passwordCreds.salt, passwordCreds.iterations, passwordCreds.algo);
    }

    if (practiceTitle !== undefined) {
      updates.push('main_practice_title = ?');
      values.push(practiceTitle);
      updates.push('main_practice_file_path = ?');
      values.push(practiceFilePath ?? null);
      updates.push('main_practice_selected_at = ?');
      values.push(practiceTitle ? practiceSelectedAt : null);
    }

    if (!usernameChanged && updates.length === 0) {
      return jsonResponse({ message: '没有需要更新的字段', user: serializeUser(auth.user) });
    }

    if (usernameChanged) {
      await migrateUsernameChange(db, auth.user, {
        oldUsername,
        targetUsername,
        newEmail,
        newPhone,
        finalAvatar,
        passwordCreds,
        practiceTitle,
        practiceFilePath,
        practiceSelectedAt,
        updatedAt
      });
    } else {
      updates.push('updated_at = ?');
      values.push(updatedAt);
      values.push(oldUsername);

      await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE username = ?`).bind(...values).run();

      if (newEmail !== undefined) {
        await applyEmailMapping(db, auth.user.email, newEmail, targetUsername);
      }
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
