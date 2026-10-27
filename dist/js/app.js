// ========== 校园二手交易平台 - 业务主逻辑（云端版） ==========
// 由原 app.js 改造：数据访问从本地后端接口切换为 Supabase 云端 SDK

// ========== 全局状态 ==========
let currentCategory = 0;
let currentSort = 1;
let currentPage = 1;
let currentKeyword = '';
let pendingImageFiles = [];
let currentTab = 'published';

// ========== 工具函数 ==========
function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function fmt(timeStr) {
    if (!timeStr) return '';
    const d = new Date(timeStr);
    if (isNaN(d.getTime())) return String(timeStr);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function currentUser() {
    return db.state.profile;
}

// 备用 CDN 源，任一加载成功即可（解决部分地区访问不畅的问题）
const SDK_SOURCES = [
    'https://fastly.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
    'https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.min.js'
];

function loadScript(src) {
    return new Promise(resolve => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve(true);
        script.onerror = () => resolve(false);
        document.head.appendChild(script);
    });
}

async function loadSupabaseSDK() {
    for (const src of SDK_SOURCES) {
        if (await loadScript(src) && window.supabase) return true;
    }
    return false;
}

// ========== 启动流程 ==========
document.addEventListener('DOMContentLoaded', async () => {
    // OFFLINE_MODE：离线单机模式，数据存浏览器本地，无需服务器与网络
    if (!window.OFFLINE_MODE) {
        if (!window.isSupabaseConfigured()) {
            location.replace('setup.html');
            return;
        }
        const loaded = await loadSupabaseSDK();
        if (!loaded) {
            document.getElementById('itemList').innerHTML =
                '<div class="empty"><span class="empty-icon">&#128268;</span>Supabase SDK 加载失败，请检查网络连接后刷新重试</div>';
            return;
        }
        try {
            db.connect();
        } catch (e) {
            renderConfigError(e.message);
            return;
        }
    }

    await db.init();
    refreshNav();
    await loadCategories();
    await loadItems();
});

function renderConfigError(reason) {
    const box = document.getElementById('itemList');
    box.innerHTML = `
        <div class="empty">
            <span class="empty-icon">⚙️</span>
            <p><strong>云数据库连接未完成配置</strong></p>
            <p style="font-size:14px;color:#6b7280;margin-top:8px;">${reason === 'NOT_CONFIGURED' ? '尚未填写 Supabase 地址和密钥' : esc(reason)}</p>
            <a class="btn btn-primary" href="setup.html" style="margin-top:16px;">前往配置</a>
        </div>`;
}

// ========== Toast 提示 ==========
function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    setTimeout(() => { toast.className = 'toast'; }, 2500);
}

// ========== 弹窗控制 ==========
function showModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) e.target.classList.remove('active');
});

// ========== 登录态与导航 ==========
function refreshNav() {
    const user = currentUser();
    if (user) {
        document.getElementById('userInfo').style.display = 'none';
        document.getElementById('userLoggedIn').style.display = 'flex';
        document.getElementById('nicknameDisplay').textContent = user.nickname || user.username;
    } else {
        document.getElementById('userInfo').style.display = 'flex';
        document.getElementById('userLoggedIn').style.display = 'none';
    }
}

async function logout() {
    await db.user.logout();
    refreshNav();
    await loadItems();
    showToast('已退出登录', 'info');
}

// ========== 登录 ==========
function showLoginModal() {
    document.getElementById('loginForm').reset();
    showModal('loginModal');
}

async function login(e) {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value.trim();
    if (!username || !password) {
        showToast('请输入用户名和密码', 'error');
        return;
    }
    const btn = document.getElementById('loginBtn');
    btn.disabled = true; btn.textContent = '登录中...';

    const res = await db.user.login({ username, password });
    btn.disabled = false; btn.textContent = '登录';

    if (res.code === 200 && res.data) {
        refreshNav();
        closeModal('loginModal');
        showToast(`欢迎回来，${res.data.nickname || res.data.username}！`, 'success');
        await loadItems();
    } else {
        showToast(res.message || '登录失败', 'error');
    }
}

// ========== 注册 ==========
function showRegisterModal() {
    document.getElementById('registerForm').reset();
    showModal('registerModal');
}

