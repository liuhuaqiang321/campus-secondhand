// ============================================================
// Supabase 连接配置
//
// 两种填写方式（任选其一）：
//   方式 A：直接修改下面的 DEFAULT_CONFIG，部署后所有人共用
//   方式 B：打开 setup.html 页面填写，配置保存在浏览器本地
//           localStorage 的值优先级更高，便于临时调试
// ============================================================

const DEFAULT_CONFIG = {
    url: 'https://wnqetxttrpjhyypenenj.supabase.co',
    anonKey: 'sb_publishable_bJCl_cE99IJyLCIhb2Zqvw_eYgEifTQ'
};

(function () {
    const savedUrl = localStorage.getItem('SUPABASE_URL');
    const savedKey = localStorage.getItem('SUPABASE_ANON_KEY');

    window.SUPABASE_URL = savedUrl || DEFAULT_CONFIG.url;
    window.SUPABASE_ANON_KEY = savedKey || DEFAULT_CONFIG.anonKey;
})();

// 是否已完成云数据库连接配置
window.isSupabaseConfigured = function () {
    return !!(window.SUPABASE_URL && window.SUPABASE_ANON_KEY);
};

// 未配置时跳转到引导页（index.html 使用）
window.ensureConfigured = function () {
    if (!window.isSupabaseConfigured()) {
        location.href = 'setup.html';
        return false;
    }
    return true;
};
