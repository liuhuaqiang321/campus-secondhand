// ============================================================
// 管理后台逻辑
// 数据访问全部走 db.admin.*，权限由数据库 RLS 管理员策略兜底
// ============================================================

const SDK_SOURCES = [
    'https://fastly.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
    'https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.min.js'
];

const PAGE_SIZE = 10;
const TAB_TITLES = {
    dashboard: '数据概览',
    users: '用户管理',
    items: '商品管理',
    categories: '分类管理',
    orders: '订单管理'
};

const pages = { users: 1, items: 1, orders: 1 };
let adminProfile = null;

// ========== 基础工具 ==========
function esc(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function fmt(timeStr) {
    if (!timeStr) return '-';
    const d = new Date(timeStr);
    if (isNaN(d.getTime())) return String(timeStr);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function money(n) {
    return '¥' + Number(n || 0).toFixed(2);
}

let toastTimer = null;
function toast(message, type = 'success') {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = 'toast show ' + type;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast ' + type; }, 2600);
}

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

// ========== 启动 ==========
document.addEventListener('DOMContentLoaded', async () => {
    const errBox = document.getElementById('loginError');

    if (!window.isSupabaseConfigured()) {
        errBox.textContent = '尚未完成云数据库配置，请先打开 setup.html 完成配置';
        return;
    }

    const loaded = await loadSupabaseSDK();
    if (!loaded) {
        errBox.textContent = 'Supabase SDK 加载失败，请检查网络后刷新重试';
        return;
    }

    try {
        db.connect();
    } catch (e) {
        errBox.textContent = '云数据库连接失败：' + e.message;
        return;
    }

    const res = await db.admin.check();
    if (res.code === 200) {
        enterApp(res.data);
    } else {
        showLogin();
    }
});

function showLogin() {
    document.getElementById('app').style.display = 'none';
    document.getElementById('loginPage').style.display = 'flex';
}

function enterApp(profile) {
    adminProfile = profile;
    document.getElementById('loginPage').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    document.getElementById('adminName').textContent = profile.nickname || profile.username;
    switchTab('dashboard');
}

// ========== 登录 / 退出 ==========
async function doLogin(e) {
    if (e) e.preventDefault();
    const errBox = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;

    errBox.textContent = '';
    if (!username || !password) {
        errBox.textContent = '请输入管理员账号和密码';
        return;
    }

    btn.disabled = true;
    btn.textContent = '登录中…';
    const res = await db.admin.login({ username, password });
    btn.disabled = false;
    btn.textContent = '登 录';

    if (res.code !== 200) {
        errBox.textContent = res.message;
        return;
    }
    document.getElementById('loginPassword').value = '';
    enterApp(res.data);
    toast('欢迎回来，' + (res.data.nickname || res.data.username));
}

async function doLogout() {
    if (!confirm('确定退出管理后台吗？')) return;
    await db.admin.logout();
    location.reload();
}

// ========== 标签切换 ==========
async function switchTab(name) {
    document.querySelectorAll('.menu-item').forEach(el => {
        el.classList.toggle('active', el.dataset.tab === name);
    });
    document.querySelectorAll('.tab-panel').forEach(el => { el.style.display = 'none'; });
    const panel = document.getElementById('tab-' + name);
    if (panel) panel.style.display = 'block';
    document.getElementById('pageTitle').textContent = TAB_TITLES[name] || '';

    if (name === 'dashboard') await loadStats();
    else if (name === 'users') await loadUsers(1);
    else if (name === 'items') await loadItems(1);
    else if (name === 'categories') await loadCategories();
    else if (name === 'orders') await loadOrders(1);
}

// ========== 数据概览 ==========
async function loadStats() {
    const grid = document.getElementById('statGrid');
    grid.innerHTML = '<div class="stat-card"><div class="stat-label">加载中…</div></div>';

    const res = await db.admin.stats();
    if (res.code !== 200) {
        grid.innerHTML = `<div class="stat-card"><div class="stat-label">${esc(res.message)}</div></div>`;
        return;
    }
    const s = res.data;
    const cards = [
        { label: '注册用户', value: s.users, sub: `今日新增 ${s.todayUsers}`, tone: 'blue' },
        { label: '商品总数', value: s.items, sub: `在售 ${s.onSale} · 今日发布 ${s.todayItems}`, tone: 'green' },
        { label: '订单总数', value: s.orders, sub: `已完成 ${s.completed}`, tone: 'orange' },
        { label: '成交金额', value: money(s.amount), sub: '已完成订单累计', tone: 'purple' },
        { label: '留言总数', value: s.messages, sub: '买卖双方沟通', tone: 'cyan' },
        { label: '禁用账号', value: s.disabledUsers, sub: '违规处理记录', tone: 'red' }
    ];
    grid.innerHTML = cards.map(c => `
        <div class="stat-card tone-${c.tone}">
            <div class="stat-label">${c.label}</div>
            <div class="stat-value">${esc(c.value)}</div>
            <div class="stat-sub">${esc(c.sub)}</div>
        </div>`).join('');
}

// ========== 用户管理 ==========
async function loadUsers(page) {
    pages.users = page || pages.users;
    const tbody = document.getElementById('userTable');
    tbody.innerHTML = '<tr><td colspan="8" class="loading">加载中…</td></tr>';

    const res = await db.admin.users({
        keyword: document.getElementById('userKeyword').value,
        page: pages.users,
        size: PAGE_SIZE
    });

    if (res.code !== 200) {
        tbody.innerHTML = `<tr><td colspan="8" class="loading">${esc(res.message)}</td></tr>`;
        document.getElementById('userPager').innerHTML = '';
        return;
    }

    const { list, total } = res.data;
    if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="loading">没有符合条件的用户</td></tr>';
    } else {
        tbody.innerHTML = list.map(u => {
            const isBanned = Number(u.status) === 0;
            const isAdmin = Number(u.role) === 1;
            const isSelf = adminProfile && u.id === adminProfile.id;
            return `
            <tr>
                <td><strong>${esc(u.username)}</strong>${isSelf ? ' <span class="tag tag-blue">本人</span>' : ''}</td>
                <td>${esc(u.nickname || '-')}</td>
                <td>${esc(u.phone || '-')}</td>
                <td>${esc(u.school || '-')}</td>
                <td>${isAdmin ? '<span class="tag tag-purple">管理员</span>' : '<span class="tag">普通用户</span>'}</td>
                <td>${isBanned ? '<span class="tag tag-red">已禁用</span>' : '<span class="tag tag-green">正常</span>'}</td>
                <td class="nowrap">${fmt(u.createdAt)}</td>
                <td class="col-op nowrap">
                    <button class="admin-btn tiny ${isBanned ? 'success' : 'danger'}" ${isSelf ? 'disabled' : ''}
                        onclick="toggleUserStatus('${u.id}', ${isBanned ? 1 : 0}, '${esc(u.username)}')">${isBanned ? '启用' : '禁用'}</button>
                    <button class="admin-btn tiny ghost" ${isSelf ? 'disabled' : ''}
                        onclick="toggleUserRole('${u.id}', ${isAdmin ? 0 : 1}, '${esc(u.username)}')">${isAdmin ? '撤销管理员' : '设为管理员'}</button>
                </td>
            </tr>`;
        }).join('');
    }
    renderPager('userPager', total, pages.users, p => loadUsers(p));
}

function resetUserSearch() {
    document.getElementById('userKeyword').value = '';
    loadUsers(1);
}

async function toggleUserStatus(userId, status, username) {
    const action = Number(status) === 0 ? '禁用' : '启用';
    if (!confirm(`确定要${action}用户「${username}」吗？`)) return;
    const res = await db.admin.setUserStatus(userId, status);
    toast(res.code === 200 ? action + '成功' : res.message, res.code === 200 ? 'success' : 'error');
    if (res.code === 200) loadUsers(pages.users);
}

async function toggleUserRole(userId, role, username) {
    const action = Number(role) === 1 ? '设为管理员' : '撤销管理员';
    if (!confirm(`确定要将「${username}」${action}吗？`)) return;
    const res = await db.admin.setUserRole(userId, role);
    toast(res.code === 200 ? action + '成功' : res.message, res.code === 200 ? 'success' : 'error');
    if (res.code === 200) loadUsers(pages.users);
}

// ========== 商品管理 ==========
const ITEM_STATUS_TEXT = { 0: '已下架', 1: '在售', 2: '已售出', 3: '已预订' };
const ITEM_STATUS_CLASS = { 0: 'tag-red', 1: 'tag-green', 2: 'tag-gray', 3: 'tag-orange' };

async function loadItems(page) {
    pages.items = page || pages.items;
    const tbody = document.getElementById('itemTable');
    tbody.innerHTML = '<tr><td colspan="8" class="loading">加载中…</td></tr>';

    const res = await db.admin.items({
        keyword: document.getElementById('itemKeyword').value,
        status: document.getElementById('itemStatusFilter').value,
        page: pages.items,
        size: PAGE_SIZE
    });

    if (res.code !== 200) {
        tbody.innerHTML = `<tr><td colspan="8" class="loading">${esc(res.message)}</td></tr>`;
        document.getElementById('itemPager').innerHTML = '';
        return;
    }

    const { list, total } = res.data;
    if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="loading">没有符合条件的商品</td></tr>';
    } else {
        tbody.innerHTML = list.map(it => {
            const status = Number(it.status);
            const cover = it.images && it.images.length ? it.images[0] : '';
            return `
            <tr>
                <td>
                    <div class="item-cell">
                        ${cover ? `<img class="thumb" src="${esc(cover)}" alt="">` : '<span class="thumb thumb-empty">无图</span>'}
                        <span class="item-title">${esc(it.title)}</span>
                    </div>
                </td>
                <td>${esc(it.categoryName || '-')}</td>
                <td>${esc(it.sellerNickname || '-')}</td>
                <td class="nowrap">${money(it.price)}</td>
                <td>${Number(it.viewCount || 0)}</td>
                <td><span class="tag ${ITEM_STATUS_CLASS[status] || ''}">${ITEM_STATUS_TEXT[status] || status}</span></td>
                <td class="nowrap">${fmt(it.createdAt)}</td>
                <td class="col-op nowrap">
                    <button class="admin-btn tiny ${status === 1 ? 'danger' : 'success'}"
                        onclick="toggleItemStatus(${it.id}, ${status === 1 ? 0 : 1}, '${esc(it.title)}')">${status === 1 ? '下架' : '上架'}</button>
                    <button class="admin-btn tiny ghost" onclick="removeItem(${it.id}, '${esc(it.title)}')">删除</button>
                </td>
            </tr>`;
        }).join('');
    }
    renderPager('itemPager', total, pages.items, p => loadItems(p));
}

