// Stripe 配置和工具函数
export const STRIPE_CONFIG = {
  // 价格配置已移至Worker配置统一管理
  // MONTHLY_PRICE_CNY: 700, // 7元 = 700分
  // MONTHLY_PRICE_USD: 100, // 1美元，用于测试
  
  // 新用户免费试用天数
  FREE_TRIAL_DAYS: 3,
  
  // Stripe 产品和价格 ID (需要在 Stripe Dashboard 中创建)
  PRODUCTS: {
    MONTHLY_MEMBERSHIP_CNY: 'price_monthly_membership_cny', // 替换为实际的价格ID
    MONTHLY_MEMBERSHIP_USD: 'price_monthly_membership_usd'  // 替换为实际的价格ID
  }
};

// 创建 Stripe 客户端
export function createStripeClient(apiKey) {
  return {
    async createCustomer(email, name) {
      const response = await fetch('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          email,
          name: name || email.split('@')[0]
        })
      });
      
      if (!response.ok) {
        throw new Error(`Stripe API error: ${response.status}`);
      }
      
      return await response.json();
    },

    async createSubscription(customerId, priceId, trialPeriodDays = null) {
      const params = {
        customer: customerId,
        items: JSON.stringify([{ price: priceId }]),
        payment_behavior: 'default_incomplete',
        payment_settings: JSON.stringify({
          save_default_payment_method: 'on_subscription'
        }),
        expand: JSON.stringify(['latest_invoice.payment_intent'])
      };

      if (trialPeriodDays) {
        params.trial_period_days = trialPeriodDays;
      }

      const response = await fetch('https://api.stripe.com/v1/subscriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams(params)
      });

      if (!response.ok) {
        throw new Error(`Stripe API error: ${response.status}`);
      }

      return await response.json();
    },

    async createPaymentIntent(amount, currency = 'cny', customerId = null) {
      const params = {
        amount,
        currency,
        automatic_payment_methods: JSON.stringify({ enabled: true })
      };

      if (customerId) {
        params.customer = customerId;
      }

      const response = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams(params)
      });

      if (!response.ok) {
        throw new Error(`Stripe API error: ${response.status}`);
      }

      return await response.json();
    },

    async retrieveSubscription(subscriptionId) {
      const response = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      if (!response.ok) {
        throw new Error(`Stripe API error: ${response.status}`);
      }

      return await response.json();
    },

    async cancelSubscription(subscriptionId) {
      const response = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });

      if (!response.ok) {
        throw new Error(`Stripe API error: ${response.status}`);
      }

      return await response.json();
    }
  };
}

// 会员状态检查工具
export function checkMembershipStatus(user) {
  const now = new Date();
  
  // 检查免费试用期
  if (user.freeTrialEndDate) {
    const trialEnd = new Date(user.freeTrialEndDate);
    if (now <= trialEnd) {
      return {
        isActive: true,
        type: 'trial',
        expiresAt: trialEnd,
        daysLeft: Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24))
      };
    }
  }
  
  // 检查付费会员 - 统一使用 membershipExpiresAt 字段
  const membershipEndDate = user.membershipExpiresAt;
  if (membershipEndDate) {
    const membershipEnd = new Date(membershipEndDate);
    if (now <= membershipEnd) {
      // 根据会员类型返回正确的类型
      const membershipType = user.membershipType === 'trial' ? 'trial' : 'paid';
      return {
        isActive: true,
        type: membershipType,
        expiresAt: membershipEnd,
        daysLeft: Math.ceil((membershipEnd - now) / (1000 * 60 * 60 * 24))
      };
    }
  }
  
  return {
    isActive: false,
    type: 'none',
    expiresAt: null,
    daysLeft: 0
  };
}

// 计算免费试用结束时间
export function calculateTrialEndDate(startDate = new Date()) {
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + STRIPE_CONFIG.FREE_TRIAL_DAYS);
  return endDate;
}