async function register(e) {
    e.preventDefault();
    const body = {
        username: document.getElementById('regUsername').value.trim(),
        password: document.getElementById('regPassword').value.trim(),
        nickname: document.getElementById('regNickname').value.trim(),
        phone: document.getElementById('regPhone').value.trim(),
        school: document.getElementById('regSchool').value.trim()
    };
    if (!body.username || !body.password) {
        showToast('用户名和密码为必填项', 'error');
        return;
    }
    const btn = document.getElementById('regBtn');
    btn.disabled = true; btn.textContent = '注册中...';

    const res = await db.user.register(body);
    btn.disabled = false; btn.textContent = '注册';

    if (res.code === 200 && res.data) {
        refreshNav();
        closeModal('registerModal');
        showToast('注册成功，已自动登录！', 'success');
        await loadItems();
    } else {
        showToast(res.message || '注册失败', 'error');
    }
}

// ========== 分类 ==========
async function loadCategories() {
    const res = await db.category.parents();
    if (res.code !== 200 || !res.data) return;
    const list = document.getElementById('categoryList');
    list.querySelectorAll('.category-item:not([data-id="0"])').forEach(el => el.remove());
    res.data.forEach(cat => {
        const li = document.createElement('li');
        li.className = 'category-item';
        li.dataset.id = cat.id;
        li.textContent = cat.name;
        li.onclick = function () { filterByCategory(cat.id, this); };
        list.appendChild(li);
    });
}

function filterByCategory(catId, el) {
    currentCategory = catId;
    currentPage = 1;
    document.querySelectorAll('.category-item').forEach(i => i.classList.remove('active'));
    if (el) el.classList.add('active');
    else document.querySelector('.category-item[data-id="0"]').classList.add('active');
    loadItems();
}

// ========== 搜索与排序 ==========
function searchItems() {
    currentKeyword = document.getElementById('searchInput').value.trim();
    currentPage = 1;
    loadItems();
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.activeElement === document.getElementById('searchInput')) {
        searchItems();
    }
});

function changeSort(sort, el) {
    currentSort = sort;
    currentPage = 1;
    document.querySelectorAll('.sort-item').forEach(i => i.classList.remove('active'));
    if (el) el.classList.add('active');
    loadItems();
}

// ========== 物品列表 ==========
async function loadItems() {
    const container = document.getElementById('itemList');
    container.innerHTML = '<div class="loading">加载中...</div>';

    const params = { pageNum: currentPage, pageSize: 12, sortType: currentSort };
    if (currentCategory > 0) params.categoryId = currentCategory;
    if (currentKeyword) params.title = currentKeyword;

    const res = await db.item.search(params);
    if (res.code === 200 && res.data) {
        const { list, total, pageNum, pageSize } = res.data;
        if (!list || list.length === 0) {
            container.innerHTML = '<div class="empty"><span class="empty-icon">📦</span>暂无物品，快去发布第一个吧！</div>';
            document.getElementById('pagination').innerHTML = '';
            return;
        }
        renderItems(list);
        renderPagination(total, pageNum, pageSize);
    } else {
        container.innerHTML = `<div class="empty"><span class="empty-icon">😵</span>${esc(res.message || '加载失败，请刷新重试')}</div>`;
        document.getElementById('pagination').innerHTML = '';
    }
}

const CONDITION_CLASS = { 1: 'tag-new', 2: 'tag-like-new', 3: 'tag-used', 4: 'tag-heavy' };
const CONDITION_TEXT = { 1: '全新', 2: '几乎全新', 3: '轻微使用', 4: '明显使用' };
const ITEM_STATUS_TEXT = { 0: '已下架', 1: '在售', 2: '已售出', 3: '已预订' };

function renderItems(items) {
    const container = document.getElementById('itemList');
    container.innerHTML = items.map(item => {
        const tagClass = CONDITION_CLASS[item.condition] || 'tag-used';
        const firstImg = item.images && item.images.length ? item.images[0] : null;
        return `
        <div class="item-card" onclick="showDetail(${item.id})">
            ${firstImg
                ? `<img class="item-card-image" src="${esc(firstImg)}" alt="${esc(item.title)}"
                     onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
                   <div class="item-card-image" style="display:none;">📦</div>`
                : `<div class="item-card-image">📦</div>`}
            <div class="item-card-body">
                <div class="item-card-title" title="${esc(item.title)}">${esc(item.title)}</div>
                <div class="item-card-price">
                    ¥${item.price}
                    ${item.originalPrice && item.originalPrice > item.price ? `<span class="original">¥${item.originalPrice}</span>` : ''}
                </div>
                <div class="item-card-meta">
                    <span class="item-card-tag ${tagClass}">${CONDITION_TEXT[item.condition] || '未知'}</span>
                    <span>👁 ${item.viewCount || 0}</span>
                </div>
            </div>
        </div>`;
    }).join('');
}

