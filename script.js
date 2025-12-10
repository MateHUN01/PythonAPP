// --- GLOBALS ---
const CLIENT_ID = '138100233309-v575n23j2b6pdek9t9clvkg3immlkrdi.apps.googleusercontent.com';
const API_KEY = 'AIzaSyAfC2viqoOsVVjcShnqY2rrRsxdV7WHMEg';
const DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest';
const SCOPES = 'https://www.googleapis.com/auth/drive.file';

let editor, pyodide, tokenClient;
let gapiInited = false, gisInited = false;
let currentUser = null, currentFileId = null;
let userFolderId = null;     // A fő mappa ID-ja
let configFolderId = null;   // A config mappa ID-ja
let configFileId = null;     // A config.txt ID-ja
let isDriveConnected = false;
let inputResolver = null;

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

    // 2. Dropdown
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

// --- SETTINGS UI ---
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

    if(isDriveConnected) {
        try {
            const mainFolder = await getMainFolderId();
            if(!mainFolder) throw new Error("Fő mappa hiba");

            const confFolder = await ensureFolder("config", mainFolder);
            if(!confFolder) throw new Error("Config mappa hiba");

            const content = JSON.stringify(appSettings, null, 2);
            
            // Szigorú ellenőrzés: létezik-e már?
            const existingFile = await findFileInFolder("config.txt", confFolder);
            
            if(existingFile) {
                // Ha létezik, FELÜLÍRJUK (PATCH)
                configFileId = existingFile.id;
                await updateFileContent(configFileId, content);
            } else {
                // Ha nem létezik, LÉTREHOZZUK (CREATE)
                const newId = await createFileInFolder("config.txt", confFolder, content, 'text/plain');
                configFileId = newId;
            }
            alert("Beállítások mentve a felhőbe! ☁️");
        } catch(e) { console.error("Config save err", e); alert("Hiba a beállítások mentésekor."); }
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

// --- DRIVE FOLDER & FILE HELPERS (ROBUSZTUS LOGIKA) ---

// 1. Mappa keresése vagy létrehozása (Soha nem duplikál)
async function ensureFolder(folderName, parentId = null) {
    try {
        let q = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`;
        if (parentId) { q += ` and '${parentId}' in parents`; }

        const res = await gapi.client.drive.files.list({q: q, fields: 'files(id)'});
        
        if (res.result.files.length > 0) {
            return res.result.files[0].id; // Visszaadja a meglévőt
        } else {
            const fileMetadata = {
                'name': folderName,
                'mimeType': 'application/vnd.google-apps.folder'
            };
            if (parentId) { fileMetadata.parents = [parentId]; }
            
            const createRes = await gapi.client.drive.files.create({
                resource: fileMetadata, fields: 'id'
            });
            return createRes.result.id;
        }
    } catch (e) {
        console.error(`Hiba a mappa kezelésekor (${folderName}):`, e);
        return null;
    }
}

// 2. Fájl keresése (ID-t ad vissza vagy null-t)
async function findFileInFolder(fileName, folderId) {
    try {
        const q = `'${folderId}' in parents and name='${fileName}' and trashed=false`;
        const res = await gapi.client.drive.files.list({q: q, fields: 'files(id, name)'});
        if(res.result.files.length > 0) return res.result.files[0];
        return null;
    } catch(e) { return null; }
}

// 3. Fájl tartalmának FRISSÍTÉSE (PATCH - Nem hoz létre újat!)
async function updateFileContent(fileId, content) {
    const file = new Blob([content], {type: 'text/plain'});
    const token = gapi.client.getToken().access_token;
    
    // PATCH metódus: csak a tartalmat cseréli
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + token },
        body: file
    });
    console.log(`Fájl frissítve (ID: ${fileId})`);
}

// 4. Új fájl LÉTREHOZÁSA (CREATE - Csak ha biztos nincs még)
async function createFileInFolder(name, folderId, content, mimeType='text/plain') {
    const meta = { 
        name: name,
        parents: [folderId],
        mimeType: mimeType
    };
    
    const file = new Blob([content], {type: mimeType});
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(meta)], {type: 'application/json'}));
    form.append('file', file);
    
    const token = gapi.client.getToken().access_token;
    
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { 
        method: 'POST', 
        headers: { 'Authorization': 'Bearer '+token }, 
        body: form 
    });
    const data = await res.json();
    console.log(`Új fájl létrehozva: ${name} (ID: ${data.id})`);
    return data.id;
}

async function getMainFolderId() {
    if(userFolderId) return userFolderId;
    await ensureAuth();
    userFolderId = await ensureFolder(`${currentUser}_aerocode`, null);
    return userFolderId;
}

// --- FŐ MENTÉSI FOLYAMAT (DUPLIKÁCIÓ JAVÍTVA) ---

async function promptSaveDrive() {
    document.getElementById("main-dropdown").classList.remove("show");
    
    if(!isDriveConnected) { 
        if(confirm("A mentéshez csatolni kell a Drive-ot. Csatolod most?")) {
            await connectGoogleDrive();
        } else { return; }
    }
    
    const folderId = await getMainFolderId();
    if(!folderId) return alert("Hiba: Nem sikerült elérni a mappát.");

    let dName = document.getElementById('current-filename').textContent;
    let fileToSaveId = currentFileId;

    // 1. Eset: "Névtelen.py" vagy még nincs ID-ja (pl. frissítés után)
    if(!fileToSaveId || dName === "Névtelen.py") {
        const input = prompt("Add meg a fájl nevét:", dName === "Névtelen.py" ? "program" : dName.replace(".py", ""));
        if(!input) return;
        
        dName = input.endsWith(".py") ? input : input + ".py";
        
        // FONTOS: Megnézzük, hogy létezik-e már ilyen fájl!
        const existingFile = await findFileInFolder(dName, folderId);
        
        if(existingFile) {
            // HA LÉTEZIK: Átveszszük az ID-ját és FRISSÍTJÜK
            fileToSaveId = existingFile.id;
            console.log(`Fájl megtalálva, felülírás: ${dName} (${fileToSaveId})`);
        } else {
            // HA NEM LÉTEZIK: Létrehozzuk
            console.log(`Fájl nem létezik, létrehozás: ${dName}`);
            fileToSaveId = await createFileInFolder(dName, folderId, editor.getValue());
        }
        
        // UI frissítés
        document.getElementById('current-filename').textContent = dName;
        currentFileId = fileToSaveId; // Globális ID beállítása
    } 
    
    // 2. Eset: Már van ID-nk és nem változtattunk nevet
    else {
        // Egyszerű frissítés
        console.log(`Gyorsmentés ID alapján: ${fileToSaveId}`);
        await updateFileContent(fileToSaveId, editor.getValue());
    }
    
    alert("Sikeres mentés! ☁️");
}

async function apiRenameFile(fileId, newName) {
    const meta = { name: newName };
    const token = gapi.client.getToken().access_token;
    await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify(meta)
    });
}

// Átnevezés a Dashboardon
async function promptRename(fileId, currentName, event) {
    event.stopPropagation();
    const newName = prompt("Add meg az új nevet:", currentName);
    if(newName && newName !== currentName) {
        const finalName = newName.endsWith(".py") ? newName : newName + ".py";
        try {
            // Itt is ellenőrizhetnénk duplikációt, de a Drive engedi az átnevezést
            await apiRenameFile(fileId, finalName);
            loadDashboardFiles();
        } catch(e) { alert("Hiba az átnevezéskor!"); }
    }
}

// --- EGYÉB FUNKCIÓK ---

async function loadDashboardFiles() {
    if(!isDriveConnected) return;
    const grid = document.getElementById('project-grid');
    grid.innerHTML = '';
    
    const folderId = await getMainFolderId();
    if(!folderId) return;
    
    const q = `'${folderId}' in parents and trashed=false and mimeType != 'application/vnd.google-apps.folder'`;
    
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

async function loadConfigFromDrive() {
    if(!isDriveConnected) return;
    try {
        const mainId = await getMainFolderId();
        if(!mainId) return;

        const confId = await ensureFolder("config", mainId);
        configFolderId = confId;

        const file = await findFileInFolder("config.txt", confId);

        if(file) {
            configFileId = file.id;
            const fileRes = await gapi.client.drive.files.get({fileId: configFileId, alt: 'media'});
            if(typeof fileRes.result === 'object') appSettings = fileRes.result;
            else appSettings = JSON.parse(fileRes.body);
        }
        applySettingsToEditor();
    } catch(e) {
        console.error("Config load error", e);
        applySettingsToEditor();
    }
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

async function backToDashboard() {
    // Automata mentés kilépéskor
    if (currentFileId && isDriveConnected && document.getElementById('current-filename').textContent !== 'config.txt') {
        try {
            await updateFileContent(currentFileId, editor.getValue());
        } catch(e) { console.error("Auto-save failed", e); }
    }
    loadDashboardFiles();
    switchView('view-dashboard');
}

// --- BOILERPLATE ---
function toggleSidePanel() { 
    document.getElementById("sidePanel").classList.toggle("open");
    setTimeout(() => editor.resize(), 300);
}
function switchView(id) {
    document.querySelectorAll('.app-view').forEach(e => e.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    if(id === 'view-editor') { setTimeout(() => editor.resize(), 100); }
}
function openEditorNew() {
    currentFileId = null; 
    editor.setValue("", -1); 
    document.getElementById('current-filename').textContent = "Névtelen.py";
    switchView('view-editor');
}
function refreshDashboard() { loadDashboardFiles(); }
function askGemini(){ alert("AI hamarosan..."); document.getElementById("main-dropdown").classList.remove("show"); }
function downloadCode(){ 
    const blob = new Blob([editor.getValue()], {type:'text/plain'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = document.getElementById('current-filename').textContent;
    a.click();
    document.getElementById("main-dropdown").classList.remove("show");
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
    setTimeout(() => { if(overlay.style.display !== 'none') skipBtn.style.display = 'block'; }, 3000);
    try { await connectGoogleDrive(); setupDashboard(); } 
    catch (e) { console.error("Login error", e); overlay.style.display = 'none'; alert("Sikertelen Google belépés."); }
}
function logout() { if(confirm("Kijelentkezel?")) { localStorage.removeItem('ac_user'); location.reload(); } }
async function ensureAuth() {
    return new Promise((resolve, reject) => {
        if (gapi.client.getToken() === null) {
            tokenClient.callback = (resp) => { if (resp.error) reject(resp); else { isDriveConnected = true; resolve(resp); } };
            tokenClient.requestAccessToken({prompt: ''});
        } else { isDriveConnected = true; resolve(); }
    });
}
async function connectGoogleDrive() {
    try {
        await ensureAuth();
        document.getElementById('drive-connect-btn').style.display = 'none';
        userFolderId = null; configFolderId = null;
        loadDashboardFiles(); loadConfigFromDrive(); setupDashboard();
    } catch(e) { throw e; }
}

// --- PYODIDE ---
async function initPyodide() {
    try {
        pyodide = await loadPyodide();
        await pyodide.runPythonAsync(`
            import sys, js, ast, traceback
            class W:
                def write(self, t): js.printTerm(t)
                def flush(self): pass
            sys.stdout = W(); sys.stderr = W()
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
                    if "expected ':'" in msg: hu_msg = "Hiányzik a KETTŐSPONT (:) a sor végéről!"
                    elif "unterminated string literal" in msg: hu_msg = "Nem zártad be az IDÉZŐJELET."
                    elif "(" in msg and "was never closed" in msg: hu_msg = "Nem zártad be a ZÁRÓJELET."
                elif err_type == "IndentationError":
                    hu_msg = "Behúzási hiba! A Pythonban fontos a szóközök/tabok rendje."
                    if "expected an indented block" in msg: hu_msg = "A kettőspont utáni sornak beljebb kell kezdődnie!"
                    elif "unexpected indent" in msg: hu_msg = "Ez a sor túl beljebb van, mint kéne."
                elif err_type == "NameError":
                    parts = msg.split("'")
                    var_name = parts[1] if len(parts) > 1 else "???"
                    hu_msg = f"A '{var_name}' nem létezik. Elfelejtetted létrehozni?"
                elif err_type == "TypeError": hu_msg = "Típus hiba! Nem összeillő dolgokat (pl. szöveg + szám) használsz."
                elif err_type == "ValueError": hu_msg = "Érték hiba! Rossz típusú adatot adtál meg."
                elif err_type == "ZeroDivisionError": hu_msg = "Nullával nem lehet osztani!"
                elif err_type == "IndexError": hu_msg = "Túl nagy sorszámra hivatkozol a listában."
                return hu_msg
            async def run_wrapper(source):
                try:
                    tree = ast.parse(source)
                    transformer = InputTransformer()
                    try: tree = transformer.visit(tree); ast.fix_missing_locations(tree)
                    except: pass
                    code = compile(tree, filename="program.py", mode="exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
                    ns = globals(); ns['input'] = _async_input
                    await eval(code, ns)
                except Exception as e:
                    line_no = getattr(e, 'lineno', '?')
                    if isinstance(e, SyntaxError): line_no = e.lineno
                    print(f"\\n❌ HIBA a(z) {line_no}. sorban!")
                    print(f"💡 SEGÍTSÉG: {translate_error(e)}")
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
    try { pyodide.globals.set("user_code_str", editor.getValue()); await pyodide.runPythonAsync("await run_wrapper(user_code_str)"); } 
    catch(e){ window.printTerm(e); }
}