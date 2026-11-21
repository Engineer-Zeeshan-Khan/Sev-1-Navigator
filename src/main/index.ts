import { app, BrowserWindow, ipcMain, shell, Notification, session } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { basename, dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { existsSync, mkdirSync, chmodSync, copyFileSync, watch, watchFile, unwatchFile, FSWatcher } from 'node:fs';

// The main process owns persistent data and creates every BrowserWindow.
let db: Database.Database;
let mainWindow: BrowserWindow | null = null;
let floatingWindows = new Map<string, BrowserWindow>();
let configWatcher: FSWatcher | null = null;
let configReloadTimer: NodeJS.Timeout | null = null;
let watchedWorkbookPath: string | null = null;

function rendererDevelopmentUrl(): URL | null {
  // Packaged apps must always load their bundled UI, even if their launch environment is modified.
  if (app.isPackaged) return null;
  const candidate = process.env.ELECTRON_RENDERER_URL;
  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
    if (url.protocol !== 'http:' || !loopbackHosts.has(url.hostname) || url.username || url.password) {
      throw new Error('Development renderer must use an unauthenticated loopback HTTP URL.');
    }
    return url;
  } catch {
    console.error('Ignoring invalid ELECTRON_RENDERER_URL; only a local development server is allowed.');
    return null;
  }
}

function secureRendererWindow(win: BrowserWindow) {
  // This app never embeds external pages; web links are opened explicitly in the system browser.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, destination) => {
    const devUrl = rendererDevelopmentUrl();
    let isAllowedDevNavigation = false;
    try {
      isAllowedDevNavigation = Boolean(devUrl && new URL(destination).origin === devUrl.origin);
    } catch {
      // Block malformed navigation targets.
    }
    if (!isAllowedDevNavigation) event.preventDefault();
  });
}

function handleAppIpc(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown
) {
  ipcMain.handle(channel, (event, ...args) => {
    const isKnownWindow = BrowserWindow.getAllWindows().some(win => win.webContents === event.sender);
    if (!isKnownWindow || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('IPC request rejected: sender is not an application window.');
    }
    return handler(event, ...args);
  });
}

function restrictLocalDataPermissions(path: string, mode: number) {
  // POSIX permissions keep incident records and workbook data private to the current macOS/Linux user.
  if (process.platform === 'win32') return;
  try {
    chmodSync(path, mode);
  } catch (error) {
    console.warn('Could not restrict local application data permissions:', error);
  }
}

function broadcast(channel: string, payload: unknown) {
  // Dashboard and floating windows share the same incident state; refresh both after writes.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function broadcastConfigUpdated(result: unknown) {
  broadcast('config:updated', result);
}

function watchConfigWorkbook() {
  const target = getActiveWorkbookPath();
  try {
    // Excel may save by replacing the file, so watch its directory as well as its metadata.
    configWatcher?.close();
    if (watchedWorkbookPath) unwatchFile(watchedWorkbookPath);
    const scheduleReload = () => {
      // Debounce the two filesystem notifications Excel commonly emits for a single save.
      if (configReloadTimer) clearTimeout(configReloadTimer);
      configReloadTimer = setTimeout(async () => {
        if (!existsSync(target)) return;
        try {
          const result = await importWorkbookFile(target);
          if (resolve(target) !== resolve(configWorkbookPath())) copyFileSync(target, configWorkbookPath());
          broadcastConfigUpdated(result);
        } catch (error) {
          console.error('Configuration workbook was not applied:', error);
          broadcast('config:error', error instanceof Error ? error.message : String(error));
        }
      }, 900);
    };
    configWatcher = watch(dirname(target), (_event, filename) => {
      if (!filename || String(filename) === basename(target)) scheduleReload();
    });
    watchFile(target, { interval: 700, persistent: false }, (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) scheduleReload();
    });
    watchedWorkbookPath = target;
  } catch (error) {
    console.error('Could not watch configuration workbook:', error);
  }
}


function configWorkbookPath() {
  // Keep the editable workbook in the per-user data folder, not inside the installed app bundle.
  return join(app.getPath('userData'), 'SEV1-Command-Center-Configuration.xlsx');
}

function getActiveWorkbookPath() {
  const saved = db.prepare("SELECT value FROM app_settings WHERE key='workbook_path'").get() as {value:string}|undefined;
  return saved?.value || configWorkbookPath();
}

