// KV到D1数据迁移脚本
// 使用方法: wrangler dev --local 然后访问 /migrate-data

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    if (url.pathname === '/migrate-data') {
      return await migrateData(env);
    }
    
    return new Response('Migration script. Visit /migrate-data to start migration.');
  }
};

async function migrateData(env) {
  const results = {
    users: 0,
    orders: 0,
    redeemCodes: 0,
    errors: []
  };

  try {
    // 1. 迁移用户数据
    console.log('开始迁移用户数据...');
    const userKeys = await env.USERS_KV.list({ prefix: 'user:' });
    
    for (const key of userKeys.keys) {
      try {
        const userData = await env.USERS_KV.get(key.name);
        if (!userData) continue;
        
        const user = JSON.parse(userData);
        
        // 插入用户
        await env.DB.prepare(`
          INSERT OR REPLACE INTO users (
            username, email, password_hash, salt, iterations, algo,
            email_verified, membership_type, membership_expires_at,
            free_trial_end_date, stripe_customer_id, subscription_id,
            wechat_openid, wechat_nickname, wechat_headimgurl, wechat_bound_at,
            alipay_user_id, alipay_nickname, alipay_bound_at,
            total_transferred_bytes, last_transfer_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          user.username,
          user.email,
          user.passwordHash,
          user.salt,
          user.iterations || 100000,
          user.algo || 'PBKDF2-SHA256',
          user.emailVerified ? 1 : 0,
          user.membershipType || 'trial',
          user.membershipExpiresAt || null,
          user.freeTrialEndDate || null,
          user.stripeCustomerId || null,
          user.subscriptionId || null,
          user.wechatOpenid || null,
          user.wechatNickname || null,
          user.wechatHeadimgurl || null,
          user.wechatBoundAt || null,
          user.alipayUserId || null,
          user.alipayNickname || null,
          user.alipayBoundAt || null,
          user.totalTransferredBytes || 0,
          user.lastTransferAt || null,
          user.createdAt,
          user.updatedAt || null
        ).run();
        
        // 插入邮箱映射
        if (user.email) {
          await env.DB.prepare(`
            INSERT OR REPLACE INTO email_username_mapping (email, username)
            VALUES (?, ?)
          `).bind(user.email, user.username).run();
        }
        
        results.users++;
      } catch (error) {
        results.errors.push(`User ${key.name}: ${error.message}`);
      }
    }

    // 2. 迁移订单数据
    console.log('开始迁移订单数据...');
    const orderKeys = await env.ORDERS_KV.list();
    
    for (const key of orderKeys.keys) {
      try {
        const orderData = await env.ORDERS_KV.get(key.name);
        if (!orderData) continue;
        
        const order = JSON.parse(orderData);
        
        await env.DB.prepare(`
          INSERT OR REPLACE INTO orders (
            order_id, user_id, plan, amount, original_amount,
            is_admin_order, status, platform, trade_no, paid_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          order.orderId,
          order.userId,
          order.plan,
          order.amount,
          order.originalAmount || null,
          order.isAdminOrder ? 1 : 0,
          order.status,
          order.platform || 'alipay',
          order.tradeNo || null,
          order.paidAt || null,
          order.createdAt
        ).run();
        
        results.orders++;
      } catch (error) {
        results.errors.push(`Order ${key.name}: ${error.message}`);
      }
    }

    // 3. 迁移兑换码数据
    console.log('开始迁移兑换码数据...');
    const codeKeys = await env.REDEEM_CODES_KV.list({ prefix: 'code:' });
    
    for (const key of codeKeys.keys) {
      try {
        const codeData = await env.REDEEM_CODES_KV.get(key.name);
        if (!codeData) continue;
        
        const code = JSON.parse(codeData);
        
        await env.DB.prepare(`
          INSERT OR REPLACE INTO redeem_codes (
            code, type, days, name, description, created_by,
            created_at, used, used_by, used_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          code.code,
          code.type,
          code.days,
          code.name,
          code.description || null,
          code.createdBy,
          code.createdAt,
          code.used ? 1 : 0,
          code.usedBy || null,
          code.usedAt || null
        ).run();
        
        results.redeemCodes++;
      } catch (error) {
        results.errors.push(`Code ${key.name}: ${error.message}`);
      }
    }

    // 4. 迁移购买记录
    console.log('开始迁移购买记录...');
    const purchaseKeys = await env.USERS_KV.list({ prefix: 'purchases:' });
    
    for (const key of purchaseKeys.keys) {
      try {
        const purchaseData = await env.USERS_KV.get(key.name);
        if (!purchaseData) continue;
        
        const purchases = JSON.parse(purchaseData);
        const username = key.name.replace('purchases:', '');
        
        for (const purchase of purchases) {
          await env.DB.prepare(`
            INSERT OR IGNORE INTO purchase_history (
              username, order_id, plan, amount, currency, status,
              payment_method, purchased_at, valid_from, valid_to
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            username,
            purchase.orderId,
            purchase.plan,
            purchase.amount,
            purchase.currency || 'CNY',
            purchase.status,
            purchase.paymentMethod,
            purchase.purchasedAt,
            purchase.validFrom,
            purchase.validTo
          ).run();
        }
      } catch (error) {
        results.errors.push(`Purchases ${key.name}: ${error.message}`);
      }
    }

    // 5. 迁移兑换记录
    console.log('开始迁移兑换记录...');
    const redeemKeys = await env.USERS_KV.list({ prefix: 'redeems:' });
    
    for (const key of redeemKeys.keys) {
      try {
        const redeemData = await env.USERS_KV.get(key.name);
        if (!redeemData) continue;
        
        const redeems = JSON.parse(redeemData);
        const username = key.name.replace('redeems:', '');
        
        for (const redeem of redeems) {
          await env.DB.prepare(`
            INSERT OR IGNORE INTO redeem_history (
              username, code, type, days, redeemed_at,
              valid_from, valid_to, previous_expiry_date
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            username,
            redeem.code,
            redeem.type,
            redeem.days,
            redeem.redeemedAt,
            redeem.validFrom,
            redeem.validTo,
            redeem.previousExpiryDate || null
          ).run();
        }
      } catch (error) {
        results.errors.push(`Redeems ${key.name}: ${error.message}`);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: '数据迁移完成',
      results,
      timestamp: new Date().toISOString()
    }, null, 2), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      stack: error.stack,
      results
    }, null, 2), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
