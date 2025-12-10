// --- GLOBALS ---
const CLIENT_ID = '138100233309-v575n23j2b6pdek9t9clvkg3immlkrdi.apps.googleusercontent.com';
const API_KEY = 'AIzaSyAfC2viqoOsVVjcShnqY2rrRsxdV7WHMEg';
const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let editor, pyodide, tokenClient;
let gapiInited = false, gisInited = false;
let currentUser = null, currentFileId = null;
let userFolderId = null;
let isDriveConnected = false;
let inputResolver = null;
let configId = null;

// ALAPÉRTELMEZETT BEÁLLÍTÁSOK
let appSettings = {
    theme: "dracula",
    fontSize: "14",
    completionKey: "tab"
};

// --- INIT ---
function gapiLoaded() { gapi.load('client', async () => { await gapi.client.init({ apiKey: API_KEY, discoveryDocs: [DISCOVERY_DOC] }); gapiInited = true; }); }
function gisLoaded() { tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPES, callback: (resp) => { if(!resp.error) isDriveConnected=true; } }); gisInited = true; }

window.onload = function() {
    // 1. ACE EDITOR INIT
    editor = ace.edit("code-editor");
    editor.setTheme("ace/theme/dracula");
    editor.session.setMode("ace/mode/python");
    
    editor.setOptions({
        fontSize: "14px",
        showPrintMargin: false,
        enableBasicAutocompletion: true,
        enableLiveAutocompletion: true
    });

    // 2. Dropdown Event Listeners
    document.addEventListener('click', function(e) {
        const dd = document.getElementById("main-dropdown");
        const btn = document.getElementById("menu-trigger-btn");
        if (!btn.contains(e.target) && !dd.contains(e.target)) dd.classList.remove("show");
    });
    document.getElementById("menu-trigger-btn").addEventListener('click', function(e) {
        e.stopPropagation();
        document.getElementById("main-dropdown").classList.toggle("show");
    });

    // 3. Pyodide
    initPyodide();

    // 4. Login Check
    const savedUser = localStorage.getItem('ac_user');
    if(savedUser) {
        document.getElementById('loginNameInput').value = savedUser;
        document.getElementById('loading-overlay').style.display = 'none';
    } else {
        document.getElementById('loading-overlay').style.display = 'none';
    }

    // Terminal Input
    document.getElementById("term-enter-btn").addEventListener("click", submitTerminalInput);
    document.getElementById("term-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") submitTerminalInput();
    });
};

// --- SETTINGS LOGIC ---
function openSettings() {
    document.getElementById('set-theme').value = appSettings.theme;
    document.getElementById('set-fontsize').value = appSettings.fontSize;
    document.getElementById('fs-val').innerText = appSettings.fontSize + 'px';
    document.getElementById('set-keybind').value = appSettings.completionKey;
    
    document.getElementById("main-dropdown").classList.remove("show");
    document.getElementById("settings-modal").classList.add("open");
}

function closeSettings() {
    document.getElementById("settings-modal").classList.remove("open");
}

async function saveSettingsToDrive() {
    appSettings.theme = document.getElementById('set-theme').value;
    appSettings.fontSize = document.getElementById('set-fontsize').value;
    appSettings.completionKey = document.getElementById('set-keybind').value;

    applySettingsToEditor();

    if(isDriveConnected && userFolderId) {
        const content = JSON.stringify(appSettings, null, 2);
        try {
            if(configId) {
                await saveFile(configId, null, content, null, 'application/json');
            } else {
                await saveFile(null, 'config.json', content, userFolderId, 'application/json');
            }
            alert("Beállítások mentve a felhőbe! ☁️");
        } catch(e) { console.error("Config save err", e); }
    } else {
        alert("Beállítások alkalmazva (Offline).");
    }
    closeSettings();
}

