export function serializeAccountUser(user) {
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
    mainPractice: user.main_practice_title
      ? {
          title: user.main_practice_title,
          filePath: user.main_practice_file_path,
          selectedAt: user.main_practice_selected_at,
        }
      : null,
    createdAt: user.created_at,
    emailVerified: user.email_verified === 1,
    membership: {
      type: user.membership_type || 'expired',
      expiresAt: user.membership_expires_at || user.free_trial_end_date || null,
    },
  };
}

export function buildPasswordLoginPayload({ token, user }) {
  return {
    token,
    username: user.username,
    userId: user.id,
    user: serializeAccountUser(user),
  };
}

export function buildProfileUpdatedPayload(user) {
  return {
    success: true,
    message: '个人资料更新成功',
    user: serializeAccountUser(user),
  };
}