function renderPagination(total, pageNum, pageSize) {
    const totalPages = Math.ceil(total / pageSize);
    const box = document.getElementById('pagination');
    if (totalPages <= 1) { box.innerHTML = ''; return; }

    let html = `<button ${pageNum <= 1 ? 'disabled' : ''} onclick="goPage(${pageNum - 1})">上一页</button>`;
    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= pageNum - 2 && i <= pageNum + 2)) {
            html += `<button class="${i === pageNum ? 'active' : ''}" onclick="goPage(${i})">${i}</button>`;
        } else if (i === pageNum - 3 || i === pageNum + 3) {
            html += '<button disabled>...</button>';
        }
    }
    html += `<button ${pageNum >= totalPages ? 'disabled' : ''} onclick="goPage(${pageNum + 1})">下一页</button>`;
    box.innerHTML = html;
}

function goPage(page) {
    currentPage = page;
    loadItems();
    window.scrollTo({ top: 300, behavior: 'smooth' });
}

// ========== 物品详情 ==========
async function showDetail(itemId) {
    showModal('detailModal');
    document.getElementById('detailContent').innerHTML = '<div class="loading">加载中...</div>';

    const res = await db.item.detail(itemId);
    if (res.code === 200 && res.data) {
        renderDetail(res.data);
    } else {
        document.getElementById('detailContent').innerHTML =
            `<p style="color:#ef4444;">加载失败：${esc(res.message || '未知错误')}</p>`;
    }
}

function renderDetail(item) {
    const user = currentUser();
    const firstImg = item.images && item.images.length ? item.images[0] : null;
    const isOwner = user && user.id === item.userId;
    const canBuy = user && !isOwner && item.status === 1;

    let html = `
    <div class="detail-layout">
        <div class="detail-gallery">
            ${item.images && item.images.length
                ? item.images.map(src => `<img class="gallery-img" src="${esc(src)}" onerror="this.style.display='none';">`).join('')
                : '<div class="detail-image">📦</div>'}
        </div>
        <div class="detail-info">
            <h3>${esc(item.title)}</h3>
            <div class="detail-price">¥${item.price}${item.originalPrice && item.originalPrice > item.price
                ? `<span style="font-size:16px;color:#9ca3af;text-decoration:line-through;font-weight:400;margin-left:8px;">¥${item.originalPrice}</span>` : ''}</div>
            <div class="detail-meta">
                <span>📂 ${esc(item.categoryName || '未分类')}</span>
                <span>🏷 ${CONDITION_TEXT[item.condition] || '未知'}</span>
                <span>📊 ${ITEM_STATUS_TEXT[item.status] || '未知'}</span>
                <span>👁 ${item.viewCount || 0} 次浏览</span>
                <span>🕐 ${fmt(item.createdAt)}</span>
            </div>
            <div class="seller-info">
                <div class="seller-avatar">👤</div>
                <div>
                    <div style="font-weight:500;">${esc(item.sellerNickname || '卖家')}</div>
                    <div style="font-size:12px;color:#9ca3af;">发布于 ${fmt(item.createdAt)}</div>
                </div>
            </div>
            ${item.description ? `<div class="detail-desc">${esc(item.description).replace(/\n/g, '<br>')}</div>` : ''}
            <div class="detail-actions">
                ${isOwner ? `<button class="btn btn-outline" onclick="offShelfItem(${item.id})">下架物品</button>` : ''}
                ${canBuy ? `<button class="btn btn-primary" onclick="buyItem(${item.id}, ${item.price})">立即购买</button>` : ''}
                ${user && !isOwner ? `<button class="btn btn-outline" id="favBtn" onclick="toggleFavorite(${item.id})">❤️ 收藏</button>` : ''}
                ${!user ? `<button class="btn btn-outline" onclick="showLoginModal()">登录后购买</button>` : ''}
            </div>
        </div>
    </div>`;

    html += `
    <div class="message-section">
        <h4>💬 留言（${esc(item.sellerNickname || '卖家')} 会收到通知）</h4>
        ${user
            ? `<div class="message-form">
                   <input type="text" id="msgInput" placeholder="输入留言内容，和卖家议价或提问..." maxlength="500">
                   <button class="btn btn-primary" onclick="sendMessage(${item.id})">发送</button>
               </div>`
            : `<p style="color:#6b7280;font-size:14px;">登录后即可留言咨询</p>`}
        <div id="messageList" style="margin-top:16px;"></div>
    </div>`;

    document.getElementById('detailContent').innerHTML = html;
    loadMessages(item.id);
    if (user && !isOwner) refreshFavButton(item.id);
}