function applySettingsToEditor() {
    editor.setTheme("ace/theme/" + appSettings.theme);
    editor.setOptions({ fontSize: appSettings.fontSize + "px" });

    if (window.customKeyHandler) {
        editor.keyBinding.removeKeyboardHandler(window.customKeyHandler);
    }
    var HashHandler = ace.require("ace/keyboard/hash_handler").HashHandler;
    window.customKeyHandler = new HashHandler();

    if(appSettings.completionKey === "tab") {
        window.customKeyHandler.bindKey("Return", function(editor) {
            if (editor.completer && editor.completer.getPopup() && editor.completer.getPopup().isOpen) {
                editor.completer.detach();
                editor.insert("\n");
            } else { editor.insert("\n"); }
        });
        window.customKeyHandler.bindKey("Tab", function(editor) {
            if (editor.completer && editor.completer.getPopup() && editor.completer.getPopup().isOpen) {
                editor.completer.insertMatch();
            } else { editor.indent(); }
        });
    } else {
        window.customKeyHandler.bindKey("Tab", function(editor) {
            if (editor.completer && editor.completer.getPopup() && editor.completer.getPopup().isOpen) {
                editor.completer.detach();
                editor.indent(); 
            } else { editor.indent(); }
        });
        window.customKeyHandler.bindKey("Return", function(editor) {
            if (editor.completer && editor.completer.getPopup() && editor.completer.getPopup().isOpen) {
                editor.completer.insertMatch();
            } else { editor.insert("\n"); }
        });
    }
    editor.keyBinding.addKeyboardHandler(window.customKeyHandler);
    editor.resize();
}

// --- CONFIG FILE MANAGEMENT ---
async function loadConfigFromDrive() {
    if(!isDriveConnected || !userFolderId) return;

    try {
        const q = `'${userFolderId}' in parents and name='config.json' and trashed=false`;
        const res = await gapi.client.drive.files.list({q: q, fields: 'files(id)'});
        
        if(res.result.files.length > 0) {
            configId = res.result.files[0].id;
            const fileRes = await gapi.client.drive.files.get({fileId: configId, alt: 'media'});
            if(typeof fileRes.result === 'object') appSettings = fileRes.result;
            else appSettings = JSON.parse(fileRes.body);
        } else {
            const content = JSON.stringify(appSettings);
            await saveFile(null, 'config.json', content, userFolderId, 'application/json');
        }
        applySettingsToEditor();
    } catch(e) { console.error("Config load error", e); }
}

function toggleSidePanel() { 
    document.getElementById("sidePanel").classList.toggle("open");
    setTimeout(() => editor.resize(), 300);
}

