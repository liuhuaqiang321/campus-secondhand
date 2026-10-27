// ============================================================
// 数据访问层 —— 由原项目后端 REST 接口（共 33 个）迁移而来
//
// 原来：浏览器 fetch → Spring Boot Controller → MyBatis → MySQL
// 现在：浏览器 → Supabase JS SDK → PostgreSQL + Auth + Storage
//
// 对外保持与原 api.js 完全一致的返回契约：
//     { code: 200, message: 'success', data: xxx }
//     { code: 500, message: '错误信息', data: null }
// 因此业务层（app.js）的调用方式基本不变。
// ============================================================

let sb = null;

const ok = (data) => ({ code: 200, message: 'success', data });
const fail = (message) => ({ code: 500, message, data: null });

function camelKeys(value) {
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) return value.map(camelKeys);
    if (typeof value !== 'object') return value;
    const out = {};
    for (const key of Object.keys(value)) {
        const newKey = key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
        out[newKey] = camelKeys(value[key]);
    }
    return out;
}

// Supabase 原始错误信息中文化
function translateError(error) {
    if (!error) return '未知错误';
    const msg = error.message || String(error);
    if (msg.includes('Invalid login credentials')) return '用户名或密码错误';
    if (msg.includes('Email not confirmed')) return '该账号尚未完成邮箱验证，请在 Supabase 后台关闭邮箱确认后重新注册';
    if (msg.includes('already registered')) return '该用户名已被注册';
    if (msg.includes('uk_order_reviewer_type')) return '您已评价过该订单';
    if (msg.includes('uk_user_item')) return '已收藏过该物品';
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) return '网络连接失败，请检查网络或 Supabase 地址是否正确';
    if (msg.includes('JWT')) return '登录状态已过期，请重新登录';
    if (msg.includes('row-level security')) return '没有权限执行该操作';
    return msg;
}

// 用户名 → 伪邮箱（Supabase Auth 以邮箱作为账号标识）
// 例：student → student@campus.secondhand.local
function toEmail(username) {
    return `${String(username).trim().toLowerCase()}@campus.secondhand.local`;
}

// 物品行 → 业务对象（补平卖家昵称、分类名）
function mapItem(row) {
    if (!row) return row;
    const item = camelKeys(row);
    item.categoryName = row.category ? row.category.name : '未分类';
    item.sellerNickname = row.profiles ? row.profiles.nickname : '卖家';
    item.sellerAvatar = row.profiles ? row.profiles.avatar : '';
    delete item.category;
    delete item.profiles;
    return item;
}

// 订单行 → 业务对象
function mapOrder(row) {
    if (!row) return row;
    const o = camelKeys(row);
    o.itemTitle = row.item ? row.item.title : '';
    o.itemImage = row.item && row.item.images && row.item.images.length ? row.item.images[0] : null;
    o.itemPrice = row.item ? row.item.price : null;
    o.buyerNickname = row.buyer ? row.buyer.nickname : '';
    o.sellerNickname = row.seller ? row.seller.nickname : '';
    delete o.item;
    delete o.buyer;
    delete o.seller;
    return o;
}

const ITEM_SELECT = '*, category:category!item_category_id_fkey(name), profiles:profiles!item_user_id_fkey(nickname, avatar)';

const ORDER_SELECT = '*, item:item!orders_item_id_fkey(title, images, price), buyer:profiles!orders_buyer_id_fkey(nickname, avatar), seller:profiles!orders_seller_id_fkey(nickname, avatar)';

