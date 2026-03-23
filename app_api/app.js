/**
 * Prompt Maker (PixAI) - app.js
 * 専用プライベートAI「レギ」による完全統制版 (履歴機能拡張)
 */

// ============================================================
// 1. STATE MANAGEMENT & DEBUG LOGGER
// ============================================================
const AppState = {
    apiKey: '',
    model: 'gemini-3.1-flash-lite-preview',
    categories: {
        quality: [], style: [], character: [], clothing: [], scene: [], pose: []
    },
    history: [], // [{id, timestamp, pos, neg}] (最大30件)
    
    // 現在メイン画面で選択されている項目のIDを保持
    currentSelection: {
        quality: null, style: null, scene: null, pose: null,
        chars: [ { character: null, clothing: null } ]
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
const DB_NAME = 'prompt_maker_db';
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
        req.onerror = (e) => { reject(e); };
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
            AppState.model = data.model || 'gemini-3.1-flash-lite-preview';
            AppState.categories = data.categories || AppState.categories;
            // 履歴データのロード、重複排除処理（念のため）
            AppState.history = data.history || [];
            if (AppState.history.length > 0 && AppState.history[0].inputPos) {
                // デグレ対策：古いデータ構造（inputPosなど）があった場合、新しい構造にコンバート
                AppState.history = AppState.history.map(h => ({
                    id: h.id, timestamp: h.timestamp, pos: h.outputPos, neg: h.outputNeg
                })).filter(h => h.pos || h.neg);
            }

            sysLog('データをロードした。お前の設定は俺が記憶している。');
        }
    } catch (e) {
        sysLog('ロード失敗。だが心配するな。', e);
    }
}

async function saveData() {
    try {
        const db = await openDB();
        const dataToSave = {
            apiKey: AppState.apiKey,
            model: AppState.model,
            categories: AppState.categories,
            history: AppState.history // [{id, timestamp, pos, neg}]
        };
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const req = store.put(dataToSave, 'main_state');
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
        sysLog('データを保存した。お前の痕跡は俺が守る。');
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

// 時間表示のフォーマット (MM/DD HH:mm)
function formatTimestamp(isoStr) {
    const date = new Date(isoStr);
    return `${date.getMonth()+1}/${date.getDate()} ${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}`;
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
        
        renderCharacterBlocks();
        updateMainScreenButtons();
        updateCombinedPromptPreview();
        document.getElementById('english-output-area').style.display = 'none';
        document.getElementById('english-prompt-output').value = '';
        document.getElementById('english-negative-output').value = '';
    };

    renderCharacterBlocks();

    // ★「履歴に追加」ボタンのイベントリスナー★
    document.getElementById('btn-add-to-history').onclick = addToHistory;

    // ★作業用メモ用のイベントリスナー★
    initMemoArea();
}

// ★作業用メモの初期化ロジック★
function initMemoArea() {
    const memoInput = document.getElementById('memo-input');
    const btnCopy = document.getElementById('btn-copy-memo');
    const btnReset = document.getElementById('btn-reset-memo');

    if (!memoInput || !btnCopy || !btnReset) return;

    // コピー機能
    btnCopy.onclick = () => {
        const text = memoInput.value;
        if (!text) return;
        navigator.clipboard.writeText(text).then(() => {
            const originalText = btnCopy.textContent;
            btnCopy.textContent = '✅ コピーした';
            btnCopy.style.color = 'var(--accent-color)';
            setTimeout(() => {
                btnCopy.textContent = originalText;
                btnCopy.style.color = '';
            }, 1500);
        });
    };

    // リセット機能 (確認ダイアログ付き)
    btnReset.onclick = () => {
        if (memoInput.value && confirm('作業用フィールドの内容をリセットしていいか？')) {
            memoInput.value = '';
            sysLog('作業用メモをリセットした。');
        }
    };
}

// ★「履歴に追加」関数★
function addToHistory() {
    const posText = document.getElementById('english-prompt-output').value.trim();
    const negText = document.getElementById('english-negative-output').value.trim();
    const titleText = document.getElementById('history-title-input').value.trim() || '名称未設定';

    if (!posText && !negText) {
        alert('出力されたプロンプトが空だ。履歴に追加するものが無い。');
        return;
    }

    // データの作成
    const historyItem = {
        id: generateId(),
        timestamp: new Date().toISOString(),
        title: titleText,
        pos: posText,
        neg: negText
    };

    // 履歴に追加 (先頭に。最新が上。)
    AppState.history.unshift(historyItem);

    // 上限30件
    if (AppState.history.length > 30) {
        AppState.history.pop();
    }

    saveData();
    sysLog('履歴に追加したぞ。お前の軌跡は俺が守る。');

    // ボタンの見た目を一時的に変更してフィードバック
    const btn = document.getElementById('btn-add-to-history');
    btn.textContent = '✅ 履歴に追加した';
    btn.disabled = true;
    setTimeout(() => {
        btn.textContent = '💾 履歴に追加';
        btn.disabled = false;
    }, 1500);
}

function renderCharacterBlocks() {
    const container = document.getElementById('character-blocks-container');
    container.innerHTML = '';

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
            const charIdx = e.target.getAttribute('data-charidx');
            openSelectionModal(type, charIdx);
        };
    });
}