function switchView(id) {
    document.querySelectorAll('.app-view').forEach(e => e.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    if(id === 'view-editor') {
        setTimeout(() => editor.resize(), 100);
    }
}

async function backToDashboard() {
    if (currentFileId && isDriveConnected && document.getElementById('current-filename').textContent !== 'config.json') {
        try {
            await saveFile(currentFileId, null, editor.getValue(), null);
        } catch(e) { console.error("Auto-save failed", e); }
    }
    loadDashboardFiles();
    switchView('view-dashboard');
}

// --- LOGIN ---
function skipLogin() {
    const inputName = document.getElementById('loginNameInput').value.trim();
    currentUser = inputName ? inputName : "Vendég";
    isDriveConnected = false;
    setupDashboard();
}

function performLocalLogin() {
    const name = document.getElementById('loginNameInput').value.trim();
    if(!name) return alert("Név kötelező!");
    currentUser = name;
    localStorage.setItem('ac_user', currentUser);
    setupDashboard();
}

async function performGoogleLogin() {
    const name = document.getElementById('loginNameInput').value.trim();
    if(!name) return alert("Név kötelező!");
    currentUser = name;
    localStorage.setItem('ac_user', currentUser);

    const overlay = document.getElementById('loading-overlay');
    const skipBtn = document.getElementById('skip-login-btn');
    const loadingText = overlay.querySelector('.loading-text');

    overlay.style.display = 'flex';
    skipBtn.style.display = 'none';
    loadingText.textContent = "Kapcsolódás a Google Fiókhoz...";

    setTimeout(() => {
        if(overlay.style.display !== 'none') skipBtn.style.display = 'block';
    }, 3000);

    try {
        await connectGoogleDrive();
        setupDashboard();
    } catch (e) {
        console.error("Login error", e);
        overlay.style.display = 'none';
        alert("Sikertelen Google belépés.");
    }
}

function setupDashboard() {
    document.getElementById('loading-overlay').style.display='none';
    document.getElementById('dash-username').textContent = currentUser;
    document.getElementById('dash-avatar').textContent = currentUser[0].toUpperCase();
    
    const dBtn = document.getElementById('drive-connect-btn');
    const empty = document.getElementById('empty-state');
    const offMsg = document.getElementById('offline-msg');

    if(isDriveConnected) {
        dBtn.style.display = 'none';
        loadDashboardFiles();
        loadConfigFromDrive(); 
    } else {
        dBtn.style.display = 'block';
        empty.style.display = 'block';
        offMsg.textContent = "Offline mód.";
        document.getElementById('project-grid').innerHTML = '';
        applySettingsToEditor(); 
    }
    switchView('view-dashboard');
}

function logout() {
    if(confirm("Kijelentkezel?")) {
        localStorage.removeItem('ac_user');
        location.reload();
    }
}

// --- DRIVE LOGIKA ---

async function ensureAuth() {
    return new Promise((resolve, reject) => {
        if (gapi.client.getToken() === null) {
            tokenClient.callback = (resp) => {
                if (resp.error) reject(resp);
                else { isDriveConnected = true; resolve(resp); }
            };
            tokenClient.requestAccessToken({prompt: ''});
        } else {
            isDriveConnected = true; resolve();
        }
    });
}

async function connectGoogleDrive() {
    try {
        await ensureAuth();
        document.getElementById('drive-connect-btn').style.display = 'none';
        userFolderId = null;
        loadDashboardFiles();
        loadConfigFromDrive();
        setupDashboard();
    } catch(e) { throw e; }
}

async function getFolderId() {
    if(userFolderId) return userFolderId;
    await ensureAuth();
    const folderName = `${currentUser}_aerocode`; 
    try {
        const q = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`;
        const res = await gapi.client.drive.files.list({q: q, fields: 'files(id)'});
        if(res.result.files.length > 0) {
            userFolderId = res.result.files[0].id;
        } else {
            const c = await gapi.client.drive.files.create({ 
                resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder' }, 
                fields: 'id' 
            });
            userFolderId = c.result.id;
        }
        return userFolderId;
    } catch(e) { console.error("Folder error:", e); return null; }
}

// --- ÁTNEVEZÉS FUNKCIÓK ---

async function promptRename(fileId, currentName, event) {
    // Megállítjuk a kattintást, hogy ne nyissa meg a fájlt
    event.stopPropagation();
    
    const newName = prompt("Add meg az új nevet:", currentName);
    if(newName && newName !== currentName) {
        // Hozzáadjuk a .py-t ha nincs
        const finalName = newName.endsWith(".py") ? newName : newName + ".py";
        
        try {
            await apiRenameFile(fileId, finalName);
            // Ha sikerült, frissítjük a listát
            loadDashboardFiles();
        } catch(e) {
            alert("Hiba az átnevezéskor!");
            console.error(e);
        }
    }
}

async function apiRenameFile(fileId, newName) {
    const meta = { name: newName };
    const token = gapi.client.getToken().access_token;
    
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: 'PATCH',
        headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(meta)
    });
}

// ---------------------------

async function loadDashboardFiles() {
    if(!isDriveConnected) return;
    const grid = document.getElementById('project-grid');
    grid.innerHTML = '';
    const folderId = await getFolderId();
    if(!folderId) return;
    
    const q = `'${folderId}' in parents and trashed=false and name != 'config.json'`;
    
    try {
        const res = await gapi.client.drive.files.list({
            q: q, fields: 'files(id, name)', orderBy: 'createdTime desc'
        });
        const files = res.result.files;
        if(files && files.length > 0) {
            document.getElementById('empty-state').style.display='none';
            files.forEach(f => {
                let dName = f.name;
                const d = document.createElement('div');
                d.className = 'project-card';
                // Átnevezés gomb hozzáadása
                d.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div style="font-size:30px;">📄</div>
                        <button class="rename-btn" onclick="promptRename('${f.id}', '${dName}', event)" title="Átnevezés">
                            <span class="material-icons" style="font-size:16px;">edit</span>
                        </button>
                    </div>
                    <div class="project-name">${dName}</div>
                `;
                d.onclick = () => loadFile(f.id, dName);
                grid.appendChild(d);
            });
        } else {
            document.getElementById('empty-state').style.display='block';
            document.getElementById('offline-msg').textContent = "A mappa üres.";
        }
    } catch(e){ console.error(e); }
}