async function refreshFavButton(itemId) {
    const res = await db.favorite.check(itemId);
    const btn = document.getElementById('favBtn');
    if (btn && res.code === 200 && res.data) {
        btn.textContent = res.data.isFavorite ? '💔 取消收藏' : '❤️ 收藏';
    }
}

// ========== 留言 ==========
async function loadMessages(itemId) {
    const container = document.getElementById('messageList');
    if (!container) return;
    const res = await db.message.item(itemId);
    if (res.code !== 200 || !res.data) {
        container.innerHTML = '<p style="color:#9ca3af;font-size:14px;">留言加载失败</p>';
        return;
    }
    const messages = res.data.messages || [];
    if (!messages.length) {
        container.innerHTML = '<p style="color:#9ca3af;font-size:14px;">暂无留言，快来第一个留言吧~</p>';
        return;
    }
    container.innerHTML = messages.map(msg => `
        <div class="message-item">
            <div class="msg-header">
                <strong>${esc(msg.fromUserNickname || '匿名用户')}</strong>
                <span>${fmt(msg.createdAt)}</span>
            </div>
            <div class="msg-content">${esc(msg.content)}</div>
            <button class="btn btn-text" style="font-size:12px;" onclick="replyTo(${msg.id}, ${itemId}, '${esc(msg.fromUserNickname)}')">回复</button>
            ${(msg.replies && msg.replies.length)
                ? msg.replies.map(r => `
                    <div class="message-reply">
                        <div class="msg-header">
                            <strong>${esc(r.fromUserNickname || '匿名用户')}</strong>
                            <span>${fmt(r.createdAt)}</span>
                        </div>
                        <div class="msg-content">${esc(r.content)}</div>
                    </div>`).join('')
                : ''}
        </div>`).join('');
}

async function sendMessage(itemId) {
    const input = document.getElementById('msgInput');
    const content = input.value.trim();
    if (!content) { showToast('请输入留言内容', 'error'); return; }
    const res = await db.message.leave({ itemId, content });
    if (res.code === 200) {
        input.value = '';
        showToast('留言成功', 'success');
        loadMessages(itemId);
    } else {
        showToast(res.message || '留言失败', 'error');
    }
}

function replyTo(parentId, itemId, nickname) {
    const content = prompt(`回复 ${nickname}：`);
    if (!content || !content.trim()) return;
    doReply(parentId, itemId, content.trim());
}

async function doReply(parentId, itemId, content) {
    const res = await db.message.leave({ itemId, content, parentId });
    if (res.code === 200) {
        showToast('回复成功', 'success');
        loadMessages(itemId);
    } else {
        showToast(res.message || '回复失败', 'error');
    }
}

// ========== 购买 ==========
async function buyItem(itemId, price) {
    if (!confirm(`确认购买此物品？金额：¥${price}`)) return;
    const res = await db.order.create({ itemId });
    if (res.code === 200) {
        showToast('下单成功！可在「我的 → 我买到的」中付款', 'success');
        closeModal('detailModal');
        await loadItems();
    } else {
        showToast(res.message || '下单失败', 'error');
    }
}

// ========== 下架 ==========
async function offShelfItem(itemId) {
    if (!confirm('确认下架该物品？')) return;
    const res = await db.item.offShelf(itemId);
    if (res.code === 200) {
        showToast('下架成功', 'success');
        closeModal('detailModal');
        await loadItems();
        if (document.getElementById('myCenterModal').classList.contains('active')) loadMyTab();
    } else {
        showToast(res.message || '下架失败', 'error');
    }
}