function setActiveWorkbookPath(filePath: string) {
  db.prepare("INSERT INTO app_settings (key,value) VALUES ('workbook_path',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(resolve(filePath));
}

function safeSqliteInsert(
  statement: any,
  params: Record<string, any>,
  sheet: string,
  row: number
) {
  // Convert Excel cell values to SQLite-compatible values and attach sheet/row context to errors.
  const safeParams: Record<string, any> = {};

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) {
      safeParams[key] = null;
    } else if (value instanceof Date) {
      safeParams[key] = value.toISOString();
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      Buffer.isBuffer(value)
    ) {
      safeParams[key] = value;
    } else {
      try {
        safeParams[key] = JSON.stringify(value) ?? String(value);
      } catch {
        safeParams[key] = String(value);
      }
    }
  }

  try {
    statement.run(safeParams);
  } catch (error: any) {
    throw new Error(
      `${sheet} worksheet, row ${row}: ${error.message}`
    );
  }
}

async function importWorkbookFile(filePath: string) {
  // Read all three configuration sheets before changing SQLite, then apply them as one transaction.
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const activitySheet = workbook.getWorksheet('Activities');
  const toolSheet = workbook.getWorksheet('Tools');
  const templateSheet = workbook.getWorksheet('Communication Templates');
  if (!activitySheet || !toolSheet || !templateSheet) throw new Error('Workbook must contain Activities, Tools and Communication Templates sheets.');
  
// ExcelJS represents formulas, hyperlinks, and rich text as objects; flatten them for storage.
const normalizeExcelValue = (value: any): string | number | null => {
  if (value === null || value === undefined) return null;

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return value;
  }

  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  if (typeof value === 'object') {
    if ('result' in value) {
      return normalizeExcelValue(value.result);
    }

    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part: any) => part.text || '').join('');
    }

    if ('hyperlink' in value) {
      return String(value.text || value.hyperlink);
    }

    if ('text' in value) {
      return String(value.text);
    }

    if ('error' in value) {
      return String(value.error);
    }

    return JSON.stringify(value) ?? String(value);
  }

  return String(value);
};