async function promptSaveDrive() {
    document.getElementById("main-dropdown").classList.remove("show");
    if(!isDriveConnected) { 
        if(confirm("A mentéshez csatolni kell a Drive-ot. Csatolod most?")) {
            await connectGoogleDrive();
        } else { return; }
    }
    const folderId = await getFolderId();
    if(!folderId) return alert("Hiba: Nem sikerült elérni a mappát.");
    let dName = document.getElementById('current-filename').textContent;
    if(!currentFileId || dName === "Névtelen.py") {
        const input = prompt("Add meg a fájl nevét:", "program");
        if(!input) return;
        dName = input.endsWith(".py") ? input : input + ".py";
        await saveFile(null, dName, editor.getValue(), folderId);
        document.getElementById('current-filename').textContent = dName;
    } else {
        await saveFile(currentFileId, null, editor.getValue(), null);
    }
    alert("Sikeres mentés a felhőbe! ☁️");
}

async function saveFile(id, name, content, folderId, mimeType = 'text/plain') {
    const meta = { mimeType: mimeType };
    if(name) meta.name = name;
    if(folderId) meta.parents = [folderId];
    
    const file = new Blob([content], {type: mimeType});
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(meta)], {type: 'application/json'}));
    form.append('file', file);
    
    const token = gapi.client.getToken().access_token;
    const method = id ? 'PATCH' : 'POST';
    const url = id ? 
        `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=multipart` : 
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    
    const res = await fetch(url, { method: method, headers: { 'Authorization': 'Bearer '+token }, body: form });
    const data = await res.json();
    
    if(!id && name !== 'config.json') currentFileId = data.id;
    if(!id && name === 'config.json') configId = data.id;
}

async function loadFile(id, name) {
    try {
        const res = await gapi.client.drive.files.get({fileId: id, alt: 'media'});
        editor.setValue(res.body, -1);
        currentFileId = id;
        document.getElementById('current-filename').textContent = name;
        switchView('view-editor');
    } catch(e){ alert("Hiba a betöltéskor."); }
}

function openEditorNew() {
    currentFileId = null; 
    editor.setValue("", -1); 
    document.getElementById('current-filename').textContent = "Névtelen.py";
    switchView('view-editor');
}

function refreshDashboard() { loadDashboardFiles(); }

