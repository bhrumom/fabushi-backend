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

export function normalizeProfileUpdateBody(body) {
  const rawDisplayName = body.nickname !== undefined ? body.nickname : body.username;
  const password = body.password !== undefined ? String(body.password) : undefined;

  return {
    hasDisplayNameField: rawDisplayName !== undefined,
    displayName: rawDisplayName !== undefined ? normalizeDisplayName(rawDisplayName) : undefined,
    email: body.email !== undefined ? normalizeEmail(body.email) : undefined,
    phoneNumber: body.phoneNumber !== undefined ? normalizePhone(body.phoneNumber) : undefined,
    avatar: body.avatar !== undefined ? normalizeOptionalString(body.avatar) : undefined,
    password,
  };
}