function resetItemSearch() {
    document.getElementById('itemKeyword').value = '';
    document.getElementById('itemStatusFilter').value = '';
    loadItems(1);
}

async function toggleItemStatus(itemId, status, title) {
    const action = Number(status) === 0 ? '下架' : '上架';
    if (!confirm(`确定要${action}商品「${title}」吗？`)) return;
    const res = await db.admin.setItemStatus(itemId, status);
    toast(res.code === 200 ? action + '成功' : res.message, res.code === 200 ? 'success' : 'error');
    if (res.code === 200) loadItems(pages.items);
}

async function removeItem(itemId, title) {
    if (!confirm(`确定要永久删除商品「${title}」吗？\n该商品的留言、收藏、订单将一并删除，不可恢复。`)) return;
    const res = await db.admin.deleteItem(itemId);
    toast(res.code === 200 ? '删除成功' : res.message, res.code === 200 ? 'success' : 'error');
    if (res.code === 200) loadItems(pages.items);
}

// ========== 分类管理 ==========
async function loadCategories() {
    const box = document.getElementById('catList');
    box.innerHTML = '<div class="loading">加载中…</div>';

    const res = await db.admin.categories();
    if (res.code !== 200) {
        box.innerHTML = `<div class="loading">${esc(res.message)}</div>`;
        return;
    }

    const list = res.data;
    const parents = list.filter(c => Number(c.parentId) === 0);
    const childrenOf = pid => list.filter(c => Number(c.parentId) === Number(pid));

    document.getElementById('catCount').textContent = `共 ${list.length} 个`;
    document.getElementById('catParent').innerHTML =
        '<option value="0">一级分类（顶级）</option>' +
        parents.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');

    const rowHtml = (c, isChild) => `
        <div class="cat-row ${isChild ? 'child' : 'parent'}" data-id="${c.id}">
            <span class="cat-prefix">${isChild ? '└' : '▸'}</span>
            <input class="admin-input cat-name" value="${esc(c.name)}" maxlength="20">
            <input class="admin-input narrow cat-sort" type="number" value="${Number(c.sortOrder) || 0}" title="排序">
            <span class="tag ${Number(c.status) === 1 ? 'tag-green' : 'tag-red'}">${Number(c.status) === 1 ? '启用' : '停用'}</span>
            <button class="admin-btn tiny primary" onclick="saveCategory(${c.id})">保存</button>
            <button class="admin-btn tiny ${Number(c.status) === 1 ? 'ghost' : 'success'}" onclick="toggleCategoryStatus(${c.id}, ${Number(c.status) === 1 ? 0 : 1})">${Number(c.status) === 1 ? '停用' : '启用'}</button>
            <button class="admin-btn tiny danger" onclick="removeCategory(${c.id}, '${esc(c.name)}')">删除</button>
        </div>`;

    box.innerHTML = parents.map(p => rowHtml(p, false) + childrenOf(p.id).map(c => rowHtml(c, true)).join('')).join('')
        || '<div class="loading">暂无分类</div>';
}