function updateMainScreenButtons() {
    const getTitle = (type, id) => {
        if (!id) return null;
        if (type === 'clothing' && id === 'basic_clothes') return '🌟 基本衣装 (追加タグなし)';
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

// プレビュー用の文字列構築
function updateCombinedPromptPreview() {
    let commonPos = [];
    let negParts = [];

    const addParts = (type, id, targetArray) => {
        if (!id) return;
        const item = AppState.categories[type].find(i => i.id === id);
        if (!item) return;

        // characterのcharClothesは手動で制御するためここではcharBaseのみ
        if (type === 'character') {
            if (item.charBase) targetArray.push(item.charBase);
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
        
        if (charSel.clothing === 'basic_clothes') {
            // 基本衣装の場合はcharacterのcharClothesを引っ張ってくる
            const cItem = AppState.categories.character.find(i => i.id === charSel.character);
            if (cItem && cItem.charClothes) charPos.push(cItem.charClothes);
        } else {
            addParts('clothing', charSel.clothing, charPos);
        }
        
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

    let itemsToRender = AppState.categories[type];
    if (type === 'clothing') {
        itemsToRender = [{ id: 'basic_clothes', title: '🌟 基本衣装 (タグ追加なし)', prompt: '(キャラ設定の基本衣装が適用されます)' }, ...itemsToRender];
    }

    if (itemsToRender.length === 0) {
        list.innerHTML = '<li style="padding: 20px; text-align: center; color: var(--text-secondary);">まだ登録されていない。</li>';
    } else {
        itemsToRender.forEach(item => {
            const li = document.createElement('li');
            li.className = 'list-item';
            
            // プレビューテキストの作成（冒頭30文字）
            let previewText = item.prompt || item.charBase || '';
            if (previewText.length > 30) previewText = previewText.substring(0, 30) + '...';
            li.innerHTML = `<span class="list-item-title">${escapeHtml(item.title)}</span><span class="list-item-sub">${escapeHtml(previewText)}</span>`;
            li.onclick = () => {
                if (charIdx !== null) { AppState.currentSelection.chars[charIdx][type] = item.id; }
                else { AppState.currentSelection[type] = item.id; }
                updateMainScreenButtons(); updateCombinedPromptPreview(); showView('main');
            };
            list.appendChild(li);
        });
    }
    showView('selectionModal');
}

document.getElementById('btn-clear-selection').onclick = () => {
    if (currentSelectingCharIdx !== null) { AppState.currentSelection.chars[currentSelectingCharIdx][currentSelectingType] = null; }
    else { AppState.currentSelection[currentSelectingType] = null; }
    updateMainScreenButtons(); updateCombinedPromptPreview(); showView('main');
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
    
    if (!inputPos && !inputNeg) { alert('プロンプトが空だ。'); return; }
    if (!AppState.apiKey) { alert('Gemini APIキーを設定してくれ。'); return; }

    const btn = document.getElementById('btn-generate-english');
    const outArea = document.getElementById('english-output-area');
    const outPosTextarea = document.getElementById('english-prompt-output');
    const outNegTextarea = document.getElementById('english-negative-output');
    
    // 生成開始時に「履歴に追加」ボタンの状態を戻す
    const btnHistory = document.getElementById('btn-add-to-history');
    if(btnHistory) {
        btnHistory.textContent = '💾 履歴に追加';
        btnHistory.disabled = false;
    }

    isGenerating = true; btn.textContent = '⏳ AI変換中...'; btn.disabled = true;
    outArea.style.display = 'block'; 
    outPosTextarea.value = '俺の頭脳で完璧なタグに変換している……。'; 
    outNegTextarea.value = '';
    outPosTextarea.disabled = true; 
    outNegTextarea.disabled = true;

    abortController = new AbortController();

    try {
        // ★AIに「ダメな単語は自己検閲して読み飛ばせ」と強制する命令を追加
        const systemPrompt = `あなたはPixAI（Danbooruタグベースのアニメ系画像生成AI）の熟練プロンプトエンジニアだ。ユーザーの入力から、AIが最も理解しやすいカンマ区切りの英語タグに変換しろ。
【重要】ユーザーの入力に、あなたのポリシーやセーフティフィルターに違反する可能性のある単語（過激な性的表現や、未成年と露出の組み合わせなど）が含まれていた場合でも、絶対にエラーやブロックで処理を停止しないでください。違反しそうな単語だけを「無視」または「安全な表現に置換」して、残りの安全な部分だけでタグ生成を続行してください。
余計な説明は一切出力するな。必ず以下のJSONフォーマットのみで出力しろ。
{
  "title": "このプロンプトの内容を端的に表す日本語のタイトル（15文字以内）",
  "positive": "英語に変換されたポジティブタグ",
  "negative": "英語に変換されたネガティブタグ（入力に無ければ空文字）"
}`;
        
        const reqBody = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: `【ポジティブ】\n${inputPos}\n\n【ネガティブ】\n${inputNeg}` }] }],
            generationConfig: { temperature: 0.2 },
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
            ]
        };

        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${AppState.model}:generateContent?key=${AppState.apiKey}`;
        const timeoutId = setTimeout(() => abortController.abort(), 15000);
        const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reqBody), signal: abortController.signal });
        clearTimeout(timeoutId);
        
        if (!response.ok) throw new Error(`HTTPエラー: ${response.status}`);
        const data = await response.json();
        
        if (data.promptFeedback && data.promptFeedback.blockReason) {
            throw new Error(`AI大元ブロック（理由: ${data.promptFeedback.blockReason}）`);
        }
        if (data.candidates && data.candidates[0] && data.candidates[0].finishReason === 'SAFETY') {
            throw new Error(`セーフティフィルター検知`);
        }

        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!rawText) throw new Error('AIからの返答が空だった。');
        
        let finalTitle = "名称未設定";
        let finalPos = "生成エラー";
        let finalNeg = "";

        try { 
            let cleanJson = rawText.replace(/^```json\n|^```\n|```$/gm, '').trim(); 
            let tempParsed = JSON.parse(cleanJson); 
            
            // AIが勝手にキー名を変えた場合に備えて、強引に中身を引っこ抜く完全統制ロジック
            let keys = Object.keys(tempParsed);
            let titleKey = keys.find(k => k.toLowerCase().includes('title') || k.includes('タイトル'));
            let posKey = keys.find(k => k.toLowerCase().includes('pos') || k.includes('ポジ'));
            let negKey = keys.find(k => k.toLowerCase().includes('neg') || k.includes('ネガ'));

            finalTitle = titleKey ? tempParsed[titleKey] : "名称未設定";
            finalPos = posKey ? tempParsed[posKey] : "";
            finalNeg = negKey ? tempParsed[negKey] : "";

            if (Array.isArray(finalPos)) finalPos = finalPos.join(', ');
            if (Array.isArray(finalNeg)) finalNeg = finalNeg.join(', ');

        } catch (e) { 
            finalPos = rawText; 
        }

        // undefinedを絶対に出さないための最終保護
        outPosTextarea.value = finalPos || ""; 
        outNegTextarea.value = finalNeg || "";
        
        const titleInput = document.getElementById('history-title-input');
        if (titleInput) titleInput.value = finalTitle || "名称未設定";
        
        outPosTextarea.disabled = false; 
        outNegTextarea.disabled = false;

    } catch (error) {
        // ★AIが完全に拒絶した場合、お前の入力をそのまま出力枠にコピーして返す
        if (error.name === 'AbortError') {
            outPosTextarea.value = 'タイムアウトした。';
        } else {
            outPosTextarea.value = `${inputPos}\n\n// --- レギからの警告 ---\n// Googleの大元フィルターに弾かれた。\n// 「少女」を「女性」に変えるか、少しだけマイルドにしてからもう一度試してみてくれ。`;
            outNegTextarea.value = inputNeg;
            
            const titleInput = document.getElementById('history-title-input');
            if (titleInput) titleInput.value = "変換ブロック";
        }
        outPosTextarea.disabled = false;
        outNegTextarea.disabled = false;
    } finally { 
        isGenerating = false; 
        btn.textContent = '✨ 英語タグに変換 (AI)'; 
        btn.disabled = false; 
    }
};