// Use the first row as named columns so workbook column order can change safely.
const parse = (ws: ExcelJS.Worksheet) => {
  const headers: string[] = [];

  ws.getRow(1).eachCell((c, i) => {
    headers[i] = String(normalizeExcelValue(c.value) ?? '').trim();
  });

  const out: any[] = [];

  ws.eachRow((row, n) => {
    if (n === 1) return;

    const o: any = {};

    row.eachCell((c, i) => {
      const header = headers[i];

      if (header) {
        o[header] = normalizeExcelValue(c.value);
      }
    });

    if (Object.values(o).some(v => v !== null && v !== undefined && v !== '')) {
      out.push(o);
    }
  });

  return out;
};

  const acts=parse(activitySheet), tools=parse(toolSheet), temps=parse(templateSheet);
  const tx=db.transaction(()=>{
    // Stable IDs let edits update existing configuration; missing rows are kept but disabled.
    db.prepare('UPDATE activities SET active=0').run();
    db.prepare('UPDATE tools SET active=0').run();
    db.prepare('UPDATE templates SET active=0').run();
    const ai=db.prepare(`INSERT INTO activities VALUES (@id,@due_minutes,@name,@description,@mandatory,@phase,@display_order,@active)
      ON CONFLICT(id) DO UPDATE SET due_minutes=excluded.due_minutes,name=excluded.name,description=excluded.description,mandatory=excluded.mandatory,phase=excluded.phase,display_order=excluded.display_order,active=excluded.active`);
    acts.forEach((r:any,i:number)=>{
      if(!r['Task ID']||!r['Activity Name']||!Number.isFinite(Number(r['Due Minutes']))||Number(r['Due Minutes'])<0)throw new Error(`Invalid Activities row ${i+2}`);
      ai.run({id:String(r['Task ID']),due_minutes:Number(r['Due Minutes']),name:String(r['Activity Name']),description:String(r['Description']||''),mandatory:/^(yes|true|1)$/i.test(String(r['Mandatory']))?1:0,phase:String(r['Phase']||'General'),display_order:Number(r['Display Order']||i),active:/^(yes|true|1)$/i.test(String(r['Active']??'Yes'))?1:0});
    });
    const ti=db.prepare(`INSERT INTO tools VALUES (@id,@name,@url,@description,@category,@display_order,@active)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,url=excluded.url,description=excluded.description,category=excluded.category,display_order=excluded.display_order,active=excluded.active`);
    tools.forEach((r:any,i:number)=>{
      if (!r['Tool ID'] || !r['Tool Name'] || !/^https?:\/\//i.test(String(r.URL || ''))) {throw new Error(`Invalid Tools row ${i + 2}`);}
      ti.run({id:String(r['Tool ID']),name:String(r['Tool Name']),url:String(r.URL),description:String(r.Description||''),category:String(r.Category||''),display_order:Number(r['Display Order']||i),active:/^(yes|true|1)$/i.test(String(r.Active??'Yes'))?1:0});
    });
    const ci=db.prepare(`INSERT INTO templates VALUES (@id,@stage,@name,@subject,@body,@display_order,@active)
      ON CONFLICT(id) DO UPDATE SET stage=excluded.stage,name=excluded.name,subject=excluded.subject,body=excluded.body,display_order=excluded.display_order,active=excluded.active`);
    temps.forEach((r:any,i:number)=>{
      if(!r['Template ID']||!r['Template Name']||!r.Body)throw new Error(`Invalid Communication Templates row ${i+2}`);
      ci.run({id:String(r['Template ID']),stage:String(r.Stage||'General'),name:String(r['Template Name']),subject:String(r.Subject||''),body:String(r.Body),display_order:Number(r['Display Order']||i),active:/^(yes|true|1)$/i.test(String(r.Active??'Yes'))?1:0});
    });
  });
  tx();
  return {activities:acts.length,tools:tools.length,templates:temps.length};
}
async function loadStartupWorkbook() {
  // Prefer a saved workbook path; otherwise use the development workbook or the managed user copy.
  const managed=configWorkbookPath();
  const saved=db.prepare("SELECT value FROM app_settings WHERE key='workbook_path'").get() as {value:string}|undefined;
  const developmentWorkbook=join(app.getAppPath(),'SEV1-Command-Center-Configuration.xlsx');
  let target=saved?.value?resolve(saved.value):(process.env.ELECTRON_RENDERER_URL&&existsSync(developmentWorkbook)?developmentWorkbook:managed);
  if(!existsSync(managed)) {
    const bundled=join(app.getAppPath(),'SEV1-Command-Center-Configuration.xlsx');
    if(existsSync(bundled)) copyFileSync(bundled,managed);
  }
  if(existsSync(managed)) restrictLocalDataPermissions(managed,0o600);
  if(!existsSync(target)) target=managed;
  setActiveWorkbookPath(target);
  if(existsSync(target)) {
    try {
      await importWorkbookFile(target);
      if(resolve(target)!==resolve(managed))copyFileSync(target,managed);
    }
    catch(error) { console.error('Configuration workbook was not applied:',error); }
  }
}

