function normalizeOptionalString(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeDisplayName(value) {
  const name = normalizeOptionalString(value);
  if (!name) return name;
  if (name.includes('@')) throw new Error('昵称不能包含 @，邮箱请填写到邮箱字段');
  if (/\s/.test(name)) throw new Error('昵称不能包含空格');
  if (name.length < 2 || name.length > 32) throw new Error('昵称长度需为 2-32 个字符');
  return name;
}

export function normalizeEmail(value) {
  const email = normalizeOptionalString(value);
  if (!email) return email;
  const normalized = email.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('邮箱格式不正确');
  return normalized;
}

export function normalizePhone(value) {
  const phone = normalizeOptionalString(value);
  if (!phone) return phone;
  if (!/^\+?[0-9]{6,20}$/.test(phone)) throw new Error('手机号格式不正确');
  return phone;
}

export function normalizeUsername(value) {
  const username = normalizeOptionalString(value);
  if (!username) return username;
  if (username.includes('@') || /\s/.test(username)) {
    throw new Error('用户名不能包含 @ 或空格');
  }
  if (username.length < 2 || username.length > 32) {
    throw new Error('用户名长度需为 2-32 个字符');
  }
  return username;
}

function looksLikeAccountUsername(value) {
  return /^[A-Za-z0-9_-]{2,32}$/.test(value);
}

export function normalizeProfileUpdateBody(body, currentUsername = '') {
  const rawNickname = body.nickname;
  const rawUsername = body.username;
  const password = body.password !== undefined ? String(body.password) : undefined;
  const normalizedCurrentUsername = String(currentUsername || '').trim();

  let hasDisplayNameField = rawNickname !== undefined;
  let displayName = rawNickname !== undefined ? normalizeDisplayName(rawNickname) : undefined;
  let username;

  if (rawUsername !== undefined) {
    const normalizedUsername = normalizeOptionalString(rawUsername);
    const wantsRename = Boolean(
      normalizedUsername
      && normalizedUsername !== normalizedCurrentUsername
      && looksLikeAccountUsername(normalizedUsername)
    );

    if (wantsRename) {
      username = normalizeUsername(normalizedUsername);
    } else if (rawNickname === undefined) {
      hasDisplayNameField = true;
      displayName = normalizeDisplayName(rawUsername);
    }
  }

  return {
    hasDisplayNameField,
    displayName,
    username,
    email: body.email !== undefined ? normalizeEmail(body.email) : undefined,
    phoneNumber: body.phoneNumber !== undefined ? normalizePhone(body.phoneNumber) : undefined,
    avatar: body.avatar !== undefined ? normalizeOptionalString(body.avatar) : undefined,
    password,
  };
}
