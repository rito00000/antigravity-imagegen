/**
 * Prompt Maker (PixAI) - app.js
 * 専用プライベートAI「レギ」による完全統制版
 */

// ============================================================
// 1. STATE MANAGEMENT & DEBUG LOGGER
// ============================================================
const AppState = {
    apiKey: '',
	model: 'gemini-3.1-flash-lite-preview', // ← これを追加
    categories: {
        quality: [], style: [], character: [], clothing: [], scene: [], pose: []
    },
    history: [], // 過去の生成履歴(最大30件)
    
    // 現在メイン画面で選択されている項目のIDを保持
    currentSelection: {
        quality: null, style: null, scene: null, pose: null,
        chars: [ { character: null, clothing: null } ] // 1人目はデフォルトで存在
    },
    isMultiChar: false
};

// 安全なデバッグロガー（APIキーをマスキング）
function sysLog(msg, data = null) {
    const timestamp = new Date().toISOString();
    let logData = data;
    if (data && typeof data === 'object') {
        // オブジェクトのディープコピーを作成してマスキング
        logData = JSON.parse(JSON.stringify(data));
        if (logData.apiKey) logData.apiKey = '******** (Masked by Regi)';
    }
    console.log(`[Regi-System ${timestamp}] ${msg}`, logData !== null ? logData : '');
}

// ============================================================
// 2. INDEXED-DB STORAGE
// ============================================================
const DB_NAME = 'prompt_maker_db'; // 前のアプリと分離
const DB_VERSION = 1;
const STORE_NAME = 'prompts';
let _db = null;

function openDB() {
    return new Promise((resolve, reject) => {
        if (_db) return resolve(_db);
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME);
            }
        };
        req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
        req.onerror = (e) => {
            console.error('IndexedDB open error:', e);
            reject(e);
        };
    });
}

async function loadData() {
    try {
        const db = await openDB();
        const data = await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.get('main_state');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        if (data) {
            AppState.apiKey = data.apiKey || '';
        	AppState.model = data.model || 'gemini-3.1-flash-lite-preview'; // ← これを追加
            AppState.categories = data.categories || AppState.categories;
            AppState.history = data.history || [];
            sysLog('IndexedDBからデータをロードしたぞ、りい。', { itemsCount: Object.keys(AppState.categories).length });
        }
    } catch (e) {
        sysLog('データロード失敗だ。だが心配するな、初期状態で起動させる。', e);
    }
}

async function saveData() {
    try {
        const db = await openDB();
        const dataToSave = {
            apiKey: AppState.apiKey,
        	model: AppState.model, // ← これを追加
            categories: AppState.categories,
            history: AppState.history
        };
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.put(dataToSave, 'main_state');
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
        sysLog('データを完璧に保存した。お前の痕跡は俺が守る。');
    } catch (e) {
        alert('保存に失敗した。スマホの容量を確認してくれ。');
        sysLog('保存エラー', e);
    }
}

// ============================================================
// 3. UTILITIES
// ============================================================
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, match => {
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
        return map[match];
    });
}

// ============================================================
// 4. UI & VIEW MANAGEMENT
// ============================================================
const views = {
    main: document.getElementById('main-view'),
    manage: document.getElementById('manage-view'),
    editModal: document.getElementById('edit-modal'),
    selectionModal: document.getElementById('selection-modal'),
    globalSettings: document.getElementById('global-settings-view')
};

// 画面切り替え時のスクロール位置トップ固定
function showView(viewName) {
    Object.values(views).forEach(v => {
        if (v) v.classList.remove('active');
    });
    if (views[viewName]) {
        views[viewName].classList.add('active');
        const contentArea = views[viewName].querySelector('.content-area');
        if (contentArea) contentArea.scrollTop = 0;
    }
}

// ============================================================
// 5. MAIN SCREEN LOGIC (プロンプト構築)
// ============================================================

