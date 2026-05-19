import { jsonResponse } from '../utils/response.js';
import {
    backfillOwnerUserId,
    hasStableUserId,
    isMissingUserIdColumnError,
    requireAuthIdentity,
} from '../utils/auth-identity.js';

async function backfillCommentsUserId(db, auth) {
    await backfillOwnerUserId(db, auth, [
        { table: 'comments', idColumn: 'account_user_id' },
    ]);
}

function isCommentShapeFallbackError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return isMissingUserIdColumnError(error) ||
        message.includes('not null constraint failed: comments.video_id');
}

async function insertComment(db, auth, {
    contentId,
    content,
    parentId,
    tag,
    videoTitle,
    mainPractice,
    now,
}) {
    if (hasStableUserId(auth)) {
        try {
            return await db.db.prepare(`
      INSERT INTO comments (content_id, username, account_user_id, content, created_at, parent_id, tag, content_title, main_practice, sync_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(contentId, auth.username, auth.userId, content, now, parentId || null, tag || null, videoTitle || null, mainPractice || null).run();
        } catch (error) {
            if (!isCommentShapeFallbackError(error)) throw error;
        }
    }

    try {
        return await db.db.prepare(`
      INSERT INTO comments (content_id, username, content, created_at, parent_id, tag, content_title, main_practice, sync_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(contentId, auth.username, content, now, parentId || null, tag || null, videoTitle || null, mainPractice || null).run();
    } catch (error) {
        if (!isCommentShapeFallbackError(error)) throw error;
    }

    return await db.db.prepare(`
      INSERT INTO comments (content_id, video_id, username, user_id, content, created_at, parent_id, tag, content_title, main_practice, sync_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(contentId, contentId, auth.username, auth.username, content, now, parentId || null, tag || null, videoTitle || null, mainPractice || null).run();
}

// 闂佸吋鍎抽崲鑼躲亹閸モ晜瀚氶柛鏇ㄥ櫘閸熷牓鏌涢幒鎿冩畽闁?
export async function handleGetComments(request, env, db) {
    try {
        const url = new URL(request.url);
        // 闂佽　鍋撴い鏍ㄧ☉閻?contentId 闂?videoId闂佹寧绋戦悧鍡涘箖濠婂牆瑙﹂幖绮光偓铏€柣搴℃贡濞呫垻妲?
        const contentId = url.searchParams.get('contentId') || url.searchParams.get('videoId');
        const page = parseInt(url.searchParams.get('page') || '1');
        const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
        const offset = (page - 1) * pageSize;

        if (!contentId) {
            return jsonResponse({ error: '闂佸憡鍔曢幊搴敊閹婵炴垶鎸哥粔鐑藉礂濡崵鈻旈柧蹇撳帨閺? }, 400);
        }

        // 闂佸吋鍎抽崲鑼躲亹閸モ晜瀚氶柛鏇ㄥ櫘閸熷牓鏌涢幒鎿冩畽闁靛棗鍟撮弫宥囦沪閽樺妯侀梺鍛婂嚬閸嬪棝寮妶澶婄闁炬艾鍊风换鍡涙煙?
        // 婵炶揪缍€濞夋洟寮ˇ濉穘tent_id缂傚倷鑳堕崰宥囩博閹绢喖鍐€闁搞儺浜炲Σ鏇㈡煥濞戞澧涙繛瀛樼⊕缁傛帡鏁愰崨顓熸灳闂佸搫顦崕鍐测枔閹插タdeo_id闂?
        const comments = await db.db.prepare(`
      SELECT 
        c.id, c.content_id, c.username as user_id, c.content, c.created_at, c.parent_id, c.like_count, c.tag, c.main_practice,
        u.username, u.nickname, u.avatar
      FROM comments c
      LEFT JOIN users u ON c.username = u.username
      WHERE c.content_id = ? AND (c.tag IS NULL OR c.tag != 'practice')
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(contentId, pageSize, offset).all();

        // 闂佸吋鍎抽崲鑼躲亹閸ヮ剙绠戦柡鍕箳濡叉垿鎮规担鍝勫妺闁?
        const totalResult = await db.db.prepare(`
      SELECT COUNT(*) as count FROM comments WHERE content_id = ? AND (tag IS NULL OR tag != 'practice')
    `).bind(contentId).first();

        return jsonResponse({
            comments: comments.results,
            total: totalResult.count,
            page,
            pageSize
        });
    } catch (error) {
        console.error('闂佸吋鍎抽崲鑼躲亹閸モ晜瀚氶柛鏇ㄥ櫘閸熷牆顭块幆鎵翱閻?', error);
        return jsonResponse({ error: '闂佸吋鍎抽崲鑼躲亹閸モ晜瀚氶柛鏇ㄥ櫘閸熷牆顭块幆鎵翱閻? }, 500);
    }
}

// 闂佸憡鐟﹂崹鐢电博妞嬪孩瀚氶柛鏇ㄥ櫘閸?
export async function handlePostComment(request, env, db) {
    try {
        const auth = await requireAuthIdentity(request, env, db.db || db);
        if (auth.error) return jsonResponse({ error: auth.error }, auth.status);
        await backfillCommentsUserId(db.db || db, auth);
        // 闂佽　鍋撴い鏍ㄧ☉閻?contentId 闂?videoId闂佹寧绋戦悧鍡涘箖濠婂牆瑙﹂幖绮光偓铏€柣搴℃贡濞呫垻妲?
        const { videoId, contentId: requestContentId, content, parentId, tag, videoTitle, filePath, mainPractice } = await request.json();
        const contentId = requestContentId || filePath || videoId;

        if (!contentId || !content) {
            return jsonResponse({ error: '闂佸憡鍔曢幊搴敊閹闂佸憡绮岄惌渚€鎯佹惔锝嗗闁告繂瀚弫鍫曟倵瑜版巻鍋撳☉姘辨喒闂佽壈娅曢崹婵堟嫻閻旇櫣鐭? }, 400);
        }

        // 婵°倗濮撮惌渚€鎯佹径鎰唨闁搞儮鏅╅崝顕€鏌?
        const validTags = ['ganying', 'fayuan', 'practice', null];
        if (tag && !validTags.includes(tag)) {
            return jsonResponse({ error: '闂佸搫鍟版慨鐢稿疾閵夆晜鍎嶉柛鏇ㄥ墰閸ㄨ偐绱掑☉妯衡挃閻炴凹鍋婂畷? }, 400);
        }

        const now = new Date().toISOString();

        // 闂佸湱绮敮鎺楀矗閸℃瑦瀚氶柛鏇ㄥ櫘閸熷牓鏌ㄥ☉妯煎濠电偛娲幃浠嬪Ω瑜忛崺鐘测槈閹绢垰浜鹃梺?content_id闂佹寧绋戦懟顖炲箖閹捐绫嶉悹铏瑰皑缂嶆牠鏌?video_id 闂?user_id 婵烇絽娲︾换鍐偓鍨瀹曘儵骞嬪┑鍥р偓鐢告煕韫囨洖甯舵い鏃€鍔欓弫?
        const result = await insertComment(db, auth, {
            contentId,
            content,
            parentId,
            tag,
            videoTitle,
            mainPractice,
            now,
        });

        // 闂佸憡鑹鹃張顒勵敆閻愬搫鍗抽悗娑櫳戦悡鈧?content_metadata 闂?comment_count
        await db.db.prepare(`
            INSERT INTO content_metadata (content_id, content_type, title, file_path, like_count, comment_count)
            VALUES (?, 'text', ?, ?, 0, 1)
            ON CONFLICT(content_id) DO UPDATE SET 
              title = COALESCE(excluded.title, title),
              file_path = COALESCE(excluded.file_path, file_path),
              comment_count = comment_count + 1
        `).bind(contentId, videoTitle || null, filePath || null).run();

        // 闂佸吋鍎抽崲鑼躲亹閸ヮ剙妫橀柣妤€鐗嗙徊濠氭煕韫囧鍔ゆ繛鍫熷灩閹风娀宕熼鍛櫏闁荤姴娴勯梽鍕磿韫囨稒鏅柛顐ｇ箓閻﹀爼鏌涘鐓庝簽闁轰降鍊濋獮瀣憥閸屾瑧绠氶梺璇″弾閸剟鍩€椤戣法鍔嶉柣鏍电悼缁灚绌遍幍浣镐壕濞达絿顭堥弫鍫曟倵绾拋娼愰柣鏍电稻閿涙劕螣缁洖浜惧ù锝呭槻閻︽粌菐閸ヨ泛鏋涘┑顔界〒閹风娀骞橀崨顖滎槴
        const newComment = await db.db.prepare(`
      SELECT 
        c.id, c.content_id, c.username as user_id, c.content, c.created_at, c.parent_id, c.like_count, c.tag, c.content_title, c.main_practice,
        u.username, u.nickname, u.avatar
      FROM comments c
      LEFT JOIN users u ON c.username = u.username
      WHERE c.id = ?
    `).bind(result.meta.last_row_id).first();

        return jsonResponse({
            message: '闁荤姴娲ょ€氼垶顢欓幋锕€鐭楅柟瀛樼箘椤忔挳鏌熺€涙ê濮囧┑?,
            comment: newComment
        }, 201);
    } catch (error) {
        console.error('闂佸憡鐟﹂崹鐢电博妞嬪孩瀚氶柛鏇ㄥ櫘閸熷牆顭块幆鎵翱閻?', error);
        return jsonResponse({ error: '闂佸憡鐟﹂崹鐢电博妞嬪孩瀚氶柛鏇ㄥ櫘閸熷牆顭块幆鎵翱閻? ' + error.message }, 500);
    }
}

// 闂佸憡甯炴繛鈧繛鍛捣閹风娀宕熼鍛櫏
export async function handleDeleteComment(request, env, db) {
    try {
        const auth = await requireAuthIdentity(request, env, db.db || db);
        if (auth.error) return jsonResponse({ error: auth.error }, auth.status);
        await backfillCommentsUserId(db.db || db, auth);

        const url = new URL(request.url);
        const commentId = url.searchParams.get('id');

        if (!commentId) {
            return jsonResponse({ error: 'comment id required' }, 400);
        }

        let comment;
        try {
            comment = await db.db.prepare(`
      SELECT username, account_user_id
      FROM comments
      WHERE id = ?
    `).bind(commentId).first();
        } catch (error) {
            if (!isMissingUserIdColumnError(error)) throw error;
            comment = await db.db.prepare(`
      SELECT username
      FROM comments
      WHERE id = ?
    `).bind(commentId).first();
        }

        if (!comment) {
            return jsonResponse({ error: 'comment not found' }, 404);
        }

        const commentUserId = Number(comment.account_user_id);
        const isOwnerById = Number.isFinite(commentUserId) && commentUserId === auth.userId;
        const isOwnerByUsername = comment.username === auth.username;
        if (!isOwnerById && !isOwnerByUsername) {
            return jsonResponse({ error: 'forbidden' }, 403);
        }

        await db.db.prepare(`
      DELETE FROM comments WHERE id = ?
    `).bind(commentId).run();

        return jsonResponse({ message: 'comment deleted' });
    } catch (error) {
        console.error('delete comment failed:', error);
        return jsonResponse({ error: 'delete comment failed' }, 500);
    }
}

// 闂佸吋鍎抽崲鑼躲亹閸モ晜鏆滈柨鏃傛櫕閸ㄨ偐绱掑☉妯衡挃婵炲牊鍨归弫顕€寮借閹藉秹鏌涢幒鎿冩畽闁靛棗鍟撮弫宥夊醇閻斿嘲韦闁?闂佸憡鐟﹂崹鍫曞礉瑜版帗鏅?
export async function handleGetTaggedPosts(request, env, db) {
    try {
        const url = new URL(request.url);
        const tag = url.searchParams.get('tag');
        const page = parseInt(url.searchParams.get('page') || '1');
        const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
        const offset = (page - 1) * pageSize;

        if (!tag || !['ganying', 'fayuan'].includes(tag)) {
            return jsonResponse({ error: '闂佸搫绉村ú銊╊敆妞嬪海灏甸悹鍥皺閳ь剛鍏樺顕€鎮╅搹顐ｇ彙闂佹寧绋戦懟顖滄崲閳ь剙顪冮妶鍥╁笡婵?ganying 闂?fayuan' }, 400);
        }

        // 闂佸吋鍎抽崲鑼躲亹閸モ晜鏆滈柨鏃傛櫕閸ㄨ偐绱掑☉妯衡挃婵炲牊鍨归弫顕€寮借閹藉秹鏌ㄥ☉妯垮閻庡灚锕㈠畷銉╊敃閵堝棙娈㈤梺鍦棎濞撹绌辨繝鍥х畳妞ゆ牗菤閸嬫挻鎷呴崫鍕寲闁荤姍鍛沪闁哄棛鍠栧畷顏嗕沪閽樺鏆ラ柣搴ｎ攰椤鎮ラ敐鍡矗?
        const posts = await db.db.prepare(`
      SELECT 
        c.id, c.content_id, c.username as user_id, c.content, c.created_at, c.tag, c.like_count, c.content_title,
        u.username, u.nickname, u.avatar
      FROM comments c
      LEFT JOIN users u ON c.username = u.username
      WHERE c.tag = ?
      ORDER BY c.created_at DESC
      LIMIT ? OFFSET ?
    `).bind(tag, pageSize, offset).all();

        // 婵炴垶鎸鹃崕銈夋儊閳╁啰鈻旀い蹇撳閻燁垶鎮楀☉娆忓妞わ腹鏅犻幃?content_title闂佹寧绋戦悧鍛椤撱垹绀傞柛顐ｇ矊閳诲繘鏌ｉ～顒€濡介柡鍡欏枛楠炴垿顢欓懖鈺傜殤闁诲孩绋掗敋闁稿绉归幆鍐礋椤掑倸鐏辨俊顐ゅ閿曨偆妲愬┑瀣Е闁挎洍鍋撻柛顭戝灡缁?content_id 闂佸湱绮崝鏇°亹閸ヮ剚鏅?
        const postsWithTitle = posts.results.map(post => {
            // 婵犵鈧啿鈧綊鎮樻径鎰瀬闁绘鐗嗙粊锕傚箹鐎涙ɑ灏版繝鈧担琛″亾濞戞顏堝磻瀹ュ鍎嶉柛鏇ㄥ墰閸ㄧ厧螞閻楀牞鍏紒杈ㄧ箞閹嫮鈧稒锚婢跺秴霉閿濆牊纭堕柡?
            if (post.content_title && post.content_title.trim()) {
                return post;
            }

            // 闂佸憡鐔粻鎴﹀垂椤栨粈鐒婃繝闈涳功濡茬霉?content_id 闂佸湱绮崝鏇°亹閸ヮ剚鏅柛顐ｇ箓閹垿鎮楃涵鍜佹綈婵☆偒鍋婂顐︽偋閸繄銈﹂梺?
            let contentTitle = '';
            if (post.content_id) {
                const parts = post.content_id.split('/');
                const filename = parts[parts.length - 1];
                contentTitle = filename.replace(/\.[^/.]+$/, '');
                contentTitle = contentTitle.replace(/[_-]/g, ' ');
            }
            return { ...post, content_title: contentTitle };
        });

        // 闂佸吋鍎抽崲鑼躲亹閸ヮ剙绠戠紓浣股戝▓?
        const totalResult = await db.db.prepare(`
      SELECT COUNT(*) as count FROM comments WHERE tag = ?
    `).bind(tag).first();

        return jsonResponse({
            posts: postsWithTitle,
            total: totalResult.count,
            page,
            pageSize
        });
    } catch (error) {
        console.error('闂佸吋鍎抽崲鑼躲亹閸モ晜鏆滈柡宓懏鎲ら梺鍛婂笚椤ㄥ濡撮崘鈺佺窞閺夊牜鍋夎:', error);
        return jsonResponse({ error: '闂佸吋鍎抽崲鑼躲亹閸モ晜鏆滈柡宓懏鎲ら梺鍛婂笚椤ㄥ濡撮崘鈺佺窞閺夊牜鍋夎' }, 500);
    }
}

// 闂佸吋鍎抽崲鑼躲亹閸ヮ剚鍊绘い鎾卞灪閿涘矂鏌涢幇顒佸櫣妞ゆ梹鍔欓弫宥夊醇濠婂懐鐓犵紓鍌欒兌閸犲秶绮╅幘顔藉剭?content_metadata 闁荤偞绋忛崝蹇涚嵁韫囨稑鐭楅柡宥囨暩缁€澶愭煕閺嵮勫櫣闁诡垰鐗撻幃娆戞兜閸涱垼娴€闂佽桨鐒﹀姗€骞忛幍顔藉珰闁告洦鍣崯鍫ユ煛娴ｇ绨荤紒?
export async function handleGetHotFeed(request, env, db) {
    try {
        const url = new URL(request.url);
        const page = parseInt(url.searchParams.get('page') || '1');
        const pageSize = parseInt(url.searchParams.get('pageSize') || '20');
        const offset = (page - 1) * pageSize;

        // 婵炲濮村ù椋庡垝閻戞鈻旈柍褜鍓熼幆?content_metadata 闁荤偞绋忛崝蹇涚嵁韫囨稑鐭楅柡宥庡亜閸斾即姊婚崒妯哄闁哥偛顕埀?
        const hotContent = await db.db.prepare(`
          SELECT 
            content_id as id,
            content_type,
            title,
            file_path,
            like_count,
            comment_count
          FROM content_metadata
          WHERE like_count > 0 OR comment_count > 0
          ORDER BY like_count DESC, comment_count DESC
          LIMIT ? OFFSET ?
        `).bind(pageSize, offset).all();

        // 闂佸吋鍎抽崲鑼躲亹閸ヮ剙绠戠紓浣股戝▓?
        const totalResult = await db.db.prepare(`
          SELECT COUNT(*) as count FROM content_metadata WHERE like_count > 0 OR comment_count > 0
        `).first();

        return jsonResponse({
            hotContent: hotContent.results,
            total: totalResult.count,
            page,
            pageSize
        });
    } catch (error) {
        console.error('闂佸吋鍎抽崲鑼躲亹閸ヮ剚鍊绘い鎾卞灪閿涘矂鏌涢幇顒佸櫣妞ゆ梹鍔栧鍕綇椤愩儛?', error);
        return jsonResponse({ error: '闂佸吋鍎抽崲鑼躲亹閸ヮ剚鍊绘い鎾卞灪閿涘矂鏌涢幇顒佸櫣妞ゆ梹鍔栧鍕綇椤愩儛? }, 500);
    }
}

// 闂佸吋鍎抽崲鑼躲亹閸モ晜鏆滈柡宓懏鎲ら柣鐘叉祫闂勫嫰宕曡箛娑欐櫖闁割偅绻傞惁鍫曟煕濮樼厧浜滈悽顖ｅ亞閹叉挳宕卞☉杈ㄦ婵烇絽娲犻崜婵囧閸涘瓨鏅?
export async function handleGetPostDetail(request, env, db) {
    try {
        const url = new URL(request.url);
        const postId = url.searchParams.get('id');

        if (!postId) {
            return jsonResponse({ error: '闁汇埄鍨遍悧鏇㈡偤濮楊湂婵炴垶鎸哥粔鐑藉礂濡崵鈻旈柧蹇撳帨閺? }, 400);
        }

        // 闂佸吋鍎抽崲鑼躲亹閸モ晜鏆滈柡宓懏鎲ら柣鐘叉祫闂勫嫰宕?
        const post = await db.db.prepare(`
      SELECT 
        c.id, c.content_id, c.username as user_id, c.content, c.created_at, c.tag, c.like_count,
        u.username, u.nickname, u.avatar
      FROM comments c
      LEFT JOIN users u ON c.username = u.username
      WHERE c.id = ? AND c.tag IS NOT NULL AND c.tag != 'practice'
    `).bind(postId).first();

        if (!post) {
            return jsonResponse({ error: '闁汇埄鍨遍悧鏇㈡偤濞嗘劗鈻旂€广儱鎳愰幗鐘绘煕? }, 404);
        }

        return jsonResponse({ post });
    } catch (error) {
        console.error('闂佸吋鍎抽崲鑼躲亹閸モ晜鏆滈柡宓懏鎲ら柣鐘叉祫闂勫嫰宕曡箛鏂跨窞閺夊牜鍋夎:', error);
        return jsonResponse({ error: '闂佸吋鍎抽崲鑼躲亹閸モ晜鏆滈柡宓懏鎲ら柣鐘叉祫闂勫嫰宕曡箛鏂跨窞閺夊牜鍋夎' }, 500);
    }
}

// 闂佸綊娼х紞濠囧闯濞差亝鍤旂€瑰嫭婢樼徊鍧楁偣閸パ冾伂妞ゆ梹鍨垮?
export async function handleBatchGetCommentCounts(request, env, db) {
    try {
        const { videoIds } = await request.json();

        if (!videoIds || !Array.isArray(videoIds) || videoIds.length === 0) {
            return jsonResponse({ error: '闁荤喐鐟ュΛ婵嬨€傜粋婊甸梺鍛婂笚椤ㄥ濡撮崘鈺冣枖鐎广儱鐗嗛崢鏉戔槈閹捐顏犻柍? }, 400);
        }

        // 闂傚倸瀚崝鏇㈠春濡や胶鈻旈柍褜鍓欓埢搴ㄥ焺閸愨晙绮繝銏ｅ煐绾板秹鎮￠敍鍕珰?00婵?
        const limitedIds = videoIds.slice(0, 100);

        // 闂佸搫顑呯€氼剛绱撻幘璇茶摕闁靛鐓堥崵?- 婵炶揪缍€濞夋洟寮?content_id 缂傚倷鑳堕崰宥囩博閹绢喖鍐€闁搞儺浜炲Σ?
        const placeholders = limitedIds.map(() => '?').join(',');
        const results = await db.db.prepare(`
            SELECT content_id, COUNT(*) as comment_count
            FROM comments
            WHERE content_id IN (${placeholders}) AND (tag IS NULL OR tag != 'practice')
            GROUP BY content_id
        `).bind(...limitedIds).all();

        // 闂佸搫顑呯€氼剛绱撻幘璇插強闁绘灏欏▓?
        const counts = {};
        for (const row of results.results) {
            counts[row.content_id] = row.comment_count;
        }

        // 缂佺虎鍙庨崰鏇犳崲濮樿泛绠ラ柍褜鍓熷鍨緞鎼搭喖娈插┑顔炬嚀閸婅鈻撻幈鏈岄梻渚囧枦婵倕锕㈡笟鈧畷鎰兜妞嬪海顦╁┑鐐插閸撴繂锕㈡担鐑樺珰闁告洦鍣崯鍫ユ煟閵娿儱顏紒缁樺灴瀹?闂?
        for (const id of limitedIds) {
            if (!(id in counts)) {
                counts[id] = 0;
            }
        }

        return jsonResponse({ counts });
    } catch (error) {
        console.error('闂佸綊娼х紞濠囧闯濞差亝鍤旂€瑰嫭婢樼徊鍧楁偣閸パ冾伂妞ゆ梹鍨垮顐﹀级鐟併倓鏉柣?', error);
        return jsonResponse({ error: '闂佸吋鍎抽崲鑼躲亹閸モ晜瀚氶柛鏇ㄥ櫘閸熷牓鏌℃担瑙勭凡闁靛洦鍨归幏? }, 500);
    }
}