async function createCategory() {
    const name = document.getElementById('catName').value.trim();
    const parentId = Number(document.getElementById('catParent').value) || 0;
    const sortOrder = Number(document.getElementById('catSort').value) || 99;
    if (!name) { toast('请输入分类名称', 'error'); return; }

    const res = await db.admin.createCategory({ name, parentId, sortOrder });
    if (res.code !== 200) { toast(res.message, 'error'); return; }
    document.getElementById('catName').value = '';
    toast('分类已添加');
    loadCategories();
}

async function saveCategory(id) {
    const row = document.querySelector(`.cat-row[data-id="${id}"]`);
    if (!row) return;
    const name = row.querySelector('.cat-name').value.trim();
    const sortOrder = Number(row.querySelector('.cat-sort').value) || 0;
    const res = await db.admin.updateCategory(id, { name, sortOrder });
    toast(res.code === 200 ? '保存成功' : res.message, res.code === 200 ? 'success' : 'error');
    if (res.code === 200) loadCategories();
}

async function toggleCategoryStatus(id, status) {
    const res = await db.admin.updateCategory(id, { status });
    toast(res.code === 200 ? '状态已更新' : res.message, res.code === 200 ? 'success' : 'error');
    if (res.code === 200) loadCategories();
}

async function removeCategory(id, name) {
    if (!confirm(`确定要删除分类「${name}」吗？`)) return;
    const res = await db.admin.deleteCategory(id);
    toast(res.code === 200 ? '删除成功' : res.message, res.code === 200 ? 'success' : 'error');
    if (res.code === 200) loadCategories();
}