// ========== 收藏 ==========
async function toggleFavorite(itemId) {
    const checkRes = await db.favorite.check(itemId);
    const isFav = checkRes.data && checkRes.data.isFavorite;
    const res = isFav ? await db.favorite.remove(itemId) : await db.favorite.add(itemId);
    if (res.code === 200) {
        showToast(isFav ? '已取消收藏' : '已收藏', 'success');
        refreshFavButton(itemId);
    } else {
        showToast(res.message || '操作失败', 'error');
    }
}

// ========== 发布物品 ==========
async function publishItem() {
    if (!currentUser()) {
        showToast('请先登录', 'error');
        showLoginModal();
        return;
    }
    await loadPublishCategories();
    document.getElementById('publishForm').reset();
    pendingImageFiles = [];
    document.getElementById('imagePreview').innerHTML = '';
    showModal('publishModal');
}

async function loadPublishCategories() {
    const res = await db.category.tree();
    const select = document.getElementById('pubCategory');
    select.innerHTML = '<option value="">请选择分类</option>';
    if (res.code !== 200 || !res.data) return;
    res.data.forEach(parent => {
        const group = document.createElement('optgroup');
        group.label = parent.name;
        (parent.children || []).forEach(child => {
            const opt = document.createElement('option');
            opt.value = child.id;
            opt.textContent = child.name;
            group.appendChild(opt);
        });
        select.appendChild(group);
    });
}

function previewImages(e) {
    let files = Array.from(e.target.files || []);
    if (files.length > 6) {
        showToast('最多选择 6 张图片', 'error');
        files = files.slice(0, 6);
    }
    pendingImageFiles = files;
    const box = document.getElementById('imagePreview');
    box.innerHTML = files.map(f =>
        `<img class="preview-thumb" src="${URL.createObjectURL(f)}" alt="预览">`).join('');
}

async function submitPublish(e) {
    e.preventDefault();
    const priceValue = document.getElementById('pubPrice').value;
    const body = {
        title: document.getElementById('pubTitle').value.trim(),
        categoryId: parseInt(document.getElementById('pubCategory').value, 10),
        price: parseFloat(priceValue),
        originalPrice: parseFloat(document.getElementById('pubOriginalPrice').value) || null,
        condition: parseInt(document.getElementById('pubCondition').value, 10),
        description: document.getElementById('pubDescription').value.trim()
    };
    if (!body.title || !body.categoryId || isNaN(body.price)) {
        showToast('请填写标题、分类和售价', 'error');
        return;
    }

    const btn = document.getElementById('pubBtn');
    let images = [];
    if (pendingImageFiles.length) {
        btn.disabled = true;
        for (const file of pendingImageFiles) {
            btn.textContent = `图片上传中（${images.length + 1}/${pendingImageFiles.length}）...`;
            const up = await db.storage.uploadImage(file);
            if (up.code === 200) images.push(up.data);
            else showToast(up.message, 'error');
        }
    }
    body.images = images;
    btn.disabled = false;
    btn.textContent = '发布';

    const res = await db.item.publish(body);
    if (res.code === 200) {
        showToast('发布成功！', 'success');
        closeModal('publishModal');
        pendingImageFiles = [];
        document.getElementById('imagePreview').innerHTML = '';
        await loadItems();
    } else {
        showToast(res.message || '发布失败', 'error');
    }
}

// ========== 个人中心 ==========
async function openMyCenter() {
    if (!currentUser()) { showToast('请先登录', 'error'); showLoginModal(); return; }
    showModal('myCenterModal');
    await loadMyProfile();
    await loadMyTab();
}

async function loadMyProfile() {
    const user = currentUser();
    if (!user) return;
    document.getElementById('myNickname').textContent = user.nickname || user.username;
    document.getElementById('myMeta').textContent =
        `${user.school ? esc(user.school) + ' · ' : ''}@${esc(user.username)}${user.phone ? ' · ' + esc(user.phone) : ''}`;

    const stats = await db.review.stats(user.id);
    if (stats.code === 200 && stats.data && stats.data.total > 0) {
        document.getElementById('myRating').textContent =
            `⭐ ${stats.data.averageRating} 分（${stats.data.total} 条评价）`;
    } else {
        document.getElementById('myRating').textContent = '暂无评分';
    }
}