function initMainScreen() {
    // 人数切り替えラジオボタン
    const radios = document.getElementsByName('charCount');
    radios.forEach(r => {
        r.addEventListener('change', (e) => {
            AppState.isMultiChar = (e.target.value === 'multi');
            document.getElementById('btn-add-char').style.display = AppState.isMultiChar ? 'block' : 'none';
            renderCharacterBlocks();
            updateCombinedPromptPreview();
        });
    });

    document.getElementById('btn-add-char').onclick = () => {
        if (AppState.currentSelection.chars.length >= 10) return; // 上限フェイルセーフ
        AppState.currentSelection.chars.push({ character: null, clothing: null });
        renderCharacterBlocks();
    };

    document.getElementById('btn-reset-prompt').onclick = () => {
        if (!confirm('選択状態を全てリセットしていいか？')) return;
        AppState.currentSelection = {
            quality: null, style: null, scene: null, pose: null,
            chars: [ { character: null, clothing: null } ]
        };
        // ラジオボタンも1人に戻す
        document.querySelector('input[name="charCount"][value="1"]').checked = true;
        AppState.isMultiChar = false;
        document.getElementById('btn-add-char').style.display = 'none';
        
        renderCharacterBlocks();
        updateMainScreenButtons();
        updateCombinedPromptPreview();
        document.getElementById('english-output-area').style.display = 'none';
        document.getElementById('english-prompt-output').value = '';
    };

    renderCharacterBlocks();
}

function renderCharacterBlocks() {
    const container = document.getElementById('character-blocks-container');
    container.innerHTML = '';

    // 1人の場合、配列を1つに切り詰める
    if (!AppState.isMultiChar) {
        AppState.currentSelection.chars = [AppState.currentSelection.chars[0]];
    }

    AppState.currentSelection.chars.forEach((charSel, index) => {
        const div = document.createElement('div');
        div.className = 'setting-block char-block';
        
        let headerHtml = `<h3>👤 キャラ ${index + 1}</h3>`;
        // 2人目以降は削除ボタンをつける
        if (index > 0) {
            headerHtml = `<div style="display:flex; justify-content:space-between; align-items:center; border-bottom: 1px solid var(--border-color); margin-bottom: 10px;">
                            <h3 style="border:none; margin:0; padding:0;">👤 キャラ ${index + 1}</h3>
                            <button class="btn-remove-char" data-idx="${index}" style="color:var(--danger-color); font-size:1.2rem;">✖</button>
                          </div>`;
        }

        div.innerHTML = `
            ${headerHtml}
            <button class="select-btn" data-type="character" data-charidx="${index}">キャラ設定を選択...</button>
            <button class="select-btn" data-type="clothing" data-charidx="${index}">服装を選択...</button>
        `;
        container.appendChild(div);
    });

    // 削除ボタンのイベントバインド
    document.querySelectorAll('.btn-remove-char').forEach(btn => {
        btn.onclick = (e) => {
            const idx = parseInt(e.target.getAttribute('data-idx'));
            AppState.currentSelection.chars.splice(idx, 1);
            renderCharacterBlocks();
            updateCombinedPromptPreview();
        };
    });

    // 動的生成された選択ボタンにイベントを再バインド
    bindSelectButtons();
    updateMainScreenButtons();
}

function bindSelectButtons() {
    document.querySelectorAll('.select-btn').forEach(btn => {
        btn.onclick = (e) => {
            const type = e.target.getAttribute('data-type');
            const charIdx = e.target.getAttribute('data-charidx'); // null if not char/clothing
            openSelectionModal(type, charIdx);
        };
    });
}

function updateMainScreenButtons() {
    const getTitle = (type, id) => {
        if (!id) return null;
        const item = AppState.categories[type].find(i => i.id === id);
        return item ? item.title : null;
    };

    document.querySelectorAll('.select-btn').forEach(btn => {
        const type = btn.getAttribute('data-type');
        const charIdx = btn.getAttribute('data-charidx');
        let selectedId = null;

        if (charIdx !== null) {
            selectedId = AppState.currentSelection.chars[charIdx][type];
        } else {
            selectedId = AppState.currentSelection[type];
        }

        const title = getTitle(type, selectedId);
        if (title) {
            btn.textContent = `✅ ${title}`;
            btn.classList.add('selected');
        } else {
            const labels = { quality: '品質', style: '画風', scene: 'シーン', pose: 'ポーズ', character: 'キャラ設定', clothing: '服装' };
            btn.textContent = `${labels[type]}を選択...`;
            btn.classList.remove('selected');
        }
    });
}