// ============================================================
// 数据服务对象
// ============================================================
const db = {
    // 本地会话状态（登录后同步更新，便于同步读取）
    state: {
        uid: null,
        profile: null
    },

    // 建立云数据库连接（SDK 加载完成后调用一次即可）
    connect() {
        if (sb) return sb;
        if (!window.supabase) throw new Error('SDK_NOT_LOADED');
        if (!window.isSupabaseConfigured()) throw new Error('NOT_CONFIGURED');
        sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: false
            }
        });
        return sb;
    },

    // ----------------------------------------------------
    // 初始化：恢复刷新页面后的登录状态
    // ----------------------------------------------------
    async init() {
        try {
            db.connect();
        } catch (e) {
            return fail(e.message === 'NOT_CONFIGURED' ? '尚未完成 Supabase 配置' : 'Supabase SDK 加载失败');
        }
        const { data } = await sb.auth.getSession();
        const user = data && data.session ? data.session.user : null;
        if (!user) {
            db.state.uid = null;
            db.state.profile = null;
            return ok(null);
        }
        db.state.uid = user.id;
        let profileRes = await db.user.getProfile(user.id);
        if (profileRes.code !== 200) {
            // auth 用户存在但 profile 缺失时的补救写入
            const fallbackName = (user.email || 'user').split('@')[0];
            await sb.from('profiles').upsert(
                { id: user.id, username: fallbackName, nickname: fallbackName, avatar: '' },
                { onConflict: 'id' }
            );
            profileRes = await db.user.getProfile(user.id);
        }
        if (profileRes.code === 200) {
            db.state.profile = profileRes.data;
            return ok(db.state.profile);
        }
        return profileRes;
    },

    // ----------------------------------------------------
    // 1. 用户模块（对应 UserController 的 4 个接口）
    // ----------------------------------------------------
    user: {
        // POST /api/user/register
        async register(body) {
            const username = String(body.username || '').trim();
            if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
                return fail('用户名需为 3-20 位字母、数字或下划线');
            }
            if (!body.password || body.password.length < 6) {
                return fail('密码长度不能少于 6 位');
            }
            // 先查重，避免 auth 账号建成而 profile 写入失败形成孤立账号
            const { count } = await sb
                .from('profiles')
                .select('id', { count: 'exact', head: true })
                .eq('username', username);
            if (count > 0) return fail('该用户名已被注册');

            const { data, error } = await sb.auth.signUp({
                email: toEmail(username),
                password: body.password,
                options: {
                    data: {
                        username,
                        nickname: body.nickname || username,
                        phone: body.phone || '',
                        school: body.school || ''
                    }
                }
            });
            if (error) return fail(translateError(error));
            if (!data.session) {
                return fail('注册成功，但需先完成邮箱验证。请在 Supabase 后台关闭邮箱确认后重新注册');
            }

            const profile = {
                id: data.user.id,
                username,
                nickname: body.nickname || username,
                phone: body.phone || null,
                school: body.school || null,
                avatar: ''
            };
            await sb.from('profiles').upsert(profile, { onConflict: 'id' });

            db.state.uid = data.user.id;
            db.state.profile = { id: profile.id, username, nickname: profile.nickname };
            return ok(db.state.profile);
        },

        // POST /api/user/login
        async login(body) {
            const username = String(body.username || '').trim();
            if (!username || !body.password) return fail('请输入用户名和密码');
            const { data, error } = await sb.auth.signInWithPassword({
                email: toEmail(username),
                password: body.password
            });
            if (error) return fail(translateError(error));
            const profileRes = await db.user.getProfile(data.user.id);
            if (profileRes.code !== 200) return profileRes;
            // 被管理员禁用的账号不允许登录
            if (Number(profileRes.data.status) === 0) {
                await sb.auth.signOut();
                return fail('该账号已被管理员禁用，如有疑问请联系管理员');
            }
            db.state.uid = data.user.id;
            db.state.profile = profileRes.data;
            return ok(profileRes.data);
        },

        async logout() {
            await sb.auth.signOut();
            db.state.uid = null;
            db.state.profile = null;
            return ok(null);
        },

        // GET /api/user/profile/{userId}
        async getProfile(userId) {
            const { data, error } = await sb
                .from('profiles')
                .select('id, username, nickname, phone, avatar, school, role, status, created_at')
                .eq('id', userId)
                .maybeSingle();
            if (error) return fail(translateError(error));
            if (!data) return fail('用户资料不存在');
            return ok(camelKeys(data));
        },

        // PUT /api/user/profile
        async updateProfile(patch) {
            const uid = db.state.uid;
            if (!uid) return fail('请先登录');
            const payload = {};
            if (patch.nickname !== undefined) payload.nickname = patch.nickname;
            if (patch.phone !== undefined) payload.phone = patch.phone;
            if (patch.school !== undefined) payload.school = patch.school;
            if (patch.avatar !== undefined) payload.avatar = patch.avatar;
            const { data, error } = await sb
                .from('profiles')
                .update(payload)
                .eq('id', uid)
                .select()
                .maybeSingle();
            if (error) return fail(translateError(error));
            db.state.profile = camelKeys(data);
            return ok(db.state.profile);
        }
    },

    // ----------------------------------------------------
    // 2. 分类模块（对应 CategoryController 的 3 个接口）
    // ----------------------------------------------------
    category: {
        async _all() {
            const { data, error } = await sb
                .from('category')
                .select('*')
                .eq('status', 1)
                .order('sort_order', { ascending: true })
                .order('id', { ascending: true });
            if (error) return fail(translateError(error));
            return ok(camelKeys(data || []));
        },

        // 选中一级分类时，连带查出其下所有二级分类（两级结构）
        async _childIds(categoryId) {
            const res = await db.category._all();
            if (res.code !== 200) return [categoryId];
            const ids = res.data
                .filter(c => c.id === categoryId || c.parentId === categoryId)
                .map(c => c.id);
            return ids.length ? ids : [categoryId];
        },

        // GET /api/category/parents
        async parents() {
            const res = await db.category._all();
            if (res.code !== 200) return res;
            return ok(res.data.filter(c => c.parentId === 0));
        },

        // GET /api/category/children/{parentId}
        async children(parentId) {
            const res = await db.category._all();
            if (res.code !== 200) return res;
            return ok(res.data.filter(c => c.parentId === Number(parentId)));
        },

        // GET /api/category/tree
        async tree() {
            const res = await db.category._all();
            if (res.code !== 200) return res;
            const parents = res.data.filter(c => c.parentId === 0);
            return ok(parents.map(p => ({
                ...p,
                children: res.data.filter(c => c.parentId === p.id)
            })));
        }
    },

    // ----------------------------------------------------
    // 3. 物品模块（对应 ItemController 的 7 个接口）
    // ----------------------------------------------------
    item: {
        // POST /api/item/publish
        async publish(body) {
            const uid = db.state.uid;
            if (!uid) return fail('请先登录');
            if (!body.title || !body.categoryId || body.price === undefined || body.price === null) {
                return fail('请填写标题、分类和售价');
            }
            const { data, error } = await sb.from('item').insert({
                title: body.title,
                category_id: Number(body.categoryId),
                user_id: uid,
                price: body.price,
                original_price: body.originalPrice || null,
                description: body.description || '',
                images: body.images || [],
                condition: body.condition || 1,
                status: 1
            }).select().single();
            if (error) return fail(translateError(error));
            return ok({ id: data.id });
        },

        // PUT /api/item/{itemId}
        async update(itemId, body) {
            const uid = db.state.uid;
            if (!uid) return fail('请先登录');
            const payload = {};
            if (body.title !== undefined) payload.title = body.title;
            if (body.categoryId !== undefined) payload.category_id = Number(body.categoryId);
            if (body.price !== undefined) payload.price = body.price;
            if (body.originalPrice !== undefined) payload.original_price = body.originalPrice;
            if (body.description !== undefined) payload.description = body.description;
            if (body.images !== undefined) payload.images = body.images;
            if (body.condition !== undefined) payload.condition = body.condition;
            const { error } = await sb.from('item').update(payload).eq('id', itemId).eq('user_id', uid);
            if (error) return fail(translateError(error));
            return ok(null);
        },

        // PUT /api/item/{itemId}/off-shelf
        async offShelf(itemId) {
            const uid = db.state.uid;
            if (!uid) return fail('请先登录');
            const { error } = await sb.from('item').update({ status: 0 }).eq('id', itemId).eq('user_id', uid);
            if (error) return fail(translateError(error));
            return ok(null);
        },

        // GET /api/item/search
        // 参数与原 ItemQueryDTO 保持一致：pageNum / pageSize / sortType / categoryId / title
        async search(query = {}) {
            const { pageNum = 1, pageSize = 12, sortType = 1, categoryId, title, userId } = query;

            let builder = sb.from('item').select(ITEM_SELECT, { count: 'exact' }).eq('status', 1);
            if (title) builder = builder.ilike('title', `%${title}%`);
            if (userId) builder = builder.eq('user_id', userId);
            if (categoryId && Number(categoryId) > 0) {
                builder = builder.in('category_id', await db.category._childIds(Number(categoryId)));
            }

            const orders = {
                1: ['created_at', false],
                2: ['price', true],
                3: ['price', false],
                4: ['view_count', false]
            };
            const [col, asc] = orders[sortType] || orders[1];
            builder = builder.order(col, { ascending: asc });

            const from = (pageNum - 1) * pageSize;
            const { data, count, error } = await builder.range(from, from + pageSize - 1);
            if (error) return fail(translateError(error));

            return ok({
                list: (data || []).map(mapItem),
                total: count || 0,
                pageNum,
                pageSize
            });
        },

        // GET /api/item/detail/{id}
        async detail(itemId) {
            const { data, error } = await sb
                .from('item')
                .select(ITEM_SELECT)
                .eq('id', itemId)
                .maybeSingle();
            if (error) return fail(translateError(error));
            if (!data) return fail('物品不存在或已下架');
            await sb.rpc('increment_view_count', { p_item_id: itemId });
            return ok(mapItem(data));
        },

        // GET /api/item/my
        async my() {
            const uid = db.state.uid;
            if (!uid) return fail('请先登录');
            const { data, error } = await sb
                .from('item')
                .select(ITEM_SELECT)
                .eq('user_id', uid)
                .order('created_at', { ascending: false });
            if (error) return fail(translateError(error));
            return ok((data || []).map(mapItem));
        },

        // GET /api/item/latest
        async latest(limit = 10) {
            const { data, error } = await sb
                .from('item')
                .select(ITEM_SELECT)
                .eq('status', 1)
                .order('created_at', { ascending: false })
                .limit(limit);
            if (error) return fail(translateError(error));
            return ok((data || []).map(mapItem));
        }
    },

    // ----------------------------------------------------
    // 4. 订单模块（对应 OrderController 的 8 个接口）
    // ----------------------------------------------------
    order: {
        // POST /api/order/create
        async create(body) {
            const { data, error } = await sb.rpc('create_order', { p_item_id: body.itemId });
            if (error) return fail(translateError(error));
            return ok({ id: data });
        },

        // PUT /api/order/{orderId}/pay | ship | confirm | cancel
        async changeStatus(orderId, action) {
            const { error } = await sb.rpc('update_order_status', {
                p_order_id: orderId,
                p_action: action
            });
            if (error) return fail(translateError(error));
            return ok(null);
        },

        // GET /api/order/buy
        async buy() {
            const uid = db.state.uid;
            if (!uid) return fail('请先登录');
            const { data, error } = await sb
                .from('orders')
                .select(ORDER_SELECT)
                .eq('buyer_id', uid)
                .order('created_at', { ascending: false });
            if (error) return fail(translateError(error));
            return ok((data || []).map(mapOrder));
        },

        // GET /api/order/sell
        async sell() {
            const uid = db.state.uid;
            if (!uid) return fail('请先登录');
            const { data, error } = await sb
                .from('orders')
                .select(ORDER_SELECT)
                .eq('seller_id', uid)
                .order('created_at', { ascending: false });
            if (error) return fail(translateError(error));
            return ok((data || []).map(mapOrder));
        },

        // GET /api/order/detail/{orderId}
        async detail(orderId) {
            const { data, error } = await sb
                .from('orders')
                .select(ORDER_SELECT)
                .eq('id', orderId)
                .maybeSingle();
            if (error) return fail(translateError(error));
            if (!data) return fail('订单不存在');
            return ok(mapOrder(data));
        }
    },

    // ----------------------------------------------------
    // 5. 留言模块（对应 MessageController 的 3 个接口）
    // ----------------------------------------------------
    message: {
        // POST /api/message/leave
        async leave(body) {
            const uid = db.state.uid;
            if (!uid) return fail('请先登录');
            if (!body.content || !body.content.trim()) return fail('留言内容不能为空');
            const { data: itemRow, error: itemErr } = await sb
                .from('item')
                .select('user_id')
                .eq('id', body.itemId)
                .maybeSingle();
            if (itemErr || !itemRow) return fail('物品不存在');

            const { error } = await sb.from('message').insert({
                item_id: body.itemId,
                from_user_id: uid,
                to_user_id: itemRow.user_id,
                content: body.content.trim(),
                parent_id: body.parentId || 0
            });
            if (error) return fail(translateError(error));
            return ok(null);
        },

        // GET /api/message/item/{itemId}
        // 返回结构与原接口一致：顶级留言内含 replies 子回复
        async item(itemId) {
            const { data, error } = await sb
                .from('message')
                .select('*, fromUser:profiles!message_from_user_id_fkey(nickname, avatar)')
                .eq('item_id', itemId)
                .eq('status', 1)
                .order('created_at', { ascending: true });
            if (error) return fail(translateError(error));

            const rows = (data || []).map(r => {
                const m = camelKeys(r);
                m.fromUserNickname = r.fromUser ? r.fromUser.nickname : '匿名用户';
                m.fromUserAvatar = r.fromUser ? r.fromUser.avatar : '';
                delete m.fromUser;
                return m;
            });

            const tops = rows.filter(m => m.parentId === 0);
            tops.forEach(t => { t.replies = rows.filter(m => m.parentId === t.id); });
            return ok({ messages: tops, list: tops });
        },

        // GET /api/message/received
        async received() {
            const uid = db.state.uid;
            if (!uid) return fail('请先登录');
            const { data, error } = await sb
                .from('message')
                .select('*, item:item!message_item_id_fkey(title, images), fromUser:profiles!message_from_user_id_fkey(nickname, avatar)')
                .eq('to_user_id', uid)
                .eq('status', 1)
                .order('created_at', { ascending: false });
            if (error) return fail(translateError(error));
            return ok((data || []).map(r => {
                const m = camelKeys(r);
                m.fromUserNickname = r.fromUser ? r.fromUser.nickname : '匿名用户';
                m.itemTitle = r.item ? r.item.title : '';
                m.itemImage = r.item && r.item.images && r.item.images.length ? r.item.images[0] : null;
                delete m.fromUser;
                delete m.item;
                return m;
            }));
        }
    },

    // ----------------------------------------------------
    // 6. 收藏模块（对应 FavoriteController 的 4 个接口）
    // ----------------------------------------------------
    favorite: {
        // POST /api/favorite/add/{itemId}
        async add(itemId) {
            const uid = db.state.uid;
            if (!uid) return fail('请先登录');
            const { error } = await sb.from('favorite').insert({ user_id: uid, item_id: itemId });
            if (error) return fail(translateError(error));
            return ok(null);
        },

        // DELETE /api/favorite/remove/{itemId}
        async remove(itemId) {
            const uid = db.state.uid;
            if (!uid) return fail('请先登录');
            const { error } = await sb.from('favorite').delete().eq('user_id', uid).eq('item_id', itemId);
            if (error) return fail(translateError(error));
            return ok(null);
        },

        // GET /api/favorite/my
        async my() {
            const uid = db.state.uid;
            if (!uid) return fail('请先登录');
            const { data, error } = await sb
                .from('favorite')
                .select('id, item_id, created_at, item:item!favorite_item_id_fkey(id, title, price, images, status, view_count)')
                .eq('user_id', uid)
                .order('created_at', { ascending: false });
            if (error) return fail(translateError(error));
            return ok((data || []).map(r => {
                const o = camelKeys(r);
                o.item = camelKeys(r.item || {});
                return o;
            }));
        },

        // GET /api/favorite/check/{itemId}
        async check(itemId) {
            const uid = db.state.uid;
            if (!uid) return ok({ isFavorite: false });
            const { count } = await sb
                .from('favorite')
                .select('id', { count: 'exact', head: true })
                .eq('user_id', uid)
                .eq('item_id', itemId);
            return ok({ isFavorite: (count || 0) > 0 });
        }
    },

    // ----------------------------------------------------
    // 7. 评价模块（对应 ReviewController 的 4 个接口）
    // ----------------------------------------------------
    review: {
        // POST /api/review/create
        async create(body) {
            const uid = db.state.uid;
            if (!uid) return fail('请先登录');
            const orderRes = await db.order.detail(body.orderId);
            if (orderRes.code !== 200) return orderRes;
            const order = orderRes.data;
            const isBuyer = order.buyerId === uid;
            const isSeller = order.sellerId === uid;
            if (!isBuyer && !isSeller) return fail('无权评价该订单');
            if (order.status !== 4) return fail('订单完成后才能评价');

            const { error } = await sb.from('review').insert({
                order_id: body.orderId,
                reviewer_id: uid,
                target_user_id: isBuyer ? order.sellerId : order.buyerId,
                item_id: order.itemId,
                rating: body.rating,
                content: body.content || '',
                type: body.type || (isBuyer ? 1 : 2)
            });
            if (error) return fail(translateError(error));
            return ok(null);
        },

        // GET /api/review/user/{userId}
        async user(userId) {
            const { data, error } = await sb
                .from('review')
                .select(`*, reviewer:profiles!review_reviewer_id_fkey(nickname, avatar)`)
                .eq('target_user_id', userId)
                .order('created_at', { ascending: false });
            if (error) return fail(translateError(error));
            return ok((data || []).map(r => {
                const o = camelKeys(r);
                o.reviewerNickname = r.reviewer ? r.reviewer.nickname : '匿名用户';
                o.reviewerAvatar = r.reviewer ? r.reviewer.avatar : '';
                delete o.reviewer;
                return o;
            }));
        },

        // GET /api/review/item/{itemId}
        async item(itemId) {
            const { data, error } = await sb
                .from('review')
                .select(`*, reviewer:profiles!review_reviewer_id_fkey(nickname, avatar)`)
                .eq('item_id', itemId)
                .order('created_at', { ascending: false });
            if (error) return fail(translateError(error));
            return ok((data || []).map(r => {
                const o = camelKeys(r);
                o.reviewerNickname = r.reviewer ? r.reviewer.nickname : '匿名用户';
                delete o.reviewer;
                return o;
            }));
        },

        // GET /api/review/stats/{userId}
        async stats(userId) {
            const { data, error } = await sb
                .from('review')
                .select('rating')
                .eq('target_user_id', userId);
            if (error) return fail(translateError(error));
            const list = data || [];
            const total = list.length;
            const sum = list.reduce((acc, r) => acc + r.rating, 0);
            return ok({
                total,
                averageRating: total ? Math.round((sum / total) * 10) / 10 : 0
            });
        }
    },

    // ----------------------------------------------------
    // 8. 图片存储（原项目无上传能力，此处补齐）
    // ----------------------------------------------------
    storage: {
        async uploadImage(file) {
            const uid = db.state.uid;
            if (!uid) return fail('请先登录');
            if (!file.type.startsWith('image/')) return fail('只能上传图片文件');
            if (file.size > 5 * 1024 * 1024) return fail('单张图片不能超过 5MB');

            const ext = (file.name.split('.').pop() || 'png').toLowerCase();
            const path = `${uid}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
            const { error } = await sb.storage.from('item-images').upload(path, file, {
                cacheControl: '3600',
                upsert: false
            });
            if (error) return fail(translateError(error));
            const { data } = sb.storage.from('item-images').getPublicUrl(path);
            return ok(data.publicUrl);
        }
    },

    // ----------------------------------------------------
    // 10. 管理员模块（后台管理，独立入口 admin.html）
    //     数据权限由数据库 9.3 节的管理员 RLS 策略保障，
    //     前端仅负责展示与调用，无法越权访问普通用户数据
    // ----------------------------------------------------
    admin: {
        // 管理员登录：先验证账号密码，再校验 role = 1
        async login(body) {
            const username = String(body.username || '').trim();
            if (!username || !body.password) return fail('请输入管理员账号和密码');
            const { data, error } = await sb.auth.signInWithPassword({
                email: toEmail(username),
                password: body.password
            });
            if (error) return fail(translateError(error));

            const profileRes = await db.user.getProfile(data.user.id);
            if (profileRes.code !== 200) {
                await sb.auth.signOut();
                return profileRes;
            }
            const profile = profileRes.data;
            if (Number(profile.role) !== 1) {
                await sb.auth.signOut();
                db.state.uid = null;
                db.state.profile = null;
                return fail('该账号不是管理员，无权进入后台');
            }
            if (Number(profile.status) !== 1) {
                await sb.auth.signOut();
                db.state.uid = null;
                db.state.profile = null;
                return fail('该账号已被禁用，无法登录');
            }
            db.state.uid = data.user.id;
            db.state.profile = profile;
            return ok(profile);
        },

        // 刷新页面后恢复后台登录态，并复核管理员身份
        async check() {
            const res = await db.init();
            if (res.code !== 200) return res;
            const profile = res.data;
            if (!profile) return fail('尚未登录');
            if (Number(profile.role) !== 1) return fail('该账号不是管理员');
            if (Number(profile.status) !== 1) return fail('该账号已被禁用');
            return ok(profile);
        },

        async logout() {
            await sb.auth.signOut();
            db.state.uid = null;
            db.state.profile = null;
            return ok(null);
        },

        // 数据看板
        async stats() {
            const countOf = async (table, build) => {
                let query = sb.from(table).select('id', { count: 'exact', head: true });
                if (build) query = build(query);
                const { count, error } = await query;
                return error ? 0 : (count || 0);
            };
            const startOfDay = new Date();
            startOfDay.setHours(0, 0, 0, 0);
            const todayIso = startOfDay.toISOString();

            const [users, disabledUsers, items, onSale, orders, completed, messages, todayUsers, todayItems] =
                await Promise.all([
                    countOf('profiles'),
                    countOf('profiles', q => q.eq('status', 0)),
                    countOf('item'),
                    countOf('item', q => q.eq('status', 1)),
                    countOf('orders'),
                    countOf('orders', q => q.eq('status', 4)),
                    countOf('message'),
                    countOf('profiles', q => q.gte('created_at', todayIso)),
                    countOf('item', q => q.gte('created_at', todayIso))
                ]);

            const { data: doneRows } = await sb.from('orders').select('amount').eq('status', 4);
            const amount = (doneRows || []).reduce((sum, r) => sum + Number(r.amount || 0), 0);

            return ok({ users, disabledUsers, items, onSale, orders, completed, messages, amount, todayUsers, todayItems });
        },

        // 用户列表（分页 + 关键字）
        async users(opts = {}) {
            const keyword = String(opts.keyword || '').trim();
            const page = Math.max(1, Number(opts.page) || 1);
            const size = Math.max(1, Number(opts.size) || 10);
            const from = (page - 1) * size;

            let query = sb.from('profiles')
                .select('id, username, nickname, phone, school, avatar, role, status, created_at', { count: 'exact' })
                .order('created_at', { ascending: false })
                .range(from, from + size - 1);
            if (keyword) {
                query = query.or(`username.ilike.%${keyword}%,nickname.ilike.%${keyword}%,phone.ilike.%${keyword}%`);
            }
            const { data, count, error } = await query;
            if (error) return fail(translateError(error));
            return ok({ list: camelKeys(data || []), total: count || 0, page, size });
        },

        // 启用 / 禁用用户
        async setUserStatus(userId, status) {
            if (userId === db.state.uid) return fail('不能禁用当前登录的管理员账号');
            const { error } = await sb.from('profiles').update({ status: Number(status) }).eq('id', userId);
            if (error) return fail(translateError(error));
            return ok(null);
        },

        // 授予 / 撤销管理员
        async setUserRole(userId, role) {
            if (userId === db.state.uid) return fail('不能修改自己的角色，以免误操作失去后台权限');
            const { error } = await sb.from('profiles').update({ role: Number(role) }).eq('id', userId);
            if (error) return fail(translateError(error));
            return ok(null);
        },

        // 商品列表（含已下架）
        async items(opts = {}) {
            const keyword = String(opts.keyword || '').trim();
            const page = Math.max(1, Number(opts.page) || 1);
            const size = Math.max(1, Number(opts.size) || 10);
            const from = (page - 1) * size;
            const hasStatus = opts.status !== '' && opts.status !== null && opts.status !== undefined;

            let query = sb.from('item')
                .select(ITEM_SELECT, { count: 'exact' })
                .order('created_at', { ascending: false })
                .range(from, from + size - 1);
            if (hasStatus) query = query.eq('status', Number(opts.status));
            if (keyword) query = query.ilike('title', `%${keyword}%`);

            const { data, count, error } = await query;
            if (error) return fail(translateError(error));
            return ok({ list: (data || []).map(mapItem), total: count || 0, page, size });
        },

        async setItemStatus(itemId, status) {
            const { error } = await sb.from('item').update({ status: Number(status) }).eq('id', itemId);
            if (error) return fail(translateError(error));
            return ok(null);
        },

        async deleteItem(itemId) {
            const { error } = await sb.from('item').delete().eq('id', itemId);
            if (error) return fail(translateError(error));
            return ok(null);
        },

        // 分类管理
        async categories() {
            const { data, error } = await sb.from('category')
                .select('*')
                .order('parent_id', { ascending: true })
                .order('sort_order', { ascending: true })
                .order('id', { ascending: true });
            if (error) return fail(translateError(error));
            return ok(camelKeys(data || []));
        },

        async createCategory(body = {}) {
            const name = String(body.name || '').trim();
            if (!name) return fail('分类名称不能为空');
            if (name.length > 20) return fail('分类名称不能超过 20 个字');
            const payload = {
                name,
                parent_id: Number(body.parentId) || 0,
                sort_order: Number(body.sortOrder) || 99,
                status: 1
            };
            const { error } = await sb.from('category').insert(payload);
            if (error) return fail(translateError(error));
            return ok(null);
        },

        async updateCategory(id, patch = {}) {
            const payload = {};
            if (patch.name !== undefined) {
                const name = String(patch.name).trim();
                if (!name) return fail('分类名称不能为空');
                payload.name = name;
            }
            if (patch.sortOrder !== undefined) payload.sort_order = Number(patch.sortOrder);
            if (patch.status !== undefined) payload.status = Number(patch.status);
            if (!Object.keys(payload).length) return fail('没有需要修改的内容');
            const { error } = await sb.from('category').update(payload).eq('id', id);
            if (error) return fail(translateError(error));
            return ok(null);
        },

        async deleteCategory(id) {
            const { count: childCount } = await sb.from('category')
                .select('id', { count: 'exact', head: true })
                .eq('parent_id', id);
            if (childCount > 0) return fail('该类目下还有子分类，请先删除子分类');

            const { count: itemCount } = await sb.from('item')
                .select('id', { count: 'exact', head: true })
                .eq('category_id', id);
            if (itemCount > 0) return fail(`该类目下还有 ${itemCount} 件商品，无法删除`);

            const { error } = await sb.from('category').delete().eq('id', id);
            if (error) return fail(translateError(error));
            return ok(null);
        },

        // 订单管理
        async orders(opts = {}) {
            const page = Math.max(1, Number(opts.page) || 1);
            const size = Math.max(1, Number(opts.size) || 10);
            const from = (page - 1) * size;
            const hasStatus = opts.status !== '' && opts.status !== null && opts.status !== undefined;

            let query = sb.from('orders')
                .select(ORDER_SELECT, { count: 'exact' })
                .order('created_at', { ascending: false })
                .range(from, from + size - 1);
            if (hasStatus) query = query.eq('status', Number(opts.status));

            const { data, count, error } = await query;
            if (error) return fail(translateError(error));
            return ok({ list: (data || []).map(mapOrder), total: count || 0, page, size });
        },

        // 强制取消异常订单
        async cancelOrder(orderId) {
            const { error } = await sb.from('orders')
                .update({ status: 5, cancel_time: new Date().toISOString() })
                .eq('id', orderId);
            if (error) return fail(translateError(error));
            return ok(null);
        }
    }
};
