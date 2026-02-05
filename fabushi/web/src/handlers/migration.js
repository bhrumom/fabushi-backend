import { jsonResponse } from '../utils/response.js';
import { verifyToken } from '../../auth-utils.js';
import { isAdmin } from '../utils/helpers.js';

// KV到D1完整数据迁移
export async function handleMigrateKvToD1(request, env, db) {
  // 验证管理员权限
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
  if (!isAdmin(user.email)) {
    return jsonResponse({ error: '权限不足，需要管理员权限' }, 403);
  }

  const results = {
    users: { migrated: 0, errors: [] },
    purchases: { migrated: 0, errors: [] },
    redeems: { migrated: 0, errors: [] },
    memberships: { migrated: 0, errors: [] }
  };

  try {
    console.log('开始完整数据迁移...');

    // 1. 迁移用户数据
    await migrateUsers(env, db, results);
    
    // 2. 迁移购买记录
    await migratePurchases(env, db, results);
    
    // 3. 迁移兑换记录
    await migrateRedeems(env, db, results);
    
    // 4. 迁移会员数据
    await migrateMemberships(env, db, results);

    console.log('迁移完成:', results);
    
    return jsonResponse({
      success: true,
      message: '数据迁移完成',
      results
    });

  } catch (error) {
    console.error('迁移失败:', error);
    return jsonResponse({
      success: false,
      error: error.message,
      results
    }, 500);
  }
}