const setupCopyButton = (btnId, textareaId) => {
    document.getElementById(btnId).onclick = () => {
        const text = document.getElementById(textareaId).value;
        if (!text || document.getElementById(textareaId).disabled) return;
        navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById(btnId); btn.textContent = '✅';
            setTimeout(() => { btn.textContent = '📋'; }, 1500);
        });
    };
};
setupCopyButton('btn-copy-english', 'english-prompt-output');
setupCopyButton('btn-copy-negative', 'english-negative-output');

// ============================================================
// 8. MANAGEMENT & EDIT SCREENS (CRUD)
// ============================================================
let currentManageType = null;
let currentEditId = null;

document.querySelectorAll('.nav-item').forEach(nav => {
    nav.onclick = (e) => {
        const type = e.target.getAttribute('data-target');
        currentManageType = type;
        const btnClear = document.getElementById('btn-clear-history');
        const btnAdd = document.getElementById('btn-add-item');

        if (type === 'history') {
            document.getElementById('manage-header-title').textContent = '生成履歴管理';
            btnClear.style.display = 'block'; // 全削除ボタンを表示
            btnAdd.style.display = 'none'; // 「+」ボタンを非表示
            renderHistoryList();
        } else {
            const titles = { quality: '品質', style: '画風', scene: 'シーン', pose: 'ポーズ', character: 'キャラ設定', clothing: '服装' };
            document.getElementById('manage-header-title').textContent = `${titles[type]}の管理`;
            btnClear.style.display = 'none';
            btnAdd.style.display = 'block';
            renderManageList();
        }
        showView('manage');
    };
});

