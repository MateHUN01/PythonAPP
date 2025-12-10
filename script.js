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

// --- INIT ---
function gapiLoaded() { gapi.load('client', async () => { await gapi.client.init({ apiKey: API_KEY, discoveryDocs: [DISCOVERY_DOC] }); gapiInited = true; }); }
function gisLoaded() { tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPES, callback: (resp) => { if(!resp.error) isDriveConnected=true; } }); gisInited = true; }

window.onload = function() {
    // 1. Editor Init
    editor = CodeMirror.fromTextArea(document.getElementById("code-editor"), {
        mode: { name: "python", version: 3 },
        theme: "dracula",
        lineNumbers: true, smartIndent: true, matchBrackets: true
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

    // 3. Start Skip Timer immediately
    setTimeout(() => {
        const skipBtn = document.getElementById('skip-login-btn');
        if(skipBtn) skipBtn.style.display = 'block';
    }, 3000);

    // 4. Try Async Pyodide Load
    initPyodide();

    // 5. Check LocalStorage User
    const savedUser = localStorage.getItem('ac_user');
    if(savedUser) {
        document.getElementById('loginNameInput').value = savedUser;
        document.getElementById('loading-overlay').style.display = 'none';
    }

    // Terminal Input
    document.getElementById("term-enter-btn").addEventListener("click", submitTerminalInput);
    document.getElementById("term-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") submitTerminalInput();
    });
};

function toggleSidePanel() { document.getElementById("sidePanel").classList.toggle("open"); }
function switchView(id) {
    document.querySelectorAll('.app-view').forEach(e => e.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    if(id==='view-editor') setTimeout(()=>editor.refresh(),100);
}

// --- AUTO-SAVE ON BACK ---
async function backToDashboard() {
    if (currentFileId && isDriveConnected) {
        try {
            await saveFile(currentFileId, null, editor.getValue(), null);
            console.log("Auto-saved on back");
        } catch(e) {
            console.error("Auto-save failed", e);
        }
    }
    loadDashboardFiles();
    switchView('view-dashboard');
}

// --- LOGIN ---
function skipLogin() {
    currentUser = "Vendég";
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
    await connectGoogleDrive();
    setupDashboard();
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
    } else {
        dBtn.style.display = 'block';
        empty.style.display = 'block';
        offMsg.textContent = "Offline mód.";
        document.getElementById('project-grid').innerHTML = '';
    }
    switchView('view-dashboard');
}

function logout() {
    if(confirm("Kijelentkezel?")) {
        localStorage.removeItem('ac_user');
        location.reload();
    }
}

// --- DRIVE LOGIKA (FRISSÍTVE) ---

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
        alert("Sikeres csatolás!");
        document.getElementById('drive-connect-btn').style.display = 'none';
        userFolderId = null; // Reseteljük, hogy az új user mappáját kérje le
        loadDashboardFiles();
    } catch(e) { 
        console.error(e);
        alert("Hiba a csatoláskor."); 
    }
}

async function getFolderId() {
    // Ha már megvan, visszaadjuk
    if(userFolderId) return userFolderId;
    
    await ensureAuth();
    
    // Mappa név a user alapján
    const folderName = `${currentUser}_aerocode`; 
    
    try {
        const q = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`;
        const res = await gapi.client.drive.files.list({q: q, fields: 'files(id)'});
        
        if(res.result.files.length > 0) {
            userFolderId = res.result.files[0].id;
        } else {
            // Létrehozás ha nincs
            const c = await gapi.client.drive.files.create({ 
                resource: { 
                    name: folderName, 
                    mimeType: 'application/vnd.google-apps.folder' 
                }, 
                fields: 'id' 
            });
            userFolderId = c.result.id;
        }
        return userFolderId;
    } catch(e) { 
        console.error("Folder error:", e);
        return null; 
    }
}

async function loadDashboardFiles() {
    if(!isDriveConnected) return;
    const grid = document.getElementById('project-grid');
    grid.innerHTML = '';
    
    const folderId = await getFolderId();
    if(!folderId) return;
    
    // Csak az adott mappában lévő fájlokat listázzuk
    const q = `'${folderId}' in parents and trashed=false`;
    
    try {
        const res = await gapi.client.drive.files.list({
            q: q, 
            fields: 'files(id, name)', 
            orderBy: 'createdTime desc'
        });
        
        const files = res.result.files;
        if(files && files.length > 0) {
            document.getElementById('empty-state').style.display='none';
            files.forEach(f => {
                let dName = f.name; // Tiszta név
                const d = document.createElement('div');
                d.className = 'project-card';
                d.innerHTML = `<div style="font-size:30px; margin-bottom:10px;">📄</div><div class="project-name">${dName}</div>`;
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
        } else {
            return; 
        }
    }
    
    const folderId = await getFolderId();
    if(!folderId) return alert("Hiba: Nem sikerült elérni a mappát.");

    let dName = document.getElementById('current-filename').textContent;
    
    // Ha új fájl (Névtelen.py) VAGY még nincs ID-ja
    if(!currentFileId || dName === "Névtelen.py") {
        const input = prompt("Add meg a fájl nevét:", "program");
        if(!input) return;
        
        dName = input.endsWith(".py") ? input : input + ".py";
        
        // Mentés a mappába, tiszta névvel
        await saveFile(null, dName, editor.getValue(), folderId);
        
        document.getElementById('current-filename').textContent = dName;
    } else {
        // Meglévő fájl frissítése
        await saveFile(currentFileId, null, editor.getValue(), null);
    }
    alert("Sikeres mentés a felhőbe! ☁️");
}

async function saveFile(id, name, content, folderId) {
    const meta = { mimeType: 'text/plain' };
    if(name) meta.name = name;
    if(folderId) meta.parents = [folderId];
    
    const file = new Blob([content], {type: 'text/plain'});
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
    
    if(!id) currentFileId = data.id;
}

async function loadFile(id, name) {
    try {
        const res = await gapi.client.drive.files.get({fileId: id, alt: 'media'});
        editor.setValue(res.body);
        currentFileId = id;
        document.getElementById('current-filename').textContent = name;
        switchView('view-editor');
    } catch(e){ alert("Hiba a betöltéskor."); }
}

function openEditorNew() {
    currentFileId = null; editor.setValue(""); 
    document.getElementById('current-filename').textContent = "Névtelen.py";
    switchView('view-editor');
}

function refreshDashboard() { loadDashboardFiles(); }

// --- PYODIDE ---
async function initPyodide() {
    try {
        pyodide = await loadPyodide();
        await pyodide.runPythonAsync(`
            import sys, js
            class W:
                def write(self,t): js.printTerm(t)
                def flush(self): pass
            sys.stdout=W(); sys.stderr=W()
            async def input(p=""):
                if p: print(p, end="")
                return await js.waitForInput()
        `);
    } catch(e){ console.log("Pyodide loading..."); }
}

window.printTerm = (t) => {
    const d=document.getElementById('output'); d.innerText+=t; d.scrollTop=d.scrollHeight;
    document.getElementById('sidePanel').classList.add('open');
};

window.waitForInput = () => {
    return new Promise(resolve => {
        inputResolver = resolve;
        const c = document.getElementById("terminal-input-container");
        c.classList.add("visible");
        document.getElementById("term-input").focus();
        document.getElementById("sidePanel").classList.add("open");
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
    document.getElementById("output").innerText="";
    try { await pyodide.runPythonAsync(editor.getValue()); } 
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