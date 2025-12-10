// --- CONFIG & GLOBALS ---
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

// --- AUTH INIT ---
function gapiLoaded() {
    gapi.load('client', async () => {
        await gapi.client.init({ apiKey: API_KEY, discoveryDocs: [DISCOVERY_DOC] });
        gapiInited = true;
    });
}
function gisLoaded() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPES,
        callback: (resp) => { if (resp.error) console.error(resp); else isDriveConnected = true; }
    });
    gisInited = true;
}

// --- APP STARTUP ---
window.onload = function() {
    // CodeMirror
    editor = CodeMirror.fromTextArea(document.getElementById("code-editor"), {
        mode: { name: "python", version: 3 },
        theme: "dracula",
        lineNumbers: true, smartIndent: true, matchBrackets: true
    });
    
    // Dropdown eseménykezelő (kívülre kattintás)
    document.addEventListener('click', function(event) {
        const dropdown = document.getElementById("main-dropdown");
        const trigger = document.getElementById("menu-trigger-btn");
        if (!trigger.contains(event.target) && !dropdown.contains(event.target)) {
            dropdown.classList.remove("show");
        }
    });

    // Dropdown nyitó gomb
    document.getElementById("menu-trigger-btn").addEventListener('click', function(e) {
        e.stopPropagation();
        document.getElementById("main-dropdown").classList.toggle("show");
    });
    
    // Pyodide indítása
    initPyodide();
    
    // Skip gomb időzítő
    setTimeout(() => {
        const skipBtn = document.getElementById('skip-login-btn');
        if(skipBtn) skipBtn.style.display = 'block';
    }, 3000);

    // Auto-login check
    const savedUser = localStorage.getItem('ac_user');
    if(savedUser) {
        document.getElementById('loginNameInput').value = savedUser;
        document.getElementById('loading-overlay').style.display = 'none';
    } else {
        document.getElementById('loading-overlay').style.display = 'none';
    }

    // Terminál Input Enter gomb
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

// --- LOGIN LOGIC ---
function skipLogin() {
    currentUser = "Vendég";
    isDriveConnected = false;
    setupDashboard();
}

function performLocalLogin() {
    const name = document.getElementById('loginNameInput').value.trim();
    if(!name) return alert("Adj meg egy nevet!");
    currentUser = name;
    localStorage.setItem('ac_user', currentUser);
    isDriveConnected = false;
    setupDashboard();
}

async function performGoogleLogin() {
    const name = document.getElementById('loginNameInput').value.trim();
    if(!name) return alert("Adj meg egy nevet!");
    currentUser = name;
    localStorage.setItem('ac_user', currentUser);
    await connectGoogleDrive();
    setupDashboard();
}

function setupDashboard() {
    document.getElementById('loading-overlay').style.display='none';
    document.getElementById('dash-username').textContent = currentUser;
    document.getElementById('dash-avatar').textContent = currentUser.substring(0,1).toUpperCase();
    
    const driveBtn = document.getElementById('drive-connect-btn');
    const emptyMsg = document.getElementById('empty-state');
    const offlineMsg = document.getElementById('offline-msg');

    if(isDriveConnected) {
        driveBtn.style.display = 'none';
        loadDashboardFiles();
    } else {
        driveBtn.style.display = 'block';
        emptyMsg.style.display = 'block';
        offlineMsg.textContent = "Offline mód. Csatold a Drive-ot a mentéshez!";
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

// --- DRIVE LOGIC ---
async function ensureAuth() {
    return new Promise((resolve, reject) => {
        if (gapi.client.getToken() === null) {
            tokenClient.callback = (resp) => {
                if (resp.error) reject(resp);
                else {
                    isDriveConnected = true;
                    resolve(resp);
                }
            };
            tokenClient.requestAccessToken({prompt: ''});
        } else {
            isDriveConnected = true;
            resolve();
        }
    });
}

async function connectGoogleDrive() {
    try {
        await ensureAuth();
        alert("Google Drive csatolva!");
        document.getElementById('drive-connect-btn').style.display = 'none';
        loadDashboardFiles();
    } catch(e) { alert("Sikertelen csatolás."); }
}

async function getFolderId() {
    if(userFolderId) return userFolderId;
    await ensureAuth();
    const folderName = "AeroCode_Pro_Files";
    try {
        const q = `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`;
        const res = await gapi.client.drive.files.list({q: q, fields: 'files(id)'});
        if(res.result.files.length > 0) userFolderId = res.result.files[0].id;
        else {
            const resCreate = await gapi.client.drive.files.create({
                resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder' }, fields: 'id'
            });
            userFolderId = resCreate.result.id;
        }
        return userFolderId;
    } catch(e) { return null; }
}

async function loadDashboardFiles() {
    if(!isDriveConnected) return;
    const grid = document.getElementById('project-grid');
    grid.innerHTML = '';
    const folderId = await getFolderId();
    if(!folderId) return;

    const prefix = currentUser + "_";
    const q = `'${folderId}' in parents and trashed=false and name contains '${prefix}'`;
    
    try {
        const res = await gapi.client.drive.files.list({
            q: q, fields: 'files(id, name, createdTime)', orderBy: 'createdTime desc'
        });
        const files = res.result.files;
        if(files && files.length > 0) {
            document.getElementById('empty-state').style.display='none';
            files.forEach(f => {
                let dName = f.name.replace(prefix, "");
                const div = document.createElement('div');
                div.className = 'project-card';
                div.innerHTML = `<div style="font-size:30px; margin-bottom:10px;">📄</div><div class="project-name">${dName}</div>`;
                div.onclick = () => loadFile(f.id, dName);
                grid.appendChild(div);
            });
        } else {
            document.getElementById('empty-state').style.display='block';
            document.getElementById('offline-msg').textContent = "Nincs mentett fájl.";
        }
    } catch(e) { console.error(e); }
}

async function promptSaveDrive() {
    // Dropdown bezárása
    document.getElementById("main-dropdown").classList.remove("show");

    if(!isDriveConnected) {
        if(confirm("Csatolod a Drive-ot a mentéshez?")) await connectGoogleDrive();
        else return;
    }

    const folderId = await getFolderId();
    if(!folderId) return;

    let dName = document.getElementById('current-filename').textContent;
    if(!currentFileId || dName === "Névtelen.py") {
        const input = prompt("Fájlnév:", "projekt");
        if(!input) return;
        dName = input.endsWith(".py") ? input : input+".py";
        const saveName = `${currentUser}_${dName}`;
        await saveFile(null, saveName, editor.getValue(), folderId);
        document.getElementById('current-filename').textContent = dName;
    } else {
        await saveFile(currentFileId, null, editor.getValue(), null);
    }
    alert("Mentve!");
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
    const url = id ? `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=multipart` : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
    
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
    } catch(e) { alert("Hiba a betöltéskor"); }
}

function openEditorNew() {
    currentFileId = null; editor.setValue(""); 
    document.getElementById('current-filename').textContent = "Névtelen.py";
    switchView('view-editor');
}

function backToDashboard() {
    loadDashboardFiles();
    switchView('view-dashboard');
}

function refreshDashboard() {
    loadDashboardFiles();
}

// --- PYTHON ENGINE & TERMINAL ---
async function initPyodide() {
    try {
        pyodide = await loadPyodide();
        await pyodide.runPythonAsync(`
            import sys, js, asyncio
            class JSWriter:
                def write(self, text): js.printToTerminal(text)
                def flush(self): pass
            sys.stdout = JSWriter(); sys.stderr = JSWriter()
            async def custom_input(prompt=""):
                if prompt: print(prompt, end="")
                val = await js.waitForInput()
                print(val); return str(val)
        `);
    } catch(e) { console.log("Pyodide init fail", e); }
}

window.printToTerminal = (text) => {
    const out = document.getElementById("output");
    out.innerText += text;
    out.scrollTop = out.scrollHeight;
    document.getElementById("sidePanel").classList.add("open");
};

window.waitForInput = () => {
    return new Promise(resolve => {
        inputResolver = resolve;
        const bar = document.getElementById("terminal-input-container");
        bar.classList.add("visible");
        document.getElementById("term-input").focus();
        // Megnyitjuk a panelt, ha nem lenne nyitva
        document.getElementById("sidePanel").classList.add("open");
    });
};

function submitTerminalInput() {
    if(inputResolver) {
        const inputField = document.getElementById("term-input");
        const val = inputField.value;
        inputField.value = "";
        
        // Kiírjuk a terminálra, hogy mit írt be a user (mintha echo lenne)
        const out = document.getElementById("output");
        out.innerText += val + "\n";
        
        document.getElementById("terminal-input-container").classList.remove("visible");
        
        inputResolver(val);
        inputResolver = null;
    }
}

async function runPython() {
    document.getElementById("sidePanel").classList.add("open");
    document.getElementById("output").innerText = ""; // Clear output
    
    let code = editor.getValue();
    code = code.replace(/\binput\s*\(/g, "await custom_input(");

    try {
        await pyodide.runPythonAsync(`
            import asyncio
            async def main_wrapper():
                try:
${code.split('\n').map(l => '                    ' + l).join('\n')}
                except Exception as e: print(e)
            await main_wrapper()
        `);
    } catch(e) { window.printToTerminal(e); }
}

function askGemini(){ alert("AI funkció hamarosan!"); document.getElementById("main-dropdown").classList.remove("show"); }
function downloadCode(){ 
    const blob = new Blob([editor.getValue()], {type:'text/plain'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = document.getElementById('current-filename').textContent;
    a.click();
    document.getElementById("main-dropdown").classList.remove("show");
}