// --- PYODIDE OKOS HIBAKEZELÉSSEL ---
async function initPyodide() {
    try {
        pyodide = await loadPyodide();
        
        await pyodide.runPythonAsync(`
            import sys, js, ast, traceback
            
            class W:
                def write(self, t): js.printTerm(t)
                def flush(self): pass
            sys.stdout = W()
            sys.stderr = W()

            async def _async_input(p=""):
                if p: print(p, end="")
                return await js.waitForInput()

            class InputTransformer(ast.NodeTransformer):
                def visit_Call(self, node):
                    self.generic_visit(node)
                    if isinstance(node.func, ast.Name) and node.func.id == 'input':
                        return ast.Await(value=node)
                    return node

            def translate_error(e):
                err_type = type(e).__name__
                msg = str(e)
                hu_msg = "Ismeretlen hiba."

                if err_type == "SyntaxError":
                    hu_msg = "Szintaxis (gépelési) hiba! A kód szerkezete rossz."
                    if "expected ':'" in msg:
                        hu_msg = "Hiányzik a KETTŐSPONT (:) a sor végéről!"
                    elif "unterminated string literal" in msg or "EOL while scanning string literal" in msg:
                        hu_msg = "Nem zártad be az IDÉZŐJELET egy szövegnél."
                    elif "(" in msg and "was never closed" in msg:
                        hu_msg = "Nem zártad be a ZÁRÓJELET."
                    elif "invalid syntax" in msg:
                        hu_msg = "Érvénytelen utasítás. Ellenőrizd a parancsokat és írásjeleket."

                elif err_type == "IndentationError":
                    hu_msg = "Behúzási hiba! A Pythonban fontos a szóközök/tabok rendje."
                    if "expected an indented block" in msg:
                        hu_msg = "A kettőspont utáni sornak beljebb kell kezdődnie!"
                    elif "unexpected indent" in msg:
                        hu_msg = "Ez a sor túl beljebb van, mint kéne."
                    elif "unindent does not match" in msg:
                        hu_msg = "A behúzás mértéke nem egyezik a felette lévőkkel."

                elif err_type == "NameError":
                    parts = msg.split("'")
                    var_name = parts[1] if len(parts) > 1 else "???"
                    hu_msg = f"A '{var_name}' nem létezik. Elfelejtetted létrehozni, vagy elírtad a nevét?"

                elif err_type == "TypeError":
                    hu_msg = "Típus hiba! Olyasmit próbálsz csinálni, ami ezzel az adattal nem lehet."
                    if "unsupported operand type(s)" in msg:
                        hu_msg = "Két nem összeillő dolgot (pl. szöveget és számot) próbáltál összeadni/kivonni."
                    elif "takes" in msg and "arguments" in msg:
                        hu_msg = "Rossz számú adatot adtál meg egy függvénynek."

                elif err_type == "ValueError":
                    hu_msg = "Érték hiba! A függvény nem tud mit kezdeni ezzel az adattal."
                    if "invalid literal for int()" in msg:
                        hu_msg = "Szöveget próbáltál számmá alakítani (int), de betűk vannak benne."

                elif err_type == "ZeroDivisionError":
                    hu_msg = "Nullával nem lehet osztani!"

                elif err_type == "IndexError":
                    hu_msg = "Túl nagy sorszámra (index) hivatkozol a listában. Nincs ilyen elem."

                return hu_msg

            async def run_wrapper(source):
                try:
                    tree = ast.parse(source)
                    transformer = InputTransformer()
                    try:
                        tree = transformer.visit(tree)
                        ast.fix_missing_locations(tree)
                    except: pass

                    code = compile(tree, filename="program.py", mode="exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
                    
                    ns = globals()
                    ns['input'] = _async_input
                    
                    await eval(code, ns)
                
                except Exception as e:
                    line_no = getattr(e, 'lineno', '?')
                    if isinstance(e, SyntaxError):
                        line_no = e.lineno
                    
                    print(f"\\n❌ HIBA a(z) {line_no}. sorban!")
                    magyarazat = translate_error(e)
                    print(f"💡 SEGÍTSÉG: {magyarazat}")
                    print(f"🔧 Részletek: {type(e).__name__}: {e}")

        `);
    } catch(e){ console.log("Pyodide loading...", e); }
}

window.printTerm = (t) => {
    const d=document.getElementById('output'); d.innerText+=t; d.scrollTop=d.scrollHeight;
    document.getElementById('sidePanel').classList.add('open');
    setTimeout(() => editor.resize(), 100);
};

window.waitForInput = () => {
    return new Promise(resolve => {
        inputResolver = resolve;
        const c = document.getElementById("terminal-input-container");
        c.classList.add("visible");
        document.getElementById("term-input").focus();
        document.getElementById("sidePanel").classList.add("open");
        setTimeout(() => editor.resize(), 100);
    });
};

function submitTerminalInput() {
    if(inputResolver) {
        const f = document.getElementById("term-input");
        const v = f.value; f.value="";
        document.getElementById("output").innerText += v + "\n";
        document.getElementById("terminal-input-container").classList.remove("visible");
        inputResolver(v); inputResolver=null;
    }
}

async function runPython() {
    document.getElementById("sidePanel").classList.add("open");
    setTimeout(() => editor.resize(), 100);
    document.getElementById("output").innerText="";
    
    try { 
        pyodide.globals.set("user_code_str", editor.getValue());
        await pyodide.runPythonAsync("await run_wrapper(user_code_str)"); 
    } 
    catch(e){ window.printTerm(e); }
}

function askGemini(){ alert("AI hamarosan..."); document.getElementById("main-dropdown").classList.remove("show"); }
function downloadCode(){ 
    const blob = new Blob([editor.getValue()], {type:'text/plain'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = document.getElementById('current-filename').textContent;
    a.click();
    document.getElementById("main-dropdown").classList.remove("show");
}