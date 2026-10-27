// 配置引导页逻辑：把 Supabase 连接信息存入浏览器本地存储
(function () {
    const urlInput = document.getElementById('cfgUrl');
    const keyInput = document.getElementById('cfgKey');

    const savedUrl = localStorage.getItem('SUPABASE_URL');
    const savedKey = localStorage.getItem('SUPABASE_ANON_KEY');
    if (savedUrl) urlInput.value = savedUrl;
    if (savedKey) keyInput.value = savedKey;

    function showToast(message, type) {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = 'toast ' + (type || 'info') + ' show';
        setTimeout(function () { toast.className = 'toast'; }, 2500);
    }

    window.saveConfig = function (e) {
        e.preventDefault();
        const url = urlInput.value.trim().replace(/\/$/, '');
        const key = keyInput.value.trim();

        if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
            showToast('Project URL 格式不正确，应形如 https://xxxx.supabase.co', 'error');
            return;
        }
        if (key.length < 40) {
            showToast('anon key 长度不足，请检查是否复制完整', 'error');
            return;
        }

        localStorage.setItem('SUPABASE_URL', url);
        localStorage.setItem('SUPABASE_ANON_KEY', key);
        showToast('配置已保存，正在进入平台...', 'success');
        setTimeout(function () { location.href = 'index.html'; }, 800);
    };
})();