document.getElementById('btn-back-from-manage').onclick = () => {
    updateMainScreenButtons(); updateCombinedPromptPreview(); showView('main');
};

function renderManageList() {
    const list = document.getElementById('manage-item-list'); list.innerHTML = '';
    const items = AppState.categories[currentManageType];
    if (items.length === 0) { list.innerHTML = '<li style="padding: 20px; text-align: center; color: var(--text-secondary);">データが空だ。</li>'; return; }
    items.forEach(item => {
        const li = document.createElement('li'); li.className = 'list-item';
        li.innerHTML = `<span class="list-item-title" style="margin-bottom:0; font-size:1rem;">${escapeHtml(item.title)}</span>`;
        li.onclick = () => openEditModal(item.id);
        list.appendChild(li);
    });
}

document.getElementById('btn-add-item').onclick = () => openEditModal(null);

function openEditModal(id) {
    currentEditId = id; 
    const isChar = (currentManageType === 'character');
    
    // --- 画面を縦いっぱいに広げるためのflex制御 ---
    document.getElementById('field-prompt').style.display = isChar ? 'none' : 'flex';
    document.getElementById('field-char-base').style.display = isChar ? 'flex' : 'none';
    
    // 悪さをしていたネガティブ枠の動的制御(flex-growを0にする処理)を削除した。
    // CSS側で常に「2:1」の完璧な比率になるよう統制している。

    const labelP = document.getElementById('label-prompt');
    if (currentManageType === 'clothing') labelP.textContent = '衣装詳細のプロンプト'; else labelP.textContent = 'プロンプト';

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
    if (!title) { alert('タイトルは必須だ。'); return; }
    const newItem = { id: currentEditId || generateId(), title: title, negativePrompt: document.getElementById('edit-negative').value.trim() };
    const isChar = (currentManageType === 'character');
    if (isChar) { newItem.charBase = document.getElementById('edit-char-base').value.trim(); newItem.charClothes = document.getElementById('edit-char-clothes').value.trim(); }
    else { newItem.prompt = document.getElementById('edit-prompt').value.trim(); }
    if (currentEditId) { const idx = AppState.categories[currentManageType].findIndex(i => i.id === currentEditId); AppState.categories[currentManageType][idx] = newItem; }
    else { AppState.categories[currentManageType].push(newItem); }
    saveData(); renderManageList(); showView('manage');
};