function switchMyTab(tab, el) {
    currentTab = tab;
    document.querySelectorAll('.my-tab').forEach(t => t.classList.remove('active'));
    if (el) el.classList.add('active');
    loadMyTab();
}

async function loadMyTab() {
    const box = document.getElementById('myTabContent');
    box.innerHTML = '<div class="loading">加载中...</div>';
    const handlers = {
        published: loadMyPublished,
        sold: loadMySold,
        bought: loadMyBought,
        favorite: loadMyFavorite,
        message: loadMyMessages
    };
    await handlers[currentTab](box);
}

async function loadMyPublished(box) {
    const res = await db.item.my();
    if (res.code !== 200) { box.innerHTML = `<p class="empty-text">${esc(res.message)}</p>`; return; }
    const list = res.data || [];
    if (!list.length) { box.innerHTML = '<p class="empty-text">还没有发布任何物品</p>'; return; }
    box.innerHTML = `<div class="mini-grid">${list.map(item => {
        const img = item.images && item.images.length ? item.images[0] : null;
        return `
        <div class="mini-card" onclick="showDetail(${item.id})">
            ${img ? `<img src="${esc(img)}" onerror="this.style.display='none';">` : '<div class="mini-noimg">📦</div>'}
            <div class="mini-body">
                <div class="mini-title">${esc(item.title)}</div>
                <div class="mini-price">¥${item.price}</div>
                <div class="mini-meta">${ITEM_STATUS_TEXT[item.status]} · 👁 ${item.viewCount || 0} · ${fmt(item.createdAt)}</div>
                ${item.status === 1 ? `<button class="btn btn-sm btn-outline" onclick="event.stopPropagation();offShelfItem(${item.id})">下架</button>` : ''}
            </div>
        </div>`;
    }).join('')}</div>`;
}

const ORDER_STATUS_TEXT = { 1: '待付款', 2: '已付款待发货', 3: '已发货', 4: '已完成', 5: '已取消' };

function renderOrderCard(order, role) {
    const img = order.itemImage;
    let actions = '';
    if (role === 'buy') {
        if (order.status === 1) actions += `<button class="btn btn-sm btn-primary" onclick="payOrder(${order.id})">付款</button>
            <button class="btn btn-sm btn-outline" onclick="cancelOrder(${order.id})">取消订单</button>`;
        if (order.status === 3) actions += `<button class="btn btn-sm btn-primary" onclick="confirmOrder(${order.id})">确认收货</button>`;
        if (order.status === 4) actions += `<button class="btn btn-sm btn-outline" onclick="openReview(${order.id})">评价</button>`;
    } else {
        if (order.status === 2) actions += `<button class="btn btn-sm btn-primary" onclick="shipOrder(${order.id})">发货</button>`;
        if (order.status === 4) actions += `<button class="btn btn-sm btn-outline" onclick="openReview(${order.id})">评价</button>`;
    }
    return `
    <div class="order-card">
        ${img ? `<img class="order-img" src="${esc(img)}" onerror="this.style.display='none';">` : '<div class="order-img">📦</div>'}
        <div class="order-body">
            <div class="order-title">${esc(order.itemTitle || '已删除的物品')}</div>
            <div class="order-meta">
                订单号 ${esc(order.orderNo)}<br>
                ¥${order.amount} · <strong>${ORDER_STATUS_TEXT[order.status] || '未知'}</strong> · ${fmt(order.createdAt)}
            </div>
            <div class="order-user">${role === 'buy' ? '卖家：' + esc(order.sellerNickname) : '买家：' + esc(order.buyerNickname)}</div>
        </div>
        <div class="order-actions">${actions}</div>
    </div>`;
}

async function loadMySold(box) {
    const res = await db.order.sell();
    if (res.code !== 200) { box.innerHTML = `<p class="empty-text">${esc(res.message)}</p>`; return; }
    const list = res.data || [];
    if (!list.length) { box.innerHTML = '<p class="empty-text">还没有卖出的订单</p>'; return; }
    box.innerHTML = list.map(o => renderOrderCard(o, 'sell')).join('');
}

async function loadMyBought(box) {
    const res = await db.order.buy();
    if (res.code !== 200) { box.innerHTML = `<p class="empty-text">${esc(res.message)}</p>`; return; }
    const list = res.data || [];
    if (!list.length) { box.innerHTML = '<p class="empty-text">还没有买到的订单</p>'; return; }
    box.innerHTML = list.map(o => renderOrderCard(o, 'buy')).join('');
}