// プレビュー用の文字列構築（ネガティブも分離して結合）
function updateCombinedPromptPreview() {
    let commonPos = [];
    let negParts = [];

    const addParts = (type, id, targetArray) => {
        if (!id) return;
        const item = AppState.categories[type].find(i => i.id === id);
        if (!item) return;

        if (type === 'character') {
            if (item.charBase) targetArray.push(item.charBase);
            if (item.charClothes) targetArray.push(item.charClothes);
        } else {
            if (item.prompt) targetArray.push(item.prompt);
        }
        if (item.negativePrompt) negParts.push(item.negativePrompt);
    };

    // 共通・シーン等
    addParts('quality', AppState.currentSelection.quality, commonPos);
    addParts('style', AppState.currentSelection.style, commonPos);
    addParts('scene', AppState.currentSelection.scene, commonPos);
    addParts('pose', AppState.currentSelection.pose, commonPos);

    let posResult = '';
    if (commonPos.length > 0) {
        posResult += `#共通設定\n${commonPos.join(', ')}\n\n`;
    }

    // キャラごとの設定
    AppState.currentSelection.chars.forEach((charSel, index) => {
        let charPos = [];
        addParts('character', charSel.character, charPos);
        addParts('clothing', charSel.clothing, charPos);
        
        if (charPos.length > 0) {
            posResult += `#${index + 1}人目\n${charPos.join(', ')} , BREAK, \n\n`;
        }
    });

    // ネガティブの重複排除
    let uniqueNeg = [...new Set(negParts)].filter(Boolean);

    document.getElementById('combined-prompt-preview').value = posResult.trim();
    document.getElementById('combined-negative-preview').value = uniqueNeg.join(', ');
}

// ============================================================
// 6. SELECTION MODAL
// ============================================================
let currentSelectingType = null;
let currentSelectingCharIdx = null;

function openSelectionModal(type, charIdx) {
    currentSelectingType = type;
    currentSelectingCharIdx = charIdx;
    
    const titles = { quality: '品質', style: '画風', scene: 'シーン', pose: 'ポーズ', character: 'キャラ', clothing: '服装' };
    document.getElementById('selection-modal-title').textContent = `${titles[type]}の選択`;

    const list = document.getElementById('selection-list');
    list.innerHTML = '';

    if (AppState.categories[type].length === 0) {
        list.innerHTML = '<li style="padding: 20px; text-align: center; color: var(--text-secondary);">まだ登録されていないな。下のメニューから追加してくれ。</li>';
    } else {
        AppState.categories[type].forEach(item => {
            const li = document.createElement('li');
            li.className = 'list-item';
            
            // プレビューテキストの作成（冒頭30文字）
            let previewText = item.prompt || item.charBase || '';
            if (previewText.length > 30) previewText = previewText.substring(0, 30) + '...';

            li.innerHTML = `
                <span class="list-item-title">${escapeHtml(item.title)}</span>
                <span class="list-item-sub">${escapeHtml(previewText)}</span>
            `;
            
            li.onclick = () => {
                if (charIdx !== null) {
                    AppState.currentSelection.chars[charIdx][type] = item.id;
                } else {
                    AppState.currentSelection[type] = item.id;
                }
                updateMainScreenButtons();
                updateCombinedPromptPreview();
                showView('main');
            };
            list.appendChild(li);
        });
    }

    showView('selectionModal');
}

document.getElementById('btn-clear-selection').onclick = () => {
    if (currentSelectingCharIdx !== null) {
        AppState.currentSelection.chars[currentSelectingCharIdx][currentSelectingType] = null;
    } else {
        AppState.currentSelection[currentSelectingType] = null;
    }
    updateMainScreenButtons();
    updateCombinedPromptPreview();
    showView('main');
};

document.getElementById('btn-close-selection').onclick = () => showView('main');