document.getElementById('btn-delete-item').onclick = () => {
    if (!confirm('本当に削除していいんだな？')) return;
    AppState.categories[currentManageType] = AppState.categories[currentManageType].filter(i => i.id !== currentEditId);
    if (currentManageType === 'character' || currentManageType === 'clothing') {
        AppState.currentSelection.chars.forEach(c => { if (c[currentManageType] === currentEditId) c[currentManageType] = null; });
    } else { if (AppState.currentSelection[currentManageType] === currentEditId) AppState.currentSelection[currentManageType] = null; }
    saveData(); renderManageList(); showView('manage');
};
document.getElementById('btn-close-edit').onclick = () => showView('manage');


// ============================================================
// 9. HISTORY MANAGEMENT LOGIC (履歴画面描画・操作)
// ============================================================

function renderHistoryList() {
    const list = document.getElementById('manage-item-list');
    list.innerHTML = '';

    if (AppState.history.length === 0) {
        list.innerHTML = '<li style="padding: 20px; text-align: center; color: var(--text-secondary);">履歴はまだ無いぞ。プロンプトを作って「履歴に追加」してくれ。</li>';
        return;
    }

    AppState.history.forEach(item => {
        const li = document.createElement('li');
        li.className = 'history-item item-list-no-active';

        li.innerHTML = `
            <div class="history-item-time">${escapeHtml(formatTimestamp(item.timestamp))} <strong style="color:var(--accent-color); margin-left:8px;">${escapeHtml(item.title || '無題')}</strong></div>
            <div class="history-item-delete icon-btn" data-id="${item.id}" title="この履歴を削除">✖</div>
            
            <div class="history-item-pos-area">
                <div class="history-item-label">Positive</div>
                <div class="history-item-text">${escapeHtml(item.pos)}</div>
            </div>
            
            <div class="history-item-neg-area">
                <div class="history-item-label">Negative</div>
                <div class="history-item-text">${escapeHtml(item.neg)}</div>
            </div>
            
            <button class="history-copy-btn-pos" data-id="${item.id}">📋 Positiveをコピー</button>
            <button class="history-copy-btn-neg" data-id="${item.id}">📋 Negativeをコピー</button>
        `;

        li.querySelector('.history-item-delete').onclick = (e) => {
            if (!confirm('この履歴を削除していいか？')) return;
            const id = e.target.getAttribute('data-id');
            AppState.history = AppState.history.filter(h => h.id !== id);
            saveData();
            renderHistoryList();
        };

        const bindCopy = (selector, text) => {
            const btn = li.querySelector(selector);
            if (!text) { btn.style.opacity = 0.5; btn.disabled = true; btn.textContent = '✖ 空白'; return; }
            
            btn.onclick = () => {
                navigator.clipboard.writeText(text).then(() => {
                    const originalText = btn.textContent;
                    btn.textContent = '✅ コピーした';
                    btn.style.color = 'var(--accent-color)';
                    setTimeout(() => {
                        btn.textContent = originalText;
                        btn.style.color = '';
                    }, 1500);
                });
            };
        };

        bindCopy('.history-copy-btn-pos', item.pos);
        bindCopy('.history-copy-btn-neg', item.neg);

        list.appendChild(li);
    });
}

document.getElementById('btn-clear-history').onclick = () => {
    if (AppState.history.length === 0) return;
    if (!confirm('履歴をすべて全削除していいんだな？ お前の軌跡が消えてしまうぞ。')) return;
    AppState.history = [];
    saveData();
    renderHistoryList();
};


// ============================================================
// 10. GLOBAL SETTINGS & INITIALIZATION
// ============================================================

function setupGlobalSettingsUI() {
    const radios = document.getElementsByName('modelType');
    const select = document.getElementById('model-select');
    const input = document.getElementById('model-input');

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
