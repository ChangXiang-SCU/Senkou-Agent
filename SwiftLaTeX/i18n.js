// Senkou Agent i18n Module
(function() {
    const DEFAULT_LANG = 'zh';
    const STORAGE_KEY = 'senkouLang';
    let currentLang = localStorage.getItem(STORAGE_KEY) || DEFAULT_LANG;
    let translations = {};
    let loaded = false;
    let _resolveReady;
    const readyPromise = new Promise(resolve => { _resolveReady = resolve; });

    async function loadLanguage(lang) {
        try {
            const resp = await fetch(`/lang/${lang}.json`);
            if (!resp.ok) throw new Error(`Failed to load ${lang}.json`);
            translations = await resp.json();
            loaded = true;
            // Update <html lang> so browser extensions (e.g. Immersive Translate) know the page language
            document.documentElement.lang = lang;
            applyTranslations();
            _resolveReady();
        } catch(e) {
            console.error('i18n load error:', e);
            if (lang !== DEFAULT_LANG) {
                await loadLanguage(DEFAULT_LANG);
            } else {
                _resolveReady(); // resolve even on failure so nothing hangs
            }
        }
    }

    function t(key, fallback) {
        if (!loaded) return fallback || undefined;
        const val = translations[key];
        if (val) return val;
        // Key not found in translations: return fallback if provided, otherwise undefined
        // so that callers using `i18n.t(key) || 'default'` pattern get the default
        return fallback || undefined;
    }

    function applyTranslations() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            const text = translations[key];
            if (text) {
                if (el.tagName === 'INPUT' && el.type !== 'submit') {
                    el.placeholder = text;
                } else {
                    el.textContent = text;
                }
            }
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            const text = translations[key];
            if (text) el.placeholder = text;
        });
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            const text = translations[key];
            if (text) el.title = text;
        });
    }

    async function setLanguage(lang) {
        currentLang = lang;
        localStorage.setItem(STORAGE_KEY, lang);
        await loadLanguage(lang);
        // Update toggle button appearance
        document.querySelectorAll('.i18n-toggle').forEach(btn => {
            btn.textContent = lang === 'zh' ? '🌐 EN' : '🌐 中文';
        });
    }

    function toggleLanguage() {
        setLanguage(currentLang === 'zh' ? 'en' : 'zh');
    }

    function getCurrentLang() {
        return currentLang;
    }

    function createToggleButton() {
        const btn = document.createElement('button');
        btn.className = 'i18n-toggle';
        btn.textContent = currentLang === 'zh' ? '🌐 EN' : '🌐 中文';
        btn.style.cssText = 'background:transparent;border:1px solid #27272a;color:#a1a1aa;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;transition:all 0.2s;';
        btn.onmouseenter = () => { btn.style.borderColor = '#3b82f6'; btn.style.color = '#e4e4e7'; };
        btn.onmouseleave = () => { btn.style.borderColor = '#27272a'; btn.style.color = '#a1a1aa'; };
        btn.onclick = toggleLanguage;
        return btn;
    }

    // Auto-init on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => loadLanguage(currentLang));
    } else {
        loadLanguage(currentLang);
    }

    // Expose API globally
    window.i18n = {
        t,
        setLanguage,
        toggleLanguage,
        getCurrentLang,
        createToggleButton,
        applyTranslations,
        ready: readyPromise
    };
})();