// ========== 订单管理 ==========
const ORDER_STATUS_TEXT = { 1: '待付款', 2: '待发货', 3: '已发货', 4: '已完成', 5: '已取消' };
const ORDER_STATUS_CLASS = { 1: 'tag-orange', 2: 'tag-blue', 3: 'tag-purple', 4: 'tag-green', 5: 'tag-gray' };

async function loadOrders(page) {
    pages.orders = page || pages.orders;
    const tbody = document.getElementById('orderTable');
    tbody.innerHTML = '<tr><td colspan="8" class="loading">加载中…</td></tr>';

    const res = await db.admin.orders({
        status: document.getElementById('orderStatusFilter').value,
        page: pages.orders,
        size: PAGE_SIZE
    });

    if (res.code !== 200) {
        tbody.innerHTML = `<tr><td colspan="8" class="loading">${esc(res.message)}</td></tr>`;
        document.getElementById('orderPager').innerHTML = '';
        return;
    }

    const { list, total } = res.data;
    if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="loading">暂无订单</td></tr>';
    } else {
        tbody.innerHTML = list.map(o => {
            const status = Number(o.status);
            const canCancel = status !== 4 && status !== 5;
            return `
            <tr>
                <td class="nowrap"><code>${esc(o.orderNo || '-')}</code></td>
                <td>${esc(o.itemTitle || '-')}</td>
                <td>${esc(o.buyerNickname || '-')}</td>
                <td>${esc(o.sellerNickname || '-')}</td>
                <td class="nowrap">${money(o.amount)}</td>
                <td><span class="tag ${ORDER_STATUS_CLASS[status] || ''}">${ORDER_STATUS_TEXT[status] || status}</span></td>
                <td class="nowrap">${fmt(o.createdAt)}</td>
                <td class="col-op nowrap">
                    <button class="admin-btn tiny danger" ${canCancel ? '' : 'disabled'}
                        onclick="forceCancelOrder(${o.id}, '${esc(o.orderNo || '')}')">强制取消</button>
                </td>
            </tr>`;
        }).join('');
    }
    renderPager('orderPager', total, pages.orders, p => loadOrders(p));
}

async function forceCancelOrder(orderId, orderNo) {
    if (!confirm(`确定强制取消订单 ${orderNo} 吗？该操作会通知双方，且不可撤销。`)) return;
    const res = await db.admin.cancelOrder(orderId);
    toast(res.code === 200 ? '订单已取消' : res.message, res.code === 200 ? 'success' : 'error');
    if (res.code === 200) loadOrders(pages.orders);
}

// ========== 分页 ==========
function renderPager(containerId, total, page, onGo) {
    const box = document.getElementById(containerId);
    if (!box) return;
    box.innerHTML = '';
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const info = document.createElement('span');
    info.className = 'pager-info';
    info.textContent = `共 ${total} 条 · 第 ${page}/${totalPages} 页`;
    box.appendChild(info);

    const mkBtn = (text, target, disabled) => {
        const btn = document.createElement('button');
        btn.className = 'admin-btn tiny ghost';
        btn.textContent = text;
        btn.disabled = disabled;
        if (!disabled) btn.addEventListener('click', () => onGo(target));
        return btn;
    };
    box.appendChild(mkBtn('上一页', page - 1, page <= 1));
    box.appendChild(mkBtn('下一页', page + 1, page >= totalPages));
}