// 迁移用户数据
async function migrateUsers(env, db, results) {
  console.log('开始迁移用户数据...');
  
  const usersList = await env.USERS_KV.list();
  
  for (const key of usersList.keys) {
    try {
      const userData = await env.USERS_KV.get(key.name, 'json');
      if (!userData) continue;

      // 检查用户是否已存在
      const existingUser = await db.db.prepare(
        'SELECT username FROM users WHERE username = ?'
      ).bind(userData.username).first();

      if (existingUser) {
        // 更新现有用户
        await db.db.prepare(`
          UPDATE users SET 
            email = ?, password_hash = ?, salt = ?, iterations = ?, algo = ?,
            email_verified = ?, membership_type = ?, membership_expires_at = ?,
            free_trial_end_date = ?, stripe_customer_id = ?, subscription_id = ?,
            wechat_openid = ?, wechat_nickname = ?, wechat_headimgurl = ?, wechat_bound_at = ?,
            alipay_user_id = ?, alipay_nickname = ?, alipay_bound_at = ?,
            total_transferred_bytes = ?, last_transfer_at = ?, updated_at = ?
          WHERE username = ?
        `).bind(
          userData.email, userData.passwordHash, userData.salt, userData.iterations, userData.algo,
          userData.emailVerified ? 1 : 0, userData.membershipType || 'trial', userData.membershipExpiresAt,
          userData.freeTrialEndDate, userData.stripeCustomerId, userData.subscriptionId,
          userData.wechatOpenid, userData.wechatNickname, userData.wechatHeadimgurl, userData.wechatBoundAt,
          userData.alipayUserId, userData.alipayNickname, userData.alipayBoundAt,
          userData.totalTransferredBytes || 0, userData.lastTransferAt, new Date().toISOString(),
          userData.username
        ).run();
      } else {
        // 插入新用户
        await db.db.prepare(`
          INSERT INTO users (
            username, email, password_hash, salt, iterations, algo, email_verified,
            membership_type, membership_expires_at, free_trial_end_date,
            stripe_customer_id, subscription_id, wechat_openid, wechat_nickname, 
            wechat_headimgurl, wechat_bound_at, alipay_user_id, alipay_nickname, 
            alipay_bound_at, total_transferred_bytes, last_transfer_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          userData.username, userData.email, userData.passwordHash, userData.salt, 
          userData.iterations, userData.algo, userData.emailVerified ? 1 : 0,
          userData.membershipType || 'trial', userData.membershipExpiresAt, userData.freeTrialEndDate,
          userData.stripeCustomerId, userData.subscriptionId, userData.wechatOpenid, 
          userData.wechatNickname, userData.wechatHeadimgurl, userData.wechatBoundAt,
          userData.alipayUserId, userData.alipayNickname, userData.alipayBoundAt,
          userData.totalTransferredBytes || 0, userData.lastTransferAt, 
          userData.createdAt || new Date().toISOString()
        ).run();

        // 插入邮箱映射
        await db.db.prepare(
          'INSERT OR REPLACE INTO email_username_mapping (email, username) VALUES (?, ?)'
        ).bind(userData.email, userData.username).run();
      }

      results.users.migrated++;
      console.log(`用户 ${userData.username} 迁移成功`);
      
    } catch (error) {
      console.error(`用户 ${key.name} 迁移失败:`, error);
      results.users.errors.push({ key: key.name, error: error.message });
    }
  }
}

// 迁移购买记录
async function migratePurchases(env, db, results) {
  console.log('开始迁移购买记录...');
  
  // 从ORDERS_KV获取订单数据
  const ordersList = await env.ORDERS_KV.list();
  
  for (const key of ordersList.keys) {
    try {
      const orderData = await env.ORDERS_KV.get(key.name, 'json');
      if (!orderData) continue;

      // 检查是否已存在
      const existing = await db.db.prepare(
        'SELECT id FROM purchase_history WHERE order_id = ?'
      ).bind(key.name).first();

      if (!existing) {
        await db.db.prepare(`
          INSERT INTO purchase_history (
            username, order_id, plan, amount, currency, status, payment_method,
            purchased_at, valid_from, valid_to
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          orderData.userId || orderData.username,
          key.name,
          orderData.plan || 'monthly',
          orderData.amount || '21.00',
          orderData.currency || 'CNY',
          orderData.status || 'completed',
          orderData.paymentMethod || 'alipay',
          orderData.createdAt || orderData.purchasedAt || new Date().toISOString(),
          orderData.validFrom || new Date().toISOString(),
          orderData.validTo || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        ).run();

        results.purchases.migrated++;
        console.log(`购买记录 ${key.name} 迁移成功`);
      }
      
    } catch (error) {
      console.error(`购买记录 ${key.name} 迁移失败:`, error);
      results.purchases.errors.push({ key: key.name, error: error.message });
    }
  }
}

// 迁移兑换记录
async function migrateRedeems(env, db, results) {
  console.log('开始迁移兑换记录...');
  
  const redeemsList = await env.REDEEM_CODES_KV.list();
  
  for (const key of redeemsList.keys) {
    try {
      const redeemData = await env.REDEEM_CODES_KV.get(key.name, 'json');
      if (!redeemData) continue;

      // 如果是已使用的兑换码，添加到兑换记录
      if (redeemData.used && redeemData.usedBy) {
        const existing = await db.db.prepare(
          'SELECT id FROM redeem_history WHERE code = ? AND username = ?'
        ).bind(key.name, redeemData.usedBy).first();

        if (!existing) {
          await db.db.prepare(`
            INSERT INTO redeem_history (
              username, code, type, days, redeemed_at, valid_from, valid_to, previous_expiry_date
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            redeemData.usedBy,
            key.name,
            redeemData.type || 'premium',
            redeemData.days || 30,
            redeemData.usedAt || new Date().toISOString(),
            redeemData.validFrom || new Date().toISOString(),
            redeemData.validTo || new Date(Date.now() + (redeemData.days || 30) * 24 * 60 * 60 * 1000).toISOString(),
            redeemData.previousExpiryDate
          ).run();

          results.redeems.migrated++;
          console.log(`兑换记录 ${key.name} 迁移成功`);
        }
      }
      
    } catch (error) {
      console.error(`兑换记录 ${key.name} 迁移失败:`, error);
      results.redeems.errors.push({ key: key.name, error: error.message });
    }
  }
}

// 迁移会员数据
async function migrateMemberships(env, db, results) {
  console.log('开始迁移会员数据...');
  
  const membershipsList = await env.MEMBERSHIP_KV.list();
  
  for (const key of membershipsList.keys) {
    try {
      const membershipData = await env.MEMBERSHIP_KV.get(key.name, 'json');
      if (!membershipData) continue;

      // 更新用户表中的会员信息
      const username = key.name.replace('membership_', '');
      
      await db.db.prepare(`
        UPDATE users SET 
          membership_type = ?, 
          membership_expires_at = ?,
          updated_at = ?
        WHERE username = ?
      `).bind(
        membershipData.type || 'paid',
        membershipData.expiresAt,
        new Date().toISOString(),
        username
      ).run();

      results.memberships.migrated++;
      console.log(`会员数据 ${username} 迁移成功`);
      
    } catch (error) {
      console.error(`会员数据 ${key.name} 迁移失败:`, error);
      results.memberships.errors.push({ key: key.name, error: error.message });
    }
  }
}