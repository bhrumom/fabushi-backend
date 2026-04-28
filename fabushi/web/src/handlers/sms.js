// 手机验证码登录处理器 - 使用自定义短信验证码方案 (Firebase REST API需要reCAPTCHA，桌面端无法使用)
// 这个方案在Worker端存储验证码，通过邮件或第三方短信服务发送

// 生成6位数字验证码
function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// 发送验证码 - 暂时通过邮件模拟，后续可接入阿里云/腾讯云短信
export async function handleSendSmsCode(request, env, db) {
    try {
        const { phoneNumber } = await request.json();

        if (!phoneNumber || phoneNumber.length < 11) {
            return new Response(JSON.stringify({
                success: false,
                error: '请输入有效的手机号'
            }), { status: 400 });
        }

        // 生成验证码
        const code = generateCode();
        const expiresAt = Date.now() + 5 * 60 * 1000; // 5分钟有效期

        // 存储到KV (key: sms_code_{phone}, value: {code, expiresAt})
        await env.USERS_KV.put(
            `sms_code_${phoneNumber}`,
            JSON.stringify({ code, expiresAt, attempts: 0 }),
            { expirationTtl: 300 } // 5分钟后自动删除
        );

        // TODO: 替换为真实短信发送
        // 目前仅在控制台打印，生产环境需接入阿里云/腾讯云短信API
        console.log(`📱 发送验证码到 ${phoneNumber}: ${code}`);

        // 开发环境：返回验证码供测试
        const isDev = env.ENVIRONMENT === 'development';

        return new Response(JSON.stringify({
            success: true,
            message: '验证码已发送',
            // 生产环境不返回验证码
            ...(isDev && { debugCode: code })
        }), { status: 200 });

    } catch (e) {
        console.error('发送验证码失败:', e);
        return new Response(JSON.stringify({
            success: false,
            error: '发送验证码失败'
        }), { status: 500 });
    }
}

// 验证码登录
export async function handleSmsLogin(request, env, db) {
    try {
        const { phoneNumber, code } = await request.json();

        if (!phoneNumber || !code) {
            return new Response(JSON.stringify({
                success: false,
                error: '手机号和验证码不能为空'
            }), { status: 400 });
        }

        // 从KV获取验证码
        const storedData = await env.USERS_KV.get(`sms_code_${phoneNumber}`);
        if (!storedData) {
            return new Response(JSON.stringify({
                success: false,
                error: '验证码已过期，请重新获取'
            }), { status: 400 });
        }

        const { code: storedCode, expiresAt, attempts = 0 } = JSON.parse(storedData);

        // 检查尝试次数
        if (attempts >= 5) {
            await env.USERS_KV.delete(`sms_code_${phoneNumber}`);
            return new Response(JSON.stringify({
                success: false,
                error: '验证码错误次数过多，请重新获取'
            }), { status: 400 });
        }

        // 检查过期
        if (Date.now() > expiresAt) {
            await env.USERS_KV.delete(`sms_code_${phoneNumber}`);
            return new Response(JSON.stringify({
                success: false,
                error: '验证码已过期'
            }), { status: 400 });
        }

        // 验证码校验
        if (code !== storedCode) {
            // 增加尝试次数
            await env.USERS_KV.put(
                `sms_code_${phoneNumber}`,
                JSON.stringify({ code: storedCode, expiresAt, attempts: attempts + 1 }),
                { expirationTtl: Math.floor((expiresAt - Date.now()) / 1000) }
            );
            return new Response(JSON.stringify({
                success: false,
                error: '验证码错误'
            }), { status: 400 });
        }

        // 验证成功，删除验证码
        await env.USERS_KV.delete(`sms_code_${phoneNumber}`);

        // 查找或创建用户
        let user = await db.getUserByPhone(phoneNumber);
        let isNewUser = false;

        if (!user) {
            // 创建新用户
            isNewUser = true;
            const username = `user_${Date.now().toString(36)}`;
            const now = new Date().toISOString();
            const trialEnd = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();

            await db.createPhoneUser({
                username,
                email: `${phoneNumber.replace('+', '')}@phone.user`,
                phoneNumber,
                firebaseUid: null,
                membershipType: 'trial',
                freeTrialEndDate: trialEnd,
                createdAt: now
            });

            user = await db.getUserByPhone(phoneNumber);
        }

        // 生成JWT token
        const token = await generateJWT(user, env.JWT_SECRET);

        return new Response(JSON.stringify({
            success: true,
            token,
            username: user.username,
            isNewUser,
            user: {
                username: user.username,
                email: user.email,
                nickname: user.nickname || null,
                avatar: user.avatar || user.alipay_avatar || user.wechat_headimgurl || null,
                phoneNumber: user.phone_number,
                firebaseUid: user.firebase_uid || null,
                membership: {
                    type: user.membership_type || 'trial',
                    expiresAt: user.membership_expires_at || user.free_trial_end_date || null
                }
            }
        }), { status: 200 });

    } catch (e) {
        console.error('验证码登录失败:', e);
        return new Response(JSON.stringify({
            success: false,
            error: '登录失败: ' + e.message
        }), { status: 500 });
    }
}

// 生成JWT (复用auth.js中的逻辑)
async function generateJWT(user, secret) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = {
        sub: user.username,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60), // 30天
        isAdmin: user.is_admin === 1
    };

    const base64Header = btoa(JSON.stringify(header)).replace(/=/g, '');
    const base64Payload = btoa(JSON.stringify(payload)).replace(/=/g, '');
    const dataToSign = `${base64Header}.${base64Payload}`;

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );


    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(dataToSign));
    const base64Signature = btoa(String.fromCharCode(...new Uint8Array(signature)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');

    return `${dataToSign}.${base64Signature}`;
}