async function loadMyFavorite(box) {
    const res = await db.favorite.my();
    if (res.code !== 200) { box.innerHTML = `<p class="empty-text">${esc(res.message)}</p>`; return; }
    const list = res.data || [];
    if (!list.length) { box.innerHTML = '<p class="empty-text">还没有收藏任何物品</p>'; return; }
    box.innerHTML = `<div class="mini-grid">${list.map(f => {
        const it = f.item || {};
        const img = it.images && it.images.length ? it.images[0] : null;
        return `
        <div class="mini-card" onclick="${it.id ? `showDetail(${it.id})` : `showToast('该物品已下架','info')`}">
            ${img ? `<img src="${esc(img)}" onerror="this.style.display='none';">` : '<div class="mini-noimg">📦</div>'}
            <div class="mini-body">
                <div class="mini-title">${esc(it.title || '已失效物品')}</div>
                <div class="mini-price">${it.price ? '¥' + it.price : '-'}</div>
                <div class="mini-meta">${ITEM_STATUS_TEXT[it.status] || '已失效'} · 收藏于 ${fmt(f.createdAt)}</div>
                <button class="btn btn-sm btn-outline" onclick="event.stopPropagation();removeFavorite(${f.itemId})">取消收藏</button>
            </div>
        </div>`;
    }).join('')}</div>`;
}

async function loadMyMessages(box) {
    const res = await db.message.received();
    if (res.code !== 200) { box.innerHTML = `<p class="empty-text">${esc(res.message)}</p>`; return; }
    const list = res.data || [];
    if (!list.length) { box.innerHTML = '<p class="empty-text">还没有收到任何留言</p>'; return; }
    box.innerHTML = list.map(m => `
        <div class="msg-card">
            <div class="msg-card-head">
                <strong>${esc(m.fromUserNickname)}</strong>
                <span>${fmt(m.createdAt)}</span>
            </div>
            <div class="msg-card-content">${esc(m.content)}</div>
            <div class="msg-card-item" onclick="showDetail(${m.itemId})">
                ${m.itemImage ? `<img src="${esc(m.itemImage)}" onerror="this.style.display='none';">` : '📦'}
                ${esc(m.itemTitle || '相关物品')}
            </div>
        </div>`).join('');
}

async function removeFavorite(itemId) {
    const res = await db.favorite.remove(itemId);
    if (res.code === 200) {
        showToast('已取消收藏', 'info');
        await loadMyTab();
    } else {
        showToast(res.message, 'error');
    }
}

// ========== 订单操作 ==========
async function handleOrderAction(orderId, action, successMsg) {
    const res = await db.order.changeStatus(orderId, action);
    if (res.code === 200) {
        showToast(successMsg, 'success');
        await loadMyTab();
        await loadItems();
    } else {
        showToast(res.message || '操作失败', 'error');
    }
}

function payOrder(orderId) { handleOrderAction(orderId, 'pay', '付款成功，等待卖家发货'); }
function shipOrder(orderId) { handleOrderAction(orderId, 'ship', '已标记发货'); }
function confirmOrder(orderId) { handleOrderAction(orderId, 'confirm', '已确认收货，快去评价吧'); }
function cancelOrder(orderId) {
    if (!confirm('确认取消该订单？')) return;
    handleOrderAction(orderId, 'cancel', '订单已取消');
}

// ========== 评价 ==========
let currentRating = 5;

function openReview(orderId) {
    document.getElementById('reviewOrderId').value = orderId;
    document.getElementById('reviewContent').value = '';
    pickStar(5);
    showModal('reviewModal');
}

function pickStar(star) {
    currentRating = star;
    document.querySelectorAll('#starPicker span').forEach(el => {
        const value = Number(el.dataset.star);
        el.classList.toggle('active', value <= star);
    });
}

async function submitReview() {
    const orderId = document.getElementById('reviewOrderId').value;
    const content = document.getElementById('reviewContent').value.trim();
    const res = await db.review.create({
        orderId: Number(orderId),
        rating: currentRating,
        content
    });
    if (res.code === 200) {
        showToast('评价成功', 'success');
        closeModal('reviewModal');
        await loadMyTab();
        await loadMyProfile();
    } else {
        showToast(res.message || '评价失败', 'error');
    }
}