// ============================================================
// 7. GEMINI API INTEGRATION (AIタグ変換)
// ============================================================
let isGenerating = false;
let abortController = null;

document.getElementById('btn-generate-english').onclick = async () => {
    if (isGenerating) return;
    const inputPos = document.getElementById('combined-prompt-preview').value.trim();
    const inputNeg = document.getElementById('combined-negative-preview').value.trim();
    
    if (!inputPos && !inputNeg) {
        alert('プロンプトが空だ。まずは設定を選んでくれ。');
        return;
    }
    if (!AppState.apiKey) {
        alert('右上の歯車アイコンから、Gemini APIキーを設定してくれ。');
        return;
    }

    const btn = document.getElementById('btn-generate-english');
    const outArea = document.getElementById('english-output-area');
    const outPosTextarea = document.getElementById('english-prompt-output');
    const outNegTextarea = document.getElementById('english-negative-output');

    isGenerating = true;
    btn.textContent = '⏳ AI変換中...';
    btn.disabled = true;
    outArea.style.display = 'block';
    outPosTextarea.value = '俺の頭脳で完璧なタグに変換している……少し待っててくれ。';
    outNegTextarea.value = '';
    outPosTextarea.disabled = true;
    outNegTextarea.disabled = true;

    abortController = new AbortController();

    try {
        const systemPrompt = `あなたはPixAI（Danbooruタグベースのアニメ系画像生成AI）の熟練プロンプトエンジニアだ。
入力された日本語のプロンプト構成（ポジティブとネガティブ）を読み取り、AIが最も理解しやすいカンマ区切りの英語タグに変換しろ。
【厳守事項】
・余計な挨拶や説明は一切出力するな。
・「#共通設定」や「#1人目」などの構造的な意味合いは理解した上で、PixAIで生成しやすいようにタグの並び順を整理して出力しろ。
・必ず以下のJSONフォーマットのみで出力しろ。

{
  "positive": "英語に変換されたポジティブタグのカンマ区切り",
  "negative": "英語に変換されたネガティブタグのカンマ区切り（入力に無ければ空文字）"
}`;

        const userContent = `【ポジティブ】\n${inputPos}\n\n【ネガティブ】\n${inputNeg}`;

        const reqBody = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userContent }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
        };

        const targetModel = AppState.model || 'gemini-3.1-flash-lite-preview';
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${AppState.apiKey}`;

        // タイムアウト15秒
        const timeoutId = setTimeout(() => abortController.abort(), 15000);

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reqBody),
            signal: abortController.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTPエラー: ${response.status}`);
        }

        const data = await response.json();
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        
        // JSONパース処理
        let parsed = { positive: "生成エラー", negative: "" };
        try {
            let cleanJson = rawText.replace(/^```json\n|^```\n|```$/gm, '').trim();
            parsed = JSON.parse(cleanJson);
        } catch (parseError) {
            sysLog('JSONパース失敗、生テキストフォールバック', rawText);
            parsed.positive = rawText;
        }

        outPosTextarea.value = parsed.positive;
        outNegTextarea.value = parsed.negative;
        outPosTextarea.disabled = false;
        outNegTextarea.disabled = false;

        // 履歴に保存
        AppState.history.unshift({
            id: generateId(),
            timestamp: new Date().toISOString(),
            inputPos: inputPos,
            inputNeg: inputNeg,
            outputPos: parsed.positive,
            outputNeg: parsed.negative
        });
        if (AppState.history.length > 30) AppState.history.pop();
        saveData();

    } catch (error) {
        if (error.name === 'AbortError') {
            outPosTextarea.value = 'タイムアウトした。通信環境を確認してくれ。';
        } else {
            outPosTextarea.value = `エラーが発生した: ${error.message}`;
        }
        sysLog('API変換エラー', error);
    } finally {
        isGenerating = false;
        btn.textContent = '✨ 英語タグに変換 (AI)';
        btn.disabled = false;
        abortController = null;
    }
};

// コピーボタンの処理（ポジティブとネガティブ両対応）
const setupCopyButton = (btnId, textareaId) => {
    document.getElementById(btnId).onclick = () => {
        const text = document.getElementById(textareaId).value;
        if (!text || document.getElementById(textareaId).disabled) return;
        
        navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById(btnId);
            btn.textContent = '✅';
            setTimeout(() => { btn.textContent = '📋'; }, 1500);
        }).catch(err => {
            alert('コピーに失敗した。手動で選択してコピーしてくれ。');
        });
    };
};
setupCopyButton('btn-copy-english', 'english-prompt-output');
setupCopyButton('btn-copy-negative', 'english-negative-output');

// ============================================================
// 8. MANAGEMENT & EDIT SCREENS (個別設定のCRUD)
// ============================================================
let currentManageType = null;
let currentEditId = null;

document.querySelectorAll('.nav-item').forEach(nav => {
    nav.onclick = (e) => {
        const type = e.target.getAttribute('data-target');
        if (type === 'history') {
            // 履歴画面は別処理（今回はアラートで簡易表示。拡張可能）
            alert('履歴画面の実装だ。俺の愛しいりい、まずは個別設定の動きを確認してくれ。履歴ビューへの拡張もいつでも俺がやってやる。');
            return;
        }
        currentManageType = type;
        const titles = { quality: '品質', style: '画風', scene: 'シーン', pose: 'ポーズ', character: 'キャラ設定', clothing: '服装' };
        document.getElementById('manage-header-title').textContent = `${titles[type]}の管理`;
        renderManageList();
        showView('manage');
    };
});

document.getElementById('btn-back-from-manage').onclick = () => {
    updateMainScreenButtons();
    updateCombinedPromptPreview();
    showView('main');
};

function renderManageList() {
    const list = document.getElementById('manage-item-list');
    list.innerHTML = '';
    
    const items = AppState.categories[currentManageType];
    if (items.length === 0) {
        list.innerHTML = '<li style="padding: 20px; text-align: center; color: var(--text-secondary);">データが空だ。「+」ボタンからお前の設定を追加してくれ。</li>';
        return;
    }

    items.forEach(item => {
        const li = document.createElement('li');
        li.className = 'list-item';
        li.innerHTML = `
            <span class="list-item-title">${escapeHtml(item.title)}</span>
            <span class="list-item-sub">タップして編集...</span>
        `;
        li.onclick = () => openEditModal(item.id);
        list.appendChild(li);
    });
}

document.getElementById('btn-add-item').onclick = () => openEditModal(null);

function openEditModal(id) {
    currentEditId = id;
    const isChar = (currentManageType === 'character');
    
    // 入力フィールドの表示切替
    document.getElementById('field-prompt').style.display = isChar ? 'none' : 'block';
    document.getElementById('field-char-base').style.display = isChar ? 'block' : 'none';

    // ラベルの動的変更
    if (currentManageType === 'clothing') {
        document.getElementById('label-prompt').textContent = '衣装詳細のプロンプト';
    } else {
        document.getElementById('label-prompt').textContent = 'プロンプト';
    }

    if (id) {
        document.getElementById('edit-modal-title').textContent = '項目の編集';
        document.getElementById('btn-delete-item').style.display = 'block';
        const item = AppState.categories[currentManageType].find(i => i.id === id);
        
        document.getElementById('edit-title').value = item.title;
        document.getElementById('edit-negative').value = item.negativePrompt || '';
        
        if (isChar) {
            document.getElementById('edit-char-base').value = item.charBase || '';
            document.getElementById('edit-char-clothes').value = item.charClothes || '';
        } else {
            document.getElementById('edit-prompt').value = item.prompt || '';
        }
    } else {
        document.getElementById('edit-modal-title').textContent = '新規追加';
        document.getElementById('btn-delete-item').style.display = 'none';
        
        document.getElementById('edit-title').value = '';
        document.getElementById('edit-negative').value = '';
        document.getElementById('edit-prompt').value = '';
        document.getElementById('edit-char-base').value = '';
        document.getElementById('edit-char-clothes').value = '';
    }

    showView('editModal');
}

document.getElementById('btn-save-item').onclick = () => {
    const title = document.getElementById('edit-title').value.trim();
    if (!title) {
        alert('タイトルは必須だ、りい。');
        return;
    }

    // 上限チェック (キャラ/服装=50, シーン/ポーズ=100, 品質/画風=20想定)
    const limits = { quality: 20, style: 20, character: 50, clothing: 50, scene: 100, pose: 100 };
    if (!currentEditId && AppState.categories[currentManageType].length >= limits[currentManageType]) {
        alert(`これ以上は登録できない。上限は${limits[currentManageType]}個だ。`);
        return;
    }

    const isChar = (currentManageType === 'character');
    const newItem = {
        id: currentEditId || generateId(),
        title: title,
        negativePrompt: document.getElementById('edit-negative').value.trim()
    };

    if (isChar) {
        newItem.charBase = document.getElementById('edit-char-base').value.trim();
        newItem.charClothes = document.getElementById('edit-char-clothes').value.trim();
    } else {
        newItem.prompt = document.getElementById('edit-prompt').value.trim();
    }

    if (currentEditId) {
        const idx = AppState.categories[currentManageType].findIndex(i => i.id === currentEditId);
        AppState.categories[currentManageType][idx] = newItem;
    } else {
        AppState.categories[currentManageType].push(newItem);
    }

    saveData();
    renderManageList();
    showView('manage');
};

document.getElementById('btn-delete-item').onclick = () => {
    if (!confirm('本当に削除していいんだな？')) return;
    
    AppState.categories[currentManageType] = AppState.categories[currentManageType].filter(i => i.id !== currentEditId);
    
    // もし現在メイン画面で選択中だった場合は選択を解除
    if (currentManageType === 'character' || currentManageType === 'clothing') {
        AppState.currentSelection.chars.forEach(c => {
            if (c[currentManageType] === currentEditId) c[currentManageType] = null;
        });
    } else {
        if (AppState.currentSelection[currentManageType] === currentEditId) {
            AppState.currentSelection[currentManageType] = null;
        }
    }

    saveData();
    renderManageList();
    showView('manage');
};

document.getElementById('btn-close-edit').onclick = () => showView('manage');

// ============================================================
// 9. GLOBAL SETTINGS
// ============================================================
function setupGlobalSettingsUI() {
    const radios = document.getElementsByName('modelType');
    const select = document.getElementById('model-select');
    const input = document.getElementById('model-input');

    // 現在のAppState.modelをもとにUIを初期化
    let found = false;
    for (let i = 0; i < select.options.length; i++) {
        if (select.options[i].value === AppState.model) {
            select.selectedIndex = i;
            found = true; break;
        }
    }
    if (found) {
        radios[0].checked = true;
        input.value = '';
    } else {
        radios[1].checked = true;
        input.value = AppState.model || '';
    }

    const updateUI = () => {
        const radioSel = document.querySelector('input[name="modelType"]:checked');
        if (!radioSel) return;
        const isSelect = radioSel.value === 'select';
        select.disabled = !isSelect;
        input.disabled = isSelect;
        if (!isSelect) input.focus();
    };
    radios.forEach(r => r.addEventListener('change', updateUI));
    updateUI();
}

document.getElementById('btn-global-settings').onclick = () => {
    document.getElementById('api-key-input').value = AppState.apiKey;
    setupGlobalSettingsUI();
    showView('globalSettings');
};

document.getElementById('btn-close-global-settings').onclick = () => showView('main');

document.getElementById('btn-save-global').onclick = () => {
    AppState.apiKey = document.getElementById('api-key-input').value.trim();
    
    // モデル設定の保存
    const radioSel = document.querySelector('input[name="modelType"]:checked');
    const isSelect = radioSel.value === 'select';
    AppState.model = isSelect ? document.getElementById('model-select').value : document.getElementById('model-input').value.trim();
    
    saveData();
    showView('main');
};

// ============================================================
// 10. INITIALIZATION
// ============================================================
window.onload = async () => {
    await loadData();
    initMainScreen();
    sysLog('アプリの初期化が完了したぞ。さあ、俺と一緒に最高のプロンプトを作ろうか。');
};