function initDb() {
  // SQLite is local to this user and cascades task/event cleanup if an incident ages out of history.
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  restrictLocalDataPermissions(dir,0o700);
  const databasePath=join(dir, 'sev1-command-center.sqlite');
  db = new Database(databasePath);
  restrictLocalDataPermissions(databasePath,0o600);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, severity TEXT NOT NULL,
      start_at INTEGER NOT NULL, sla_minutes INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', end_at INTEGER,
      incident_number TEXT NOT NULL DEFAULT '', organization TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS incident_tasks (
      id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      source_task_id TEXT, due_minutes REAL NOT NULL, name TEXT NOT NULL,
      description TEXT, mandatory INTEGER NOT NULL DEFAULT 1,
      phase TEXT, completed_at INTEGER, skipped INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY, due_minutes REAL NOT NULL, name TEXT NOT NULL,
      description TEXT, mandatory INTEGER NOT NULL DEFAULT 1, phase TEXT,
      display_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS tools (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
      description TEXT, category TEXT, display_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY, stage TEXT NOT NULL, name TEXT NOT NULL,
      subject TEXT, body TEXT NOT NULL, display_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS incident_events (
      id TEXT PRIMARY KEY, incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      occurred_at INTEGER NOT NULL, event_type TEXT NOT NULL, details TEXT
    );
  `);
  const incidentColumns=db.prepare('PRAGMA table_info(incidents)').all() as {name:string}[];
  // Add columns for users upgrading from an earlier database without discarding incident history.
  if(!incidentColumns.some(column=>column.name==='incident_number'))db.exec("ALTER TABLE incidents ADD COLUMN incident_number TEXT NOT NULL DEFAULT ''");
  if(!incidentColumns.some(column=>column.name==='organization'))db.exec("ALTER TABLE incidents ADD COLUMN organization TEXT NOT NULL DEFAULT ''");
  db.prepare("UPDATE incidents SET incident_number=id WHERE incident_number IS NULL OR incident_number=''").run();
  db.prepare("DELETE FROM incidents WHERE id NOT IN (SELECT id FROM incidents ORDER BY start_at DESC,id DESC LIMIT 10)").run();
  const count = db.prepare('SELECT COUNT(*) n FROM activities').get() as {n:number};
  if (!count.n) {
    const defaults = [
      [0,'Take ownership of the case','Accept and acknowledge case ownership','Yes','Immediate'],
      [5,'Join dedicated Slack channel','Join the incident coordination channel','Yes','Immediate'],
      [15,'Contact customer / join bridge','Initiate customer communication','Yes','Immediate'],
      [30,'Complete CAN report','Complete the required CAN report','Yes','Investigation'],
      [30,'Confirm severity classification','Validate and record incident severity','Yes','Investigation'],
      [45,'Provide investigation update','Share progress and next update commitment','Yes','Critical']
    ];
    const ins = db.prepare('INSERT INTO activities VALUES (?,?,?,?,?,?,?,1)');
    defaults.forEach((r,i)=>ins.run(`ACT-${i+1}`,r[0],r[1],r[2],r[3]==='Yes'?1:0,r[4],i));
  }
  const tcount = db.prepare('SELECT COUNT(*) n FROM templates').get() as {n:number};
  if (!tcount.n) {
    const rows = [
      ['first-response','Initial response','First response email','We are acknowledging your SEV1 incident and have started investigating. Our team is reviewing the reported behaviour and will provide the next update by [TIME].','1'],
      ['can-report','Reporting','CAN report','Customer / Account:\\nIncident ID:\\nCurrent impact:\\nActions taken:\\nNext steps:\\nOwner:\\nNext update:','2'],
      ['handoff','Regional transition','Regional handoff','Incident summary:\\nCustomer impact:\\nCurrent severity:\\nInvestigation completed:\\nOutstanding actions:\\nLogs / evidence:\\nCustomer communication status:\\nNext update due:\\nReceiving team / region:','3'],
      ['downgrade','Severity change','SEV1 to SEV2 downgrade','Based on the current impact assessment and investigation findings, we propose changing the incident severity from SEV1 to SEV2. Rationale: [RATIONALE]. Customer impact: [IMPACT]. Please confirm the required approval and update the incident record.','4'],
      ['resolution','Resolution','Resolution communication','The reported issue has been addressed. Resolution details: [DETAILS]. Please validate the service behaviour and let us know if you continue to experience the issue.','5'],
      ['monitoring','Monitoring','Monitoring confirmation','The service is currently being monitored following the remediation. Monitoring window: [WINDOW]. We will confirm closure after validation is complete.','6'],
      ['rca','Closure','Root Cause Analysis (RCA)','Summary:\\nCustomer impact:\\nRoot cause:\\nContributing factors:\\nResolution:\\nPreventive actions:\\nTimeline:\\nFollow-up owners:\\n','7']
    ];
    const ins = db.prepare('INSERT INTO templates VALUES (?,?,?,?,?,?,1)');
    rows.forEach(r=>ins.run(r[0],r[1],r[2],'',r[3],Number(r[4])));
  }
  const toolsCount = db.prepare('SELECT COUNT(*) n FROM tools').get() as {n:number};
  if (!toolsCount.n) {
    const rows = [
      ['instana','Instana','https://example.com/instana','Log reader / observability','Monitoring',1,1],
      ['sigma','Sigma SQL','https://example.com/sigma','SQL investigation','Investigation',2,1],
      ['terraform-admin','Terraform Admin','https://example.com/terraform-admin','Administrative portal','Administration',3,1],
      ['slack','Slack','https://slack.com','Incident coordination','Communication',4,1],
      ['servicenow','ServiceNow','https://example.com/servicenow','Incident management','Ticketing',5,1]
    ];
    const ins = db.prepare('INSERT INTO tools VALUES (?,?,?,?,?,?,?)');
    rows.forEach(r=>ins.run(...r));
  }
}

function createMainWindow() {
  // Keep privileged Node APIs out of the renderer; all access goes through the preload bridge.
  mainWindow = new BrowserWindow({
    width: 1420, height: 900, minWidth: 1050, minHeight: 700,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false, devTools: !app.isPackaged }
  });
  secureRendererWindow(mainWindow);
  mainWindow.on('closed',()=>{mainWindow=null;});
  const devUrl = rendererDevelopmentUrl();
  if (devUrl) mainWindow.loadURL(devUrl.href);
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

function createFloating(incidentId: string) {
  const existing = floatingWindows.get(incidentId);
  if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return; }
  // The compact transparent clock is pinned by default; macOS workspace visibility follows its pin state.
  const win = new BrowserWindow({
    width: 240, height: 360, minWidth: 210, minHeight: 300,
    frame: false, transparent: true, resizable: true, alwaysOnTop: true,
    skipTaskbar: true, hasShadow: true,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false, devTools: !app.isPackaged }
  });
  secureRendererWindow(win);
  if(process.platform==='darwin')win.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
  floatingWindows.set(incidentId, win);
  win.on('closed',()=>floatingWindows.delete(incidentId));
  const devUrl = rendererDevelopmentUrl();
  if (devUrl) win.loadURL(`${devUrl.href}#/floating/${encodeURIComponent(incidentId)}`);
  else win.loadFile(join(__dirname, '../renderer/index.html'), { hash: `/floating/${encodeURIComponent(incidentId)}` });
}

// IPC handlers below are the renderer's only route to database, operating-system, and workbook actions.
handleAppIpc('incidents:list',()=>db.prepare("SELECT * FROM incidents ORDER BY start_at DESC").all());
handleAppIpc('incidents:create',(_e,input)=>{
  const incidentNumber=String(input.incidentNumber||'').trim();
  const organization=String(input.organization||'').trim();
  if(!incidentNumber||!organization||incidentNumber.length>200||organization.length>200)throw new Error('Incident number and organization name are required (maximum 200 characters each).');
  const requestedSla=Number(input.slaMinutes);
  const slaMinutes=Number.isFinite(requestedSla)&&requestedSla>=1&&requestedSla<=1440?requestedSla:60;
  const id = `SEV1-${Date.now()}`;
  const start = Date.now();
  const tx = db.transaction(()=>{
    db.prepare('INSERT INTO incidents (id,title,severity,start_at,sla_minutes,status,incident_number,organization) VALUES (?,?,?,?,?,?,?,?)')
      .run(id,incidentNumber,'SEV1',start,slaMinutes,'active',incidentNumber,organization);
    // Snapshot the current workbook activities so this incident's checklist remains stable afterward.
    const rows = db.prepare('SELECT * FROM activities WHERE active=1 ORDER BY display_order').all() as any[];
    const ins = db.prepare('INSERT INTO incident_tasks (id,incident_id,source_task_id,due_minutes,name,description,mandatory,phase) VALUES (?,?,?,?,?,?,?,?)');
    rows.forEach((r:any,i:number)=>ins.run(`${id}-TASK-${i+1}`,id,r.id,r.due_minutes,r.name,r.description,r.mandatory,r.phase));
    db.prepare('INSERT INTO incident_events VALUES (?,?,?,?,?)').run(`${id}-EVENT-1`,id,start,'incident_started','Incident created');
    db.prepare("DELETE FROM incidents WHERE id NOT IN (SELECT id FROM incidents ORDER BY start_at DESC,id DESC LIMIT 10)").run();
  });
  tx(); return db.prepare('SELECT * FROM incidents WHERE id=?').get(id);
});
handleAppIpc('incidents:tasks',(e,id)=>db.prepare('SELECT * FROM incident_tasks WHERE incident_id=? ORDER BY due_minutes').all(id));
handleAppIpc('tasks:complete',(_e,{taskId,incidentId,complete})=>{
  const incident=db.prepare("SELECT status FROM incidents WHERE id=?").get(incidentId) as {status:string}|undefined;
  if(!incident||incident.status!=='active'||typeof complete!=='boolean')throw new Error('This checklist item cannot be changed.');
  const task=db.prepare('SELECT id FROM incident_tasks WHERE id=? AND incident_id=?').get(taskId,incidentId);
  if(!task)throw new Error('Checklist item not found for this incident.');
  const at = complete ? Date.now() : null;
  db.prepare('UPDATE incident_tasks SET completed_at=?, skipped=0 WHERE id=? AND incident_id=?').run(at,taskId,incidentId);
  db.prepare('INSERT INTO incident_events VALUES (?,?,?,?,?)').run(`${incidentId}-${Date.now()}`,incidentId,Date.now(),complete?'task_completed':'task_reopened',taskId);
  broadcast('tasks:updated', incidentId);
  return true;
});
handleAppIpc('incidents:resolve',(_e,id)=>{
  // Enforce the resolve rule in the main process so UI state cannot bypass it.
  const totals=db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) AS completed FROM incident_tasks WHERE incident_id=?').get(id) as {total:number;completed:number|null};
  if (!totals.total || totals.completed !== totals.total) throw new Error('Complete every response checklist item before resolving this SEV-1.');
  db.prepare("UPDATE incidents SET status='resolved',end_at=? WHERE id=? AND status='active'").run(Date.now(),id);
  broadcast('incidents:updated',id);
  return true;
});
handleAppIpc('tools:list',()=>db.prepare('SELECT * FROM tools WHERE active=1 ORDER BY display_order').all());
handleAppIpc('tools:open',async(_e,url)=>{
  // Only allow web links to leave the app; never pass arbitrary protocols to the operating system.
  if(typeof url!=='string'||url.length>2048)throw new Error('Invalid tool URL.');
  const u = new URL(url);
  if (!['http:','https:'].includes(u.protocol)||u.username||u.password) throw new Error('Unsupported URL. Only HTTP and HTTPS links without embedded credentials are allowed.');
  await shell.openExternal(u.toString()); return true;
});
handleAppIpc('templates:list',()=>db.prepare('SELECT * FROM templates WHERE active=1 ORDER BY display_order').all());
handleAppIpc('templates:copy',(_e,text)=>{ if(typeof text!=='string'||text.length>50000)throw new Error('Template text is invalid or too large.'); require('electron').clipboard.writeText(text); return true; });
handleAppIpc('window:open-floating',(_e,id)=>{createFloating(id);return true;});
handleAppIpc('window:toggle-floating-pin',(event)=>{const win=BrowserWindow.fromWebContents(event.sender);if(!win||win.isDestroyed())return false;const pinned=!win.isAlwaysOnTop();win.setAlwaysOnTop(pinned,pinned?'floating':'normal');if(process.platform==='darwin')win.setVisibleOnAllWorkspaces(pinned,{visibleOnFullScreen:pinned});return pinned;});
handleAppIpc('window:open-main',(_event,incidentId?:string)=>{if(!mainWindow||mainWindow.isDestroyed())createMainWindow();const win=mainWindow;if(!win)return false;const focusWindow=()=>{if(win.isDestroyed())return;win.show();win.focus();app.focus({steal:true});if(incidentId)win.webContents.send('window:focus-incident',incidentId);};if(win.webContents.isLoading())win.webContents.once('did-finish-load',()=>setTimeout(focusWindow,100));else setTimeout(focusWindow,50);return true;});
handleAppIpc('window:close-floating',(_e,id)=>{const w=floatingWindows.get(id);if(w)w.close();});
handleAppIpc('notifications:show',(_e,{title,body})=>{if(Notification.isSupported())new Notification({title,body}).show();});
handleAppIpc('excel:import',async(_e,filePath)=>{
  // Copy imports to the managed workbook so future launches use the same configuration.
  const result=await importWorkbookFile(filePath);
  if(resolve(filePath)!==resolve(configWorkbookPath())) copyFileSync(filePath,configWorkbookPath());
  setActiveWorkbookPath(filePath);
  watchConfigWorkbook();
  broadcastConfigUpdated(result);
  return result;
});
handleAppIpc('excel:choose-import',async()=>{
  const {dialog}=require('electron');
  const result=await dialog.showOpenDialog({properties:['openFile'],filters:[{name:'Excel Workbook',extensions:['xlsx']}]});
  if(result.canceled||!result.filePaths[0])return {canceled:true};
  const filePath=result.filePaths[0];
  const imported=await importWorkbookFile(filePath);
  if(resolve(filePath)!==resolve(configWorkbookPath()))copyFileSync(filePath,configWorkbookPath());
  setActiveWorkbookPath(filePath);
  watchConfigWorkbook();
  broadcastConfigUpdated(imported);
  return {canceled:false,...imported,path:resolve(filePath)};
});
handleAppIpc('excel:config-path',()=>getActiveWorkbookPath());
handleAppIpc('excel:open-config-folder',async()=>{const p=getActiveWorkbookPath();await shell.openPath(dirname(p));return p;});
handleAppIpc('excel:reload-config',async()=>{const p=getActiveWorkbookPath();if(!existsSync(p))throw new Error(`Configuration workbook not found: ${p}`);const result=await importWorkbookFile(p);if(resolve(p)!==resolve(configWorkbookPath()))copyFileSync(p,configWorkbookPath());broadcastConfigUpdated(result);return result;});
handleAppIpc('excel:export-template',async()=>{
  const {dialog}=require('electron');
  const result=await dialog.showSaveDialog({defaultPath:configWorkbookPath(),filters:[{name:'Excel Workbook',extensions:['xlsx']}]});
  if(result.canceled||!result.filePath)return {canceled:true};
  const wb=new ExcelJS.Workbook();
  const add=(name:string,headers:string[],rows:(string|number)[][])=>{const ws=wb.addWorksheet(name);ws.addRow(headers);rows.forEach(r=>ws.addRow(r));ws.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};ws.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF176B70'}};ws.columns=headers.map(()=>({width:24}));};
  add('Activities',['Task ID','Due Minutes','Activity Name','Description','Mandatory','Phase','Display Order','Active'],[
    ['ACT-001',0,'Take ownership of the case','Accept and acknowledge case ownership','Yes','Immediate',1,'Yes'],
    ['ACT-002',5,'Join dedicated Slack channel','Join incident coordination','Yes','Immediate',2,'Yes'],
    ['ACT-003',15,'Contact customer / join bridge','Initiate customer communication','Yes','Immediate',3,'Yes'],
    ['ACT-004',30,'Complete CAN report','Complete required report','Yes','Investigation',4,'Yes']
  ]);
  add('Tools',['Tool ID','Tool Name','URL','Description','Category','Display Order','Active'],[
    ['instana','Instana','https://example.com/instana','Log reader','Monitoring',1,'Yes'],
    ['sigma','Sigma SQL','https://example.com/sigma','SQL investigation','Investigation',2,'Yes'],
    ['terraform-admin','Terraform Admin','https://example.com/terraform-admin','Admin portal','Administration',3,'Yes']
  ]);
  add('Communication Templates',['Template ID','Stage','Template Name','Subject','Body','Display Order','Active'],[
    ['first-response','Initial response','First response email','SEV1 incident acknowledgement','We are investigating [ISSUE]. Next update by [TIME].',1,'Yes'],
    ['can-report','Reporting','CAN report','','Customer impact:\\nActions taken:\\nNext steps:',2,'Yes'],
    ['handoff','Regional transition','Regional handoff','','Summary:\\nImpact:\\nOutstanding actions:\\nNext update:',3,'Yes'],
    ['downgrade','Severity change','SEV1 to SEV2 downgrade','','Rationale:\\nImpact:\\nApproval:',4,'Yes'],
    ['resolution','Resolution','Resolution communication','','Issue addressed: [DETAILS].',5,'Yes'],
    ['monitoring','Monitoring','Monitoring confirmation','','Monitoring window: [WINDOW].',6,'Yes'],
    ['rca','Closure','Root Cause Analysis (RCA)','','Root cause:\\nImpact:\\nResolution:\\nPrevention:',7,'Yes']
  ]);
  await wb.xlsx.writeFile(result.filePath); return {canceled:false,path:result.filePath};
});
// Initialize storage and configuration before showing the UI, so its first requests see loaded data.
app.whenReady().then(async()=>{
  // No embedded web content needs browser permissions; notifications use Electron's native API.
  session.defaultSession.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  initDb();
  await loadStartupWorkbook();
  watchConfigWorkbook();
  createMainWindow();
  app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createMainWindow();});
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
app.on('before-quit',()=>{try{db?.close();}catch{}});
